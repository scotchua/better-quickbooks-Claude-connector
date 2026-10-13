import { describe, expect, it, vi } from "vitest";
import { qboQuery } from "../src/qbo.js";

vi.mock("../src/entities.js", () => ({
  resolveRef: vi.fn(async (type, name) => ({ value: `${type}-${name}`, name })),
  findByName: vi.fn(async (_type, name) => name === "Missing Person" ? null : { Id: `Entity-${name}` }),
  findAnyServiceItem: vi.fn(async () => ({ Id: "Service-17", Name: "Harbor Mapping" })),
  notFoundError: vi.fn((type, name) => new Error(`${type} not found: ${name}`)),
  suggestNames: vi.fn(async () => []),
}));

vi.mock("../src/qbo.js", () => ({
  qboQuery: vi.fn(async () => ({ TaxCode: [{ Id: "Tax-21", Name: "Harbor Exempt" }] })),
}));

const {
  buildJournalLines, buildSalesLines, buildAccountLines, buildItemExpenseLines,
  buildDepositLines, departmentRef,
} = await import(process.env.SWEEP_LINES_MODULE || "../src/lines.js");

const company = "harbor-ledger-test";

describe("departmentRef", () => {
  it("resolves a department by name", async () => {
    expect(await departmentRef("East Pier", company)).toEqual({ value: "Department-East Pier", name: "East Pier" });
  });
});

describe("buildJournalLines", () => {
  const balanced = [
    { account: "Harbor Cash", amount: 41, posting_type: "Debit" },
    { account: "Harbor Revenue", amount: 41, posting_type: "Credit" },
  ];

  it("requires two balanced lines", async () => {
    await expect(buildJournalLines(balanced.slice(0, 1), company)).rejects.toThrow(/at least two lines/);
    await expect(buildJournalLines([{ ...balanced[0], amount: 42 }, balanced[1]], company)).rejects.toThrow();
    expect(await buildJournalLines(balanced, company)).toHaveLength(2);
  });

  it("resolves account, entity, class and location on a line", async () => {
    const lines = await buildJournalLines([
      { ...balanced[0], entity_name: "Mira Quill", entity_type: "Customer", class: "Dockwork", location: "East Pier", description: "October charting" },
      balanced[1],
    ], company);
    expect(lines[0]).toEqual({
      Amount: 41,
      DetailType: "JournalEntryLineDetail",
      Description: "October charting",
      JournalEntryLineDetail: {
        PostingType: "Debit",
        AccountRef: { value: "Account-Harbor Cash", name: "Harbor Cash" },
        Entity: { Type: "Customer", EntityRef: { value: "Entity-Mira Quill" } },
        ClassRef: { value: "Class-Dockwork", name: "Dockwork" },
        DepartmentRef: { value: "Department-East Pier", name: "East Pier" },
      },
    });
  });

  it("requires an entity type and rejects an unknown entity", async () => {
    await expect(buildJournalLines([{ ...balanced[0], entity_name: "Mira Quill" }, balanced[1]], company))
      .rejects.toThrow(/entity_type is required/);
    await expect(buildJournalLines([{ ...balanced[0], entity_name: "Missing Person", entity_type: "Customer" }, balanced[1]], company))
      .rejects.toThrow(/Customer not found/);
  });
});

