import { describe, it, expect } from "vitest";
import { matchTransactions, findDuplicateGroups } from "../src/reconcile.js";

describe("matchTransactions", () => {
  const stmt = [
    { row: 2, date: "2026-07-01", amount: 50 },
    { row: 3, date: "2026-07-05", amount: 20 },
    { row: 4, date: "2026-07-09", amount: 75 },
  ];
  const reg = [
    { id: "a", date: "2026-07-02", amount: 50 },
    { id: "b", date: "2026-07-20", amount: 20 },
    { id: "c", date: "2026-07-10", amount: 99 },
  ];
  it("matches on amount within the date tolerance", () => {
    const out = matchTransactions(stmt, reg, { toleranceDays: 2 });
    expect(out.matched).toHaveLength(1);
    expect(out.matched[0]).toMatchObject({ statement: { row: 2 }, register: { id: "a" }, date_diff_days: 1 });
    expect(out.statement_only.map((s) => s.row)).toEqual([3, 4]);
    expect(out.register_only.map((r) => r.id)).toEqual(["b", "c"]);
  });
  it("consumes each register row at most once and prefers the closest date", () => {
    const out = matchTransactions(
      [{ date: "2026-07-03", amount: 10 }, { date: "2026-07-03", amount: 10 }],
      [{ id: "x", date: "2026-07-03", amount: 10 }, { id: "y", date: "2026-07-05", amount: 10 }]
    );
    expect(out.matched.map((m) => m.register.id)).toEqual(["x", "y"]);
    expect(out.statement_only).toHaveLength(0);
  });
  it("treats a cent of difference as a non-match", () => {
    const out = matchTransactions([{ date: "2026-07-01", amount: 10.0 }], [{ id: "z", date: "2026-07-01", amount: 10.02 }]);
    expect(out.matched).toHaveLength(0);
  });
});

describe("findDuplicateGroups", () => {
  it("clusters same party + amount within the date window", () => {
    const rows = [
      { id: "1", party: "Rent Co", amount: 1500, date: "2026-07-01" },
      { id: "2", party: "Rent Co", amount: 1500, date: "2026-07-02" },
      { id: "3", party: "Rent Co", amount: 1500, date: "2026-08-01" },
      { id: "4", party: "Cafe", amount: 4.5, date: "2026-07-02" },
    ];
    const groups = findDuplicateGroups(rows, { dateWindowDays: 3 });
    expect(groups).toHaveLength(1);
    expect(groups[0].map((r) => r.id)).toEqual(["1", "2"]);
  });
  it("returns nothing when amounts differ", () => {
    const groups = findDuplicateGroups([
      { id: "1", party: "A", amount: 100, date: "2026-07-01" },
      { id: "2", party: "A", amount: 100.5, date: "2026-07-01" },
    ]);
    expect(groups).toHaveLength(0);
  });
});
