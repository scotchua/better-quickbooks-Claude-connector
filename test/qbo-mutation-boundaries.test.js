import { afterEach, describe, expect, it, vi } from "vitest";
import { __test, chooseRefreshSource, configureQboRuntime, credentials, getCompanyInfoWithTokens } from "../src/qbo.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  configureQboRuntime(process.env);
});

describe("configuredTimeoutMs", () => {
  it("rejects a zero timeout", () => {
    expect(() => configureQboRuntime({ QBO_TIMEOUT_MS: "0" })).toThrow(/QBO_TIMEOUT_MS/);
  });
});

describe("configuredResponseMaxBytes", () => {
  it("rejects a zero response cap", () => {
    expect(() => configureQboRuntime({ QBO_RESPONSE_MAX_BYTES: "0" })).toThrow(/QBO_RESPONSE_MAX_BYTES/);
  });
});

describe("qboFetch", () => {
  it("rejects a zero replay deadline before sending", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(__test.qboFetch("https://example.invalid", {}, { retryDeadlineMs: 0 }))
      .rejects.toThrow(/retry deadline/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not retry when backoff exactly reaches the deadline", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetchMock = vi.fn(async () => new Response("", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const wait = vi.fn(async () => {});

    const response = await __test.qboFetch("https://example.invalid", {}, {
      idempotent: true,
      retryDeadlineMs: 2_000,
      now: () => 1_000,
      wait,
    });

    expect(response.status).toBe(503);
    expect(wait).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses backoff for a zero Retry-After header", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const wait = vi.fn(async () => {});

    await __test.qboFetch("https://example.invalid", {}, { wait });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledOnce();
    expect(wait.mock.calls[0][0]).toBeGreaterThanOrEqual(1_000);
  });
});

describe("credentials", () => {
  it("uses production keys when both environments have keys", () => {
    vi.stubEnv("QBO_CLIENT_ID", "invented-production-id");
    vi.stubEnv("QBO_CLIENT_SECRET", "invented-production-secret");
    vi.stubEnv("QBO_CLIENT_ID_SANDBOX", "invented-sandbox-id");
    vi.stubEnv("QBO_CLIENT_SECRET_SANDBOX", "invented-sandbox-secret");

    expect(credentials("production")).toMatchObject({
      clientId: "invented-production-id",
      clientSecret: "invented-production-secret",
    });
  });
});

describe("getCompanyInfoWithTokens", () => {
  it("rejects a successful response without CompanyInfo", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));

    await expect(getCompanyInfoWithTokens({
      access_token: "invented-token",
      realmId: "123456789",
      environment: "sandbox",
    })).rejects.toThrow(/No canonical authorization was saved/);
  });
});

describe("chooseRefreshSource", () => {
  it("refreshes at exactly the one-minute safety margin", () => {
    const choice = chooseRefreshSource(
      { access_token: "new", refresh_token: "new-refresh", expires_at: 1_060_000 },
      { access_token: "old", refresh_token: "old-refresh" },
      false,
      1_000_000
    );
    expect(choice.use).toBe("on-disk");
  });
});
