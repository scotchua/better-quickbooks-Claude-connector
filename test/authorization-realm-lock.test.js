import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { persistAuthorization } from "../src/qbo.js";

const REALM = "919999999999991";
const SLUGS = ["realm-race-a", "realm-race-b"];
const tokenPath = (slug) => path.join(process.env.QBO_TOKENS_DIR, `tokens.${slug}.json`);
const refreshLock = (slug) => path.join(process.env.QBO_TOKENS_DIR, `.refresh-${slug}.lock`);
const realmLock = path.join(
  process.env.QBO_TOKENS_DIR,
  `.realm-authorization-${createHash("sha256").update(REALM).digest("hex").slice(0, 32)}.lock`
);

function bundle(slug) {
  return {
    access_token: `access-${slug}`,
    refresh_token: `refresh-${slug}`,
    expires_at: Date.now() + 3_600_000,
    refresh_expires_at: Date.now() + 86_400_000,
    realmId: REALM,
    environment: "sandbox",
  };
}

function spawnAuthorizationCommit(slug) {
  const qboModule = new URL("../src/qbo.js", import.meta.url).href;
  const script = `
    import { persistAuthorization } from ${JSON.stringify(qboModule)};
    const slug = process.env.QBO_TEST_AUTH_SLUG;
    const realmId = process.env.QBO_TEST_AUTH_REALM;
    process.stdout.write("READY\\n");
    process.stdin.once("data", async () => {
      try {
        const now = Date.now();
        await persistAuthorization(slug, {
          access_token: "access-" + slug,
          refresh_token: "refresh-" + slug,
          expires_at: now + 3_600_000,
          refresh_expires_at: now + 86_400_000,
          realmId,
          environment: "sandbox",
        });
        process.stdout.write("RESULT:" + JSON.stringify({ ok: true }) + "\\n");
      } catch (error) {
        process.stdout.write("RESULT:" + JSON.stringify({ ok: false, error: error.message }) + "\\n");
      }
    });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: {
      ...process.env,
      QBO_TEST_AUTH_SLUG: slug,
      QBO_TEST_AUTH_REALM: REALM,
      QBO_TOKEN_KEY: "84".repeat(32),
      QBO_TOKEN_ENCRYPTION: "on",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (stdout.includes("READY\n")) readyResolve();
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, ready, done };
}

async function cleanup() {
  await Promise.all([
    ...SLUGS.flatMap((slug) => [tokenPath(slug), refreshLock(slug)]),
    realmLock,
  ].map((file) => rm(file, { force: true, recursive: true })));
}

beforeEach(async () => {
  await cleanup();
  vi.stubEnv("QBO_TOKEN_KEY", "84".repeat(32));
  vi.stubEnv("QBO_TOKEN_ENCRYPTION", "on");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanup();
});

describe("realm-scoped authorization commits", () => {
  it("allows exactly one of two concurrent slugs to claim the same realm", async () => {
    const outcomes = await Promise.allSettled(
      SLUGS.map((slug) => persistAuthorization(slug, bundle(slug)))
    );
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.message).toMatch(/already authorized.*refusing to create a second slug/is);

    const existing = [];
    for (const slug of SLUGS) {
      try {
        await stat(tokenPath(slug));
        existing.push(slug);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    expect(existing).toHaveLength(1);

    const envelope = JSON.parse(await readFile(tokenPath(existing[0]), "utf8"));
    expect(envelope.realmId).toBe(REALM);
    expect(envelope.environment).toBe("sandbox");
    await expect(stat(realmLock)).rejects.toThrow();
    for (const slug of SLUGS) await expect(stat(refreshLock(slug))).rejects.toThrow();
  });

  it("serializes the same-realm claim across independent Node processes", async () => {
    const children = SLUGS.map(spawnAuthorizationCommit);
    await Promise.all(children.map((child) => child.ready));
    // Release both only after both processes have imported their own qbo.js
    // instance, so no in-memory state can serialize this race for us.
    for (const { child } of children) child.stdin.end("commit\n");
    const outcomes = await Promise.all(children.map((child) => child.done));
    expect(outcomes.every(({ code, signal }) => code === 0 && signal == null)).toBe(true);

    const results = outcomes.map(({ stdout, stderr }) => {
      const line = stdout.split(/\r?\n/).find((value) => value.startsWith("RESULT:"));
      if (!line) throw new Error(`Child produced no RESULT line. stderr: ${stderr}`);
      return JSON.parse(line.slice("RESULT:".length));
    });
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const [rejected] = results.filter((result) => !result.ok);
    expect(rejected.error).toMatch(/already authorized.*refusing to create a second slug/is);

    const existing = [];
    for (const slug of SLUGS) {
      try {
        await stat(tokenPath(slug));
        existing.push(slug);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    expect(existing).toHaveLength(1);
    await expect(stat(realmLock)).rejects.toThrow();
    for (const slug of SLUGS) await expect(stat(refreshLock(slug))).rejects.toThrow();
  }, 15_000);
});
