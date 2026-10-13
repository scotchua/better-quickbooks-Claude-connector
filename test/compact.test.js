import { describe, it, expect } from "vitest";
import { compactList } from "../src/compact.js";

describe("compactList entity shapes", () => {
  const entity = {
    Id: "42", DocNumber: "DOC-42", TxnDate: "2026-05-04", DueDate: "2026-06-04",
    ExpirationDate: "2026-06-18", StartDate: "2026-01-01", EndDate: "2026-12-31",
    CustomerRef: { value: "C-7", name: "Cedar Lantern Studio" },
    VendorRef: { value: "V-8", name: "Willow Parts" },
    IncomeAccountRef: { value: "A-9", name: "Harbor Sales" },
    TotalAmt: 248.75, Balance: 49.25, UnappliedAmt: 12.5,
    EmailStatus: "NotSet", TxnStatus: "Pending", PayType: "Check",
    DisplayName: "Cedar Lantern Studio", CompanyName: "Cedar Lantern Studio LLC",
    PrimaryEmailAddr: { Address: "billing@cedar-lantern.example" },
    PrimaryPhone: { FreeFormNumber: "555-0102" },
    Active: true, Vendor1099: false, Name: "Harbor Sales", Type: "Service",
    UnitPrice: 37.5, AcctNum: "4100", AccountType: "Income",
    AccountSubType: "SalesOfProductIncome", CurrentBalance: 871.25,
    DueDays: 30, DiscountPercent: 2, Description: "Local sales tax",
    BudgetType: "ProfitAndLoss", InternalNote: "keep out of compact rows",
  };

  const cases = [
    ["Estimate", { Id: "42", DocNumber: "DOC-42", TxnDate: "2026-05-04", ExpirationDate: "2026-06-18", Customer: "Cedar Lantern Studio", TotalAmt: 248.75, TxnStatus: "Pending" }],
    ["Bill", { Id: "42", DocNumber: "DOC-42", TxnDate: "2026-05-04", DueDate: "2026-06-04", Vendor: "Willow Parts", TotalAmt: 248.75, Balance: 49.25 }],
    ["BillPayment", { Id: "42", DocNumber: "DOC-42", TxnDate: "2026-05-04", Vendor: "Willow Parts", TotalAmt: 248.75, PayType: "Check" }],
    ["Payment", { Id: "42", TxnDate: "2026-05-04", Customer: "Cedar Lantern Studio", TotalAmt: 248.75, UnappliedAmt: 12.5 }],
    ["Customer", { Id: "42", DisplayName: "Cedar Lantern Studio", CompanyName: "Cedar Lantern Studio LLC", Email: "billing@cedar-lantern.example", Phone: "555-0102", Balance: 49.25, Active: true }],
    ["Vendor", { Id: "42", DisplayName: "Cedar Lantern Studio", CompanyName: "Cedar Lantern Studio LLC", Email: "billing@cedar-lantern.example", Phone: "555-0102", Balance: 49.25, Active: true, Vendor1099: false }],
    ["Item", { Id: "42", Name: "Harbor Sales", Type: "Service", UnitPrice: 37.5, IncomeAccount: "Harbor Sales", Active: true }],
    ["Account", { Id: "42", Name: "Harbor Sales", AcctNum: "4100", AccountType: "Income", AccountSubType: "SalesOfProductIncome", CurrentBalance: 871.25, Active: true }],
    ["Term", { Id: "42", Name: "Harbor Sales", Type: "Service", DueDays: 30, DiscountPercent: 2, Active: true }],
    ["PaymentMethod", { Id: "42", Name: "Harbor Sales", Type: "Service", Active: true }],
    ["TaxCode", { Id: "42", Name: "Harbor Sales", Description: "Local sales tax", Active: true }],
    ["Budget", { Id: "42", Name: "Harbor Sales", StartDate: "2026-01-01", EndDate: "2026-12-31", BudgetType: "ProfitAndLoss", Active: true }],
  ];

  for (const [name, expected] of cases) {
    it(`keeps the ${name} fields and drops unrelated data`, () => {
      expect(compactList(name, [entity])).toEqual([expected]);
    });
  }

  it("preserves reference fallback and nullish values", () => {
    expect(compactList("Invoice", [{ CustomerRef: { value: "C-7" } }])[0].Customer).toBe("C-7");
    expect(compactList("Invoice", [{ CustomerRef: { name: "", value: "C-7" } }])[0].Customer).toBe("");
    expect(compactList("Invoice", [{ CustomerRef: null }])[0].Customer).toBe(null);
  });
});
