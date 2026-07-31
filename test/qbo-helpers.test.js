import { describe, it, expect } from "vitest";
import { deriveSlugFromRealm, sanitizeSlug } from "../src/qbo.js";
import { compactList } from "../src/compact.js";

describe("sanitizeSlug", () => {
  it("strips everything outside [a-zA-Z0-9_-]", () => {
    expect(sanitizeSlug("../../etc/passwd")).toBe("etcpasswd");
    expect(sanitizeSlug("acme-2 ")).toBe("acme-2");
    expect(sanitizeSlug(null)).toBe("");
  });
});

describe("deriveSlugFromRealm", () => {
  it("uses the last four digits and extends on collision", () => {
    expect(deriveSlugFromRealm("9999999999123456")).toBe("3456");
    expect(deriveSlugFromRealm("9999999999123456", new Set(["3456"]))).toBe("23456");
  });
  it("falls back sensibly for degenerate realm ids", () => {
    expect(deriveSlugFromRealm("12")).toBe("12");
  });
});

describe("compactList", () => {
  const invoice = {
    Id: "145", DocNumber: "1042", TxnDate: "2026-07-01", DueDate: "2026-07-31",
    CustomerRef: { value: "3", name: "Acme" }, TotalAmt: 500, Balance: 100,
    EmailStatus: "NotSet", SyncToken: "4", MetaData: { CreateTime: "x" }, Line: [{}],
  };
  it("trims known entities to action-relevant fields", () => {
    const [row] = compactList("Invoice", [invoice]);
    expect(row).toEqual({
      Id: "145", DocNumber: "1042", TxnDate: "2026-07-01", DueDate: "2026-07-31",
      Customer: "Acme", TotalAmt: 500, Balance: 100, EmailStatus: "NotSet",
    });
  });
  it("returns raw rows when verbose or unknown entity", () => {
    expect(compactList("Invoice", [invoice], true)[0]).toBe(invoice);
    expect(compactList("Widget", [invoice])[0]).toBe(invoice);
  });
});
