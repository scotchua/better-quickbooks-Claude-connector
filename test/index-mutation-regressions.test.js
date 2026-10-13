import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const state = vi.hoisted(() => ({ requests: [], closedDates: [], currentDate: "2026-04-12", batchFault: false }));

vi.mock("../src/qbo.js", async (importOriginal) => ({
  ...await importOriginal(),
  listCompanies: async () => [{ slug: "willow-lantern", realmId: "123456789", environment: "sandbox" }],
  getValidTokens: async () => ({ realmId: "123456789", environment: "sandbox" }),
  qboRequest: async (path) => {
    state.requests.push(path);
    if (path.startsWith("/reports/")) return { Header: { ReportName: "ProfitAndLoss" }, Rows: { Row: [] } };
    if (path === "/preferences") return { Preferences: { AccountingInfoPrefs: { BookCloseDate: null } } };
    if (path === "/batch") return state.batchFault
      ? { BatchItemResponse: [{ bId: "bid0", Fault: { Error: [{ Message: "Declined" }] } }] }
      : { BatchItemResponse: [{ bId: "bid0", Class: { Id: "71" }, Invoice: { Id: "72" } }] };
    return { Class: { Id: "71" }, Estimate: { Id: "42" } };
  },
  qboRequestBinary: async () => Buffer.alloc(8),
}));

vi.mock("../src/entities.js", async (importOriginal) => ({
  ...await importOriginal(),
  fetchEntity: async () => ({ Id: "42", SyncToken: "0", TxnDate: state.currentDate, TotalAmt: 5 }),
  closedPeriodWarnings: async (_company, dates) => {
    state.closedDates.push(dates);
    return ["closed-period warning"];
  },
}));

vi.mock("../src/policy.js", async (importOriginal) => ({
  ...await importOriginal(),
  checkWritePolicy: async () => {},
  policyFor: async () => ({ max_write_amount: 10 }),
}));

const handlers = new Map();

async function call(name, args = {}) {
  const result = await handlers.get(name)(args);
  const body = JSON.parse(result.content[0].text);
  return { ...result, body };
}

beforeAll(async () => {
  process.env.QBO_TOOL_PROFILE = "full";
  process.env.QBO_DISABLE_WRITES = "false";
  process.env.QBO_PDF_MAX_INLINE_BYTES = "8";
  const register = McpServer.prototype.registerTool;
  const registerSpy = vi.spyOn(McpServer.prototype, "registerTool").mockImplementation(function (name, config, handler) {
    handlers.set(name, handler);
    return register.call(this, name, config, handler);
  });
  const connectSpy = vi.spyOn(McpServer.prototype, "connect").mockResolvedValue();
  const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await import("../src/index.js");
  } finally {
    registerSpy.mockRestore();
    connectSpy.mockRestore();
    logSpy.mockRestore();
  }
});

beforeEach(() => {
  state.requests.length = 0;
  state.closedDates.length = 0;
  state.currentDate = "2026-04-12";
  state.batchFault = false;
});

describe("strictBooleanEnv", () => {
  it("keeps writes registered when QBO_DISABLE_WRITES is false", () => {
    expect(handlers.has("create_invoice")).toBe(true);
  });
});

describe("assertDateRangeOrMacro", () => {
  it("rejects a macro combined with only an end date", async () => {
    const result = await call("get_profit_and_loss", { end_date: "2026-04-30", date_macro: "Last Month" });
    expect(result.isError).toBe(true);
    expect(result.body.error).toMatch(/either both start_date and end_date, or date_macro/);
    expect(state.requests).toEqual([]);
  });
});

describe("reportQuery", () => {
  it("omits absent optional report parameters", async () => {
    const result = await call("get_profit_and_loss", {
      start_date: "2026-04-01", end_date: "2026-04-30", company: "willow-lantern",
    });
    expect(result.isError).not.toBe(true);
    expect(state.requests).toEqual(["/reports/ProfitAndLoss?start_date=2026-04-01&end_date=2026-04-30"]);
  });
});

describe("resolveCompany", () => {
  it("allows a read to use the sole connected company", async () => {
    const result = await call("get_preferences", {});
    expect(result.isError).not.toBe(true);
    expect(result.body.company).toBe("willow-lantern");
  });
});

describe("pdfReadResult", () => {
  it("accepts a PDF exactly at the inline byte cap", async () => {
    const result = await call("get_invoice_pdf", { invoice_id: "42", company: "willow-lantern" });
    expect(result.isError).not.toBe(true);
    expect(result.content[1].resource.blob).toBe(Buffer.alloc(8).toString("base64"));
  });
});

describe("batchEntityIsAudited", () => {
  it("accepts an audited nontransaction Class create", async () => {
    const result = await call("execute_batch", {
      operations: [{ operation: "create", entity: "Class", body: { Name: "Willow Design" } }],
      company: "willow-lantern",
    });
    expect(result.isError).not.toBe(true);
    expect(state.requests).toContain("/batch");
  });
});

describe("transactionEntity", () => {
  it("checks the source date of a raw estimate update", async () => {
    state.currentDate = "invalid-date";
    const result = await call("api_request", {
      path: "/estimate", method: "POST",
      body: { Id: "42", TxnDate: "2026-04-12" }, company: "willow-lantern",
    });
    expect(result.isError).toBe(true);
    expect(result.body.error).toMatch(/current TxnDate is missing or invalid/);
    expect(state.requests).toEqual([]);
  });
});

describe("gateBatchExistingTransactions", () => {
  it("does not fetch a current record for a batch create", async () => {
    const result = await call("execute_batch", {
      operations: [{ operation: "create", entity: "Invoice", body: { TxnDate: "2026-04-12", TotalAmt: 5 } }],
      company: "willow-lantern",
    });
    expect(result.isError).not.toBe(true);
    expect(state.requests).toContain("/batch");
  });
});

describe("execute_batch", () => {
  it("subtracts failed operations from the succeeded count", async () => {
    state.batchFault = true;
    const result = await call("execute_batch", {
      operations: [{ operation: "create", entity: "Class", body: { Name: "Willow Design" } }],
      company: "willow-lantern",
    });
    expect(result.body).toMatchObject({ succeeded: 0, failed: 1 });
  });
});

describe("create_employee", () => {
  it("requires at least one employee name before posting", async () => {
    const result = await call("create_employee", { company: "willow-lantern" });
    expect(result.isError).toBe(true);
    expect(result.body.error).toMatch(/Provide display_name or given_name\/family_name/);
    expect(state.requests).toEqual([]);
  });
});

describe("assertRawDestructiveAllowed", () => {
  it("does not apply delete-only limits to a raw Class create", async () => {
    const result = await call("api_request", {
      path: "/class", method: "POST", body: { Name: "Willow Design" }, company: "willow-lantern",
    });
    expect(result.isError).not.toBe(true);
    expect(state.requests).toContain("/class");
  });
});
