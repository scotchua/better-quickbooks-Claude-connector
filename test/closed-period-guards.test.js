// End-to-end closed-period regressions. The real MCP server runs in a child
// process with a tiny fetch preload standing in for Intuit, so these tests cover
// the actual tool handlers and prove the guarded POST is never reached.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SLUG = "closed-period-guard-test";
const REALM = "987654321098765";
const TOKEN_FILE = path.join(ROOT, `tokens.${SLUG}.json`);

function startServer(preload, tempDir, extraEnv = {}) {
  const child = spawn(process.execPath, ["--import", preload, "src/index.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      QBO_TOOL_PROFILE: "full",
      QBO_CLOSED_PERIOD: "block",
      QBO_TOKEN_ENCRYPTION: "off",
      QBO_POLICY_FILE: path.join(tempDir, "no-policy.json"),
      QBO_AUDIT_DIR: path.join(tempDir, "audit"),
      ...extraEnv,
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
    clientInfo: { name: "closed-period-test", version: "1" },
  });
  if (response.error) throw new Error(response.error.message);
}

async function callTool(server, name, args) {
  const response = await server.call("tools/call", { name, arguments: args });
  if (response.error) throw new Error(response.error.message);
  const result = response.result;
  let body;
  try { body = JSON.parse(result.content[0].text); } catch { body = {}; }
  return { ...result, body };
}

