import { afterEach, describe, it, expect, vi } from "vitest";
import { deriveSlugFromRealm, sanitizeSlug, assertSlug, getCompanyInfoWithTokens } from "../src/qbo.js";
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

// sanitizeSlug is lenient because it guards a filename and must never throw.
// assertSlug is the boundary version: silently rewriting "northwind!" to
// "northwind" would let a typo resolve to a real company's books.
describe("assertSlug", () => {
  it("accepts slugs that survive sanitizing unchanged", () => {
    expect(assertSlug("northwind-supply")).toBe("northwind-supply");
    expect(assertSlug("mhpe_2026")).toBe("mhpe_2026");
    expect(assertSlug("  arrow  ")).toBe("arrow"); // surrounding space is not a typo
  });

  it("refuses anything that would be silently rewritten", () => {
    expect(() => assertSlug("northwind!")).toThrow(/not a valid company slug/);
    expect(() => assertSlug("northwind supply")).toThrow(/not a valid company slug/);
    expect(() => assertSlug("../escape")).toThrow(/not a valid company slug/);
    expect(() => assertSlug("arrow/../northwind")).toThrow(/not a valid company slug/);
  });

  it("suggests the sanitized form when there is one", () => {
    expect(() => assertSlug("northwind!")).toThrow(/Did you mean "northwind"/);
  });

  it("still refuses input that sanitizes to nothing", () => {
    expect(() => assertSlug("!!!")).toThrow(/not a valid company slug/);
  });
});

describe("fresh authorization verification", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads CompanyInfo with the fresh token before any on-disk selector is involved", async () => {
    const fetchMock = vi.fn(async (_url, init) => new Response(JSON.stringify({
      CompanyInfo: { CompanyName: "Verified Books", LegalName: "Verified Books LLC" },
    }), { status: 200, headers: { intuit_tid: "tid-verify" } }));
    vi.stubGlobal("fetch", fetchMock);
    const info = await getCompanyInfoWithTokens({
      access_token: "fresh-secret-token",
      realmId: "123456789",
      environment: "sandbox",
    });
    expect(info.CompanyName).toBe("Verified Books");
    expect(String(fetchMock.mock.calls[0][0])).toContain("/v3/company/123456789/companyinfo/123456789");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer fresh-secret-token");
  });

  it("fails without persisting when the fresh realm cannot be verified", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      Fault: { Error: [{ Message: "AuthenticationFailed" }] },
    }), { status: 401 })));
    await expect(getCompanyInfoWithTokens({
      access_token: "do-not-print-me",
      realmId: "987654321",
      environment: "production",
    })).rejects.toThrow(/No canonical authorization was saved/);
  });
});
