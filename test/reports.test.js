import { describe, it, expect } from "vitest";
import { flattenReport, toNumber, consolidateReports, glFlatten, flagGlRows, reportReceipt } from "../src/reports.js";

const pnl = (income, rentName, rentAmt) => ({
  Columns: { Column: [{ ColTitle: "", ColType: "Account" }, { ColTitle: "Total", ColType: "Money" }] },
  Rows: {
    Row: [
      {
        type: "Section",
        Header: { ColData: [{ value: "Income" }] },
        Rows: { Row: [{ ColData: [{ value: "Sales" }, { value: String(income) }] }] },
        Summary: { ColData: [{ value: "Total Income" }, { value: String(income) }] },
      },
      {
        type: "Section",
        Header: { ColData: [{ value: "Expenses" }] },
        Rows: { Row: [{ ColData: [{ value: rentName }, { value: String(rentAmt) }] }] },
        Summary: { ColData: [{ value: "Total Expenses" }, { value: String(rentAmt) }] },
      },
    ],
  },
});

describe("flattenReport", () => {
  it("walks nested sections and keeps section paths plus summaries", () => {
    const flat = flattenReport(pnl(1000, "Rent", 400));
    expect(flat.columns).toEqual(["Account", "Total"]);
    expect(flat.rows).toContainEqual({ section: "Income", is_summary: false, values: ["Sales", "1000"] });
    expect(flat.rows).toContainEqual({ section: "", is_summary: true, values: ["Total Income", "1000"] });
  });
  it("handles empty reports", () => {
    expect(flattenReport({}).rows).toEqual([]);
  });
  it("leaves rows without entity ids exactly as they were", () => {
    for (const r of flattenReport(pnl(1000, "Rent", 400)).rows) expect(r).not.toHaveProperty("ids");
  });
  it("keeps entity ids alongside the values when a row carries them", () => {
    const withIds = {
      Columns: { Column: [{ ColTitle: "Date" }, { ColTitle: "Transaction Type" }] },
      Rows: { Row: [{ ColData: [{ value: "2026-08-03" }, { value: "Deposit", id: "24862" }] }] },
    };
    expect(flattenReport(withIds).rows[0].ids).toEqual([null, "24862"]);
  });
});

describe("toNumber", () => {
  it("parses money strings and rejects text", () => {
    expect(toNumber("1,234.56")).toBe(1234.56);
    expect(toNumber("-4.50")).toBe(-4.5);
    expect(toNumber("")).toBeNull();
    expect(toNumber("n/a")).toBeNull();
  });
});

describe("consolidateReports", () => {
  it("merges rows by name across companies with a combined total", () => {
    const byCompany = [
      { company: "acme", flat: flattenReport(pnl(1000, "Rent", 400)) },
      { company: "bakery", flat: flattenReport(pnl(500, "Rent", 250)) },
    ];
    const out = consolidateReports(byCompany);
    expect(out.companies).toEqual(["acme", "bakery"]);
    const rent = out.rows.find((r) => r.name === "Rent");
    expect(rent.amounts).toEqual({ acme: 400, bakery: 250 });
    expect(rent.combined_total).toBe(650);
  });
  it("keeps rows missing from one company (partial amounts)", () => {
    const a = { company: "a", flat: flattenReport(pnl(100, "Rent", 50)) };
    const b = { company: "b", flat: flattenReport(pnl(200, "Software", 75)) };
    const out = consolidateReports([a, b]);
    const rent = out.rows.find((r) => r.name === "Rent");
    expect(rent.amounts).toEqual({ a: 50 });
    expect(rent.combined_total).toBe(50);
    expect(out.rows.find((r) => r.name === "Software").amounts).toEqual({ b: 75 });
  });
});

