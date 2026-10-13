import { describe, it, expect } from "vitest";
import { extractLinks, summarizeTxn, describeChain, READABLE_TXN_TYPES } from "../src/links.js";

// Shaped after the real sandbox responses captured on 2026-08-05.
const payment = {
  Id: "148", TxnDate: "2026-08-05", TotalAmt: 450, UnappliedAmt: 0,
  CustomerRef: { value: "1", name: "Amy's Bird Sanctuary" },
  Line: [
    { Amount: 100, LinkedTxn: [{ TxnId: "145", TxnType: "Invoice" }] },
    { Amount: 200, LinkedTxn: [{ TxnId: "146", TxnType: "Invoice" }] },
    { Amount: 150, LinkedTxn: [{ TxnId: "147", TxnType: "Invoice" }] },
  ],
};

// The other end of a link: a vendor credit consumed by a bill payment records
// the relationship with no amount on it.
const vendorCredit = {
  Id: "150", TxnDate: "2026-08-02", TotalAmt: 200, Balance: 0,
  VendorRef: { value: "30", name: "Books by Bessie" },
  LinkedTxn: [{ TxnId: "151", TxnType: "BillPayment" }],
  Line: [{ Amount: 200, DetailType: "AccountBasedExpenseLineDetail" }],
};

describe("extractLinks", () => {
  it("reads line-level links and keeps the amount applied to each", () => {
    expect(extractLinks(payment)).toEqual([
      { txn_type: "Invoice", txn_id: "145", amount_applied: 100, on_line: 1 },
      { txn_type: "Invoice", txn_id: "146", amount_applied: 200, on_line: 2 },
      { txn_type: "Invoice", txn_id: "147", amount_applied: 150, on_line: 3 },
    ]);
  });

  it("reads the reverse direction, where no amount is recorded", () => {
    const links = extractLinks(vendorCredit);
    expect(links).toEqual([{ txn_type: "BillPayment", txn_id: "151" }]);
    expect(links[0].amount_applied).toBeUndefined();
  });

  it("treats a link named both at the top level and on a line as one, keeping the amount", () => {
    const both = {
      LinkedTxn: [{ TxnId: "145", TxnType: "Invoice" }],
      Line: [{ Amount: 100, LinkedTxn: [{ TxnId: "145", TxnType: "Invoice" }] }],
    };
    const links = extractLinks(both);
    expect(links).toHaveLength(1);
    expect(links[0].amount_applied).toBe(100);
  });

  it("ignores malformed and absent links", () => {
    expect(extractLinks({})).toEqual([]);
    expect(extractLinks(null)).toEqual([]);
    expect(extractLinks({ LinkedTxn: [{ TxnType: "Invoice" }, { TxnId: "9" }] })).toEqual([]);
  });

  it("coerces numeric ids to strings so they compare cleanly", () => {
    expect(extractLinks({ LinkedTxn: [{ TxnId: 145, TxnType: "Invoice" }] })[0].txn_id).toBe("145");
  });

  it("keeps types separate and normalizes string and zero applied amounts", () => {
    const links = extractLinks({
      LinkedTxn: [
        { TxnId: "42", TxnType: "Invoice" },
        { TxnId: "42", TxnType: "CreditMemo" },
      ],
      Line: [
        { Amount: "12.50", LinkedTxn: [{ TxnId: "42", TxnType: "Invoice" }] },
        { Amount: 0, LinkedTxn: [{ TxnId: "42", TxnType: "CreditMemo" }] },
      ],
    });
    expect(links).toEqual([
      { txn_type: "Invoice", txn_id: "42", amount_applied: 12.5, on_line: 1 },
      { txn_type: "CreditMemo", txn_id: "42", amount_applied: 0, on_line: 2 },
    ]);
  });
});

describe("summarizeTxn", () => {
  it("gives mixed entity types one shape", () => {
    expect(summarizeTxn(payment)).toEqual({
      id: "148", date: "2026-08-05", doc_number: null, total: 450,
      balance: null, party: "Amy's Bird Sanctuary", memo: null,
    });
  });
  it("finds the party on a vendor document too", () => {
    expect(summarizeTxn(vendorCredit).party).toBe("Books by Bessie");
  });
  it("returns null for nothing", () => {
    expect(summarizeTxn(null)).toBeNull();
  });

  it("keeps populated document fields, zero totals, entity names, and notes", () => {
    expect(summarizeTxn({
      Id: "91", TxnDate: "2025-03-14", DocNumber: "R-9", TotalAmt: 0, Balance: 0,
      EntityRef: { name: "Copper Finch LLC" }, PrivateNote: "Quarterly test",
    })).toEqual({
      id: "91", date: "2025-03-14", doc_number: "R-9", total: 0,
      balance: 0, party: "Copper Finch LLC", memo: "Quarterly test",
    });
  });

  it("uses reference values when customer and vendor names are absent", () => {
    expect(summarizeTxn({ CustomerRef: { value: "customer-7" } }).party).toBe("customer-7");
    expect(summarizeTxn({ VendorRef: { value: "vendor-8" } }).party).toBe("vendor-8");
  });
});

describe("describeChain", () => {
  it("totals the applied amounts when this side records them", () => {
    const out = describeChain("Payment", summarizeTxn(payment), extractLinks(payment));
    expect(out).toBe("Payment 148 is linked to 3 Invoices. It applies 450.00.");
  });

  it("says where the amounts live when this side does not record them", () => {
    const out = describeChain("VendorCredit", summarizeTxn(vendorCredit), extractLinks(vendorCredit));
    expect(out).toContain("1 BillPayment");
    expect(out).toContain("recorded on the other side");
  });

  it("is explicit about an unlinked transaction", () => {
    expect(describeChain("Invoice", { id: "200" }, [])).toBe("Invoice 200 is not linked to any other transaction.");
  });

  it("describes mixed link types and only the available applied amounts", () => {
    const links = [
      { txn_type: "Invoice", amount_applied: 0 },
      { txn_type: "Bill", amount_applied: 12.5 },
      { txn_type: "Invoice" },
    ];
    expect(describeChain("Payment", { id: "91" }, links)).toBe(
      "Payment 91 is linked to 2 Invoices, 1 Bill. Of those, the amounts it applies total 12.50.",
    );
  });
});

describe("READABLE_TXN_TYPES", () => {
  it("covers the types the traversal tool accepts and excludes unqueryable ones", () => {
    for (const t of ["Invoice", "Bill", "BillPayment", "Payment", "VendorCredit", "CreditMemo"]) {
      expect(READABLE_TXN_TYPES.has(t)).toBe(true);
    }
    expect(READABLE_TXN_TYPES.has("ReimburseCharge")).toBe(false);
  });
});
