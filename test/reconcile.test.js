import { describe, it, expect } from "vitest";
import { matchTransactions, findDuplicateGroups, bankRegisterFromGl, bankTieOut } from "../src/reconcile.js";
import { flattenReport, glFlatten } from "../src/reports.js";

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

// Shaped after a real account-filtered GeneralLedger response: eight columns,
// an opening row whose date cell holds a label and whose only number is the
// running balance, and the transaction id hanging off the Transaction Type cell.
const cell = (value, id) => (id === undefined ? { value } : { value, id });
const glRow = ({ date, type, id, num = "", name = "", memo = "", split = "", amount = "", balance = "" }) => ({
  ColData: [
    cell(date), cell(type, id), cell(num), cell(name), cell(memo), cell(split), cell(amount), cell(balance),
  ],
});
const bankGl = (rows) => ({
  Columns: { Column: [
    { ColTitle: "Date" }, { ColTitle: "Transaction Type" }, { ColTitle: "Num" }, { ColTitle: "Name" },
    { ColTitle: "Memo/Description" }, { ColTitle: "Split" }, { ColTitle: "Amount" }, { ColTitle: "Balance" },
  ] },
  Rows: { Row: [{
    type: "Section",
    Header: { ColData: [cell("First Bank", "172")] },
    Rows: { Row: rows },
  }] },
});
const register = (rows) => bankRegisterFromGl(glFlatten(flattenReport(bankGl(rows))));

const OPENING = glRow({ date: "Beginning Balance", type: "", balance: "1000.00" });

describe("bankRegisterFromGl", () => {
  it("pulls the opening balance out of the label row and keeps it out of the transactions", () => {
    const reg = register([OPENING, glRow({ date: "2026-07-02", type: "Deposit", id: "11", amount: "500.00", balance: "1500.00" })]);
    expect(reg.beginning_balance).toBe(1000);
    expect(reg.transactions).toHaveLength(1);
    expect(reg.transactions[0]).toMatchObject({ id: "11", type: "Deposit", amount: 500 });
  });

  it("covers every transaction type that hits the account, not just purchases and deposits", () => {
    const reg = register([
      OPENING,
      glRow({ date: "2026-07-02", type: "Deposit", id: "11", amount: "500.00", balance: "1500.00" }),
      glRow({ date: "2026-07-03", type: "Expense", id: "12", amount: "-200.00", balance: "1300.00" }),
      glRow({ date: "2026-07-05", type: "Transfer", id: "13", amount: "-100.00", balance: "1200.00" }),
      glRow({ date: "2026-07-06", type: "Bill Payment (Check)", id: "14", amount: "-50.00", balance: "1150.00" }),
      glRow({ date: "2026-07-07", type: "Journal Entry", id: "15", amount: "-25.00", balance: "1125.00" }),
    ]);
    expect(reg.transactions.map((t) => t.type)).toEqual([
      "Deposit", "Expense", "Transfer", "Bill Payment (Check)", "Journal Entry",
    ]);
    expect(reg.ending_balance).toBe(1125);
    expect(reg.net_activity).toBe(125);
  });

  it("reads a vendor refund as money in, which the Purchase-only scan got backwards", () => {
    const reg = register([
      OPENING,
      glRow({ date: "2026-07-04", type: "Expense", id: "21", memo: "vendor refund", amount: "75.00", balance: "1075.00" }),
    ]);
    expect(reg.transactions[0].amount).toBe(75); // positive: an inflow, despite being typed Expense
  });

  it("derives the closing balance from the opening balance when no running balance is returned", () => {
    const reg = register([
      glRow({ date: "Beginning Balance", type: "", balance: "1000.00" }),
      glRow({ date: "2026-07-02", type: "Deposit", id: "11", amount: "500.00" }),
    ]);
    expect(reg.ending_balance).toBe(1500);
  });

  it("survives an empty ledger", () => {
    const reg = register([]);
    expect(reg).toMatchObject({ beginning_balance: null, transactions: [], ending_balance: null });
  });
});

describe("bankTieOut", () => {
  // Books hold a deposit, a check and a transfer. The statement shows only the
  // first two, so the transfer is still outstanding at the cutoff.
  const reg = register([
    OPENING,
    glRow({ date: "2026-07-02", type: "Deposit", id: "11", amount: "500.00", balance: "1500.00" }),
    glRow({ date: "2026-07-03", type: "Expense", id: "12", amount: "-200.00", balance: "1300.00" }),
    glRow({ date: "2026-07-05", type: "Transfer", id: "13", amount: "-100.00", balance: "1200.00" }),
  ]);
  const registerIn = reg.transactions.filter((t) => t.amount > 0);
  const registerOut = reg.transactions.filter((t) => t.amount < 0).map((t) => ({ ...t, amount: Math.abs(t.amount) }));
  const outflows = matchTransactions([{ row: 2, date: "2026-07-03", amount: 200 }], registerOut);
  const inflows = matchTransactions([{ row: 3, date: "2026-07-02", amount: 500 }], registerIn);

  it("balances once outstanding items are bridged", () => {
    const tie = bankTieOut({ statementEndingBalance: 1300, glEndingBalance: reg.ending_balance, outflows, inflows });
    expect(tie.outstanding_items).toEqual({ count: 1, total: 100 });
    expect(tie.deposits_in_transit).toEqual({ count: 0, total: 0 });
    expect(tie.adjusted_bank_balance).toBe(1200);
    expect(tie.adjusted_book_balance).toBe(1200);
    expect(tie.difference).toBe(0);
    expect(tie.balanced).toBe(true);
  });

  it("reports the gap rather than hiding it when the statement disagrees", () => {
    const tie = bankTieOut({ statementEndingBalance: 1350, glEndingBalance: reg.ending_balance, outflows, inflows });
    expect(tie.difference).toBe(50);
    expect(tie.balanced).toBe(false);
  });

  it("nulls every balance when the statement closing balance is not supplied", () => {
    const tie = bankTieOut({ glEndingBalance: reg.ending_balance, outflows, inflows });
    expect(tie.adjusted_bank_balance).toBeNull();
    expect(tie.difference).toBeNull();
    expect(tie.balanced).toBeNull();
    expect(tie.outstanding_items).toEqual({ count: 1, total: 100 }); // the lists still work
  });

  it("counts unrecorded statement activity on the book side", () => {
    const out = matchTransactions([{ row: 9, date: "2026-07-20", amount: 40 }], []);
    const tie = bankTieOut({ statementEndingBalance: 1000, glEndingBalance: 1000, outflows: out, inflows: { matched: [], statement_only: [], register_only: [] } });
    expect(tie.unrecorded_payments).toEqual({ count: 1, total: 40 });
    expect(tie.adjusted_book_balance).toBe(960);
    expect(tie.difference).toBe(40);
  });
});
