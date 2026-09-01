import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  listUnresolvedWrites,
  withWriteRecoveryRequestLock,
  writeRecoveryFilePath,
  __test as auditTest,
} from "../src/audit.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORIGINAL_AUDIT_DIR = process.env.QBO_AUDIT_DIR;

function runChild(script, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Recovery-ledger child exited code=${code} signal=${signal}: ${stderr}`));
    });
  });
}

async function waitForFile(file, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await readFile(file);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("write-recovery ledger owner lock", () => {
  let directory;

  afterEach(async () => {
    if (ORIGINAL_AUDIT_DIR === undefined) delete process.env.QBO_AUDIT_DIR;
    else process.env.QBO_AUDIT_DIR = ORIGINAL_AUDIT_DIR;
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("preserves complete JSONL records from concurrent processes", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "qbo-recovery-lock-processes-"));
    process.env.QBO_AUDIT_DIR = directory;
    const childScript = path.join(directory, "append-ledger.mjs");
    const startFile = path.join(directory, "start");
    const moduleUrl = pathToFileURL(path.join(ROOT, "src", "audit.js")).href;
    await writeFile(childScript, `
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { recordWriteIntent } from ${JSON.stringify(moduleUrl)};
const [worker, rawCount, startFile] = process.argv.slice(2);
await writeFile(startFile + "." + worker + ".ready", "ready");
while (!existsSync(startFile)) await new Promise((resolve) => setTimeout(resolve, 5));
for (let index = 0; index < Number(rawCount); index++) {
  const requestId = "worker-" + worker + "-" + index;
  await recordWriteIntent({
    request_id: requestId,
    company: "acme",
    realmId: "123456789",
    environment: "sandbox",
    method: "POST",
    path: "/invoice?requestid=" + requestId,
    body_sha256: worker.repeat(64).slice(0, 64),
  });
}
`, { mode: 0o600 });

    const workers = ["a", "b", "c"];
    const perWorker = 8;
    const children = workers.map((worker) => runChild(
      childScript,
      [worker, String(perWorker), startFile],
      { QBO_AUDIT_DIR: directory, QBO_AUDIT: "off" }
    ));
    await Promise.all(workers.map((worker) => waitForFile(`${startFile}.${worker}.ready`)));
    await writeFile(startFile, "go");
    await Promise.all(children);

    const lines = (await readFile(writeRecoveryFilePath(), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(workers.length * perWorker);
    const records = lines.map(JSON.parse);
    expect(new Set(records.map((record) => record.request_id)).size).toBe(records.length);
    expect(records.every((record) => record.kind === "api_write_intent")).toBe(true);
    await expect(listUnresolvedWrites({ limit: 500 })).resolves.toHaveLength(records.length);
  }, 30_000);

  it("does not expose a partially written append to a recovery reader", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "qbo-recovery-lock-partial-"));
    process.env.QBO_AUDIT_DIR = directory;
    const file = writeRecoveryFilePath();
    let signalPartial;
    const partialWritten = new Promise((resolve) => { signalPartial = resolve; });
    let allowCompletion;
    const canComplete = new Promise((resolve) => { allowCompletion = resolve; });
    let wrappedLedgerHandle = false;

    const openFile = async (target, flags, mode) => {
      const handle = await open(target, flags, mode);
      if (target !== file || flags !== "a" || wrappedLedgerHandle) return handle;
      wrappedLedgerHandle = true;
      return {
        writeFile: async (contents) => {
          const midpoint = Math.max(1, Math.floor(contents.length / 2));
          await handle.writeFile(contents.subarray(0, midpoint));
          signalPartial();
          await canComplete;
          await handle.writeFile(contents.subarray(midpoint));
        },
        sync: () => handle.sync(),
        close: () => handle.close(),
      };
    };

    const requestId = "partial-visibility";
    const writer = auditTest.appendRecoveryRecord({
      kind: "api_write_intent",
      ts: new Date().toISOString(),
      request_id: requestId,
      company: "acme",
      realmId: "123456789",
      environment: "sandbox",
      method: "POST",
      path: `/invoice?requestid=${requestId}`,
      body_sha256: "a".repeat(64),
    }, { openFile });
    await partialWritten;

    // Prove the controlled writer really has exposed a non-JSON prefix at the
    // filesystem level; the public reader must nevertheless wait on its lock.
    const partialText = await readFile(file, "utf8");
    expect(() => JSON.parse(partialText)).toThrow();
    let readerSettled = false;
    const reader = listUnresolvedWrites()
      .then((value) => ({ value }), (error) => ({ error }))
      .finally(() => { readerSettled = true; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(readerSettled).toBe(false);
    } finally {
      allowCompletion();
    }

    await writer;
    const result = await reader;
    expect(result.error).toBeUndefined();
    expect(result.value).toHaveLength(1);
    expect(result.value[0]).toMatchObject({ request_id: requestId, outcome: "no_outcome_recorded" });
  });

  it("treats an existing request-lock failure as a possibly active owner, not a never-sent request", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "qbo-recovery-request-lock-blocked-"));
    process.env.QBO_AUDIT_DIR = directory;
    const requestId = "blocked-request-id";
    const lockPath = auditTest.writeRecoveryRequestLockPath(requestId);
    // A legacy/malformed file is a deterministic acquisition failure after the
    // recovery directory itself was prepared successfully.
    await writeFile(lockPath, "legacy lock");
    let callbackEntered = false;
    const error = await withWriteRecoveryRequestLock(requestId, async () => {
      callbackEntered = true;
    }).catch((caught) => caught);

    expect(callbackEntered).toBe(false);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(
      /This invocation.*sent no QuickBooks request.*Another owner may still be processing.*do not retry.*new request_id/is
    );
    expect(error.message).not.toContain("The QuickBooks request was NOT sent");
  });
});
