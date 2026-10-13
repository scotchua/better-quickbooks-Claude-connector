import { describe, it, expect } from "vitest";
import { planInvoiceAllocations, planBillPaymentApplication } from "../src/allocate.js";

describe("planInvoiceAllocations", () => {
  it("rounds fractional cents before building an invoice allocation", () => {
    const out = planInvoiceAllocations({
      allocations: [{ invoice_id: "inv-orchid-1", amount: 10.001 }],
      invoices: [{ Id: "inv-orchid-1", Balance: 20, CustomerRef: { value: "orchid-studio" } }],
      total: 10.001, customerId: "orchid-studio",
    });
    expect(out.plan[0].applying).toBe(10);
    expect(out.total_allocated).toBe(10);
  });

  it("refuses a zero amount invoice allocation", () => {
    expect(() => planInvoiceAllocations({
      allocations: [{ invoice_id: "inv-cedar-1", amount: 0 }],
      invoices: [{ Id: "inv-cedar-1", Balance: 40, CustomerRef: { value: "cedar-workshop" } }],
      total: 0, customerId: "cedar-workshop",
    })).toThrow(/must be greater than zero/);
  });
});

describe("planBillPaymentApplication", () => {
  it("omits zero amount bill lines when no cash or credit is available", () => {
    const out = planBillPaymentApplication({
      bills: [{ Id: "bill-maple-1", Balance: 25 }], credits: [], amount: 0,
    });
    expect(out.bills).toEqual([]);
    expect(out.lines).toEqual([]);
  });
});
