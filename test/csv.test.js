import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseCSV,
  parseAmount,
  normalizeDate,
  planImport,
  importId,
  rowMarker,
  parseRowMarker,
  readJournal,
  unconfirmedRows,
  recordPreviewed,
  recordIntent,
  recordPosted,
} from "../src/csv.js";

describe("parseCSV", () => {
  it("handles quoted fields with commas and escaped quotes", () => {
    const rows = parseCSV('a,"b,c","say ""hi"""\n1,2,3');
    expect(rows).toEqual([["a", "b,c", 'say "hi"'], ["1", "2", "3"]]);
  });
  it("handles CRLF and a trailing line without newline", () => {
    expect(parseCSV("a,b\r\n1,2")).toEqual([["a", "b"], ["1", "2"]]);
  });
  it("strips a UTF-8 BOM from the first header cell", () => {
    const rows = parseCSV("﻿Date,Amount\n1/2/26,5");
    expect(rows[0][0]).toBe("Date");
  });
  it("keeps newlines inside quoted fields", () => {
    expect(parseCSV('"line1\nline2",x')).toEqual([["line1\nline2", "x"]]);
  });
});

describe("parseAmount", () => {
  it("parses plain and negative amounts", () => {
    expect(parseAmount("42.50")).toBe(42.5);
    expect(parseAmount("-42.50")).toBe(-42.5);
  });
  it("parses accounting parentheses as negative", () => {
    expect(parseAmount("(1,234.56)")).toBe(-1234.56);
  });
  it("strips currency symbols and thousands separators", () => {
    expect(parseAmount("$2,000")).toBe(2000);
  });
  it("returns NaN for non-numbers and empty strings", () => {
    expect(parseAmount("n/a")).toBeNaN();
    expect(parseAmount("")).toBeNaN();
  });
});

describe("normalizeDate", () => {
  it("passes ISO through and normalizes US formats", () => {
    expect(normalizeDate("2026-07-31")).toBe("2026-07-31");
    expect(normalizeDate("7/4/2026")).toBe("2026-07-04");
    expect(normalizeDate("07/04/26")).toBe("2026-07-04");
    expect(normalizeDate("2026/7/4")).toBe("2026-07-04");
  });
  it("rejects unreadable or impossible dates", () => {
    expect(normalizeDate("July 4")).toBeNull();
    expect(normalizeDate("13/40/2026")).toBeNull();
    expect(normalizeDate("")).toBeNull();
  });
});

describe("planImport", () => {
  it("splits outflows from inflows with negative_out convention", () => {
    const rows = parseCSV("Date,Description,Amount\n1/2/26,COFFEE SHOP,-4.50\n1/3/26,PAYROLL DEPOSIT,2000\n1/4/26,VENDOR,(25.00)");
    const plan = planImport(rows);
    expect(plan.outflows.map((o) => [o.date, o.amount])).toEqual([["2026-01-02", 4.5], ["2026-01-04", 25]]);
    expect(plan.inflows).toHaveLength(1);
    expect(plan.errors).toHaveLength(0);
  });
  it("flips sign under positive_out convention", () => {
    const rows = parseCSV("Date,Description,Amount\n1/2/26,CHARGE,4.50");
    const plan = planImport(rows, { amountConvention: "positive_out" });
    expect(plan.outflows).toHaveLength(1);
    expect(plan.inflows).toHaveLength(0);
  });
  it("uses Debit/Credit columns when present (debit = money out)", () => {
    const rows = parseCSV("Date,Description,Debit,Credit\n1/2/26,RENT,1500,\n1/3/26,REFUND,,75");
    const plan = planImport(rows);
    expect(plan.outflows).toEqual([{ row: 2, date: "2026-01-02", description: "RENT", amount: 1500 }]);
    expect(plan.inflows[0].amount).toBe(75);
  });
  it("collects row errors instead of importing garbage", () => {
    const rows = parseCSV("Date,Description,Amount\nnotadate,X,5\n1/5/26,Y,zzz");
    const plan = planImport(rows);
    expect(plan.errors).toHaveLength(2);
    expect(plan.outflows).toHaveLength(0);
  });
  it("throws when required columns are missing", () => {
    expect(() => planImport(parseCSV("Foo,Bar\n1,2"))).toThrow(/Could not detect/);
  });
});

