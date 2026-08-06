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
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// Minimal JSON-RPC-over-stdio client: enough to initialize and list.
function startServer(env = {}) {
  const child = spawn(process.execPath, ["src/index.js"], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
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
      const resolve = pending.get(msg.id);
      if (resolve) { pending.delete(msg.id); resolve(msg); }
    }
  });

  let nextId = 1;
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), 10_000);
    });

  return { child, call, stop: () => child.kill() };
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
    server.stop();
  }
}

describe("MCP server contract", () => {
  let tools;
  beforeAll(async () => { tools = await listTools(); }, 20_000);

  const byName = (n) => tools.find((t) => t.name === n);

  it("registers the full tool surface", () => {
    expect(tools.length).toBe(115);
  });

  // Traversal reads the graph and changes nothing, so a host should be able to
  // auto-approve it alongside the other reads.
  it("treats the link traversal tool as a read", () => {
    expect(byName("get_transaction_links").annotations.readOnlyHint).toBe(true);
  });

  // The detail variants ride on the existing tools rather than adding four
  // more; if the flag stops being registered they silently become unreachable.
  it("offers detail and save_path on the balance and valuation reports", () => {
    for (const n of ["get_customer_balance", "get_vendor_balance", "get_inventory_valuation"]) {
      const props = byName(n).inputSchema.properties;
      expect(Object.keys(props), n).toEqual(expect.arrayContaining(["detail", "save_path"]));
    }
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

  it("gives every tool a description and an input schema", () => {
    const missing = tools.filter((t) => !t.description || !t.inputSchema);
    expect(missing.map((t) => t.name)).toEqual([]);
  });

  // Without annotations a host cannot tell delete_transaction from
  // get_balance_sheet, so everything is presented to the user identically.
  it("annotates every tool", () => {
    expect(tools.filter((t) => !t.annotations).map((t) => t.name)).toEqual([]);
  });

  it("marks reads read-only and writes not", () => {
    expect(byName("get_balance_sheet").annotations.readOnlyHint).toBe(true);
    expect(byName("api_get").annotations.readOnlyHint).toBe(true);
    expect(byName("create_invoice").annotations.readOnlyHint).toBe(false);
    expect(byName("api_request").annotations.readOnlyHint).toBe(false);
  });

  it("marks only deletes and voids destructive", () => {
    expect(byName("delete_transaction").annotations.destructiveHint).toBe(true);
    expect(byName("void_invoice").annotations.destructiveHint).toBe(true);
    expect(byName("create_invoice").annotations.destructiveHint).toBe(false);
    expect(byName("get_profit_and_loss").annotations.destructiveHint).toBe(false);
  });

  // These change state on this machine rather than in QuickBooks, so the
  // write-verb prefixes miss them; calling them read-only would be a lie.
  it("does not call local state mutators read-only", () => {
    for (const n of ["select_company", "set_company_policy", "register_client", "connect_company"]) {
      expect(byName(n).annotations.readOnlyHint, n).toBe(false);
    }
  });

  it("reports the version from package.json, not a hardcoded string", async () => {
    const { version } = JSON.parse(
      await import("node:fs/promises").then((fs) => fs.readFile(path.join(ROOT, "package.json"), "utf8"))
    );
    const server = startServer();
    try {
      const res = await server.call("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "contract-test", version: "1" },
      });
      expect(res.result.serverInfo.version).toBe(version);
    } finally {
      server.stop();
    }
  }, 20_000);
});

// The kill switches work by not registering tools at all, which is stronger
// than refusing them at call time — but it also means only a real listing can
// prove they took effect.
describe("MCP server kill switches", () => {
  it("hides every write tool under QBO_DISABLE_WRITES", async () => {
    const names = (await listTools({ QBO_DISABLE_WRITES: "true" })).map((t) => t.name);
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
    const names = (await listTools({ QBO_DISABLE_DELETES: "true" })).map((t) => t.name);
    for (const n of ["delete_transaction", "void_invoice", "void_payment", "void_sales_receipt"]) {
      expect(names, n).not.toContain(n);
    }
    for (const n of ["create_invoice", "get_balance_sheet"]) {
      expect(names, n).toContain(n);
    }
  }, 20_000);
});
