import { describe, it, expect } from "vitest";
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
  it("expands a leading tilde", () => {
    expect(expandHome("~/x.csv")).toBe(`${process.env.HOME}/x.csv`);
  });
  it("leaves absolute paths alone", () => {
    expect(expandHome("/tmp/x.csv")).toBe("/tmp/x.csv");
  });
});
