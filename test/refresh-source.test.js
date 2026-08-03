// chooseRefreshSource: which refresh token a refresh actually exchanges.
//
// The import path (force) must exchange the SUPPLIED token. Without that, a
// re-authorization of an already-connected company silently reports success
// for a paste nobody checked, and stores nothing new.
import { describe, expect, it } from "vitest";
import { chooseRefreshSource } from "../src/qbo.js";

const NOW = 1_800_000_000_000;
const fresh = { access_token: "on-disk-access", refresh_token: "on-disk-refresh", expires_at: NOW + 3_600_000 };
const stale = { access_token: "on-disk-access", refresh_token: "on-disk-refresh", expires_at: NOW - 1 };
const supplied = { refresh_token: "pasted-refresh" }; // playground import: no access token

describe("chooseRefreshSource, normal path", () => {
  it("uses a fresher on-disk access token instead of refreshing", () => {
    expect(chooseRefreshSource(fresh, { access_token: "mine", refresh_token: "r" }, false, NOW).use)
      .toBe("on-disk-fresh");
  });

  it("prefers the on-disk refresh token when the access token is stale", () => {
    // Intuit invalidates the previous refresh token on every rotation, so the
    // newest one on disk wins over whatever the caller was holding.
    expect(chooseRefreshSource(stale, { access_token: "mine", refresh_token: "older" }, false, NOW).use)
      .toBe("on-disk");
  });

  it("falls back to the caller's token when nothing usable is on disk", () => {
    expect(chooseRefreshSource(null, supplied, false, NOW).use).toBe("existing");
    expect(chooseRefreshSource({ realmId: "1" }, supplied, false, NOW).use).toBe("existing");
  });
});

describe("chooseRefreshSource, import path (force)", () => {
  it("exchanges the supplied token even when a fresh one sits on disk", () => {
    // The pre-fix bug: this returned on-disk-fresh, so the paste was never
    // checked and a wrong token looked like a successful import.
    expect(chooseRefreshSource(fresh, supplied, true, NOW).use).toBe("existing");
  });

  it("exchanges the supplied token even when a stale on-disk token exists", () => {
    // The other half of the bug: this used the on-disk refresh token, so the
    // import validated the OLD credential rather than the pasted one.
    expect(chooseRefreshSource(stale, supplied, true, NOW).use).toBe("existing");
  });

  it("still works with no token file at all (the first-time import)", () => {
    expect(chooseRefreshSource(null, supplied, true, NOW).use).toBe("existing");
  });
});
