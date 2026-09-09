import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decryptTokens, encryptTokens } from "../src/secure-store.js";
import { __test, disconnectCompany, getValidTokens, persistAuthorization, refreshTokens, saveTokens } from "../src/qbo.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SLUG = "refresh-recovery-test";
const OTHER_SLUG = "refresh-recovery-other";
const REALM = "910000000000772";
const TOKEN_FILE = path.join(process.env.QBO_TOKENS_DIR, `tokens.${SLUG}.json`);
const RECOVERY_FILE = path.join(process.env.QBO_TOKENS_DIR, `.qbo-refresh-recovery-${SLUG}.json`);
const DISCONNECT_FILE = path.join(process.env.QBO_TOKENS_DIR, `.qbo-disconnect-recovery-${SLUG}.json`);
const STAGE_FILE = path.join(process.env.QBO_TOKENS_DIR, `.qbo-token-stage-${SLUG}.json`);
const LOCK_FILE = path.join(process.env.QBO_TOKENS_DIR, `.refresh-${SLUG}.lock`);
const REALM_LOCK = path.join(
  process.env.QBO_TOKENS_DIR,
  `.realm-authorization-${createHash("sha256").update(REALM).digest("hex").slice(0, 32)}.lock`
);
const OTHER_TOKEN_FILE = path.join(process.env.QBO_TOKENS_DIR, `tokens.${OTHER_SLUG}.json`);
const OTHER_LOCK_FILE = path.join(process.env.QBO_TOKENS_DIR, `.refresh-${OTHER_SLUG}.lock`);
const KEY = "84".repeat(32);

function originalTokens() {
  return {
    access_token: "expired-access",
    refresh_token: "predecessor-refresh",
    expires_at: Date.now() - 60_000,
    refresh_expires_at: Date.now() + 86_400_000,
    realmId: REALM,
    environment: "sandbox",
  };
}

function successfulResponse() {
  return new Response(JSON.stringify({
    access_token: "confirmed-successor-access",
    refresh_token: "confirmed-successor-refresh",
    expires_in: 3600,
    x_refresh_token_expires_in: 7_776_000,
  }), { status: 200, headers: { "content-type": "application/json" } });
}

async function cleanup() {
  await Promise.all([
    TOKEN_FILE,
    RECOVERY_FILE,
    DISCONNECT_FILE,
    STAGE_FILE,
    LOCK_FILE,
    REALM_LOCK,
    OTHER_TOKEN_FILE,
    OTHER_LOCK_FILE,
  ].map((file) => rm(file, { force: true, recursive: true })));
}

async function writeEncryptedFixture(file, contents) {
  const payload = await encryptTokens(contents);
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
  await rename(tmp, file);
}

function childEnv() {
  return {
    ...process.env,
    QBO_CLIENT_ID: "test-client",
    QBO_CLIENT_SECRET: "test-secret",
    QBO_TOKEN_KEY: KEY,
    QBO_TOKEN_ENCRYPTION: "on",
  };
}

function spawnModule(script, envOverrides = {}) {
  return spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: ROOT,
    env: { ...childEnv(), ...envOverrides },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function collectChild(child) {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code, signal] = await once(child, "exit");
  return { stdout, stderr, code, signal };
}

async function waitForOutput(child, pattern, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${pattern}; saw ${output}`)), timeoutMs);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (pattern.test(output)) {
        clearTimeout(timer);
        resolve(output);
      }
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Child exited before ${pattern} (code ${code}, signal ${signal}); saw ${output}`));
    });
  });
}

