import { describe, it, expect } from "vitest";
import { planInvoiceAllocations, planBillPaymentApplication } from "../src/allocate.js";

const invoice = (Id, Balance, extra = {}) => ({
  Id, Balance, TotalAmt: Balance, DocNumber: `INV-${Id}`,
  CustomerRef: { value: "1", name: "Amy's Bird Sanctuary" }, ...extra,
});

describe("planInvoiceAllocations", () => {
  const invoices = [invoice("145", 100), invoice("146", 200), invoice("147", 300)];

  it("splits a payment across invoices, closing the ones paid in full", () => {
    const out = planInvoiceAllocations({
      allocations: [
        { invoice_id: "145", amount: 100 },
        { invoice_id: "146", amount: 200 },
        { invoice_id: "147", amount: 150 },
      ],
      invoices, total: 450, customerId: "1",
    });
    expect(out.total_allocated).toBe(450);
    expect(out.invoices_closed).toBe(2);
    expect(out.plan[2]).toMatchObject({ invoice_id: "147", applying: 150, balance_after: 150, closes_invoice: false });
    expect(out.lines).toEqual([
      { Amount: 100, LinkedTxn: [{ TxnId: "145", TxnType: "Invoice" }] },
      { Amount: 200, LinkedTxn: [{ TxnId: "146", TxnType: "Invoice" }] },
      { Amount: 150, LinkedTxn: [{ TxnId: "147", TxnType: "Invoice" }] },
    ]);
  });

  it("refuses an allocation that leaves part of the payment unapplied", () => {
    expect(() => planInvoiceAllocations({
      allocations: [{ invoice_id: "145", amount: 100 }],
      invoices, total: 450, customerId: "1",
    })).toThrow(/leaving 350.00 unapplied/);
  });

  it("refuses allocating more than the payment", () => {
    expect(() => planInvoiceAllocations({
      allocations: [{ invoice_id: "146", amount: 200 }],
      invoices, total: 150, customerId: "1",
    })).toThrow(/50.00 more than the payment/);
  });

  it("refuses more than an invoice's open balance", () => {
    expect(() => planInvoiceAllocations({
      allocations: [{ invoice_id: "145", amount: 500 }],
      invoices, total: 500, customerId: "1",
    })).toThrow(/exceeds its open balance of 100.00/);
  });

  it("refuses another customer's invoice, which QBO would happily accept", () => {
    const foreign = invoice("999", 50, { CustomerRef: { value: "2", name: "Bill's Windsurf Shop" } });
    expect(() => planInvoiceAllocations({
      allocations: [{ invoice_id: "999", amount: 50 }],
      invoices: [foreign], total: 50, customerId: "1",
    })).toThrow(/belongs to Bill's Windsurf Shop/);
  });

  it("refuses the same invoice listed twice", () => {
    expect(() => planInvoiceAllocations({
      allocations: [{ invoice_id: "145", amount: 50 }, { invoice_id: "145", amount: 50 }],
      invoices, total: 100, customerId: "1",
    })).toThrow(/listed twice/);
  });

  it("reports every problem at once instead of one per round trip", () => {
    let message = "";
    try {
      planInvoiceAllocations({
        allocations: [{ invoice_id: "145", amount: 500 }, { invoice_id: "nope", amount: 10 }],
        invoices, total: 510, customerId: "1",
      });
    } catch (e) { message = e.message; }
    expect(message).toMatch(/refused for 2 reasons/);
    expect(message).toMatch(/exceeds its open balance/);
    expect(message).toMatch(/No invoice with Id nope/);
  });

  it("allows a cent of rounding slack", () => {
    expect(() => planInvoiceAllocations({
      allocations: [{ invoice_id: "145", amount: 100 }],
      invoices, total: 100.004, customerId: "1",
    })).not.toThrow();
  });
});

describe("planBillPaymentApplication", () => {
  const bill = (Id, Balance) => ({ Id, Balance, TotalAmt: Balance, DocNumber: `BILL-${Id}` });
  const credit = (Id, Balance) => ({ Id, Balance, TotalAmt: Balance });

  it("settles a bill with cash plus a credit, sending only the cash as the total", () => {
    const out = planBillPaymentApplication({
      bills: [bill("149", 500)], credits: [credit("150", 200)], amount: 300,
    });
    expect(out.cash_paid).toBe(300);
    expect(out.credits_applied).toBe(200);
    expect(out.total_settled).toBe(500);
    expect(out.bills[0]).toMatchObject({ applying: 500, balance_after: 0, closes_bill: true });
    // Positive amounts on both: QBO stores the credit line positive whatever sign it is sent.
    expect(out.lines).toEqual([
      { Amount: 500, LinkedTxn: [{ TxnId: "149", TxnType: "Bill" }] },
      { Amount: 200, LinkedTxn: [{ TxnId: "150", TxnType: "VendorCredit" }] },
    ]);
  });

  it("still refuses an overpayment once credits are counted", () => {
    expect(() => planBillPaymentApplication({
      bills: [bill("149", 500)], credits: [credit("150", 200)], amount: 400,
    })).toThrow(/exceeds the listed bills' open balances by 100.00/);
  });

  it("allows a partial payment", () => {
    const out = planBillPaymentApplication({ bills: [bill("149", 500)], credits: [], amount: 200 });
    expect(out.bills[0]).toMatchObject({ applying: 200, balance_after: 300, closes_bill: false });
  });

  it("spreads across bills in order, capped at each open balance", () => {
    const out = planBillPaymentApplication({
      bills: [bill("1", 100), bill("2", 100)], credits: [], amount: 150,
    });
    expect(out.bills.map((b) => b.applying)).toEqual([100, 50]);
  });

  it("rejects a credit with nothing left on it", () => {
    expect(() => planBillPaymentApplication({
      bills: [bill("149", 500)], credits: [credit("150", 0)], amount: 100,
    })).toThrow(/no open balance left/);
  });

  it("keeps the old cash-only behaviour unchanged", () => {
    const out = planBillPaymentApplication({ bills: [bill("149", 500)], credits: [], amount: 500 });
    expect(out.credits_applied).toBe(0);
    expect(out.lines).toHaveLength(1);
  });
});
