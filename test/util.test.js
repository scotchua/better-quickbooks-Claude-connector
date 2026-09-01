import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import { isDestructiveOperation, isRealCalendarDate, validateRawQboPath } from "../src/util.js";

// This predicate is what holds the api_request escape hatch to the same rules
// as the named delete_/void_ tools. A shape it fails to recognize is a delete
// that slips past QBO_DISABLE_DELETES and past the amount/date policy.
describe("isDestructiveOperation", () => {
  it("recognizes every destructive shape QBO accepts", () => {
    expect(isDestructiveOperation("/invoice?operation=delete")).toBe(true);
    expect(isDestructiveOperation("/invoice?operation=void")).toBe(true);
    // the payment-void form, which is an update with an include flag
    expect(isDestructiveOperation("/payment?operation=update&include=void")).toBe(true);
    expect(isDestructiveOperation("/salesreceipt?minorversion=75&operation=delete")).toBe(true);
    expect(isDestructiveOperation("/invoice?OPERATION=DELETE")).toBe(true);
    expect(isDestructiveOperation("/invoice?operation=%64elete")).toBe(true);
    expect(isDestructiveOperation("/payment?operation=update&include=%76oid")).toBe(true);
  });
  it("leaves ordinary writes and reads alone", () => {
    expect(isDestructiveOperation("/invoice")).toBe(false);
    expect(isDestructiveOperation("/query?query=SELECT * FROM Bill")).toBe(false);
    expect(isDestructiveOperation("/reports/GeneralLedger?start_date=2026-01-01")).toBe(false);
    expect(isDestructiveOperation("/payment?operation=update")).toBe(false);
    // a customer whose name merely contains the word
    expect(isDestructiveOperation("/query?query=SELECT * FROM Customer WHERE Name = 'Void Ltd'")).toBe(false);
    expect(isDestructiveOperation(undefined)).toBe(false);
  });
});

describe("validateRawQboPath", () => {
  it("accepts ordinary company-relative paths without rewriting the query", () => {
    expect(validateRawQboPath("query?query=SELECT%20*%20FROM%20Bill")).toBe("/query?query=SELECT%20*%20FROM%20Bill");
  });
  it.each([
    ["/invoice#hidden", /fragments/],
    ["/invoice%23hidden", /fragments/],
    ["//evil.example/invoice", /relative/],
    ["/../invoice", /traversal/],
    ["/invoice?requestid=chosen", /reserved/],
    ["/invoice?%72equestid=chosen", /reserved/],
    ["/invoice?minorversion=1", /reserved/],
    ["/invoice?%6dinorversion=1", /reserved/],
  ])("refuses unsafe raw path %s", (value, pattern) => {
    expect(() => validateRawQboPath(value)).toThrow(pattern);
  });
});
import { esc, assertId, normalizeName, assertBalanced, guessContentType, expandHome } from "../src/util.js";

describe("esc", () => {
  it("escapes single quotes", () => {
    expect(esc("O'Brien")).toBe("O\\'Brien");
  });
  it("escapes backslashes before quotes (no string-literal breakout)", () => {
    expect(esc("evil\\")).toBe("evil\\\\");
    expect(esc("a\\'b")).toBe("a\\\\\\'b");
  });
  it("passes plain strings through", () => {
    expect(esc("Acme LLC")).toBe("Acme LLC");
  });
});

describe("assertId", () => {
  it("accepts numeric ids and trims", () => {
    expect(assertId(" 145 ")).toBe("145");
    expect(assertId(9007)).toBe("9007");
  });
  it("rejects path traversal and non-numeric ids", () => {
    expect(() => assertId("123/../456")).toThrow(/numeric/);
    expect(() => assertId("abc", "invoice_id")).toThrow(/invoice_id/);
    expect(() => assertId("")).toThrow();
  });
});

describe("normalizeName", () => {
  it("casefolds and collapses whitespace", () => {
    expect(normalizeName("  ACME   Llc ")).toBe("acme llc");
  });
  it("keeps punctuation (conservative matching)", () => {
    expect(normalizeName("Acme, LLC")).toBe("acme, llc");
  });
});

describe("assertBalanced", () => {
  const line = (amount, posting_type) => ({ amount, posting_type });
  it("accepts balanced entries", () => {
    expect(assertBalanced([line(500, "Debit"), line(500, "Credit")])).toEqual({ debit: 500, credit: 500 });
  });
  it("tolerates sub-half-cent float noise", () => {
    expect(() => assertBalanced([line(0.1, "Debit"), line(0.2, "Debit"), line(0.3, "Credit")])).not.toThrow();
  });
  it("rejects unbalanced entries", () => {
    expect(() => assertBalanced([line(500, "Debit"), line(499.98, "Credit")])).toThrow(/not balanced/);
  });
});

describe("guessContentType", () => {
  it("maps known extensions and defaults to octet-stream", () => {
    expect(guessContentType("receipt.PDF")).toBe("application/pdf");
    expect(guessContentType("weird.zzz")).toBe("application/octet-stream");
  });
});

describe("expandHome", () => {
  it("expands a bare tilde using the platform home directory", () => {
    expect(expandHome("~")).toBe(os.homedir());
  });
  it("normalizes POSIX and Windows separators after a leading tilde", () => {
    const expected = path.join(os.homedir(), "statements", "june.csv");
    expect(expandHome("~/statements/june.csv")).toBe(expected);
    expect(expandHome("~\\statements\\june.csv")).toBe(expected);
  });
  it("leaves paths without a standalone leading tilde alone", () => {
    const absolute = path.resolve("tmp", "x.csv");
    expect(expandHome(absolute)).toBe(absolute);
    expect(expandHome("~another-user/x.csv")).toBe("~another-user/x.csv");
  });
});

// A YYYY-MM-DD shape check accepts dates that do not exist. QuickBooks then
// either 400s opaquely or coerces them, and a coerced date silently lands a
// transaction in the wrong period.
describe("isRealCalendarDate", () => {
  it("accepts real dates including leap days", () => {
    expect(isRealCalendarDate("2026-08-05")).toBe(true);
    expect(isRealCalendarDate("2024-02-29")).toBe(true); // leap year
    expect(isRealCalendarDate("2026-12-31")).toBe(true);
  });
  it("rejects dates that pass a regex but do not exist", () => {
    expect(isRealCalendarDate("2026-02-31")).toBe(false);
    expect(isRealCalendarDate("2025-02-29")).toBe(false); // not a leap year
    expect(isRealCalendarDate("2026-04-31")).toBe(false);
    expect(isRealCalendarDate("2026-13-01")).toBe(false);
    expect(isRealCalendarDate("2026-00-10")).toBe(false);
    expect(isRealCalendarDate("2026-01-00")).toBe(false);
  });
  it("rejects anything not in YYYY-MM-DD form", () => {
    expect(isRealCalendarDate("8/5/2026")).toBe(false);
    expect(isRealCalendarDate("2026-8-5")).toBe(false);
    expect(isRealCalendarDate("")).toBe(false);
    expect(isRealCalendarDate(null)).toBe(false);
  });
});