async function recoverInFreshProcess() {
  const script = `
    globalThis.fetch = async () => { throw new Error("FETCH_SHOULD_NOT_RUN"); };
    const { getValidTokens } = await import(${JSON.stringify(new URL("../src/qbo.js", import.meta.url).href)});
    try {
      const tokens = await getValidTokens(${JSON.stringify(SLUG)});
      process.stdout.write(JSON.stringify({ access_token: tokens.access_token, refresh_token: tokens.refresh_token }));
    } catch (error) {
      process.stdout.write("ERROR:" + error.message);
    }
  `;
  return collectChild(spawnModule(script));
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

describe("crash-safe normal refresh recovery", () => {
  it("keeps legacy plaintext reads side-effect free so they cannot overwrite a rotated successor", async () => {
    const legacy = {
      ...originalTokens(),
      access_token: "fresh-legacy-access",
      expires_at: Date.now() + 3_600_000,
    };
    await writeFile(TOKEN_FILE, JSON.stringify(legacy, null, 2), { mode: 0o600 });

    await expect(getValidTokens(SLUG)).resolves.toMatchObject({ refresh_token: "predecessor-refresh" });
    expect(JSON.parse(await readFile(TOKEN_FILE, "utf8"))).toMatchObject(legacy);

    const successor = {
      ...legacy,
      access_token: "newer-access",
      refresh_token: "newer-rotated-refresh",
    };
    await saveTokens(SLUG, successor);
    await expect(getValidTokens(SLUG)).resolves.toMatchObject({
      access_token: "newer-access",
      refresh_token: "newer-rotated-refresh",
    });
    const canonical = await decryptTokens(JSON.parse(await readFile(TOKEN_FILE, "utf8")));
    expect(canonical.refresh_token).toBe("newer-rotated-refresh");
  });

  it("rejects an invalid timeout before creating a marker or calling fetch", async () => {
    await saveTokens(SLUG, originalTokens());
    const script = `
      globalThis.fetch = async () => { process.stdout.write("FETCH_SHOULD_NOT_RUN"); };
      try {
        const { refreshTokens } = await import(${JSON.stringify(new URL("../src/qbo.js", import.meta.url).href)});
        await refreshTokens(${JSON.stringify(SLUG)}, ${JSON.stringify(originalTokens())});
      } catch (error) {
        process.stdout.write("ERROR:" + error.message);
      }
    `;
    const child = await collectChild(spawnModule(script, { QBO_TIMEOUT_MS: "-1" }));
    expect(child.code).toBe(0);
    expect(child.stdout).toMatch(/ERROR:QBO_TIMEOUT_MS must be a positive whole number/);
    expect(child.stdout).not.toContain("FETCH_SHOULD_NOT_RUN");
    await expect(stat(RECOVERY_FILE)).rejects.toThrow();
    await expect(stat(TOKEN_FILE)).resolves.toBeTruthy();
  });

  it("fsyncs an encrypted successor before canonical promotion and cleans the journal on success", async () => {
    const original = originalTokens();
    await saveTokens(SLUG, original);
    vi.stubGlobal("fetch", vi.fn(async () => successfulResponse()));

    const saveCanonical = vi.fn(async (slug, tokens) => {
      const recoveryEnvelope = JSON.parse(await readFile(RECOVERY_FILE, "utf8"));
      expect(JSON.stringify(recoveryEnvelope)).not.toContain("confirmed-successor-refresh");
      const recovery = await decryptTokens(recoveryEnvelope);
      expect(recovery.refresh_recovery_state).toBe("successor");
      expect(recovery.token_bundle.refresh_token).toBe("confirmed-successor-refresh");
      await saveTokens(slug, tokens);
    });

    await expect(__test.refreshTokensWithStorageForTest(SLUG, original, { saveCanonical }))
      .resolves.toMatchObject({ refresh_token: "confirmed-successor-refresh" });
    expect(saveCanonical).toHaveBeenCalledOnce();
    await expect(stat(RECOVERY_FILE)).rejects.toThrow();
    const canonical = await decryptTokens(JSON.parse(await readFile(TOKEN_FILE, "utf8")));
    expect(canonical.refresh_token).toBe("confirmed-successor-refresh");
  });

  it.each([
    ["canonical temp open", () => ({
      openFile: async () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); },
    })],
    ["canonical rename", () => ({
      move: async () => { throw Object.assign(new Error("rename failed"), { code: "EIO" }); },
    })],
    ["canonical directory fsync", () => ({
      platform: "linux",
      openFile: async (target, flags, mode) => {
        if (flags === "r") {
          return {
            sync: async () => { throw Object.assign(new Error("directory fsync failed"), { code: "EIO" }); },
            close: async () => {},
          };
        }
        return open(target, flags, mode);
      },
    })],
  ])("recovers across restart after %s failure without another POST", async (_label, atomicOptions) => {
    const original = originalTokens();
    if (_label === "canonical temp open") {
      // Recovery must run before getValidTokens rejects the expired predecessor.
      original.refresh_expires_at = Date.now() - 1;
    }
    await saveTokens(SLUG, original);
    vi.stubGlobal("fetch", vi.fn(async () => successfulResponse()));
    const saveCanonical = (slug, tokens) => saveTokens(slug, tokens, { atomicOptions: atomicOptions() });

    await expect(__test.refreshTokensWithStorageForTest(SLUG, original, { saveCanonical }))
      .rejects.toThrow(/confirmed successor.*canonical token persistence failed.*never the refresh POST/is);
    expect(fetch).toHaveBeenCalledTimes(1);
    const recovery = await decryptTokens(JSON.parse(await readFile(RECOVERY_FILE, "utf8")));
    expect(recovery.refresh_recovery_state).toBe("successor");
    expect(recovery.token_bundle.refresh_token).toBe("confirmed-successor-refresh");

    const child = await recoverInFreshProcess();
    expect(child.code).toBe(0);
    expect(child.stdout).not.toContain("FETCH_SHOULD_NOT_RUN");
    expect(child.stdout).not.toContain("ERROR:");
    expect(JSON.parse(child.stdout)).toEqual({
      access_token: "confirmed-successor-access",
      refresh_token: "confirmed-successor-refresh",
    });
    await expect(stat(RECOVERY_FILE)).rejects.toThrow();
  });

  it("survives process death after POST upload but before response and never replays the predecessor", async () => {
    await saveTokens(SLUG, originalTokens());
    const script = `
      const keepAlive = setInterval(() => {}, 1000);
      globalThis.fetch = async () => {
        process.stdout.write("POST_SENT\\n");
        return new Promise(() => {});
      };
      const { refreshTokens } = await import(${JSON.stringify(new URL("../src/qbo.js", import.meta.url).href)});
      await refreshTokens(${JSON.stringify(SLUG)}, ${JSON.stringify(originalTokens())});
      clearInterval(keepAlive);
    `;
    const child = spawnModule(script);
    await waitForOutput(child, /POST_SENT/);
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;

    const envelope = JSON.parse(await readFile(RECOVERY_FILE, "utf8"));
    expect(JSON.stringify(envelope)).not.toContain("predecessor-refresh");
    const recovery = await decryptTokens(envelope);
    expect(recovery.refresh_recovery_state).toBe("prepared");

    const restarted = await recoverInFreshProcess();
    expect(restarted.code).toBe(0);
    expect(restarted.stdout).toMatch(/ERROR:Token refresh is quarantined.*no definitive response/is);
    expect(restarted.stdout).not.toContain("FETCH_SHOULD_NOT_RUN");

    await persistAuthorization(SLUG, {
      access_token: "reauthorized-access",
      refresh_token: "reauthorized-refresh",
      expires_at: Date.now() + 3_600_000,
      refresh_expires_at: Date.now() + 86_400_000,
      realmId: REALM,
      environment: "sandbox",
    }, { replaceExisting: true });
    await expect(stat(RECOVERY_FILE)).rejects.toThrow();
  });

  it("pre-stages a forced Playground refresh before upload and refuses it after process death", async () => {
    const seed = {
      refresh_token: "operator-supplied-refresh",
      realmId: REALM,
      environment: "production",
    };
    const script = `
      const keepAlive = setInterval(() => {}, 1000);
      globalThis.fetch = async () => {
        process.stdout.write("POST_SENT\\n");
        return new Promise(() => {});
      };
      const { importRefreshToken } = await import(${JSON.stringify(new URL("../src/qbo.js", import.meta.url).href)});
      await importRefreshToken(${JSON.stringify(SLUG)}, ${JSON.stringify(seed)}, {
        validate: async () => ({ CompanyName: "must not run" }),
      });
      clearInterval(keepAlive);
    `;
    const child = spawnModule(script);
    await waitForOutput(child, /POST_SENT/);
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;

    const envelope = JSON.parse(await readFile(STAGE_FILE, "utf8"));
    expect(JSON.stringify(envelope)).not.toContain("operator-supplied-refresh");
    const staged = await decryptTokens(envelope);
    expect(staged.refresh_outcome_unknown_at).toBeTruthy();

    const recoverScript = `
      globalThis.fetch = async () => { throw new Error("FETCH_SHOULD_NOT_RUN"); };
      const { recoverStagedTokenImport } = await import(${JSON.stringify(new URL("../src/qbo.js", import.meta.url).href)});
      try {
        await recoverStagedTokenImport(${JSON.stringify(SLUG)}, {
          validate: async () => { throw new Error("VALIDATE_SHOULD_NOT_RUN"); },
        });
      } catch (error) {
        process.stdout.write(error.message);
      }
    `;
    const restarted = await collectChild(spawnModule(recoverScript));
    expect(restarted.code).toBe(0);
    expect(restarted.stdout).toMatch(/staged token import.*quarantined.*cannot be resumed/is);
    expect(restarted.stdout).not.toContain("FETCH_SHOULD_NOT_RUN");
    expect(restarted.stdout).not.toContain("VALIDATE_SHOULD_NOT_RUN");
  });

  it("refuses sidecar-only disconnect when the realm is now authorized under another slug", async () => {
    const original = originalTokens();
    await saveTokens(SLUG, original);
    vi.stubGlobal("fetch", vi.fn(async () => successfulResponse()));
    const saveCanonical = (slug, tokens) => saveTokens(slug, tokens, {
      atomicOptions: {
        openFile: async () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); },
      },
    });
    await expect(__test.refreshTokensWithStorageForTest(SLUG, original, { saveCanonical }))
      .rejects.toThrow(/confirmed successor.*canonical token persistence failed/is);

    await rm(TOKEN_FILE, { force: true });
    await persistAuthorization(OTHER_SLUG, {
      access_token: "other-fresh-access",
      refresh_token: "other-fresh-refresh",
      expires_at: Date.now() + 3_600_000,
      refresh_expires_at: Date.now() + 86_400_000,
      realmId: REALM,
      environment: "sandbox",
    });
    fetch.mockClear();

    await expect(disconnectCompany(SLUG)).rejects.toThrow(
      /recovery-only realm.*authorized under refresh-recovery-other.*could invalidate that newer grant/is
    );
    expect(fetch).not.toHaveBeenCalled();
    await expect(stat(OTHER_TOKEN_FILE)).resolves.toBeTruthy();
    await expect(stat(RECOVERY_FILE)).resolves.toBeTruthy();
  });

  it("refuses canonical disconnect when another slug owns the same realm", async () => {
    const shared = {
      ...originalTokens(),
      access_token: "shared-current-access",
      expires_at: Date.now() + 3_600_000,
    };
    await saveTokens(SLUG, shared);
    await saveTokens(OTHER_SLUG, shared);
    vi.stubGlobal("fetch", vi.fn(async () => successfulResponse()));

    await expect(disconnectCompany(SLUG)).rejects.toThrow(
      /canonical realm.*also authorized under refresh-recovery-other.*No revocation was attempted.*backups\//is
    );
    expect(fetch).not.toHaveBeenCalled();
    await expect(stat(TOKEN_FILE)).resolves.toBeTruthy();
    await expect(stat(OTHER_TOKEN_FILE)).resolves.toBeTruthy();
    await expect(stat(DISCONNECT_FILE)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("durably marks revocation in flight before upload and suppresses replay after process death", async () => {
    await saveTokens(SLUG, {
      ...originalTokens(),
      access_token: "current-access",
      expires_at: Date.now() + 3_600_000,
    });
    const script = `
      const keepAlive = setInterval(() => {}, 1000);
      globalThis.fetch = async () => {
        process.stdout.write("REVOKE_SENT\\n");
        return new Promise(() => {});
      };
      const { disconnectCompany } = await import(${JSON.stringify(new URL("../src/qbo.js", import.meta.url).href)});
      await disconnectCompany(${JSON.stringify(SLUG)});
      clearInterval(keepAlive);
    `;
    const child = spawnModule(script);
    await waitForOutput(child, /REVOKE_SENT/);
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;

    const receipt = await decryptTokens(JSON.parse(await readFile(DISCONNECT_FILE, "utf8")));
    expect(Object.values(receipt.credentials)).toHaveLength(1);
    expect(Object.values(receipt.credentials)[0].state).toBe("attempting");

    const retryScript = `
      globalThis.fetch = async () => { process.stdout.write("FETCH_SHOULD_NOT_RUN"); };
      const { disconnectCompany } = await import(${JSON.stringify(new URL("../src/qbo.js", import.meta.url).href)});
      try { await disconnectCompany(${JSON.stringify(SLUG)}); }
      catch (error) { process.stdout.write("ERROR:" + error.message); }
    `;
    const restarted = await collectChild(spawnModule(retryScript));
    expect(restarted.code).toBe(0);
    expect(restarted.stdout).toMatch(/ERROR:QuickBooks disconnect is incomplete.*no durably confirmed outcome.*ambiguous/is);
    expect(restarted.stdout).not.toContain("FETCH_SHOULD_NOT_RUN");
  });

  it("quarantines a 503 revocation outcome and never replays it", async () => {
    await saveTokens(SLUG, {
      ...originalTokens(),
      access_token: "current-access",
      expires_at: Date.now() + 3_600_000,
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("upstream failure", { status: 503 })));

    await expect(disconnectCompany(SLUG)).rejects.toThrow(/disconnect is incomplete.*HTTP 503.*ambiguous/is);
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockClear();
    await expect(disconnectCompany(SLUG)).rejects.toThrow(/no durably confirmed outcome.*ambiguous/is);
    expect(fetch).not.toHaveBeenCalled();
    await expect(stat(TOKEN_FILE)).resolves.toBeTruthy();
    await expect(stat(DISCONNECT_FILE)).resolves.toBeTruthy();
  });

  it("resumes cleanup from confirmed revocation receipts without another POST", async () => {
    const tokens = {
      ...originalTokens(),
      access_token: "current-access",
      expires_at: Date.now() + 3_600_000,
    };
    await saveTokens(SLUG, tokens);
    const hash = createHash("sha256").update(tokens.refresh_token).digest("hex");
    await writeEncryptedFixture(DISCONNECT_FILE, {
      realmId: REALM,
      environment: "sandbox",
      disconnect_recovery_version: 1,
      disconnect_recovery_kind: "disconnect",
      disconnect_recovery_created_at: new Date().toISOString(),
      disconnect_recovery_updated_at: new Date().toISOString(),
      credentials: {
        [hash]: {
          sources: ["canonical"],
          token_bundle: tokens,
          state: "confirmed",
          attempt_count: 1,
          confirmed_at: new Date().toISOString(),
          last_status: 200,
        },
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("FETCH_SHOULD_NOT_RUN"); }));

    await expect(disconnectCompany(SLUG)).resolves.toMatchObject({ revoked_credentials: 1 });
    expect(fetch).not.toHaveBeenCalled();
    await expect(stat(TOKEN_FILE)).rejects.toThrow();
    await expect(stat(DISCONNECT_FILE)).rejects.toThrow();
  });
});
