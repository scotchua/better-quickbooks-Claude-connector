// Paste-cleaning helpers for the playground import flow: people paste labels,
// quotes, and whitespace along with the values.
import { describe, expect, it } from "vitest";
import { cleanRealmId, cleanRefreshToken, PLAYGROUND_REDIRECT } from "../src/connect-playground.js";

describe("cleanRealmId", () => {
  it("accepts a bare realm id", () => {
    expect(cleanRealmId("9341455197052068")).toBe("9341455197052068");
  });
  it("extracts the id from a pasted label", () => {
    expect(cleanRealmId("Realm ID: 1373639405")).toBe("1373639405");
    expect(cleanRealmId('  "1424791380"  ')).toBe("1424791380");
  });
  it("rejects pastes with no plausible id", () => {
    expect(cleanRealmId("acme")).toBeNull();
    expect(cleanRealmId("123")).toBeNull();
    expect(cleanRealmId("")).toBeNull();
  });
});

describe("cleanRefreshToken", () => {
  const token = "AB11759481864JGoZgvxGaGGpZitCFqIgGjWlB0KVvYSuHYNCz";
  it("accepts a bare token", () => {
    expect(cleanRefreshToken(token)).toBe(token);
  });
  it("strips quotes, whitespace, and a pasted label", () => {
    expect(cleanRefreshToken(`  "${token}" `)).toBe(token);
    expect(cleanRefreshToken(`Refresh Token: ${token}`)).toBe(token);
  });
  it("rejects things that are not tokens", () => {
    expect(cleanRefreshToken("short")).toBeNull();
    expect(cleanRefreshToken("has spaces inside the middle of it which tokens never do")).toBeNull();
    expect(cleanRefreshToken("")).toBeNull();
  });
});

describe("PLAYGROUND_REDIRECT", () => {
  it("is the documented Intuit playground redirect URL", () => {
    expect(PLAYGROUND_REDIRECT).toBe("https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl");
  });
});