describe("import identity", () => {
  it("is stable for identical inputs and distinct otherwise", () => {
    const a = importId({ company: "acme", bankAccount: "35", fileBytes: Buffer.from("x") });
    const b = importId({ company: "acme", bankAccount: "35", fileBytes: Buffer.from("x") });
    const c = importId({ company: "acme", bankAccount: "36", fileBytes: Buffer.from("x") });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
  });
  it("stamps a recognizable row marker", () => {
    expect(rowMarker("abc123", 7)).toBe("[import abc123 row 7]");
  });
  it("reads its own marker back off a PrivateNote", () => {
    const note = `COFFEE SHOP ${rowMarker("abc123", 7)}`;
    expect(parseRowMarker(note)).toEqual({ importId: "abc123", row: 7 });
  });
  it("returns null for notes with no marker", () => {
    expect(parseRowMarker("just a memo")).toBeNull();
    expect(parseRowMarker(null)).toBeNull();
  });
});

// The journal is what stops a re-run from double-posting. The dangerous window
// is between QBO committing a batch and the confirmation reaching this file:
// those rows must come back as "unconfirmed" (go ask QuickBooks), never as
// "not posted yet" (safe to send again).
describe("import journal", () => {
  let dir;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "qbo-journal-"));
    process.env.QBO_AUDIT_DIR = dir;
  });
  afterEach(() => {
    delete process.env.QBO_AUDIT_DIR;
  });

  it("starts empty", async () => {
    const j = await readJournal("aaa111");
    expect(j.previewed).toBe(false);
    expect([...j.posted]).toEqual([]);
    expect([...unconfirmedRows(j)]).toEqual([]);
  });

  it("records a dry run so a live import can require one", async () => {
    expect((await readJournal("aaa111")).previewed).toBe(false);
    await recordPreviewed("aaa111", { rows_out: 3 });
    expect((await readJournal("aaa111")).previewed).toBe(true);
    // scoped to this import only
    expect((await readJournal("bbb222")).previewed).toBe(false);
  });

  it("reports intent-without-confirmation as unconfirmed, not as unposted", async () => {
    await recordIntent("aaa111", [2, 3, 4]);
    await recordPosted("aaa111", [{ row: 2, purchase_id: "10" }]);
    // rows 3 and 4 were sent to QBO and never confirmed: the crash window
    const j = await readJournal("aaa111");
    expect([...j.posted]).toEqual([2]);
    expect([...unconfirmedRows(j)].sort()).toEqual([3, 4]);
  });

  it("clears unconfirmed rows once their outcome is journaled", async () => {
    await recordIntent("aaa111", [3]);
    await recordPosted("aaa111", [{ row: 3, purchase_id: "11" }]);
    expect([...unconfirmedRows(await readJournal("aaa111"))]).toEqual([]);
  });

  it("keeps imports separate", async () => {
    await recordIntent("aaa111", [1]);
    await recordPosted("bbb222", [{ row: 9, purchase_id: "12" }]);
    expect([...unconfirmedRows(await readJournal("aaa111"))]).toEqual([1]);
    expect([...(await readJournal("bbb222")).posted]).toEqual([9]);
  });

  it("reads pre-`kind` records as posted rows, so an in-flight import resumes", async () => {
    const file = path.join(dir, "imports-journal.jsonl");
    await writeFile(file, JSON.stringify({ ts: "2026-08-01T00:00:00Z", import_id: "aaa111", row: 5, purchase_id: "99" }) + "\n");
    expect([...(await readJournal("aaa111")).posted]).toEqual([5]);
  });

  it("skips corrupt lines rather than losing the whole journal", async () => {
    await recordPosted("aaa111", [{ row: 1, purchase_id: "1" }]);
    const file = path.join(dir, "imports-journal.jsonl");
    await appendFile(file, "{ this is not json\n");
    await recordPosted("aaa111", [{ row: 2, purchase_id: "2" }]);
    expect([...(await readJournal("aaa111")).posted].sort()).toEqual([1, 2]);
  });
});

describe("normalizeDate rejects impossible calendar dates", () => {
  it("refuses a day that does not exist in that month", () => {
    expect(normalizeDate("2026-02-31")).toBeNull();
    expect(normalizeDate("2/31/2026")).toBeNull();
    expect(normalizeDate("2025-02-29")).toBeNull();
  });
  it("still accepts a real leap day", () => {
    expect(normalizeDate("2024-02-29")).toBe("2024-02-29");
    expect(normalizeDate("2/29/2024")).toBe("2024-02-29");
  });
});
