// End-to-end proof that the posting tool will not reuse a preview after the
// CSV interpretation or resolved Chart-of-Accounts category has changed.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SLUG = "csv-preview-binding-test";
const TOKEN_FILE = path.join(ROOT, `tokens.${SLUG}.json`);

function startServer(preload, tempDir, categoryFile, writeLog) {
  const child = spawn(process.execPath, ["--import", preload, "src/index.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      QBO_TOOL_PROFILE: "full",
      QBO_TOKEN_ENCRYPTION: "off",
      QBO_CLOSED_PERIOD: "off",
      QBO_POLICY_FILE: path.join(tempDir, "no-policy.json"),
      QBO_AUDIT_DIR: path.join(tempDir, "audit"),
      QBO_FILES_DIR: tempDir,
      QBO_TEST_CATEGORY_FILE: categoryFile,
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
    }, 10_000);
    pending.set(id, { resolve, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  };
  return { child, call, stop };
}

async function initialize(server) {
  const response = await server.call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "csv-preview-binding-test", version: "1" },
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

describe("CSV preview plan binding", () => {
  let tempDir;
  let categoryFile;
  let writeLog;
  let csvFile;
  let server;

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "qbo-csv-preview-binding-"));
    categoryFile = path.join(tempDir, "category-id.txt");
    writeLog = path.join(tempDir, "qbo-writes.log");
    csvFile = path.join(tempDir, "bank.csv");
    const preload = path.join(tempDir, "mock-qbo-fetch.mjs");
    await writeFile(categoryFile, "81");
    await writeFile(csvFile, "Date,Description,Amount\n1/2/26,Coffee Hut,-4.50\n");
    await writeFile(preload, `
import { appendFileSync, readFileSync } from "node:fs";
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", intuit_tid: "csv-preview-binding-tid" },
});
globalThis.fetch = async (input, init = {}) => {
  const method = String(init.method || "GET").toUpperCase();
  if (method !== "GET") {
    appendFileSync(process.env.QBO_TEST_WRITE_LOG, method + " " + String(input) + "\\n");
    return json({ Fault: { Error: [{ Message: "AMBIGUOUS_QBO_WRITE" }] } }, 503);
  }
  const url = new URL(String(input));
  if (!url.pathname.endsWith("/query")) {
    return json({ Fault: { Error: [{ Message: "Unexpected mock GET" }] } }, 404);
  }
  const sql = url.searchParams.get("query") || "";
  if (sql.includes("FROM Account") && sql.includes("WHERE Name = 'Checking'")) {
    return json({ QueryResponse: { Account: [{ Id: "35", Name: "Checking", AccountType: "Bank" }] } });
  }
  if (sql.includes("FROM Account") && sql.includes("AccountType = 'Expense'")) {
    const categoryId = readFileSync(process.env.QBO_TEST_CATEGORY_FILE, "utf8").trim();
    return json({ QueryResponse: { Account: [
      { Id: "80", Name: "Uncategorized Expense", AccountType: "Expense" },
      { Id: categoryId, Name: "Coffee", AccountType: "Expense" },
    ] } });
  }
  return json({ QueryResponse: {} });
};
`, { mode: 0o600 });
    const tokenStage = `${TOKEN_FILE}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tokenStage, JSON.stringify({
      access_token: "csv-preview-binding-token",
      refresh_token: "csv-preview-binding-refresh",
      expires_at: Date.now() + 3_600_000,
      refresh_expires_at: Date.now() + 86_400_000,
      realmId: "123456789012345",
      environment: "sandbox",
    }), { mode: 0o600 });
    await rename(tokenStage, TOKEN_FILE);
    server = startServer(preload, tempDir, categoryFile, writeLog);
    await initialize(server);
  }, 20_000);

  afterAll(async () => {
    await server?.stop();
    await rm(TOKEN_FILE, { force: true });
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  const baseArgs = () => ({
    file_path: csvFile,
    bank_account_name: "Checking",
    company: SLUG,
  });

  async function expectNoQboWrites() {
    await expect(readFile(writeLog, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  }

  it("requires a new preview when amount_convention changes", async () => {
    const preview = await callTool(server, "preview_bank_csv_import", {
      ...baseArgs(),
      amount_convention: "negative_out",
    });
    expect(preview.isError).not.toBe(true);

    const imported = await callTool(server, "import_transactions_from_csv", {
      ...baseArgs(),
      amount_convention: "positive_out",
    });
    expect(imported.isError).toBe(true);
    expect(imported.body.error).toMatch(/no longer matches the previewed amount convention/i);
    await expectNoQboWrites();
  });

  it("requires a new preview when the resolved expense category ID changes", async () => {
    await writeFile(categoryFile, "81");
    const preview = await callTool(server, "preview_bank_csv_import", {
      ...baseArgs(),
      amount_convention: "negative_out",
    });
    expect(preview.isError).not.toBe(true);

    await writeFile(categoryFile, "82");
    const imported = await callTool(server, "import_transactions_from_csv", {
      ...baseArgs(),
      amount_convention: "negative_out",
    });
    expect(imported.isError).toBe(true);
    expect(imported.body.error).toMatch(/resolved expense categories/i);
    await expectNoQboWrites();
  });

  it("never sends a second batch when an ambiguous row marker is absent from a recovery query", async () => {
    await writeFile(categoryFile, "81");
    const preview = await callTool(server, "preview_bank_csv_import", {
      ...baseArgs(),
      amount_convention: "negative_out",
    });
    expect(preview.isError).not.toBe(true);

    const interrupted = await callTool(server, "import_transactions_from_csv", {
      ...baseArgs(),
      amount_convention: "negative_out",
    });
    expect(interrupted.isError).toBe(true);
    expect(interrupted.body.error).toMatch(/503.*request_id/is);
    expect((await readFile(writeLog, "utf8")).trim().split("\n")).toHaveLength(1);

    const resumed = await callTool(server, "import_transactions_from_csv", {
      ...baseArgs(),
      amount_convention: "negative_out",
    });
    expect(resumed.isError).toBe(true);
    expect(resumed.body.error).toMatch(/missing query result is not proof|not proof that the create failed/is);
    expect(resumed.body.error).toMatch(/will NOT be posted again.*No QuickBooks write was sent/is);
    expect((await readFile(writeLog, "utf8")).trim().split("\n")).toHaveLength(1);
  });
});
