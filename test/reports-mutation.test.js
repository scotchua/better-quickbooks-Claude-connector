import { describe, it, expect } from "vitest";
import { flattenReport, consolidateReports, glFlatten, flagGlRows } from "../src/reports.js";

describe("flattenReport mutation coverage", () => {
  it("keeps a section summary when the section has no child Rows", () => {
    const report = {
      Rows: { Row: [{
        type: "Section",
        Header: { ColData: [{ value: "Invented Sales" }] },
        Summary: { ColData: [{ value: "Total Invented Sales" }, { value: "42.00" }] },
      }] },
    };
    expect(flattenReport(report).rows).toEqual([
      { section: "", is_summary: true, values: ["Total Invented Sales", "42.00"] },
    ]);
  });

  it("preserves entity ids on summary cells", () => {
    const report = {
      Rows: { Row: [{
        type: "Section",
        Summary: { ColData: [{ value: "Total Imaginary Fees" }, { value: "25.00", id: "summary-7" }] },
      }] },
    };
    expect(flattenReport(report).rows[0].ids).toEqual([null, "summary-7"]);
  });
});

describe("consolidateReports mutation coverage", () => {
  it("keeps detail and summary rows with the same name separate", () => {
    const flat = { rows: [
      { section: "Invented Income", is_summary: false, values: ["Imaginary Sales", "10.00"] },
      { section: "Invented Income", is_summary: true, values: ["Imaginary Sales", "20.00"] },
    ] };
    const rows = consolidateReports([{ company: "Fictional Finch", flat }]).rows;
    expect(rows.map((row) => [row.is_summary, row.combined_total])).toEqual([[false, 10], [true, 20]]);
  });

  it("skips nameless rows", () => {
    const flat = { rows: [{ section: "Invented Expenses", is_summary: false, values: ["", "8.00"] }] };
    expect(consolidateReports([{ company: "Fictional Finch", flat }]).rows).toEqual([]);
  });

  it("rounds the combined amount to cents", () => {
    const row = (amount) => ({ section: "Invented Income", is_summary: false, values: ["Imaginary Sales", amount] });
    const out = consolidateReports([
      { company: "Fictional Finch", flat: { rows: [row("1.234")] } },
      { company: "Madeup Maple", flat: { rows: [row("2.345")] } },
    ]);
    expect(out.rows[0].combined_total).toBe(3.58);
  });
});

describe("glFlatten mutation coverage", () => {
  it("maps transaction number, name, and description columns", () => {
    const flat = {
      columns: ["Date", "Amount", "Num", "Name", "Description"],
      rows: [{ section: "Invented Checking", is_summary: false, values: ["2026-10-07", "17.00", "INV-7", "Fictional Vendor", "Imaginary supplies"] }],
    };
    expect(glFlatten(flat)[0]).toMatchObject({ num: "INV-7", name: "Fictional Vendor", memo: "Imaginary supplies" });
  });

  it("maps a Memo column when Description is absent", () => {
    const flat = {
      columns: ["Date", "Amount", "Memo"],
      rows: [{ section: "Invented Checking", is_summary: false, values: ["2026-10-07", "17.00", "Imaginary invoice"] }],
    };
    expect(glFlatten(flat)[0].memo).toBe("Imaginary invoice");
  });

  it("skips rows without a date or amount", () => {
    const flat = {
      columns: ["Date", "Amount", "Name"],
      rows: [{ section: "Invented Checking", is_summary: false, values: ["", "", "Decorative heading"] }],
    };
    expect(glFlatten(flat)).toEqual([]);
  });
});

describe("flagGlRows mutation coverage", () => {
  it("uses inclusive round and large thresholds", () => {
    const rows = flagGlRows([{ amount: 1000 }, { amount: 10000 }]);
    expect(rows[0].flags).toEqual(["round_amount"]);
    expect(rows[1].flags).toEqual(["round_amount", "large"]);
  });

  it("does not flag a small round amount or 9999 as large", () => {
    const rows = flagGlRows([{ amount: 100 }, { amount: 9999 }]);
    expect(rows[0].flags).toBeUndefined();
    expect(rows[1].flags).toBeUndefined();
  });
});
