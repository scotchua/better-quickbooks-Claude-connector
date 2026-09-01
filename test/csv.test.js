import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseCSV,
  parseAmount,
  normalizeDate,
  planImport,
  importId,
  normalizeAmountConvention,
  previewPlanHash,
  rowMarker,
  parseRowMarker,
  readJournal,
  unconfirmedRows,
  recordPreviewed,
  recordIntent,
  recordPosted,
  recordRejected,
  recordBatchOutcomes,
  withImportLock,
  __test as csvTest,
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

  it("normalizes an omitted amount convention to negative_out", () => {
    expect(normalizeAmountConvention()).toBe("negative_out");
    expect(normalizeAmountConvention("negative_out")).toBe("negative_out");
    expect(() => normalizeAmountConvention("sideways")).toThrow(/Unsupported CSV amount convention/);
  });

  it("fingerprints the exact resolved preview plan", () => {
    const base = {
      company: "acme",
      bankAccount: "35",
      fileBytes: Buffer.from("Date,Description,Amount\n1/2/26,Coffee,-4.50\n"),
      plannedRows: [{
        row: 2,
        date: "2026-01-02",
        amount: 4.5,
        description: "Coffee",
        category_id: "81",
      }],
    };
    const expected = previewPlanHash(base);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
    // Omitted and explicit defaults are the same normalized plan.
    expect(previewPlanHash({ ...base, amountConvention: "negative_out" })).toBe(expected);

    const variants = [
      { ...base, company: "other" },
      { ...base, bankAccount: "36" },
      { ...base, fileBytes: Buffer.from("different file") },
      { ...base, amountConvention: "positive_out" },
      { ...base, plannedRows: [{ ...base.plannedRows[0], row: 3 }] },
      { ...base, plannedRows: [{ ...base.plannedRows[0], date: "2026-01-03" }] },
      { ...base, plannedRows: [{ ...base.plannedRows[0], amount: 5 }] },
      { ...base, plannedRows: [{ ...base.plannedRows[0], description: "Tea" }] },
      { ...base, plannedRows: [{ ...base.plannedRows[0], category_id: "82" }] },
    ];
    for (const variant of variants) expect(previewPlanHash(variant)).not.toBe(expected);
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
  afterEach(async () => {
    delete process.env.QBO_AUDIT_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  it("starts empty", async () => {
    const j = await readJournal("aaa111");
    expect(j.previewed).toBe(false);
    expect([...j.posted]).toEqual([]);
    expect([...j.rejected]).toEqual([]);
    expect([...unconfirmedRows(j)]).toEqual([]);
  });

  it("records a dry run so a live import can require one", async () => {
    expect((await readJournal("aaa111")).previewed).toBe(false);
    await recordPreviewed("aaa111", { rows_out: 3, plan_hash: "first" });
    expect(await readJournal("aaa111")).toMatchObject({ previewed: true, previewPlanHash: "first" });
    // Only the latest preview is authoritative for a live import.
    await recordPreviewed("aaa111", { rows_out: 3, plan_hash: "second" });
    expect((await readJournal("aaa111")).previewPlanHash).toBe("second");
    // scoped to this import only
    expect((await readJournal("bbb222")).previewed).toBe(false);
  });

  it("treats a legacy preview without a plan hash as requiring a fresh preview", async () => {
    await recordPreviewed("aaa111", { rows_out: 3 });
    expect(await readJournal("aaa111")).toMatchObject({ previewed: true, previewPlanHash: null });
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

  it("retries a definite rejection but makes a new ambiguous retry unconfirmed", async () => {
    await recordIntent("aaa111", [3]);
    await recordRejected("aaa111", [{ row: 3, error: "Validation failed" }]);
    let journal = await readJournal("aaa111");
    expect([...journal.rejected]).toEqual([3]);
    expect([...unconfirmedRows(journal)]).toEqual([]);

    // A later retry supersedes the old rejection. Until that new attempt gets a
    // terminal outcome, it is ambiguous and must not be sent a third time.
    await recordIntent("aaa111", [3]);
    journal = await readJournal("aaa111");
    expect([...journal.rejected]).toEqual([]);
    expect([...unconfirmedRows(journal)]).toEqual([3]);

    await recordRejected("aaa111", [{ row: 3, error: "Still invalid" }]);
    expect([...(await readJournal("aaa111")).rejected]).toEqual([3]);
  });

  it("records successful and rejected rows from one batch as terminal outcomes", async () => {
    await recordIntent("aaa111", [2, 3]);
    await recordBatchOutcomes("aaa111", {
      posted: [{ row: 2, purchase_id: "20" }],
      rejected: [{ row: 3, error: "Invalid account" }],
    });
    const journal = await readJournal("aaa111");
    expect([...journal.posted]).toEqual([2]);
    expect([...journal.rejected]).toEqual([3]);
    expect([...unconfirmedRows(journal)]).toEqual([]);
  });

  it("keeps a confirmed posting terminal even if a legacy concurrent intent was appended later", async () => {
    await recordIntent("aaa111", [7]);
    await recordPosted("aaa111", [{ row: 7, purchase_id: "77" }]);
    await recordIntent("aaa111", [7]);
    const journal = await readJournal("aaa111");
    expect([...journal.posted]).toEqual([7]);
    expect([...unconfirmedRows(journal)]).toEqual([]);
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

  it("fails closed with path and line guidance when a nonblank journal line is invalid JSON", async () => {
    await recordPreviewed("aaa111", { rows_out: 1, plan_hash: "reviewed-plan" });
    await recordPosted("aaa111", [{ row: 1, purchase_id: "1" }]);
    const file = path.join(dir, "imports-journal.jsonl");
    await appendFile(file, "{ this is not json\n");
    await expect(readJournal("aaa111")).rejects.toThrow(
      new RegExp(`Malformed durable CSV import journal at ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}, line 3.*reconcile`, "s")
    );
  });

  it("fails closed when a parseable intent record is structurally corrupt", async () => {
    const file = path.join(dir, "imports-journal.jsonl");
    await writeFile(file, [
      JSON.stringify({ kind: "previewed", import_id: "aaa111", plan_hash: "reviewed-plan" }),
      JSON.stringify({ kind: "intent", import_id: "aaa111", rows: "2" }),
      "",
    ].join("\n"));
    await expect(readJournal("aaa111")).rejects.toThrow(/line 2.*intent record has invalid rows.*reconcile/s);
  });

  it("fails closed when a rejected outcome is structurally corrupt", async () => {
    const file = path.join(dir, "imports-journal.jsonl");
    await writeFile(file, JSON.stringify({ kind: "rejected", import_id: "aaa111", row: "2" }) + "\n");
    await expect(readJournal("aaa111")).rejects.toThrow(/line 1.*rejected record has an invalid row.*reconcile/s);
  });

  it("serializes the same import with a path-safe owner lock", async () => {
    let releaseFirst;
    const firstCanLeave = new Promise((resolve) => { releaseFirst = resolve; });
    let firstEntered;
    const firstDidEnter = new Promise((resolve) => { firstEntered = resolve; });
    let secondObservedWaiting;
    const secondDidWait = new Promise((resolve) => { secondObservedWaiting = resolve; });
    const entered = [];

    const first = withImportLock("../same-import", async () => {
      entered.push("first");
      firstEntered();
      await firstCanLeave;
    });
    await firstDidEnter;

    const second = withImportLock("../same-import", async () => {
      entered.push("second");
    }, {
      wait: async () => {
        secondObservedWaiting();
        await new Promise((resolve) => setTimeout(resolve, 1));
      },
    });
    await secondDidWait;
    expect(entered).toEqual(["first"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(entered).toEqual(["first", "second"]);
    const lockPath = csvTest.importLockPath("../same-import");
    expect(path.dirname(lockPath)).toBe(dir);
    expect(path.basename(lockPath)).toMatch(/^\.csv-import-[0-9a-f]{64}\.lock$/);
  });

  it("serializes shared journal access across different import IDs", async () => {
    let releaseFirst;
    const firstCanLeave = new Promise((resolve) => { releaseFirst = resolve; });
    let firstEntered;
    const firstDidEnter = new Promise((resolve) => { firstEntered = resolve; });
    let secondObservedWaiting;
    const secondDidWait = new Promise((resolve) => { secondObservedWaiting = resolve; });
    const entered = [];

    const first = csvTest.withJournalLock(async () => {
      entered.push("import-a");
      firstEntered();
      await firstCanLeave;
    });
    await firstDidEnter;

    const second = csvTest.withJournalLock(async () => {
      entered.push("import-b");
    }, {
      wait: async () => {
        secondObservedWaiting();
        await new Promise((resolve) => setTimeout(resolve, 1));
      },
    });
    await secondDidWait;
    expect(entered).toEqual(["import-a"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(entered).toEqual(["import-a", "import-b"]);
    expect(csvTest.journalLockPath()).toBe(path.join(dir, ".csv-import-journal.lock"));
  });

  it("keeps concurrent records for different imports as complete JSONL lines", async () => {
    const imports = Array.from({ length: 12 }, (_, index) => ({
      id: `import-${index}`,
      row: index + 1,
    }));
    await Promise.all(imports.map(({ id, row }) => recordIntent(id, [row])));

    const file = path.join(dir, "imports-journal.jsonl");
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(imports.length);
    expect(lines.map((line) => JSON.parse(line).import_id).sort()).toEqual(
      imports.map(({ id }) => id).sort()
    );
    for (const { id, row } of imports) {
      expect([...unconfirmedRows(await readJournal(id))]).toEqual([row]);
    }
  }, 15_000);

  it("fails closed on journal read errors other than a missing file", async () => {
    const file = path.join(dir, "imports-journal.jsonl");
    await mkdir(file);
    await expect(readJournal("aaa111")).rejects.toThrow(
      new RegExp(`Could not read the durable CSV import journal at ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*Restore access`, "s")
    );
  });

  it("fsyncs an append before flushing the journal directory and newly-created parents", async () => {
    const nested = path.join(dir, "new", "deep");
    process.env.QBO_AUDIT_DIR = nested;
    const events = [];
    const makeDirectory = vi.fn(async () => path.join(dir, "new"));
    const openFile = vi.fn(async (target, flags) => {
      events.push(`open:${target}:${flags}`);
      if (flags === "a") {
        return {
          writeFile: async (contents) => events.push(`write:${Buffer.isBuffer(contents)}`),
          sync: async () => events.push("sync:file"),
          close: async () => events.push("close:file"),
        };
      }
      return {
        sync: async () => events.push(`sync:dir:${target}`),
        close: async () => events.push(`close:dir:${target}`),
      };
    });

    await csvTest.appendJournal(
      [{ kind: "intent", import_id: "aaa111", rows: [2] }],
      { openFile, makeDirectory, platform: "linux" }
    );

    expect(makeDirectory).toHaveBeenCalledWith(nested, { recursive: true, mode: 0o700 });
    expect(events).toEqual([
      `open:${path.join(nested, "imports-journal.jsonl")}:a`,
      "write:true",
      "sync:file",
      "close:file",
      `open:${nested}:r`,
      `sync:dir:${nested}`,
      `close:dir:${nested}`,
      `open:${path.join(dir, "new")}:r`,
      `sync:dir:${path.join(dir, "new")}`,
      `close:dir:${path.join(dir, "new")}`,
      `open:${dir}:r`,
      `sync:dir:${dir}`,
      `close:dir:${dir}`,
    ]);
  });

  it.each([
    ["intent", () => recordIntent("aaa111", [2]), /batch was NOT sent/],
    ["outcome", () => recordPosted("aaa111", [{ row: 2, purchase_id: "10" }]), /may already contain these rows/],
    ["rejection", () => recordRejected("aaa111", [{ row: 2, error: "bad row" }]), /automatic retry will remain blocked/],
  ])("fails closed when the durable %s append cannot be created", async (_kind, operation, message) => {
    const blocker = path.join(dir, "not-a-directory");
    await writeFile(blocker, "x");
    process.env.QBO_AUDIT_DIR = path.join(blocker, "nested");
    await expect(operation()).rejects.toThrow(message);
  });

  it("propagates an fsync failure instead of reporting a durable append", async () => {
    const fileHandle = {
      writeFile: vi.fn(async () => {}),
      sync: vi.fn(async () => { throw new Error("disk flush failed"); }),
      close: vi.fn(async () => {}),
    };
    await expect(csvTest.appendJournal(
      [{ kind: "intent", import_id: "aaa111", rows: [2] }],
      {
        makeDirectory: vi.fn(async () => undefined),
        openFile: vi.fn(async () => fileHandle),
        platform: "linux",
      }
    )).rejects.toThrow(/disk flush failed/);
    expect(fileHandle.close).toHaveBeenCalledOnce();
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
