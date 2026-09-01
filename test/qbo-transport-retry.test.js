import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { qboRequest, saveTokens, __test } from "../src/qbo.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SLUG = "transport-retry-test";
const TOKEN_FILE = path.join(ROOT, `tokens.${SLUG}.json`);
const REFRESH_LOCK = path.join(ROOT, `.refresh-${SLUG}.lock`);
let auditDir;

const jsonResponse = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", ...headers },
});

beforeEach(async () => {
  auditDir = await mkdtemp(path.join(tmpdir(), "qbo-transport-retry-"));
  vi.stubEnv("QBO_TOKEN_ENCRYPTION", "off");
  vi.stubEnv("QBO_AUDIT", "off");
  vi.stubEnv("QBO_AUDIT_DIR", auditDir);
  vi.stubEnv("QBO_POLICY_FILE", path.join(auditDir, "no-policy.json"));
  await saveTokens(SLUG, {
    access_token: "fresh-access",
    refresh_token: "fresh-refresh",
    expires_at: Date.now() + 3_600_000,
    refresh_expires_at: Date.now() + 86_400_000,
    realmId: "920000000000001",
    environment: "sandbox",
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all([
    rm(TOKEN_FILE, { force: true }),
    rm(REFRESH_LOCK, { force: true, recursive: true }),
    auditDir ? rm(auditDir, { recursive: true, force: true }) : Promise.resolve(),
  ]);
});

describe("QBO transport retry boundaries", () => {
  it("does not send when an absolute replay deadline has already elapsed", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(__test.qboFetch("https://example.invalid/write", { method: "POST" }, {
      idempotent: true,
      retryDeadlineMs: 999,
      now: () => 1_000,
    })).rejects.toThrow(/replay deadline elapsed.*No request was sent after that deadline/is);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not start another attempt when a backoff overshoots the absolute deadline", async () => {
    let clock = 1_000;
    const fetchMock = vi.fn(async () => jsonResponse({ error: "ambiguous" }, 503));
    const wait = vi.fn(async () => { clock = 3_001; });
    vi.stubGlobal("fetch", fetchMock);

    const response = await __test.qboFetch("https://example.invalid/write", { method: "POST" }, {
      idempotent: true,
      retryDeadlineMs: 3_000,
      now: () => clock,
      wait,
    });
    expect(response.status).toBe(503);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not wait when Retry-After exceeds the absolute deadline", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(
      { Fault: { Error: [{ Message: "throttled" }] } },
      429,
      { "retry-after": "1" }
    ));
    const wait = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await __test.qboFetch("https://example.invalid/write", { method: "POST" }, {
      idempotent: true,
      retryDeadlineMs: 1_025,
      now: () => 1_000,
      wait,
    });

    expect(response.status).toBe(429);
    expect(wait).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("honors Retry-After for a rejected GET and then succeeds", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: "throttled" }, 429, { "retry-after": "0.001" }))
      .mockResolvedValueOnce(jsonResponse({ QueryResponse: { Invoice: [] } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(qboRequest("/query?query=select%20*%20from%20Invoice", { company: SLUG }))
      .resolves.toMatchObject({ QueryResponse: { Invoice: [] } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries an idempotent GET after a 5xx response", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: "temporary" }, 503))
      .mockResolvedValueOnce(jsonResponse({ CompanyInfo: { CompanyName: "Recovered" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(qboRequest("/companyinfo/920000000000001", { company: SLUG }))
      .resolves.toMatchObject({ CompanyInfo: { CompanyName: "Recovered" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("bounds a chunked JSON response before parsing it", async () => {
    vi.stubEnv("QBO_RESPONSE_MAX_BYTES", "16");
    const bounded = await import("../src/qbo.js?response-size-bounded");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ QueryResponse: { Invoice: [{ Id: "123" }] } }),
      { headers: { "content-type": "application/json" } }
    )));

    await expect(bounded.qboRequest("/query?query=select%20*%20from%20Invoice", { company: SLUG }))
      .rejects.toThrow(/QBO JSON response exceeded the 16-byte cap.*QBO_RESPONSE_MAX_BYTES/is);
  });

  it("bounds parsed QBO fault detail before returning an error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      Fault: { Error: [{ Message: "bad request", Detail: "x".repeat(20_000) }] },
    }, 400)));

    const error = await qboRequest("/query?query=select%20*%20from%20Invoice", { company: SLUG })
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("bad request");
    expect(error.message.length).toBeLessThan(3_000);
  });

  it("keeps one requestid when opted-in write retry recovers from a timeout", async () => {
    vi.stubEnv("QBO_RETRY_WRITES", "true");
    const retryEnabled = await import("../src/qbo.js?retry-writes-enabled");
    const urls = [];
    const fetchMock = vi.fn(async (url) => {
      urls.push(String(url));
      if (urls.length === 1) {
        const error = new Error("simulated timeout");
        error.name = "TimeoutError";
        throw error;
      }
      return jsonResponse({ Invoice: { Id: "1" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(retryEnabled.qboRequest("/invoice", {
      method: "POST",
      company: SLUG,
      body: { TxnDate: "2026-08-31", CustomerRef: { value: "1" }, Line: [] },
    })).resolves.toMatchObject({ Invoice: { Id: "1" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(urls[0]).toBe(urls[1]);
    const requestIds = urls.map((url) => new URL(url).searchParams.get("requestid"));
    expect(requestIds[0]).toMatch(/^[0-9a-f-]{36}$/i);
    expect(requestIds[1]).toBe(requestIds[0]);
  });

  it("does not automatically resend a throttled write when write retries are off", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ Fault: { Error: [{ Message: "throttled" }] } }, 429, { "retry-after": "1" }))
      .mockResolvedValueOnce(jsonResponse({ Invoice: { Id: "unexpected-second-write" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(qboRequest("/invoice", {
      method: "POST",
      company: SLUG,
      body: { TxnDate: "2026-08-31", CustomerRef: { value: "1" }, Line: [] },
    })).rejects.toThrow(/QBO API 429.*throttled/is);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not wait past the replay deadline for a throttled opted-in write", async () => {
    vi.stubEnv("QBO_RETRY_WRITES", "true");
    vi.stubEnv("QBO_RECOVERY_REPLAY_MAX_AGE_MS", "25");
    const bounded = await import("../src/qbo.js?throttle-window-bounded");
    const fetchMock = vi.fn(async () => jsonResponse(
      { Fault: { Error: [{ Message: "throttled" }] } },
      429,
      { "retry-after": "1" }
    ));
    vi.stubGlobal("fetch", fetchMock);

    await expect(bounded.qboRequest("/invoice", {
      method: "POST",
      company: SLUG,
      body: { TxnDate: "2026-08-31", CustomerRef: { value: "1" }, Line: [] },
    })).rejects.toThrow(/QBO API 429.*throttled/is);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("bounds the entire opted-in write attempt sequence by the replay-age ceiling", async () => {
    vi.stubEnv("QBO_RETRY_WRITES", "true");
    vi.stubEnv("QBO_TIMEOUT_MS", "60000");
    vi.stubEnv("QBO_RECOVERY_REPLAY_MAX_AGE_MS", "100");
    const bounded = await import("../src/qbo.js?retry-window-bounded");
    const fetchMock = vi.fn((_url, init) => new Promise((resolve, reject) => {
      const fail = () => reject(init.signal.reason || Object.assign(new Error("aborted"), { name: "TimeoutError" }));
      if (init.signal.aborted) fail();
      else init.signal.addEventListener("abort", fail, { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);

    const error = await bounded.qboRequest("/invoice", {
      method: "POST",
      company: SLUG,
      body: { TxnDate: "2026-08-31", CustomerRef: { value: "1" }, Line: [] },
    }).then(() => null, (caught) => caught);

    expect(error?.message).toMatch(/timed out after [0-9.]+s.*may or may not have been applied/is);
    const timeoutSeconds = Number(/timed out after ([0-9.]+)s/i.exec(error.message)?.[1]);
    expect(timeoutSeconds).toBeGreaterThan(0);
    expect(timeoutSeconds).toBeLessThanOrEqual(0.1);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves an omitted TxnDate when no date-floor policy is active", async () => {
    let sentBody;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      sentBody = JSON.parse(init.body);
      return jsonResponse({ Invoice: { Id: "2" } });
    }));

    await expect(qboRequest("/invoice", {
      method: "POST",
      company: SLUG,
      body: { CustomerRef: { value: "1" }, Line: [] },
    })).resolves.toMatchObject({ Invoice: { Id: "2" } });
    expect(sentBody).not.toHaveProperty("TxnDate");
  });
});
