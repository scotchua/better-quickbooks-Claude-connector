// End-to-end MCP boundary regressions for single-write replay, pure reads, and
// explicit local exports. A preload replaces Intuit fetch while the real server,
// schemas, tool wrappers, recovery ledger, redaction, and resources all run.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SLUG = "tool-ergonomics-test";
const REALM = "765432109876543";
const TOKEN_FILE = path.join(process.env.QBO_TOKENS_DIR, `tokens.${SLUG}.json`);

function startServer(preload, tempDir, filesDir, writeLog) {
  const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, "src/index.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      QBO_TOOL_PROFILE: "full",
      QBO_TOKEN_ENCRYPTION: "off",
      QBO_CLOSED_PERIOD: "off",
      QBO_RETRY_WRITES: "false",
      QBO_PDF_MAX_BYTES: "32",
      QBO_POLICY_FILE: path.join(tempDir, "no-policy.json"),
      QBO_AUDIT_DIR: path.join(tempDir, "audit"),
      QBO_FILES_DIR: filesDir,
      QBO_TEST_WRITE_LOG: writeLog,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  // Register immediately so an early child exit cannot race teardown. Waiting
  // for close (not just kill()) also waits for the stdio handles to be released,
  // which matters before Windows removes the fixture directory.
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
    clientInfo: { name: "tool-ergonomics-test", version: "1" },
  });
  if (response.error) throw new Error(response.error.message);
}

async function callTool(server, name, args) {
  const response = await server.call("tools/call", { name, arguments: args });
  if (response.error) throw new Error(response.error.message);
  const result = response.result;
  let body;
  try { body = JSON.parse(result.content[0].text); } catch { body = null; }
  return { ...result, body };
}

