import { describe, it, expect } from "vitest";
import { parseCSV, parseAmount, normalizeDate, planImport, importId, rowMarker } from "../src/csv.js";

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
});
