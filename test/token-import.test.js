import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { disconnectCompany, getValidTokens, importRefreshToken, recoverStagedTokenImport, saveTokens } from "../src/qbo.js";
import { decryptTokens } from "../src/secure-store.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SLUG = "token-stage-test";
const REALM = "910000000000333";
const canonical = path.join(ROOT, `tokens.${SLUG}.json`);
const stage = path.join(ROOT, `.qbo-token-stage-${SLUG}.json`);
const lock = path.join(ROOT, `.refresh-${SLUG}.lock`);
const refreshRecovery = path.join(ROOT, `.qbo-refresh-recovery-${SLUG}.json`);
const disconnectRecovery = path.join(ROOT, `.qbo-disconnect-recovery-${SLUG}.json`);

async function cleanup() {
  await Promise.all([canonical, stage, lock, refreshRecovery, disconnectRecovery]
    .map((p) => rm(p, { force: true, recursive: true })));
}

function tokenResponse() {
  return new Response(JSON.stringify({
    access_token: "fresh-access",
    refresh_token: "rotated-refresh",
    expires_in: 3600,
    x_refresh_token_expires_in: 7_776_000,
  }), { status: 200, headers: { "content-type": "application/json" } });
}

beforeEach(async () => {
  await cleanup();
  vi.stubEnv("QBO_CLIENT_ID", "test-client");
  vi.stubEnv("QBO_CLIENT_SECRET", "test-secret");
  vi.stubEnv("QBO_TOKEN_KEY", "11".repeat(32));
  vi.stubEnv("QBO_TOKEN_ENCRYPTION", "on");
  vi.stubGlobal("fetch", vi.fn(async () => tokenResponse()));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await cleanup();
});

