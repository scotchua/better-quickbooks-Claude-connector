import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { __test } from "../src/qbo.js";
import { listAuthorizedCompanies, listAuthorizationIdentities, duplicateRealms, realmSiblingSlugs } from "../src/company-registry.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIRECTORY = process.env.QBO_TOKENS_DIR;
const realm = "910000000000123";
const realmKey = createHash("sha256").update(realm).digest("hex").slice(0, 32);
const paths = [
  ["slugged token", __test.tokensPathFor, "acme", "tokens.acme.json"],
  ["legacy token", __test.tokensPathFor, "", "tokens.json"],
  ["staged token", __test.tokenStagePathFor, "acme", ".qbo-token-stage-acme.json"],
  ["legacy staged token", __test.tokenStagePathFor, "", ".qbo-token-stage-default.json"],
  ["refresh recovery", __test.refreshRecoveryPathFor, "acme", ".qbo-refresh-recovery-acme.json"],
  ["legacy refresh recovery", __test.refreshRecoveryPathFor, "", ".qbo-refresh-recovery-default.json"],
  ["disconnect recovery", __test.disconnectRecoveryPathFor, "acme", ".qbo-disconnect-recovery-acme.json"],
  ["legacy disconnect recovery", __test.disconnectRecoveryPathFor, "", ".qbo-disconnect-recovery-default.json"],
  ["refresh lock", __test.refreshLockPathFor, "acme", ".refresh-acme.lock"],
  ["legacy refresh lock", __test.refreshLockPathFor, "", ".refresh-default.lock"],
  ["realm authorization lock", __test.realmAuthorizationLockPath, realm, `.realm-authorization-${realmKey}.lock`],
];

afterEach(() => vi.unstubAllEnvs());

describe("token directory paths", () => {
  it.each(paths)("preserves the ROOT-based %s path when unset", (_label, resolve, identity, filename) => {
    vi.stubEnv("QBO_TOKENS_DIR", undefined);
    expect(resolve(identity)).toBe(path.join(ROOT, filename));
  });

  it.each(paths)("relocates the %s path", (_label, resolve, identity, filename) => {
    vi.stubEnv("QBO_TOKENS_DIR", DIRECTORY);
    expect(resolve(identity)).toBe(path.join(DIRECTORY, filename));
  });

  it.each(paths)("preserves the ROOT-based %s path for an empty override", (_label, resolve, identity, filename) => {
    vi.stubEnv("QBO_TOKENS_DIR", "");
    expect(resolve(identity)).toBe(path.join(ROOT, filename));
  });
});

async function writeToken(directory, filename, realmId) {
  await writeFile(path.join(directory, filename), JSON.stringify({
    realmId,
    environment: "sandbox",
    access_token: "test-access",
    refresh_token: "test-refresh",
  }), { mode: 0o600 });
}

describe("token directory enumeration", () => {
  it("uses the current override for company lists, identities, siblings, and duplicate realms", async () => {
    const directory = path.join(DIRECTORY, "registry");
    const other = path.join(DIRECTORY, "other");
    await mkdir(directory);
    await mkdir(other);
    await writeToken(directory, "tokens.acme.json", realm);
    await writeToken(directory, "tokens.json", realm);
    await writeToken(other, "tokens.other.json", "other-realm");

    vi.stubEnv("QBO_TOKENS_DIR", directory);
    expect(await listAuthorizedCompanies()).toEqual([{ slug: "acme", realmId: realm, environment: "sandbox" }]);
    expect((await listAuthorizationIdentities()).map((row) => row.slug)).toEqual(["", "acme"]);
    expect(await realmSiblingSlugs("acme")).toEqual(["", "acme"]);
    expect(await duplicateRealms()).toEqual([{ realmId: realm, slugs: ["", "acme"], environments: ["sandbox"] }]);

    vi.stubEnv("QBO_TOKENS_DIR", other);
    expect(await listAuthorizedCompanies()).toEqual([{ slug: "other", realmId: "other-realm", environment: "sandbox" }]);
    expect(await duplicateRealms()).toEqual([]);
  });

  it("makes doctor inspect overridden tokens, recovery sidecars, and duplicate identities", async () => {
    const directory = path.join(DIRECTORY, "doctor");
    await mkdir(directory);
    await writeToken(directory, "tokens.acme.json", realm);
    await writeToken(directory, "tokens.json", realm);
    for (const filename of [".qbo-refresh-recovery-acme.json", ".qbo-disconnect-recovery-acme.json", ".qbo-token-stage-acme.json"]) {
      await writeFile(path.join(directory, filename), "{}");
    }
    const result = spawnSync(process.execPath, ["src/doctor.js", "--json"], {
      cwd: ROOT,
      env: { ...process.env, QBO_TOKENS_DIR: directory },
      encoding: "utf8",
    });
    expect(result.error).toBeUndefined();
    const { results } = JSON.parse(result.stdout);
    expect(results.find((row) => row.check === "Company authorizations")).toMatchObject({
      status: "ok",
      detail: "2 token file(s) found and structurally valid with private permissions.",
    });
    expect(results.find((row) => row.check === "OAuth recovery state")).toMatchObject({
      status: "warn",
      detail: "1 refresh, 1 disconnect, and 1 Playground recovery record(s) are pending.",
    });
    expect(results.find((row) => row.check === "Company identity")).toMatchObject({
      status: "error",
      detail: `Realm ${realm} is authorized under 2 identities: acme, (default).`,
    });
  });
});
