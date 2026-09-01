import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decryptTokens } from "../src/secure-store.js";
import { getValidTokens, refreshTokens, saveTokens } from "../src/qbo.js";

const execFileP = promisify(execFile);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SLUG = "refresh-ambiguity-test";
const TOKEN_FILE = path.join(ROOT, `tokens.${SLUG}.json`);
const LOCK_FILE = path.join(ROOT, `.refresh-${SLUG}.lock`);
const RECOVERY_FILE = path.join(ROOT, `.qbo-refresh-recovery-${SLUG}.json`);
const KEY = "73".repeat(32);

function expiredTokens(overrides = {}) {
  return {
    access_token: "expired-access",
    refresh_token: "possibly-consumed-refresh",
    expires_at: Date.now() - 60_000,
    refresh_expires_at: Date.now() + 86_400_000,
    realmId: "910000000000001",
    environment: "sandbox",
    ...overrides,
  };
}

async function cleanup() {
  await Promise.all([TOKEN_FILE, LOCK_FILE, RECOVERY_FILE].map((file) => rm(file, { force: true, recursive: true })));
}

beforeEach(async () => {
  await cleanup();
  vi.stubEnv("QBO_CLIENT_ID", "test-client");
  vi.stubEnv("QBO_CLIENT_SECRET", "test-secret");
  vi.stubEnv("QBO_TOKEN_KEY", KEY);
  vi.stubEnv("QBO_TOKEN_ENCRYPTION", "on");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await cleanup();
});

describe("ambiguous refresh outcomes", () => {
  it("never replays the POST and durably quarantines later calls and processes", async () => {
    const original = expiredTokens();
    await saveTokens(SLUG, original);
    const fetchMock = vi.fn(async () => { throw new TypeError("socket closed after upload"); });
    vi.stubGlobal("fetch", fetchMock);

    await expect(refreshTokens(SLUG, original)).rejects.toThrow(/ambiguous outcome.*not replayed.*quarantined/is);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const envelope = JSON.parse(await readFile(TOKEN_FILE, "utf8"));
    expect(envelope.refresh_outcome_unknown_at).toBeUndefined();
    const quarantined = await decryptTokens(envelope);
    expect(quarantined.refresh_outcome_unknown_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(quarantined.refresh_token).toBe(original.refresh_token);

    await expect(refreshTokens(SLUG, original)).rejects.toThrow(/refresh is quarantined/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A separate Node process must make the same refusal from durable state,
    // before it gets any chance to contact Intuit.
    const script = `
      globalThis.fetch = async () => { throw new Error("FETCH_SHOULD_NOT_RUN"); };
      const { getValidTokens } = await import(${JSON.stringify(new URL("../src/qbo.js", import.meta.url).href)});
      try { await getValidTokens(${JSON.stringify(SLUG)}); }
      catch (error) { process.stdout.write(error.message); }
    `;
    const child = await execFileP(process.execPath, ["--input-type=module", "-e", script], {
      cwd: ROOT,
      env: {
        ...process.env,
        QBO_CLIENT_ID: "test-client",
        QBO_CLIENT_SECRET: "test-secret",
        QBO_TOKEN_KEY: KEY,
        QBO_TOKEN_ENCRYPTION: "on",
      },
    });
    expect(child.stdout).toMatch(/refresh is quarantined/i);
    expect(child.stdout).not.toContain("FETCH_SHOULD_NOT_RUN");
  });

  it("adopts an independently persisted fresh successor without replaying the POST", async () => {
    const original = expiredTokens();
    const successor = expiredTokens({
      access_token: "independent-fresh-access",
      refresh_token: "independent-latest-refresh",
      expires_at: Date.now() + 3_600_000,
    });
    await saveTokens(SLUG, original);
    const fetchMock = vi.fn(async () => {
      // Deliberately bypass the public authorization commit lock to model a
      // separate legacy writer that finished while this response was lost.
      await saveTokens(SLUG, successor);
      throw new TypeError("response lost");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(refreshTokens(SLUG, original)).resolves.toMatchObject({
      access_token: successor.access_token,
      refresh_token: successor.refresh_token,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const persisted = await decryptTokens(JSON.parse(await readFile(TOKEN_FILE, "utf8")));
    expect(persisted.refresh_token).toBe(successor.refresh_token);
    expect(persisted.refresh_outcome_unknown_at).toBeUndefined();
  });

  it("does not auto-retry the refresh endpoint even when it returns 429", async () => {
    const original = expiredTokens();
    await saveTokens(SLUG, original);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "temporarily throttled" }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "0.001" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(refreshTokens(SLUG, original)).rejects.toThrow(/Token refresh failed.*temporarily throttled/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const persisted = await decryptTokens(JSON.parse(await readFile(TOKEN_FILE, "utf8")));
    expect(persisted.refresh_outcome_unknown_at).toBeUndefined();
  });

  it.each([
    ["a readable 503", () => new Response(JSON.stringify({ error: "upstream failure" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    })],
    ["an unreadable 503 body", () => ({
      status: 503,
      ok: false,
      headers: new Headers(),
      text: async () => { throw new TypeError("response stream reset"); },
    })],
    ["an HTTP 408", () => new Response(JSON.stringify({ error: "request timeout" }), {
      status: 408,
      headers: { "content-type": "application/json" },
    })],
  ])("quarantines %s and prevents every later refresh attempt", async (_label, response) => {
    const original = expiredTokens();
    await saveTokens(SLUG, original);
    const fetchMock = vi.fn(async () => response());
    vi.stubGlobal("fetch", fetchMock);

    await expect(refreshTokens(SLUG, original)).rejects.toThrow(/ambiguous outcome.*not replayed.*quarantined/is);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const persisted = await decryptTokens(JSON.parse(await readFile(TOKEN_FILE, "utf8")));
    expect(persisted.refresh_outcome_unknown_at).toBeTruthy();
    await expect(refreshTokens(SLUG, original)).rejects.toThrow(/refresh is quarantined/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
