// End-to-end contract test: spawn the real server, speak MCP over stdio, and
// assert what a client actually receives.
//
// Everything else in this suite tests helpers in isolation. This is the only
// test that exercises registration itself — the wiring where a bad import, a
// malformed schema, or a mis-derived annotation would go unnoticed until a
// human started Claude Desktop. It needs no QuickBooks credentials, because
// listing tools never calls Intuit.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { writeFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KNOWN_TOOL_NAMES } from "../src/tool-profiles.js";
import Ajv2020 from "ajv/dist/2020.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FULL_TOOL_COUNT = 118;

// Minimal JSON-RPC-over-stdio client: enough to initialize and list.
function startServer(env = {}) {
  const child = spawn(process.execPath, ["src/index.js"], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  const pending = new Map();
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const request = pending.get(msg.id);
      if (request) {
        pending.delete(msg.id);
        clearTimeout(request.timer);
        request.resolve(msg);
      }
    }
  });

  let nextId = 1;
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timed out waiting for ${method}`));
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

async function listTools(env = {}) {
  const server = startServer(env);
  try {
    await server.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "contract-test", version: "1" },
    });
    const res = await server.call("tools/list", {});
    return res.result.tools;
  } finally {
    await server.stop();
  }
}

async function initialize(server) {
  await server.call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "contract-test", version: "1" },
  });
}

async function callTool(server, name, args = {}) {
  const res = await server.call("tools/call", { name, arguments: args });
  let body;
  try { body = JSON.parse(res.result.content[0].text); } catch { body = null; }
  return { ...res.result, body };
}

describe("MCP server contract", () => {
  let tools;
  beforeAll(async () => { tools = await listTools({ QBO_TOOL_PROFILE: "full" }); }, 20_000);

  const byName = (n) => tools.find((t) => t.name === n);

  it("registers the full tool surface", () => {
    expect(tools).toHaveLength(FULL_TOOL_COUNT);
    expect(tools.map((tool) => tool.name).sort()).toEqual([...KNOWN_TOOL_NAMES].sort());
  });

  // Traversal reads the graph and changes nothing, so a host should be able to
  // auto-approve it alongside the other reads.
  it("treats the link traversal tool as a read", () => {
    expect(byName("get_transaction_links").annotations.readOnlyHint).toBe(true);
  });

  // The detail variants ride on the existing tools rather than adding four
  // more; the old save_path remains only as a migration sentinel that errors.
  it("offers detail and an explicit export migration on balance and valuation reports", () => {
    for (const n of ["get_customer_balance", "get_vendor_balance", "get_inventory_valuation"]) {
      const props = byName(n).inputSchema.properties;
      expect(Object.keys(props), n).toEqual(expect.arrayContaining(["detail", "save_path"]));
      expect(props.save_path.description, n).toMatch(/deprecated.*export_qbo_artifact/i);
    }
    expect(byName("export_qbo_artifact").inputSchema.required).toEqual(
      expect.arrayContaining(["artifact", "save_path"])
    );
  });

  // A detail report can exceed 900KB with no way to bound it by date, so the
  // escape hatch has to name the reports that have no tool of their own.
  it("points at the working reports that were deliberately not wrapped", () => {
    for (const n of ["api_get", "api_request"]) {
      for (const r of ["ClassSales", "DepartmentSales", "CustomerIncome"]) {
        expect(byName(n).description, `${n} should mention ${r}`).toContain(r);
      }
    }
  });

  it("gives every tool a title, non-empty description, and input schema", () => {
    const missing = tools.filter((t) =>
      !t.title || typeof t.description !== "string" || !t.description.trim()
      || !t.inputSchema || t.inputSchema.type !== "object"
    );
    expect(missing.map((t) => t.name)).toEqual([]);
  });

  // Without annotations a host cannot tell delete_transaction from
  // get_balance_sheet, so everything is presented to the user identically.
  it("annotates every tool", () => {
    expect(tools.filter((t) => !t.annotations).map((t) => t.name)).toEqual([]);
  });

  it("marks reads read-only and writes not", () => {
    expect(byName("get_balance_sheet").annotations.readOnlyHint).toBe(true);
    expect(byName("get_invoice_pdf").annotations.readOnlyHint).toBe(true);
    expect(byName("api_get").annotations.readOnlyHint).toBe(true);
    expect(byName("create_invoice").annotations.readOnlyHint).toBe(false);
    expect(byName("api_request").annotations.readOnlyHint).toBe(false);
  });

  it("marks named corrections and raw/batch escape hatches destructive", () => {
    expect(byName("delete_transaction").annotations.destructiveHint).toBe(true);
    expect(byName("void_invoice").annotations.destructiveHint).toBe(true);
    expect(byName("api_request").annotations.destructiveHint).toBe(true);
    expect(byName("execute_batch").annotations.destructiveHint).toBe(true);
    expect(byName("download_attachment").annotations.destructiveHint).toBe(true);
    expect(byName("create_invoice").annotations.destructiveHint).toBe(false);
    expect(byName("get_profit_and_loss").annotations.destructiveHint).toBe(false);
  });

  // These change state on this machine rather than in QuickBooks, so the
  // write-verb prefixes miss them; calling them read-only would be a lie.
  it("does not call local state mutators read-only", () => {
    for (const n of ["select_company", "set_company_policy", "register_client", "connect_company", "preview_bank_csv_import"]) {
      expect(byName(n).annotations.readOnlyHint, n).toBe(false);
    }
  });

  it("does not call local file writers read-only", () => {
    for (const n of ["export_qbo_artifact", "download_attachment"]) {
      expect(byName(n).annotations.readOnlyHint, n).toBe(false);
    }
  });

  it("makes company required in every ordinary write schema by default", () => {
    for (const n of ["create_invoice", "update_bill", "void_payment", "attach_file", "api_request"]) {
      expect(byName(n).inputSchema.required, n).toContain("company");
    }
    expect(byName("get_company_info").inputSchema.required || []).not.toContain("company");
  });

  it("offers exact replay only when one tool call maps to one QBO request", () => {
    for (const n of ["create_invoice", "create_bill", "update_bill", "void_payment", "attach_file", "execute_batch", "api_request"]) {
      expect(byName(n).inputSchema.properties.request_id, n).toBeTruthy();
    }
    for (const n of ["import_transactions_from_csv", "create_journal_entry_multi"]) {
      expect(byName(n).inputSchema.properties.request_id, n).toBeUndefined();
    }
    expect(byName("get_balance_sheet").inputSchema.properties.request_id).toBeUndefined();
    expect(byName("create_invoice").inputSchema.properties.request_id.maxLength).toBe(50);
    expect(byName("api_request").inputSchema.properties.request_id.maxLength).toBe(50);
    expect(byName("execute_batch").inputSchema.properties.request_id.maxLength).toBe(36);
  });

  it("keeps former composite convenience flags as safe migration sentinels", () => {
    expect(byName("create_invoice").inputSchema.properties.send_email).toMatchObject({ const: false });
    expect(byName("create_bill").inputSchema.properties.create_vendor_if_missing).toMatchObject({ const: false });
  });

  it("rejects legacy report save_path before fetching instead of silently ignoring it", async () => {
    const server = startServer({ QBO_TOOL_PROFILE: "full" });
    try {
      await initialize(server);
      const result = await callTool(server, "get_balance_sheet", {
        end_date: "2026-07-31",
        save_path: path.join(tmpdir(), "old-caller-report.json"),
      });
      expect(result.isError).toBe(true);
      expect(result.body.error).toMatch(/did not write a file.*export_qbo_artifact/is);
    } finally {
      await server.stop();
    }
  });

  it("splits CSV preview from posting so preview keeps read-style company resolution", () => {
    const preview = byName("preview_bank_csv_import");
    const importer = byName("import_transactions_from_csv");
    expect(preview.inputSchema.required || []).not.toContain("company");
    expect(preview.inputSchema.properties).not.toHaveProperty("dry_run");
    expect(preview.inputSchema.properties).not.toHaveProperty("request_id");
    expect(importer.inputSchema.required).toContain("company");
    expect(importer.inputSchema.properties).not.toHaveProperty("dry_run");
    expect(importer.inputSchema.properties).not.toHaveProperty("request_id");
  });

  it("keeps purely local context tools closed-world", () => {
    for (const n of ["list_companies", "get_active_company", "list_clients", "resolve_client", "get_company_policy", "list_unresolved_writes"]) {
      expect(byName(n).annotations.openWorldHint, n).toBe(false);
    }
  });

  it("returns server usage instructions during initialization", async () => {
    const server = startServer({ QBO_TOOL_PROFILE: "full" });
    try {
      const res = await server.call("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "contract-test", version: "1" },
      });
      expect(res.result.instructions).toMatch(/pass that company explicitly on every write/i);
    } finally {
      await server.stop();
    }
  });

  it("publishes output schemas for high-traffic tools", () => {
    for (const n of ["list_companies", "health_check", "resolve_client", "get_preferences", "get_transaction_links", "list_unresolved_writes"]) {
      expect(byName(n).outputSchema, n).toBeTruthy();
    }
  });

  it.each([["full", 10], ["", 9]])("publishes compilable 2020-12 output schemas for profile %s", async (profile, count) => {
    const listed = profile === "full" ? tools : await listTools({ QBO_TOOL_PROFILE: profile });
    const declared = listed.filter((tool) => Object.hasOwn(tool, "outputSchema"));
    expect(declared).toHaveLength(count);
    const ajv = new Ajv2020();
    for (const tool of declared) {
      expect(tool.outputSchema.$schema, tool.name).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(() => ajv.compile(tool.outputSchema), tool.name).not.toThrow();
    }
    const validate = ajv.compile(declared.find((tool) => tool.name === "list_clients").outputSchema);
    expect(validate({ count: 0, clients: [] })).toBe(true);
    expect(validate({ clients: [] })).toBe(false);
    expect(validate({ count: "0", clients: [] })).toBe(false);
  });

  it("returns MCP structuredContent while preserving the text fallback", async () => {
    const server = startServer({ QBO_TOOL_PROFILE: "full" });
    try {
      await initialize(server);
      const result = await callTool(server, "list_companies");
      expect(result.structuredContent).toMatchObject({ count: expect.any(Number), companies: expect.any(Array) });
      expect(result.body).toEqual(result.structuredContent);
    } finally {
      await server.stop();
    }
  }, 20_000);

  it("does not duplicate untyped payloads in structuredContent", async () => {
    const server = startServer({ QBO_TOOL_PROFILE: "full" });
    try {
      await initialize(server);
      const result = await callTool(server, "get_company_policy", {});
      expect(result.body).toMatchObject({ companies: expect.any(Array) });
      expect(result.structuredContent).toBeUndefined();
    } finally {
      await server.stop();
    }
  }, 20_000);

  it("returns honest untyped errors without claiming every failure is non-retryable", async () => {
    const server = startServer({ QBO_TOOL_PROFILE: "full" });
    try {
      await initialize(server);
      const result = await callTool(server, "get_preferences", { company: "definitely-not-connected-zzzz" });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(result.body).toMatchObject({ error: expect.stringMatching(/No such company/) });
      expect(result.body).not.toHaveProperty("retryable");
    } finally {
      await server.stop();
    }
  }, 20_000);

  it("reports the version from package.json, not a hardcoded string", async () => {
    const { version } = JSON.parse(
      await import("node:fs/promises").then((fs) => fs.readFile(path.join(ROOT, "package.json"), "utf8"))
    );
    const server = startServer({ QBO_TOOL_PROFILE: "full" });
    try {
      const res = await server.call("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "contract-test", version: "1" },
      });
      expect(res.result.serverInfo.version).toBe(version);
    } finally {
      await server.stop();
    }
  }, 20_000);
});

describe("MCP resources and prompts", () => {
  it("lists static and parameterized company context resources", async () => {
    const server = startServer({ QBO_TOOL_PROFILE: "full" });
    try {
      await initialize(server);
      const resources = await server.call("resources/list", {});
      expect(resources.result.resources.map((r) => r.uri)).toContain("qbo://companies");
      const templates = await server.call("resources/templates/list", {});
      expect(templates.result.resourceTemplates.map((r) => r.uriTemplate)).toContain("qbo://company/{slug}/context");
    } finally {
      await server.stop();
    }
  }, 20_000);

  it("offers portable accounting workflow prompts", async () => {
    const server = startServer({ QBO_TOOL_PROFILE: "full" });
    try {
      await initialize(server);
      const listed = await server.call("prompts/list", {});
      const names = listed.result.prompts.map((p) => p.name);
      for (const name of ["close-readiness-review", "business-health-brief", "collections-review", "transaction-explanation", "reconciliation-review"]) {
        expect(names, name).toContain(name);
      }
      const prompt = await server.call("prompts/get", {
        name: "close-readiness-review",
        arguments: { client: "acme", month: "2026-07", accounting_basis: "Accrual", materiality: "$1,000" },
      });
      expect(prompt.result.messages[0].content.text).toMatch(/Do not infer a tie-out that was not tested/);
    } finally {
      await server.stop();
    }
  }, 20_000);

  it("rejects malformed YYYY-MM prompt arguments", async () => {
    const server = startServer({ QBO_TOOL_PROFILE: "full" });
    try {
      await initialize(server);
      for (const [name, args] of [
        ["month-end-data-pack", { client: "acme", month: "2026-13" }],
        ["close-readiness-review", {
          client: "acme",
          month: "July 2026",
          accounting_basis: "Accrual",
          materiality: "$1,000",
        }],
      ]) {
        const response = await server.call("prompts/get", { name, arguments: args });
        expect(response.error, name).toBeTruthy();
        expect(JSON.stringify(response.error), name).toMatch(/month|invalid|format/i);
        expect(response.result, name).toBeUndefined();
      }
    } finally {
      await server.stop();
    }
  }, 20_000);

  it("advertises prompts only when the active profile exposes their required tools", async () => {
    const owner = startServer({ QBO_TOOL_PROFILE: "owner" });
    const admin = startServer({ QBO_TOOL_PROFILE: "admin" });
    try {
      await initialize(owner);
      await initialize(admin);
      const ownerNames = (await owner.call("prompts/list", {})).result.prompts.map((p) => p.name);
      expect(ownerNames).toEqual(["business-health-brief"]);
      const adminResult = await admin.call("prompts/list", {});
      expect(adminResult.result?.prompts ?? []).toEqual([]);
    } finally {
      await Promise.all([owner.stop(), admin.stop()]);
    }
  }, 20_000);
});

// The kill switches work by not registering tools at all, which is stronger
// than refusing them at call time — but it also means only a real listing can
// prove they took effect.
describe("MCP server kill switches", () => {
  it("hides every write tool under QBO_DISABLE_WRITES", async () => {
    const names = (await listTools({ QBO_TOOL_PROFILE: "full", QBO_DISABLE_WRITES: "true" })).map((t) => t.name);
    for (const n of ["create_invoice", "delete_transaction", "api_request", "execute_batch", "attach_file"]) {
      expect(names, n).not.toContain(n);
    }
    // Reads and the guardrail tools must survive, or a read-only deployment
    // cannot lock a company down.
    for (const n of ["get_balance_sheet", "api_get", "set_company_policy", "list_companies"]) {
      expect(names, n).toContain(n);
    }
  }, 20_000);

  it("hides only deletes and voids under QBO_DISABLE_DELETES", async () => {
    const names = (await listTools({ QBO_TOOL_PROFILE: "full", QBO_DISABLE_DELETES: "true" })).map((t) => t.name);
    for (const n of ["delete_transaction", "void_invoice", "void_payment", "void_sales_receipt"]) {
      expect(names, n).not.toContain(n);
    }
    for (const n of ["create_invoice", "get_balance_sheet"]) {
      expect(names, n).toContain(n);
    }
  }, 20_000);
});

describe("MCP startup tool profiles", () => {
  it("uses a bounded task-sized core profile by default", async () => {
    const tools = await listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("create_journal_entry");
    expect(names).toContain("get_consolidated_balance_sheet");
    expect(names).toContain("create_invoice");
    expect(names).toContain("create_bill_payment");
    const exportArtifacts = tools.find((tool) => tool.name === "export_qbo_artifact")
      .inputSchema.properties.artifact.enum;
    expect(exportArtifacts).toEqual(expect.arrayContaining(["invoice_pdf", "profit_and_loss", "general_ledger"]));
    expect(exportArtifacts).not.toEqual(expect.arrayContaining(["estimate_pdf", "inventory_valuation", "vendor_expenses"]));
    for (const n of ["query", "api_get", "api_request", "execute_batch", "delete_transaction", "connect_company"]) {
      expect(names, n).not.toContain(n);
    }
    // Prevent profile creep from silently returning to the former ~146 KB,
    // 100+ tool default. Both count and serialized wire size affect model
    // context and tool-selection quality.
    // One explicit exporter replaced dozens of mixed read/write report fields;
    // the single extra tool keeps those read contracts honest without adding a
    // separate exporter for every report and PDF.
    expect(names.length).toBeLessThanOrEqual(61);
    expect(Buffer.byteLength(JSON.stringify(tools), "utf8")).toBeLessThanOrEqual(100_000);
  }, 20_000);

  it("can expose only the owner-oriented surface", async () => {
    const tools = await listTools({ QBO_TOOL_PROFILE: "owner" });
    const names = tools.map((t) => t.name);
    expect(names).toContain("get_profit_and_loss");
    expect(names).toContain("create_invoice");
    expect(names).not.toContain("create_journal_entry");
    expect(names).not.toContain("set_company_policy");
    const exportArtifacts = tools.find((tool) => tool.name === "export_qbo_artifact")
      .inputSchema.properties.artifact.enum;
    expect(exportArtifacts).toContain("estimate_pdf");
    expect(exportArtifacts).not.toContain("general_ledger");
  }, 20_000);
});

describe("company response provenance", () => {
  async function writeTokenFixture(slug, realmId) {
    const future = Date.now() + 3_600_000;
    const tokenFile = path.join(process.env.QBO_TOKENS_DIR, `tokens.${slug}.json`);
    const tokenStage = `${tokenFile}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tokenStage, JSON.stringify({
      access_token: "test-access-token",
      refresh_token: "test-refresh-token",
      expires_at: future,
      realmId,
      environment: "sandbox",
    }));
    await rename(tokenStage, tokenFile);
    return tokenFile;
  }

  it("labels an explicit company with the slug and realm that served it", async () => {
    const fixture = await writeTokenFixture("provenance-a", "1000000000000001");
    const server = startServer();
    try {
      await initialize(server);
      const result = await callTool(server, "get_company_info", { company: "provenance-a" });
      expect(result.isError).toBe(true);
      expect(result.body.company_provenance).toEqual({
        slug: "provenance-a",
        realmId: "1000000000000001",
        source: "explicit",
      });
    } finally {
      await server.stop();
      await rm(fixture, { force: true });
    }
  }, 20_000);

  it("keeps select_company as a disclosed process default", async () => {
    const fixture = await writeTokenFixture("provenance-b", "1000000000000002");
    const server = startServer();
    try {
      await initialize(server);
      await callTool(server, "select_company", { company: "provenance-b" });
      const result = await callTool(server, "get_company_info");
      expect(result.isError).toBe(true);
      expect(result.body.company_provenance).toEqual({
        slug: "provenance-b",
        realmId: "1000000000000002",
        source: "process_default",
      });
    } finally {
      await server.stop();
      await rm(fixture, { force: true });
    }
  }, 20_000);

  it("fails when an explicit slug resolves to another company's realm", async () => {
    const original = await writeTokenFixture("provenance-a", "1000000000000001");
    const duplicate = await writeTokenFixture("provenance-mismatch", "1000000000000001");
    const server = startServer();
    try {
      await initialize(server);
      const result = await callTool(server, "get_company_info", { company: "provenance-mismatch" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/Resolved company mismatch/);
    } finally {
      await server.stop();
      await Promise.all([original, duplicate].map((file) => rm(file, { force: true })));
    }
  }, 20_000);
});
