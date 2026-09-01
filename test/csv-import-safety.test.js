import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SLUG = "csv-import-safety-test";
const TOKEN_FILE = path.join(ROOT, `tokens.${SLUG}.json`);

function startServer(preload, { auditDir, policyFile, modeFile, countFile, writeLog, filesDir }) {
  const child = spawn(process.execPath, ["--import", preload, "src/index.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      QBO_TOOL_PROFILE: "full",
      QBO_TOKEN_ENCRYPTION: "off",
      QBO_CLOSED_PERIOD: "off",
      QBO_POLICY_FILE: policyFile,
      QBO_AUDIT_DIR: auditDir,
      QBO_FILES_DIR: filesDir,
      QBO_TEST_MODE_FILE: modeFile,
      QBO_TEST_COUNT_FILE: countFile,
      QBO_TEST_WRITE_LOG: writeLog,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  const pending = new Map();
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    let newline;
    while ((newline = stdout.indexOf("\n")) >= 0) {
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const request = pending.get(message.id);
      if (!request) continue;
      clearTimeout(request.timer);
      pending.delete(message.id);
      request.resolve(message);
    }
  });

  let nextId = 1;
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${method}. Server stderr:\n${stderr}`));
    }, 20_000);
    pending.set(id, { resolve, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  };
  return { call, stop };
}

async function initialize(server) {
  const response = await server.call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "csv-import-safety-test", version: "1" },
  });
  if (response.error) throw new Error(response.error.message);
}

async function callTool(server, name, args) {
  const response = await server.call("tools/call", { name, arguments: args });
  if (response.error) throw new Error(response.error.message);
  let body;
  try { body = JSON.parse(response.result.content[0].text); } catch { body = {}; }
  return { ...response.result, body };
}

async function waitForLines(file, expected, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const lines = (await readFile(file, "utf8")).trim().split("\n").filter(Boolean);
      if (lines.length >= expected) return lines;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${expected} write-log line(s).`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("CSV import concurrency, recovery, and aggregate policy", () => {
  let tempDir;
  let preload;
  const servers = [];

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "qbo-csv-import-safety-"));
    preload = path.join(tempDir, "mock-qbo-fetch.mjs");
    await writeFile(preload, `
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", intuit_tid: "csv-import-safety-tid" },
});
const readText = (file, fallback = "") => {
  try { return readFileSync(file, "utf8").trim(); } catch { return fallback; }
};
const bumpAttempt = () => {
  const next = Number(readText(process.env.QBO_TEST_COUNT_FILE, "0")) + 1;
  writeFileSync(process.env.QBO_TEST_COUNT_FILE, String(next));
  return next;
};
globalThis.fetch = async (input, init = {}) => {
  const method = String(init.method || "GET").toUpperCase();
  const url = new URL(String(input));
  if (method !== "GET") {
    const body = JSON.parse(String(init.body || "{}"));
    appendFileSync(process.env.QBO_TEST_WRITE_LOG, JSON.stringify({ url: String(input), body }) + "\\n");
    const mode = readText(process.env.QBO_TEST_MODE_FILE, "success");
    const attempt = bumpAttempt();
    if (mode === "slow-success") await new Promise((resolve) => setTimeout(resolve, 800));
    if (mode === "fault-once" && attempt === 1) {
      return json({ BatchItemResponse: (body.BatchItemRequest || []).map((item) => ({
        bId: item.bId,
        Fault: { Error: [{ Message: "ROW_REJECTED", Detail: "definite validation failure" }] },
      })) });
    }
    return json({ BatchItemResponse: (body.BatchItemRequest || []).map((item, index) => ({
      bId: item.bId,
      Purchase: {
        ...item.Purchase,
        Id: String(7000 + attempt * 100 + index),
        TotalAmt: item.Purchase?.Line?.[0]?.Amount,
      },
    })) });
  }
  if (!url.pathname.endsWith("/query")) {
    return json({ Fault: { Error: [{ Message: "Unexpected mock GET", Detail: url.pathname }] } }, 404);
  }
  const sql = url.searchParams.get("query") || "";
  if (sql.includes("FROM Account") && sql.includes("WHERE Name = 'Checking'")) {
    return json({ QueryResponse: { Account: [{ Id: "35", Name: "Checking", AccountType: "Bank" }] } });
  }
  if (sql.includes("FROM Account") && sql.includes("AccountType = 'Expense'")) {
    return json({ QueryResponse: { Account: [
      { Id: "80", Name: "Uncategorized Expense", AccountType: "Expense" },
      { Id: "81", Name: "Coffee", AccountType: "Expense" },
    ] } });
  }
  if (sql.includes("FROM Purchase")) return json({ QueryResponse: { Purchase: [] } });
  return json({ QueryResponse: {} });
};
`, { mode: 0o600 });

    const tokenStage = `${TOKEN_FILE}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tokenStage, JSON.stringify({
      access_token: "csv-import-safety-token",
      refresh_token: "csv-import-safety-refresh",
      expires_at: Date.now() + 3_600_000,
      refresh_expires_at: Date.now() + 86_400_000,
      realmId: "223456789012345",
      environment: "sandbox",
    }), { mode: 0o600 });
    await rename(tokenStage, TOKEN_FILE);
  }, 20_000);

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.stop()));
  });

  afterAll(async () => {
    await rm(TOKEN_FILE, { force: true });
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  async function fixture(name, { mode = "success", policy = null, csv } = {}) {
    const directory = path.join(tempDir, name);
    await mkdir(directory, { recursive: true });
    const csvFile = path.join(directory, "bank.csv");
    const modeFile = path.join(directory, "mode.txt");
    const countFile = path.join(directory, "count.txt");
    const writeLog = path.join(directory, "writes.jsonl");
    const policyFile = path.join(directory, "policy.json");
    await writeFile(modeFile, mode);
    await writeFile(countFile, "0");
    await writeFile(csvFile, csv || "Date,Description,Amount\n1/2/26,Coffee Hut,-4.50\n");
    if (policy) await writeFile(policyFile, JSON.stringify(policy));
    return {
      csvFile,
      writeLog,
      serverOptions: {
        auditDir: path.join(directory, "audit"),
        policyFile,
        modeFile,
        countFile,
        writeLog,
        filesDir: tempDir,
      },
    };
  }

  const argsFor = (csvFile) => ({
    file_path: csvFile,
    bank_account_name: "Checking",
    company: SLUG,
  });

  it("serializes the same import across processes so a waiter observes the confirmed outcome", async () => {
    const fx = await fixture("concurrent", { mode: "slow-success" });
    const firstServer = startServer(preload, fx.serverOptions);
    const secondServer = startServer(preload, fx.serverOptions);
    servers.push(firstServer, secondServer);
    await Promise.all([initialize(firstServer), initialize(secondServer)]);
    await expect(callTool(firstServer, "preview_bank_csv_import", argsFor(fx.csvFile)))
      .resolves.toMatchObject({ body: { dry_run: true } });

    const first = callTool(firstServer, "import_transactions_from_csv", argsFor(fx.csvFile));
    await waitForLines(fx.writeLog, 1);
    const second = callTool(secondServer, "import_transactions_from_csv", argsFor(fx.csvFile));
    const results = await Promise.all([first, second]);

    expect(results.every((result) => !result.isError)).toBe(true);
    expect(results.map((result) => result.body.imported).sort()).toEqual([0, 1]);
    expect(await waitForLines(fx.writeLog, 1)).toHaveLength(1);
  }, 20_000);

  it("durably records a definite batch Fault so the row can be retried", async () => {
    const fx = await fixture("definite-fault", { mode: "fault-once" });
    const server = startServer(preload, fx.serverOptions);
    servers.push(server);
    await initialize(server);
    await callTool(server, "preview_bank_csv_import", argsFor(fx.csvFile));

    const rejected = await callTool(server, "import_transactions_from_csv", argsFor(fx.csvFile));
    expect(rejected.isError).not.toBe(true);
    expect(rejected.body).toMatchObject({ imported: 0, errors: ["ROW_REJECTED"] });

    const retried = await callTool(server, "import_transactions_from_csv", argsFor(fx.csvFile));
    expect(retried.isError).not.toBe(true);
    expect(retried.body.imported).toBe(1);

    const idempotent = await callTool(server, "import_transactions_from_csv", argsFor(fx.csvFile));
    expect(idempotent.isError).not.toBe(true);
    expect(idempotent.body.imported).toBe(0);
    expect(await waitForLines(fx.writeLog, 2)).toHaveLength(2);
  });

  it("blocks the aggregate import amount before the first 30-row chunk is sent", async () => {
    const rows = Array.from({ length: 60 }, (_, index) =>
      `1/2/26,Coffee ${index + 1},-20.00`).join("\n");
    const fx = await fixture("aggregate-cap", {
      csv: `Date,Description,Amount\n${rows}\n`,
      policy: { defaults: { max_write_amount: 1000 }, companies: {} },
    });
    const server = startServer(preload, fx.serverOptions);
    servers.push(server);
    await initialize(server);
    await callTool(server, "preview_bank_csv_import", argsFor(fx.csvFile));

    const blocked = await callTool(server, "import_transactions_from_csv", argsFor(fx.csvFile));
    expect(blocked.isError).toBe(true);
    expect(blocked.body.error).toMatch(/totals 1200\.00.*limit of 1000/i);
    await expect(readFile(fx.writeLog, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