describe("glFlatten + flags", () => {
  const gl = {
    Columns: { Column: [
      { ColTitle: "Date" }, { ColTitle: "Transaction Type" }, { ColTitle: "Num" },
      { ColTitle: "Name" }, { ColTitle: "Memo/Description" }, { ColTitle: "Split" }, { ColTitle: "Amount" },
    ] },
    Rows: { Row: [{
      type: "Section",
      Header: { ColData: [{ value: "Checking" }] },
      Rows: { Row: [
        { ColData: [{ value: "2026-07-25" }, { value: "Journal Entry" }, { value: "12" }, { value: "" }, { value: "accrual" }, { value: "Rent" }, { value: "20000" }] },
        { ColData: [{ value: "2026-07-22" }, { value: "Expense" }, { value: "" }, { value: "Cafe" }, { value: "coffee" }, { value: "Meals" }, { value: "4.50" }] },
      ] },
      Summary: { ColData: [{ value: "Total for Checking" }, { value: "" }, { value: "" }, { value: "" }, { value: "" }, { value: "" }, { value: "20004.50" }] },
    }] },
  };
  it("maps report columns to flat rows by title", () => {
    const rows = glFlatten(flattenReport(gl));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ account: "Checking", date: "2026-07-25", type: "Journal Entry", amount: 20000, split: "Rent" });
  });
  it("flags weekend, large, round, and journal-entry rows", () => {
    const [je, coffee] = flagGlRows(glFlatten(flattenReport(gl)));
    expect(je.flags).toEqual(expect.arrayContaining(["weekend", "round_amount", "large", "journal_entry"]));
    expect(coffee.flags).toBeUndefined();
  });
  it("carries the transaction id and running balance through when the report has them", () => {
    const withIds = {
      Columns: { Column: [
        { ColTitle: "Date" }, { ColTitle: "Transaction Type" }, { ColTitle: "Amount" }, { ColTitle: "Balance" },
      ] },
      Rows: { Row: [{ ColData: [
        { value: "2026-08-03" }, { value: "Deposit", id: "24862" }, { value: "633.43" }, { value: "115740.11" },
      ] }] },
    };
    expect(glFlatten(flattenReport(withIds))[0]).toMatchObject({ id: "24862", amount: 633.43, balance: 115740.11 });
  });
  it("omits id and balance rather than emitting nulls when the report lacks them", () => {
    const row = glFlatten(flattenReport(gl))[0];
    expect(row).not.toHaveProperty("id");
    expect(row).not.toHaveProperty("balance");
  });
});

describe("reportReceipt", () => {
  const hdr = {
    Header: {
      ReportName: "ProfitAndLoss",
      StartPeriod: "2025-02-01",
      EndPeriod: "2026-07-31",
      ReportBasis: "Accrual",
      SummarizeColumnsBy: "Month",
    },
  };

  it("names the file, the size and enough of the header to confirm the window", () => {
    const out = reportReceipt(hdr, "/tmp/pl.json", 157900);
    expect(out).toContain("/tmp/pl.json");
    expect(out).toContain("157,900 bytes");
    expect(out).toContain("ProfitAndLoss");
    expect(out).toContain("2025-02-01 to 2026-07-31");
    expect(out).toContain("Accrual");
    expect(out).toContain("by Month");
  });

  it("degrades to just the file line when the report carries no header", () => {
    expect(reportReceipt({}, "/tmp/x.json", 12)).toBe("Saved 12 bytes to /tmp/x.json");
    expect(reportReceipt(null, "/tmp/x.json", 12)).toBe("Saved 12 bytes to /tmp/x.json");
  });

  it("omits header parts the report does not carry", () => {
    const out = reportReceipt({ Header: { ReportName: "AgedReceivables" } }, "/tmp/ar.json", 5);
    const [fileLine, descLine] = out.split("\n");
    expect(fileLine).toBe("Saved 5 bytes to /tmp/ar.json");
    expect(descLine).toBe("AgedReceivables");   // no empty period or basis fragments trailing it
    expect(out).not.toContain("undefined");
    expect(out).not.toContain("null");
  });
});