describe("tool ergonomics at the MCP boundary", () => {
  let tempDir;
  let filesDir;
  let writeLog;
  let server;

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "qbo-tool-ergonomics-"));
    filesDir = path.join(tempDir, "files");
    writeLog = path.join(tempDir, "writes.jsonl");
    await mkdir(filesDir, { recursive: true });
    await writeFile(writeLog, "", { mode: 0o600 });
    const preload = path.join(tempDir, "mock-qbo-fetch.mjs");
    await writeFile(preload, `
import { appendFileSync } from "node:fs";
const counts = { invoice: 0, bill: 0, batch: 0 };
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", intuit_tid: "tool-ergonomics-tid" },
});
const entityRows = {
  Customer: [{ Id: "7", DisplayName: "Acme Customer", PrimaryEmailAddr: { Address: "billing@example.test" } }],
  Item: [{ Id: "11", Name: "Consulting", Type: "Service", IncomeAccountRef: { value: "30", name: "Services" } }],
  Vendor: [{ Id: "17", DisplayName: "Widget Supply" }],
  Account: [{ Id: "20", Name: "Office Supplies", AccountType: "Expense" }],
  Invoice: [{ Id: "41", DocNumber: "INV-41", TotalAmt: 125 }],
  Estimate: [{ Id: "42", DocNumber: "EST-42", TotalAmt: 225 }],
};
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.hostname === "secret.example.test") {
    return new Response("x".repeat(33), {
      status: 200,
      headers: { "content-type": "application/pdf", "content-length": "33" },
    });
  }
  const method = String(init.method || "GET").toUpperCase();
  const marker = "/v3/company/";
  const companyIndex = url.pathname.indexOf(marker);
  const afterCompany = companyIndex < 0 ? url.pathname : url.pathname.slice(companyIndex + marker.length);
  const slash = afterCompany.indexOf("/");
  const endpoint = slash < 0 ? "/" : afterCompany.slice(slash);

  if (endpoint.startsWith("/query")) {
    const sql = url.searchParams.get("query") || "";
    if (/FROM\\s+Attachable/i.test(sql)) {
      return json({ QueryResponse: { Attachable: [{
        Id: "88",
        FileName: "receipt.pdf",
        TempDownloadUri: "https://secret.example.test/download?token=top-secret",
        nested: { FileAccessUri: "https://secret.example.test/file?token=nested-secret", safe: "kept" },
      }] } });
    }
    const entity = /\\bFROM\\s+([A-Za-z]+)/i.exec(sql)?.[1] || "Customer";
    return json({ QueryResponse: { [entity]: entityRows[entity] || [] } });
  }
  if (endpoint.startsWith("/reports/ProfitAndLoss")) {
    return json({
      Header: { ReportName: "ProfitAndLoss", StartPeriod: "2026-07-01", EndPeriod: "2026-07-31", ReportBasis: "Accrual" },
      Rows: { Row: [{ ColData: [{ value: "Income" }, { value: "125.00" }] }] },
    });
  }
  if (endpoint.startsWith("/companyinfo/")) {
    return json({ CompanyInfo: { CompanyName: "Tool Ergonomics Co", LegalName: "Tool Ergonomics Co LLC", Country: "US" } });
  }
  if (endpoint.startsWith("/preferences")) {
    return json({ Preferences: {
      AccountingInfoPrefs: { FirstMonthOfFiscalYear: "January", BookCloseDate: "2026-06-30" },
      CurrencyPrefs: { MultiCurrencyEnabled: false, HomeCurrency: { value: "USD" } },
    } });
  }
  if (/^\\/(invoice|estimate)\\/[^/]+\\/pdf$/.test(endpoint)) {
    return new Response("%PDF-1.7\\nmock pdf\\n%%EOF", {
      status: 200,
      headers: { "content-type": "application/pdf", intuit_tid: "tool-ergonomics-pdf" },
    });
  }
  if (method === "POST" && (endpoint === "/invoice" || endpoint === "/bill")) {
    const kind = endpoint.slice(1);
    appendFileSync(process.env.QBO_TEST_WRITE_LOG, JSON.stringify({
      kind,
      request_id: url.searchParams.get("requestid"),
      body: JSON.parse(String(init.body || "{}")),
    }) + "\\n");
    counts[kind] += 1;
    if (counts[kind] === 1) throw new Error("simulated socket reset");
    return kind === "invoice"
      ? json({ Invoice: { Id: "501", DocNumber: "INV-501", TotalAmt: 125 } })
      : json({ Bill: { Id: "601", DocNumber: "BILL-601", TotalAmt: 75 } });
  }
  if (method === "POST" && endpoint === "/batch") {
    appendFileSync(process.env.QBO_TEST_WRITE_LOG, JSON.stringify({
      kind: "batch",
      request_id: url.searchParams.get("requestid"),
      url: url.toString(),
      serialized_body: String(init.body || ""),
    }) + "\\n");
    counts.batch += 1;
    if (counts.batch === 1) throw new Error("simulated batch socket reset after upload");
    return json({ BatchItemResponse: [{
      bId: "bid0",
      Class: { Id: "701", Name: "Batch Replay Class" },
    }] });
  }
  return json({ Fault: { Error: [{ Message: "Unexpected mock request", Detail: method + " " + endpoint }] } }, 404);
};
`, { mode: 0o600 });
    const tokenStage = `${TOKEN_FILE}.${process.pid}.tmp`;
    await writeFile(tokenStage, JSON.stringify({
      access_token: "tool-ergonomics-access",
      refresh_token: "tool-ergonomics-refresh",
      expires_at: Date.now() + 3_600_000,
      refresh_expires_at: Date.now() + 86_400_000,
      realmId: REALM,
      environment: "sandbox",
    }), { mode: 0o600 });
    await rename(tokenStage, TOKEN_FILE);
    server = startServer(preload, tempDir, filesDir, writeLog);
    await initialize(server);
  }, 20_000);

  afterAll(async () => {
    await server?.stop();
    await rm(TOKEN_FILE, { force: true });
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it.each([
    ["create_invoice", {
      customer_ref: "7",
      line_items: [{ amount: 125, item: "11", description: "Consulting" }],
      txn_date: "2026-07-15",
    }, "Invoice", "501"],
    ["create_bill", {
      vendor_name: "Widget Supply",
      amount: 75,
      category: "Office Supplies",
      transaction_date: "2026-07-16",
    }, "Bill", "601"],
  ])("replays %s with its exact original request_id", async (name, args, entity, id) => {
    const first = await callTool(server, name, { ...args, company: SLUG });
    expect(first.isError).toBe(true);
    const requestId = /request_id\s+([0-9a-f-]+)/i.exec(first.body.error)?.[1];
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);

    const replay = await callTool(server, name, { ...args, company: SLUG, request_id: requestId });
    expect(replay.isError).not.toBe(true);
    expect(replay.body.created).toMatchObject({ Id: id });

    const writes = (await readFile(writeLog, "utf8")).trim().split("\n").map(JSON.parse)
      .filter((row) => row.kind === name.replace("create_", ""));
    expect(writes).toHaveLength(2);
    expect(writes[0].request_id).toBe(requestId);
    expect(writes[1].request_id).toBe(requestId);
    expect(writes[1].body).toEqual(writes[0].body);
    expect(replay.body.created).toHaveProperty("Id", id);
    expect(entity).toMatch(/Invoice|Bill/);
  });

  it("replays an ambiguous batch with the exact original URL and body", async () => {
    const operations = [{
      operation: "create",
      entity: "Class",
      body: { Name: "Batch Replay Class" },
    }];
    const first = await callTool(server, "execute_batch", { operations, company: SLUG });
    expect(first.isError).toBe(true);
    const requestId = /request_id\s+([0-9a-f-]+)/i.exec(first.body.error)?.[1];
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);

    const replay = await callTool(server, "execute_batch", {
      operations,
      company: SLUG,
      request_id: requestId,
    });
    expect(replay.isError).not.toBe(true);
    expect(replay.body).toMatchObject({
      company: SLUG,
      succeeded: 1,
      failed: 0,
      results: [{ bId: "bid0", ok: true, entity: "Class", id: "701" }],
    });

    const writes = (await readFile(writeLog, "utf8")).trim().split("\n").map(JSON.parse)
      .filter((row) => row.kind === "batch");
    expect(writes).toHaveLength(2);
    expect(writes[0].request_id).toBe(requestId);
    expect(writes[1].request_id).toBe(requestId);
    expect(writes[1].url).toBe(writes[0].url);
    expect(writes[1].serialized_body).toBe(writes[0].serialized_body);
    expect(JSON.parse(writes[0].serialized_body)).toEqual({
      BatchItemRequest: [{
        bId: "bid0",
        operation: "create",
        Class: { Name: "Batch Replay Class" },
      }],
    });
  });

  it("rejects deprecated composite flags before another QBO write", async () => {
    const before = await readFile(writeLog, "utf8");
    for (const [name, args] of [
      ["create_invoice", {
        customer_ref: "7",
        line_items: [{ amount: 125, item: "11" }],
        txn_date: "2026-07-15",
        send_email: true,
        company: SLUG,
      }],
      ["create_bill", {
        vendor_name: "Widget Supply",
        amount: 75,
        category: "Office Supplies",
        transaction_date: "2026-07-16",
        create_vendor_if_missing: true,
        company: SLUG,
      }],
    ]) {
      const response = await server.call("tools/call", { name, arguments: args });
      expect(response.error || response.result?.isError, name).toBeTruthy();
      expect(JSON.stringify(response), name).toMatch(/invalid|false|literal/i);
    }
    expect(await readFile(writeLog, "utf8")).toBe(before);
  });

  it("enforces Intuit request-id length limits at the MCP boundary", async () => {
    const before = await readFile(writeLog, "utf8");
    const ordinary = await server.call("tools/call", {
      name: "create_invoice",
      arguments: {
        customer_ref: "7",
        line_items: [{ amount: 125, item: "11" }],
        company: SLUG,
        request_id: "x".repeat(51),
      },
    });
    const batch = await server.call("tools/call", {
      name: "execute_batch",
      arguments: {
        operations: [{ operation: "create", entity: "Customer", body: { DisplayName: "Too Long" } }],
        company: SLUG,
        request_id: "x".repeat(37),
      },
    });
    for (const [name, response] of [["ordinary", ordinary], ["batch", batch]]) {
      expect(response.error || response.result?.isError, name).toBeTruthy();
      expect(JSON.stringify(response), name).toMatch(/too_big|maximum|invalid|characters/i);
    }
    expect(await readFile(writeLog, "utf8")).toBe(before);
  });

  it("keeps reports and PDFs inline while export is fenced and no-clobber", async () => {
    const inlineMacro = await callTool(server, "get_profit_and_loss", {
      date_macro: "Last Month",
      company: SLUG,
    });
    expect(inlineMacro.isError).not.toBe(true);
    expect(inlineMacro.body).toMatchObject({ Header: { ReportName: "ProfitAndLoss" } });

    const reportPath = path.join(filesDir, "reports", "last-month-pl.json");
    const exported = await callTool(server, "export_qbo_artifact", {
      artifact: "profit_and_loss",
      date_macro: "Last Month",
      save_path: reportPath,
      company: SLUG,
    });
    expect(exported.isError).not.toBe(true);
    expect(exported.body).toMatchObject({ artifact: "profit_and_loss", saved_to: reportPath });
    expect(JSON.parse(await readFile(reportPath, "utf8"))).toMatchObject({ Header: { ReportName: "ProfitAndLoss" } });

    const clobber = await callTool(server, "export_qbo_artifact", {
      artifact: "profit_and_loss",
      start_date: "2026-07-01",
      end_date: "2026-07-31",
      save_path: reportPath,
      company: SLUG,
    });
    expect(clobber.isError).toBe(true);
    expect(clobber.body.error).toMatch(/refusing to overwrite.*never overwrites/is);

    const outside = await callTool(server, "export_qbo_artifact", {
      artifact: "profit_and_loss",
      start_date: "2026-07-01",
      end_date: "2026-07-31",
      save_path: path.join(tempDir, "outside.json"),
      company: SLUG,
    });
    expect(outside.isError).toBe(true);
    expect(outside.body.error).toMatch(/outside QBO_FILES_DIR/i);

    const pdf = await callTool(server, "get_invoice_pdf", { invoice_id: "41", company: SLUG });
    expect(pdf.isError).not.toBe(true);
    expect(pdf.content[1]).toMatchObject({
      type: "resource",
      resource: { mimeType: "application/pdf" },
    });
    expect(Buffer.from(pdf.content[1].resource.blob, "base64").toString("utf8")).toContain("%PDF-1.7");
  });

  it("redacts attachment credentials from a real tool response", async () => {
    const result = await callTool(server, "api_get", {
      path: `/query?query=${encodeURIComponent("SELECT * FROM Attachable")}`,
      company: SLUG,
    });
    expect(result.isError).not.toBe(true);
    const serialized = JSON.stringify(result.body);
    expect(serialized).not.toMatch(/TempDownloadUri|FileAccessUri|top-secret|nested-secret/);
    expect(result.body.QueryResponse.Attachable[0].nested.safe).toBe("kept");
  });

  it("rejects an oversized attachment before writing its destination", async () => {
    const destination = path.join(filesDir, "oversized-attachment.pdf");
    const result = await callTool(server, "download_attachment", {
      attachable_id: "88",
      save_path: destination,
      company: SLUG,
    });
    expect(result.isError).toBe(true);
    expect(result.body.error).toMatch(/Attachment declares 33 bytes.*32-byte cap.*QBO_PDF_MAX_BYTES/);
    await expect(readFile(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serves qbo://company/{slug}/context through the registered handler", async () => {
    const response = await server.call("resources/read", {
      uri: `qbo://company/${SLUG}/context`,
    });
    expect(response.error).toBeUndefined();
    const context = JSON.parse(response.result.contents[0].text);
    expect(context.company).toMatchObject({
      slug: SLUG,
      realmId: REALM,
      company_name: "Tool Ergonomics Co",
      connection: "ok",
    });
    expect(context.capabilities).toMatchObject({ home_currency: "USD", book_close_date: "2026-06-30" });
    expect(context.operating_rules).toHaveProperty("tool_profile", "full");
  });
});