describe("closed-period update guards", () => {
  let tempDir;
  let preload;
  let oldPeriodServer;
  let openPeriodServer;
  let missingLookupServer;
  let missingDateServer;
  let nonPostingServer;
  let amountPolicyServer;
  let aggregateAmountPolicyServer;
  let futureDateFloorServer;

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "qbo-closed-period-"));
    preload = path.join(tempDir, "mock-qbo-fetch.mjs");
    await writeFile(preload, `
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", intuit_tid: "closed-period-test-tid" },
});
const existingDate = process.env.QBO_TEST_EXISTING_DATE || "2026-01-15";
const lookupScenario = process.env.QBO_TEST_LOOKUP_SCENARIO || "found";
const allowedWriteEntities = (process.env.QBO_TEST_ALLOW_WRITE_ENTITY || "").split(",").filter(Boolean);
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const method = String(init.method || "GET").toUpperCase();
  const marker = "/v3/company/";
  const companyIndex = url.pathname.indexOf(marker);
  const afterCompany = companyIndex < 0 ? url.pathname : url.pathname.slice(companyIndex + marker.length);
  const slash = afterCompany.indexOf("/");
  const endpoint = slash < 0 ? "/" : afterCompany.slice(slash);

  if (method !== "GET") {
    const allowedWriteEntity = allowedWriteEntities.find((name) => endpoint.startsWith("/" + name));
    if (allowedWriteEntity) {
      const entity = allowedWriteEntity === "changeorder"
        ? "ChangeOrder"
        : allowedWriteEntity[0].toUpperCase() + allowedWriteEntity.slice(1);
      return json({ [entity]: { Id: "9", SyncToken: "1", TxnDate: existingDate } });
    }
    return json({ Fault: { Error: [{ Message: "UNEXPECTED_QBO_WRITE", Detail: endpoint }] } }, 409);
  }
  if (endpoint.startsWith("/preferences")) {
    return json({ Preferences: { AccountingInfoPrefs: { BookCloseDate: "2026-01-31" } } });
  }
  if (endpoint.startsWith("/journalentry/")) {
    if (lookupScenario === "missing") return json({});
    return json({ JournalEntry: {
      Id: "9", SyncToken: "0", TxnDate: existingDate,
      Line: [
        { Amount: 25, JournalEntryLineDetail: { PostingType: "Debit" } },
        { Amount: 25, JournalEntryLineDetail: { PostingType: "Credit" } },
      ],
    } });
  }
  if (endpoint.startsWith("/inventoryadjustment/")) {
    if (lookupScenario === "missing") return json({});
    return json({ InventoryAdjustment: { Id: "9", SyncToken: "0", TxnDate: existingDate, Line: [] } });
  }
  if (endpoint.startsWith("/creditcardpayment/")) {
    if (lookupScenario === "missing") return json({});
    return json({ CreditCardPaymentTxn: { Id: "9", SyncToken: "0", TxnDate: existingDate, Amount: 25 } });
  }
  if (endpoint.startsWith("/changeorder/")) {
    if (lookupScenario === "missing") return json({});
    return json({ ChangeOrder: { Id: "9", SyncToken: "0", TxnDate: existingDate } });
  }
  if (endpoint.startsWith("/query")) {
    const sql = url.searchParams.get("query") || "";
    const entity = /\\bFROM\\s+([A-Za-z]+)/i.exec(sql)?.[1] || "Invoice";
    if (["InventoryAdjustment", "ChangeOrder"].includes(entity)) {
      return json({ Fault: { Error: [{ Message: entity + " is not queryable" }] } }, 400);
    }
    if (lookupScenario === "missing") return json({ QueryResponse: {} });
    const record = {
      Id: "9",
      SyncToken: "0",
      TxnDate: existingDate,
      TotalAmt: 25,
      PaymentType: "Check",
      AccountRef: { value: "1" },
      VendorRef: { value: "2" },
    };
    if (entity === "JournalEntry") {
      delete record.TotalAmt;
      record.Line = [
        { Amount: 25, JournalEntryLineDetail: { PostingType: "Debit" } },
        { Amount: 25, JournalEntryLineDetail: { PostingType: "Credit" } },
      ];
    }
    return json({ QueryResponse: entity === "CreditCardPayment"
      ? { CreditCardPaymentTxn: [record] }
      : { [entity]: [record] } });
  }
  return json({ Fault: { Error: [{ Message: "Unexpected mock GET", Detail: endpoint }] } }, 404);
};
`, { mode: 0o600 });

    const tokenStage = `${TOKEN_FILE}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tokenStage, JSON.stringify({
      access_token: "closed-period-test-token",
      refresh_token: "closed-period-test-refresh",
      expires_at: Date.now() + 3_600_000,
      refresh_expires_at: Date.now() + 86_400_000,
      realmId: REALM,
      environment: "sandbox",
    }), { mode: 0o600 });
    await rename(tokenStage, TOKEN_FILE);

    oldPeriodServer = startServer(preload, tempDir, { QBO_TEST_EXISTING_DATE: "2026-01-15" });
    openPeriodServer = startServer(preload, tempDir, { QBO_TEST_EXISTING_DATE: "2026-02-15" });
    missingLookupServer = startServer(preload, tempDir, { QBO_TEST_LOOKUP_SCENARIO: "missing" });
    missingDateServer = startServer(preload, tempDir, { QBO_TEST_EXISTING_DATE: "missing" });
    nonPostingServer = startServer(preload, tempDir, {
      QBO_TEST_EXISTING_DATE: "2026-01-15",
      QBO_TEST_ALLOW_WRITE_ENTITY: "estimate,changeorder",
    });
    const amountPolicyFile = path.join(tempDir, "amount-policy.json");
    await writeFile(amountPolicyFile, JSON.stringify({ defaults: { max_write_amount: 10 }, companies: {} }));
    amountPolicyServer = startServer(preload, tempDir, {
      QBO_CLOSED_PERIOD: "off",
      QBO_POLICY_FILE: amountPolicyFile,
      QBO_TEST_EXISTING_DATE: "2026-02-15",
    });
    const aggregateAmountPolicyFile = path.join(tempDir, "aggregate-amount-policy.json");
    await writeFile(aggregateAmountPolicyFile, JSON.stringify({ defaults: { max_write_amount: 40 }, companies: {} }));
    aggregateAmountPolicyServer = startServer(preload, tempDir, {
      QBO_CLOSED_PERIOD: "off",
      QBO_POLICY_FILE: aggregateAmountPolicyFile,
      QBO_TEST_EXISTING_DATE: "2026-02-15",
    });
    const futureDateFloorPolicyFile = path.join(tempDir, "future-date-floor-policy.json");
    await writeFile(futureDateFloorPolicyFile, JSON.stringify({ defaults: { min_txn_date: "9999-12-31" }, companies: {} }));
    futureDateFloorServer = startServer(preload, tempDir, {
      QBO_CLOSED_PERIOD: "off",
      QBO_POLICY_FILE: futureDateFloorPolicyFile,
      QBO_TEST_EXISTING_DATE: "2026-02-15",
    });
    await Promise.all([
      initialize(oldPeriodServer), initialize(openPeriodServer), initialize(missingLookupServer), initialize(missingDateServer),
      initialize(nonPostingServer),
      initialize(amountPolicyServer),
      initialize(aggregateAmountPolicyServer),
      initialize(futureDateFloorServer),
    ]);
  }, 20_000);

  afterAll(async () => {
    await Promise.all([
      oldPeriodServer, openPeriodServer, missingLookupServer, missingDateServer,
      nonPostingServer, amountPolicyServer, futureDateFloorServer,
      aggregateAmountPolicyServer,
    ].filter(Boolean).map((server) => server.stop()));
    await rm(TOKEN_FILE, { force: true });
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  const movedNamedUpdates = [
    ["update_journal_entry", {
      journal_entry_id: "9",
      lines: [
        { account: "1", amount: 25, posting_type: "Debit" },
        { account: "2", amount: 25, posting_type: "Credit" },
      ],
      txn_date: "2026-02-15",
    }],
    ["update_sales_receipt", { sales_receipt_id: "9", txn_date: "2026-02-15", memo: "move" }],
    ["update_purchase", { purchase_id: "9", txn_date: "2026-02-15", memo: "move" }],
    ["update_bill", { bill_id: "9", txn_date: "2026-02-15", memo: "move" }],
  ];

  it.each(movedNamedUpdates)("blocks %s when its existing date is closed even if its resulting date is open", async (name, args) => {
    const result = await callTool(oldPeriodServer, name, { ...args, company: SLUG });
    expect(result.isError).toBe(true);
    expect(result.body.error).toMatch(/Books are closed through 2026-01-31/);
    expect(result.body.error).toContain("2026-01-15");
    expect(result.body.error).not.toContain("UNEXPECTED_QBO_WRITE");
  });

  it("keeps an unchanged sparse invoice update gated by its existing date", async () => {
    const result = await callTool(oldPeriodServer, "update_invoice", {
      invoice_id: "9", memo: "closed-period edit", company: SLUG,
    });
    expect(result.isError).toBe(true);
    expect(result.body.error).toContain("2026-01-15");
    expect(result.body.error).not.toContain("UNEXPECTED_QBO_WRITE");
  });

  it("blocks a raw update against both the existing and resulting dates", async () => {
    const sourceResult = await callTool(oldPeriodServer, "api_request", {
      path: "/invoice",
      method: "POST",
      body: { Id: "9", SyncToken: "0", sparse: true, TxnDate: "2026-02-15" },
      company: SLUG,
    });
    expect(sourceResult.isError).toBe(true);
    expect(sourceResult.body.error).toContain("2026-01-15");

    const destinationResult = await callTool(openPeriodServer, "api_request", {
      path: "/invoice",
      method: "POST",
      body: { Id: "9", SyncToken: "0", sparse: true, TxnDate: "2026-01-20" },
      company: SLUG,
    });
    expect(destinationResult.isError).toBe(true);
    expect(destinationResult.body.error).toContain("2026-01-20");
    expect(destinationResult.body.error).not.toContain("UNEXPECTED_QBO_WRITE");
  });

  it("applies the same raw update guard to InventoryAdjustment", async () => {
    const result = await callTool(oldPeriodServer, "api_request", {
      path: "/inventoryadjustment",
      method: "POST",
      body: { Id: "9", SyncToken: "0", sparse: true, TxnDate: "2026-02-15" },
      company: SLUG,
    });
    expect(result.isError).toBe(true);
    expect(result.body.error).toContain("2026-01-15");
    expect(result.body.error).not.toContain("UNEXPECTED_QBO_WRITE");
  });

  it("uses the CreditCardPaymentTxn direct-read envelope for card-payment updates", async () => {
    const result = await callTool(oldPeriodServer, "api_request", {
      path: "/creditcardpayment",
      method: "POST",
      body: { Id: "9", SyncToken: "0", sparse: true, TxnDate: "2026-02-15" },
      company: SLUG,
    });
    expect(result.isError).toBe(true);
    expect(result.body.error).toContain("2026-01-15");
    expect(result.body.error).not.toContain("UNEXPECTED_QBO_WRITE");
  });

  it("does not apply the QBO book-close gate to non-posting estimates", async () => {
    const result = await callTool(nonPostingServer, "api_request", {
      path: "/estimate",
      method: "POST",
      body: { Id: "9", SyncToken: "0", sparse: true, TxnDate: "2026-01-15" },
      company: SLUG,
    });
    expect(result.isError).not.toBe(true);
    expect(result.body.Estimate?.Id).toBe("9");
  });

  it("direct-reads non-queryable ChangeOrder for source-date policy without book-close blocking", async () => {
    const result = await callTool(nonPostingServer, "api_request", {
      path: "/changeorder",
      method: "POST",
      body: { Id: "9", SyncToken: "0", TxnDate: "2026-02-15" },
      company: SLUG,
    });
    expect(result.isError).not.toBe(true);
    expect(result.body.ChangeOrder?.Id).toBe("9");
  });

  it("applies max_write_amount to the current value of sparse updates", async () => {
    const named = await callTool(amountPolicyServer, "update_invoice", {
      invoice_id: "9", memo: "edit a material invoice", company: SLUG,
    });
    expect(named.isError).toBe(true);
    expect(named.body.error).toMatch(/totals 25\.00.*limit of 10/i);

    const estimate = await callTool(amountPolicyServer, "update_estimate", {
      estimate_id: "9", memo: "edit a material estimate", company: SLUG,
    });
    expect(estimate.isError).toBe(true);
    expect(estimate.body.error).toMatch(/totals 25\.00.*limit of 10/i);

    const raw = await callTool(amountPolicyServer, "api_request", {
      path: "/creditcardpayment",
      method: "POST",
      body: { Id: "9", SyncToken: "0", sparse: true, PrivateNote: "material edit" },
      company: SLUG,
    });
    expect(raw.isError).toBe(true);
    expect(raw.body.error).toMatch(/totals 25\.00.*limit of 10/i);

    const batch = await callTool(amountPolicyServer, "execute_batch", {
      operations: [{
        operation: "update",
        entity: "Invoice",
        body: { Id: "9", SyncToken: "0", sparse: true, PrivateNote: "material edit" },
      }],
      company: SLUG,
    });
    expect(batch.isError).toBe(true);
    expect(batch.body.error).toMatch(/totals 25\.00.*limit of 10/i);

    const journalUpdate = await callTool(amountPolicyServer, "update_journal_entry", {
      journal_entry_id: "9",
      lines: [
        { account: "1", amount: 5, posting_type: "Debit" },
        { account: "2", amount: 5, posting_type: "Credit" },
      ],
      company: SLUG,
    });
    expect(journalUpdate.isError).toBe(true);
    expect(journalUpdate.body.error).toMatch(/totals 25\.00.*limit of 10/i);
    expect(journalUpdate.body.error).not.toContain("UNEXPECTED_QBO_WRITE");

    const journalDelete = await callTool(amountPolicyServer, "delete_transaction", {
      entity: "JournalEntry", transaction_id: "9", company: SLUG,
    });
    expect(journalDelete.isError).toBe(true);
    expect(journalDelete.body.error).toMatch(/totals 25\.00.*limit of 10/i);
    expect(journalDelete.body.error).not.toContain("UNEXPECTED_QBO_WRITE");
  });

  it("applies max_write_amount to the aggregate current value of a sparse batch", async () => {
    const result = await callTool(aggregateAmountPolicyServer, "execute_batch", {
      operations: ["9", "10"].map((Id) => ({
        operation: "update",
        entity: "Invoice",
        body: { Id, SyncToken: "0", sparse: true, PrivateNote: "material edit" },
      })),
      company: SLUG,
    });
    expect(result.isError).toBe(true);
    expect(result.body.error).toMatch(/totals 50\.00.*limit of 40/i);
    expect(result.body.error).not.toContain("UNEXPECTED_QBO_WRITE");
  });

  it("requires a valid explicit TxnDate when a posting create is subject to min_txn_date", async () => {
    const named = await callTool(futureDateFloorServer, "create_journal_entry", {
      lines: [
        { account: "1", amount: 5, posting_type: "Debit" },
        { account: "2", amount: 5, posting_type: "Credit" },
      ],
      company: SLUG,
    });
    expect(named.isError).toBe(true);
    expect(named.body.error).toMatch(/omitted TxnDate.*date floor 9999-12-31.*Supply TxnDate explicitly as YYYY-MM-DD/is);
    expect(named.body.error).not.toContain("UNEXPECTED_QBO_WRITE");

    const raw = await callTool(futureDateFloorServer, "api_request", {
      path: "/invoice",
      method: "POST",
      body: { CustomerRef: { value: "1" }, Line: [] },
      company: SLUG,
    });
    expect(raw.isError).toBe(true);
    expect(raw.body.error).toMatch(/omitted TxnDate.*date floor 9999-12-31.*Supply TxnDate explicitly as YYYY-MM-DD/is);
    expect(raw.body.error).not.toContain("UNEXPECTED_QBO_WRITE");

    const batch = await callTool(futureDateFloorServer, "execute_batch", {
      operations: [{
        operation: "create",
        entity: "Bill",
        body: { VendorRef: { value: "1" }, Line: [] },
      }],
      company: SLUG,
    });
    expect(batch.isError).toBe(true);
    expect(batch.body.error).toMatch(/omitted TxnDate.*date floor 9999-12-31.*Supply TxnDate explicitly as YYYY-MM-DD/is);
    expect(batch.body.error).not.toContain("UNEXPECTED_QBO_WRITE");

    const invalidRaw = await callTool(futureDateFloorServer, "api_request", {
      path: "/invoice",
      method: "POST",
      body: { TxnDate: "not-a-date", CustomerRef: { value: "1" }, Line: [] },
      company: SLUG,
    });
    expect(invalidRaw.isError).toBe(true);
    expect(invalidRaw.body.error).toMatch(/invalid TxnDate.*date floor 9999-12-31.*invalid values are refused/is);
    expect(invalidRaw.body.error).not.toContain("UNEXPECTED_QBO_WRITE");

    const invalidBatch = await callTool(futureDateFloorServer, "execute_batch", {
      operations: [{
        operation: "create",
        entity: "Bill",
        body: { TxnDate: "2026-02-30", VendorRef: { value: "1" }, Line: [] },
      }],
      company: SLUG,
    });
    expect(invalidBatch.isError).toBe(true);
    expect(invalidBatch.body.error).toMatch(/invalid TxnDate.*date floor 9999-12-31.*invalid values are refused/is);
    expect(invalidBatch.body.error).not.toContain("UNEXPECTED_QBO_WRITE");
  });

  it("does not guess a UTC date for undated posting creates in closed-period block mode", async () => {
    const named = await callTool(openPeriodServer, "create_journal_entry", {
      lines: [
        { account: "1", amount: 5, posting_type: "Debit" },
        { account: "2", amount: 5, posting_type: "Credit" },
      ],
      company: SLUG,
    });
    expect(named.isError).toBe(true);
    expect(named.body.error).toMatch(/no valid explicit TxnDate.*server time.*timezone.*QBO_CLOSED_PERIOD=block/is);
    expect(named.body.error).not.toContain("UNEXPECTED_QBO_WRITE");

    const raw = await callTool(openPeriodServer, "api_request", {
      path: "/invoice",
      method: "POST",
      body: { CustomerRef: { value: "1" }, Line: [] },
      company: SLUG,
    });
    expect(raw.isError).toBe(true);
    expect(raw.body.error).toMatch(/no valid explicit TxnDate.*server time.*timezone.*QBO_CLOSED_PERIOD=block/is);
    expect(raw.body.error).not.toContain("UNEXPECTED_QBO_WRITE");

    const batch = await callTool(openPeriodServer, "execute_batch", {
      operations: [{
        operation: "create",
        entity: "Bill",
        body: { VendorRef: { value: "1" }, Line: [] },
      }],
      company: SLUG,
    });
    expect(batch.isError).toBe(true);
    expect(batch.body.error).toMatch(/no valid explicit TxnDate.*server time.*timezone.*QBO_CLOSED_PERIOD=block/is);
    expect(batch.body.error).not.toContain("UNEXPECTED_QBO_WRITE");
  });

  it("fails closed for inventory adjustments when a monetary ceiling cannot be evaluated", async () => {
    const result = await callTool(amountPolicyServer, "api_request", {
      path: "/inventoryadjustment",
      method: "POST",
      body: {
        TxnDate: "2026-02-15",
        Line: [{ DetailType: "ItemAdjustmentLineDetail", ItemAdjustmentLineDetail: { QtyDiff: -1 } }],
      },
      company: SLUG,
    });
    expect(result.isError).toBe(true);
    expect(result.body.error).toMatch(/InventoryAdjustment.*max_write_amount=10.*No QuickBooks write was sent/is);
    expect(result.body.error).not.toContain("UNEXPECTED_QBO_WRITE");
  });

  it("prefetches a batch sparse-update target and blocks its existing closed date", async () => {
    const result = await callTool(oldPeriodServer, "execute_batch", {
      operations: [{
        operation: "update",
        entity: "Invoice",
        body: { Id: "9", SyncToken: "0", sparse: true, PrivateNote: "undated edit" },
      }],
      company: SLUG,
    });
    expect(result.isError).toBe(true);
    expect(result.body.error).toContain("2026-01-15");
    expect(result.body.error).not.toContain("UNEXPECTED_QBO_WRITE");
  });

  it("fails closed when a raw update's current transaction cannot be found", async () => {
    const result = await callTool(missingLookupServer, "api_request", {
      path: "/invoice",
      method: "POST",
      body: { Id: "9", SyncToken: "0", sparse: true, TxnDate: "2026-02-15" },
      company: SLUG,
    });
    expect(result.isError).toBe(true);
    expect(result.body.error).toMatch(/current transaction lookup failed/i);
    expect(result.body.error).toMatch(/No QuickBooks write was sent/i);
    expect(result.body.error).not.toContain("UNEXPECTED_QBO_WRITE");
  });

  it("fails closed when the current transaction has no valid TxnDate", async () => {
    const result = await callTool(missingDateServer, "api_request", {
      path: "/invoice",
      method: "POST",
      body: { Id: "9", SyncToken: "0", sparse: true, TxnDate: "2026-02-15" },
      company: SLUG,
    });
    expect(result.isError).toBe(true);
    expect(result.body.error).toMatch(/current TxnDate is missing or invalid/i);
    expect(result.body.error).toMatch(/No QuickBooks write was sent/i);
    expect(result.body.error).not.toContain("UNEXPECTED_QBO_WRITE");
  });

  it("fails closed on missing source dates before named voids and deletes", async () => {
    const voided = await callTool(missingDateServer, "void_invoice", {
      invoice_id: "9", company: SLUG,
    });
    expect(voided.isError).toBe(true);
    expect(voided.body.error).toMatch(/current TxnDate is missing or invalid/i);
    expect(voided.body.error).not.toContain("UNEXPECTED_QBO_WRITE");

    const deleted = await callTool(missingDateServer, "delete_transaction", {
      entity: "Invoice", transaction_id: "9", company: SLUG,
    });
    expect(deleted.isError).toBe(true);
    expect(deleted.body.error).toMatch(/current TxnDate is missing or invalid/i);
    expect(deleted.body.error).not.toContain("UNEXPECTED_QBO_WRITE");
  });

  it("fails closed when a batch transaction update cannot be looked up or omits Id", async () => {
    const missing = await callTool(missingLookupServer, "execute_batch", {
      operations: [{
        operation: "update",
        entity: "Invoice",
        body: { Id: "9", SyncToken: "0", sparse: true, TxnDate: "2026-02-15" },
      }],
      company: SLUG,
    });
    expect(missing.isError).toBe(true);
    expect(missing.body.error).toMatch(/current transaction lookup failed/i);
    expect(missing.body.error).not.toContain("UNEXPECTED_QBO_WRITE");

    const noId = await callTool(oldPeriodServer, "execute_batch", {
      operations: [{
        operation: "update",
        entity: "Invoice",
        body: { sparse: true, TxnDate: "2026-02-15" },
      }],
      company: SLUG,
    });
    expect(noId.isError).toBe(true);
    expect(noId.body.error).toMatch(/missing Id/);
    expect(noId.body.error).toMatch(/No QuickBooks write was sent/i);
  });

  it("refuses unaudited batch entities and raw Item writes before any POST", async () => {
    const unknown = await callTool(openPeriodServer, "execute_batch", {
      operations: [{ operation: "create", entity: "NovelPostingEntity", body: { Amount: 1 } }],
      company: SLUG,
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.body.error).toMatch(/not in the connector's audited.*allowlist/is);
    expect(unknown.body.error).not.toContain("UNEXPECTED_QBO_WRITE");

    const unknownRaw = await callTool(openPeriodServer, "api_request", {
      path: "/novelpostingentity",
      method: "POST",
      body: { Amount: 1 },
      company: SLUG,
    });
    expect(unknownRaw.isError).toBe(true);
    expect(unknownRaw.body.error).toMatch(/not in the connector's audited.*allowlist.*No QuickBooks write was sent/is);
    expect(unknownRaw.body.error).not.toContain("UNEXPECTED_QBO_WRITE");

    const inventoryBatch = await callTool(openPeriodServer, "execute_batch", {
      operations: [{
        operation: "create",
        entity: "Item",
        body: { Type: "Inventory", InvStartDate: "2026-01-15", QtyOnHand: 3, PurchaseCost: 20 },
      }],
      company: SLUG,
    });
    expect(inventoryBatch.isError).toBe(true);
    expect(inventoryBatch.body.error).toMatch(/Item.*not in the connector's audited.*allowlist/is);
    expect(inventoryBatch.body.error).not.toContain("UNEXPECTED_QBO_WRITE");

    const inventoryRaw = await callTool(openPeriodServer, "api_request", {
      path: "/item",
      method: "POST",
      body: { Type: "Inventory", InvStartDate: "2026-01-15", QtyOnHand: 3, PurchaseCost: 20 },
      company: SLUG,
    });
    expect(inventoryRaw.isError).toBe(true);
    expect(inventoryRaw.body.error).toMatch(/Raw Item writes are refused.*opening-balance transaction.*No QuickBooks write was sent/is);
    expect(inventoryRaw.body.error).not.toContain("UNEXPECTED_QBO_WRITE");

    for (const [entity, body] of [
      ["Account", { Name: "Unsafe", AccountType: "Bank", OpeningBalance: 100000, OpeningBalanceDate: "2026-01-15" }],
      ["Customer", { DisplayName: "Unsafe", Balance: 100000, OpenBalanceDate: "2026-01-15" }],
      ["Vendor", { DisplayName: "Unsafe", Balance: 100000, OpenBalanceDate: "2026-01-15" }],
    ]) {
      const batchOpeningBalance = await callTool(openPeriodServer, "execute_batch", {
        operations: [{ operation: "create", entity, body }],
        company: SLUG,
      });
      expect(batchOpeningBalance.isError, entity).toBe(true);
      expect(batchOpeningBalance.body.error, entity).toMatch(/not in the connector's audited.*allowlist/is);
      expect(batchOpeningBalance.body.error, entity).not.toContain("UNEXPECTED_QBO_WRITE");

      const rawOpeningBalance = await callTool(openPeriodServer, "api_request", {
        path: `/${entity.toLowerCase()}`,
        method: "POST",
        body,
        company: SLUG,
      });
      expect(rawOpeningBalance.isError, entity).toBe(true);
      expect(rawOpeningBalance.body.error, entity).toMatch(/not in the connector's audited.*allowlist.*No QuickBooks write was sent/is);
      expect(rawOpeningBalance.body.error, entity).not.toContain("UNEXPECTED_QBO_WRITE");
    }
  });
});