describe("buildSalesLines", () => {
  it("rejects inconsistent quantity, price and amount at the cent boundary", async () => {
    await expect(buildSalesLines([{ amount: 10.01, quantity: 2, unit_price: 5 }], company))
      .rejects.toThrow(/does not foot/);
    await expect(buildSalesLines([{ amount: 10.0055, quantity: 2, unit_price: 5 }], company))
      .rejects.toThrow(/does not foot/);
    await expect(buildSalesLines([{ amount: 10, quantity: 2, unit_price: 5 }], company))
      .resolves.toHaveLength(1);
  });

  it("allows an amount without quantity or unit price", async () => {
    expect((await buildSalesLines([{ amount: 19, item: "Pilot Charts" }], company))[0].SalesItemLineDetail)
      .toEqual({ ItemRef: { value: "Item-Pilot Charts", name: "Pilot Charts" } });
    expect((await buildSalesLines([{ amount: 19, item: "Pilot Charts", unit_price: 5 }], company))[0].Amount)
      .toBe(19);
    expect((await buildSalesLines([{ amount: 19, item: "Pilot Charts", quantity: null, unit_price: 5 }], company))[0].Amount)
      .toBe(19);
  });

  it("uses a service item when none is named", async () => {
    expect((await buildSalesLines([{ amount: 19 }], company))[0].SalesItemLineDetail.ItemRef)
      .toEqual({ value: "Service-17", name: "Harbor Mapping" });
  });

  it("carries quantity, price, class and description", async () => {
    expect((await buildSalesLines([{
      amount: 18, item: "Pilot Charts", quantity: 3, unit_price: 6,
      class: "Dockwork", description: "October survey",
    }], company))[0]).toEqual({
      Amount: 18,
      DetailType: "SalesItemLineDetail",
      Description: "October survey",
      SalesItemLineDetail: {
        ItemRef: { value: "Item-Pilot Charts", name: "Pilot Charts" },
        Qty: 3,
        UnitPrice: 6,
        ClassRef: { value: "Class-Dockwork", name: "Dockwork" },
      },
    });
  });

  it("uses literal and named tax codes and rejects missing codes", async () => {
    expect((await buildSalesLines([{ amount: 19, tax_code: " tax " }], company))[0].SalesItemLineDetail.TaxCodeRef)
      .toEqual({ value: "TAX" });
    expect((await buildSalesLines([{ amount: 19, tax_code: "42" }], company))[0].SalesItemLineDetail.TaxCodeRef)
      .toEqual({ value: "42" });
    expect((await buildSalesLines([{ amount: 19, tax_code: "Harbor Exempt" }], company))[0].SalesItemLineDetail.TaxCodeRef)
      .toEqual({ value: "Tax-21", name: "Harbor Exempt" });
    vi.mocked(qboQuery).mockResolvedValueOnce({});
    await expect(buildSalesLines([{ amount: 19, tax_code: "Unknown Harbor Code" }], company))
      .rejects.toThrow(/TaxCode not found/);
  });
});

describe("buildAccountLines", () => {
  it("builds account expense details with class and description", async () => {
    expect(await buildAccountLines([{ account: "Pier Rent", amount: 29, class: "Dockwork", description: "October rent" }], company))
      .toEqual([{
        Amount: 29,
        DetailType: "AccountBasedExpenseLineDetail",
        Description: "October rent",
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: "Account-Pier Rent", name: "Pier Rent" },
          ClassRef: { value: "Class-Dockwork", name: "Dockwork" },
        },
      }]);
  });
});

describe("buildItemExpenseLines", () => {
  it("rejects a line whose item arithmetic does not foot", async () => {
    await expect(buildItemExpenseLines([{ item: "Chart Paper", amount: 15, quantity: 2, unit_price: 7 }], company))
      .rejects.toThrow(/does not foot/);
  });

  it("builds item expense details with quantity, price and class", async () => {
    expect(await buildItemExpenseLines([{
      item: "Chart Paper", amount: 14, quantity: 2, unit_price: 7,
      class: "Dockwork", description: "October stock",
    }], company)).toEqual([{
      Amount: 14,
      DetailType: "ItemBasedExpenseLineDetail",
      Description: "October stock",
      ItemBasedExpenseLineDetail: {
        ItemRef: { value: "Item-Chart Paper", name: "Chart Paper" },
        Qty: 2,
        UnitPrice: 7,
        ClassRef: { value: "Class-Dockwork", name: "Dockwork" },
      },
    }]);
  });
});

describe("buildDepositLines", () => {
  it("requires an entity type when an entity is named", async () => {
    await expect(buildDepositLines([{ account: "Harbor Receipts", amount: 31, entity_name: "Mira Quill" }], company))
      .rejects.toThrow(/entity_type is required/);
  });

  it("builds a deposit with account, entity, class and description", async () => {
    expect(await buildDepositLines([{
      account: "Harbor Receipts", amount: 31, entity_name: "Mira Quill", entity_type: "Customer",
      class: "Dockwork", description: "October deposit",
    }], company)).toEqual([{
      Amount: 31,
      DetailType: "DepositLineDetail",
      Description: "October deposit",
      DepositLineDetail: {
        AccountRef: { value: "Account-Harbor Receipts", name: "Harbor Receipts" },
        Entity: { value: "Customer-Mira Quill", name: "Mira Quill" },
        ClassRef: { value: "Class-Dockwork", name: "Dockwork" },
      },
    }]);
  });
});