describe("crash-safe Playground token import", () => {
  it("holds the refresh lock through staging, validation, and promotion", async () => {
    const result = await importRefreshToken(
      SLUG,
      { refresh_token: "pasted-refresh", realmId: REALM, environment: "production" },
      {
        validate: async (tokens) => {
          await expect(stat(lock)).resolves.toBeTruthy();
          const staged = JSON.parse(await readFile(stage, "utf8"));
          expect(staged.enc?.data).toBeTruthy();
          expect(JSON.stringify(staged)).not.toContain("rotated-refresh");
          expect(tokens.refresh_token).toBe("rotated-refresh");
          return { CompanyName: "Acme" };
        },
      }
    );

    expect(result.validation.CompanyName).toBe("Acme");
    await expect(stat(canonical)).resolves.toBeTruthy();
    await expect(stat(stage)).rejects.toThrow();
    await expect(stat(lock)).rejects.toThrow();
  });

  it("keeps a failed verification encrypted and resumes it without another token exchange", async () => {
    await expect(importRefreshToken(
      SLUG,
      { refresh_token: "pasted-refresh", realmId: REALM, environment: "production" },
      { validate: async () => { throw new Error("CompanyInfo unavailable"); } }
    )).rejects.toThrow(/remains encrypted.*rerun/i);

    const staged = JSON.parse(await readFile(stage, "utf8"));
    expect(staged.enc?.data).toBeTruthy();
    expect(JSON.stringify(staged)).not.toContain("rotated-refresh");
    await expect(stat(canonical)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);

    const recovered = await recoverStagedTokenImport(SLUG, {
      validate: async (tokens) => {
        expect(tokens.refresh_token).toBe("rotated-refresh");
        return { CompanyName: "Recovered Co" };
      },
    });

    expect(recovered.validation.CompanyName).toBe("Recovered Co");
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(stat(canonical)).resolves.toBeTruthy();
    await expect(stat(stage)).rejects.toThrow();
  });

  it("revokes and removes a staged credential even when no canonical token was promoted", async () => {
    await expect(importRefreshToken(
      SLUG,
      { refresh_token: "pasted-refresh", realmId: REALM, environment: "production" },
      { validate: async () => { throw new Error("verification stopped"); } }
    )).rejects.toThrow(/remains encrypted/);

    await expect(disconnectCompany(SLUG)).resolves.toMatchObject({
      slug: SLUG,
      realmId: REALM,
      revoked_credentials: 1,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[1][0])).toContain("/tokens/revoke");
    await expect(stat(stage)).rejects.toThrow();
    await expect(stat(canonical)).rejects.toThrow();
  });

  it("attempts every credential, remembers a confirmed partial revocation, and skips it on retry", async () => {
    await saveTokens(SLUG, {
      access_token: "canonical-access",
      refresh_token: "canonical-refresh",
      expires_at: Date.now() + 3_600_000,
      refresh_expires_at: Date.now() + 86_400_000,
      realmId: REALM,
      environment: "production",
    });
    await expect(importRefreshToken(
      SLUG,
      { refresh_token: "pasted-refresh", realmId: REALM, environment: "production" },
      { validate: async () => { throw new Error("leave successor staged"); }, replaceExisting: true }
    )).rejects.toThrow(/remains encrypted/);

    fetch.mockReset();
    fetch
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response("temporary rejection", { status: 400 }));

    await expect(disconnectCompany(SLUG)).rejects.toThrow(
      /disconnect is incomplete.*canonical: confirmed HTTP 200.*playground_stage: HTTP 400.*retry.*already confirmed revocations will be skipped/is
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(stat(canonical)).resolves.toBeTruthy();
    await expect(stat(stage)).resolves.toBeTruthy();
    await expect(stat(disconnectRecovery)).resolves.toBeTruthy();
    await expect(getValidTokens(SLUG)).rejects.toThrow(/authorization removal is incomplete.*will not use or refresh/is);

    const receipt = await decryptTokens(JSON.parse(await readFile(disconnectRecovery, "utf8")));
    const entries = Object.values(receipt.credentials);
    expect(entries.map((entry) => entry.state).sort()).toEqual(["confirmed", "failed_explicit"]);

    fetch.mockReset();
    fetch.mockResolvedValue(new Response(null, { status: 200 }));
    await expect(disconnectCompany(SLUG)).resolves.toMatchObject({
      revoked_credentials: 2,
    });
    // The first credential's durable success was not replayed; only the prior
    // explicit failure was attempted again.
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(stat(canonical)).rejects.toThrow();
    await expect(stat(stage)).rejects.toThrow();
    await expect(stat(disconnectRecovery)).rejects.toThrow();
  });

  it("keeps a missing-credentials disconnect retryable because no revoke request was sent", async () => {
    await saveTokens(SLUG, {
      access_token: "canonical-access",
      refresh_token: "canonical-refresh",
      expires_at: Date.now() + 3_600_000,
      refresh_expires_at: Date.now() + 86_400_000,
      realmId: REALM,
      environment: "production",
    });
    fetch.mockReset();
    vi.stubEnv("QBO_CLIENT_ID", "");
    vi.stubEnv("QBO_CLIENT_SECRET", "");

    await expect(disconnectCompany(SLUG)).rejects.toThrow(
      /disconnect is incomplete.*local revocation preparation failed before any request was sent.*retry/is
    );
    expect(fetch).not.toHaveBeenCalled();
    const receipt = await decryptTokens(JSON.parse(await readFile(disconnectRecovery, "utf8")));
    expect(Object.values(receipt.credentials)).toHaveLength(1);
    expect(Object.values(receipt.credentials)[0].state).toBe("unattempted");

    vi.stubEnv("QBO_CLIENT_ID", "test-client");
    vi.stubEnv("QBO_CLIENT_SECRET", "test-secret");
    fetch.mockResolvedValue(new Response(null, { status: 200 }));
    await expect(disconnectCompany(SLUG)).resolves.toMatchObject({ revoked_credentials: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(stat(canonical)).rejects.toThrow();
    await expect(stat(disconnectRecovery)).rejects.toThrow();
  });

  it("stops replaying a repeatedly rejected credential while still attempting the other candidate", async () => {
    await saveTokens(SLUG, {
      access_token: "canonical-access",
      refresh_token: "canonical-refresh",
      expires_at: Date.now() + 3_600_000,
      refresh_expires_at: Date.now() + 86_400_000,
      realmId: REALM,
      environment: "production",
    });
    await expect(importRefreshToken(
      SLUG,
      { refresh_token: "pasted-refresh", realmId: REALM, environment: "production" },
      { validate: async () => { throw new Error("leave successor staged"); }, replaceExisting: true }
    )).rejects.toThrow(/remains encrypted/);

    fetch.mockReset();
    fetch
      .mockResolvedValueOnce(new Response("old token rejected", { status: 400 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    await expect(disconnectCompany(SLUG)).rejects.toThrow(/canonical: HTTP 400.*playground_stage: confirmed HTTP 200/is);
    expect(fetch).toHaveBeenCalledTimes(2);

    fetch.mockReset();
    fetch.mockResolvedValue(new Response("still rejected", { status: 400 }));
    await expect(disconnectCompany(SLUG)).rejects.toThrow(/manual.*app connection/is);
    expect(fetch).toHaveBeenCalledTimes(1);

    fetch.mockReset();
    await expect(disconnectCompany(SLUG)).rejects.toThrow(/manual.*app connection/is);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("quarantines an ambiguous import in the encrypted stage and never retries it", async () => {
    fetch.mockRejectedValue(new TypeError("connection reset after request upload"));

    await expect(importRefreshToken(
      SLUG,
      {
        access_token: "fresh-looking-but-uncertain",
        refresh_token: "pasted-refresh",
        expires_at: Date.now() + 3_600_000,
        realmId: REALM,
        environment: "production",
      },
      { validate: async () => ({ CompanyName: "must not run" }) }
    )).rejects.toThrow(/not replayed.*quarantined/is);
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(stat(canonical)).rejects.toThrow();

    const encrypted = JSON.parse(await readFile(stage, "utf8"));
    expect(encrypted.enc?.data).toBeTruthy();
    expect(JSON.stringify(encrypted)).not.toContain("pasted-refresh");
    const quarantined = await decryptTokens(encrypted);
    expect(quarantined.refresh_outcome_unknown_at).toBeTruthy();
    expect(quarantined.expires_at).toBeGreaterThan(Date.now() + 60_000);

    const validate = vi.fn(async () => ({ CompanyName: "must not run" }));
    await expect(recoverStagedTokenImport(SLUG, {
      validate,
    })).rejects.toThrow(/staged token import.*quarantined.*fresh-looking.*cannot be resumed.*npm run disconnect.*Do not rerun/is);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(validate).not.toHaveBeenCalled();
  });
});
