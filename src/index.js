#!/usr/bin/env node
// index.js — MCP server exposing QuickBooks Online read + write tools to Claude Desktop.
// Run normally (stdio) for Claude Desktop, or `node src/index.js --connect` once to authorize.
//
// Multi-company (single connector): every tool takes an optional `company` slug.
// You can also set a session default with select_company; individual calls may
// still override it. Resolution precedence, per call:
//   explicit `company` arg → session default → env QBO_COMPANY → sole company
//   (reads only) → error listing the available companies.
// Write tools never auto-pick a company — they require an explicit arg or a
// session/env default, so a transaction can never post to the wrong books.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
// Load .env by absolute path (relative to this file), not the current working
// directory — Claude Desktop launches the server from a different cwd.
const dotenvResult = dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
// Host apps can inject empty-string env values, which would otherwise beat the
// .env file (a failure mode reported against Intuit's MCP server). Treat empty
// as unset, but never clobber a real value: shell overrides like
// `QBO_ENVIRONMENT=production npm run connect` must still win.
for (const [k, v] of Object.entries(dotenvResult.parsed || {})) {
  if (process.env[k] === "") process.env[k] = v;
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  qboRequest,
  qboQuery,
  qboRequestBinary,
  qboUpload,
  getRealmId,
  getValidTokens,
  runAuthorizationFlow,
  runBatchAuthorization,
  disconnectCompany,
  deriveSlugFromRealm,
  listCompanies,
  sanitizeSlug,
} from "./qbo.js";
import { todayISO, esc, assertId, guessContentType, expandHome } from "./util.js";
import {
  QUERY_PAGE_SIZE,
  qboQueryAll,
  resolveRef,
  fetchEntity,
  readJournalEntry,
  findCustomerByName,
  findVendorByName,
  findAccountByName,
  findAnyIncomeAccount,
  findAnyServiceItem,
  suggestNames,
  notFoundError,
  closedPeriodWarnings,
  withWarnings,
  buildWhere,
} from "./entities.js";
import {
  journalLineSchema,
  salesLineSchema,
  accountLineSchema,
  itemLineSchema,
  depositLineSchema,
  buildJournalLines,
  buildSalesLines,
  buildAccountLines,
  buildItemExpenseLines,
  buildDepositLines,
  departmentRef,
} from "./lines.js";
import { compactList } from "./compact.js";
import { parseCSV, planImport, importId, rowMarker, postedRows, recordPosted } from "./csv.js";
import { flattenReport, consolidateReports, glFlatten, flagGlRows } from "./reports.js";
import { matchTransactions, findDuplicateGroups } from "./reconcile.js";
import { checkWritePolicy } from "./policy.js";

const log = (...a) => console.error("[qbo-mcp]", ...a);

// ---- One-time authorization mode ------------------------------------------
if (process.argv.includes("--connect")) {
  try {
    await runAuthorizationFlow();
    log("Authorization complete. You can now start Claude Desktop.");
    process.exit(0);
  } catch (e) {
    log("Authorization failed:", e.message);
    process.exit(1);
  }
}

// ---- Pattern A: sequential batch authorization ----------------------------
// `npm run connect:batch`            → keep going, asking "add another?" after each
// `npm run connect:batch -- --count 50` → authorize exactly 50, no prompts
// `npm run connect:batch -- --dry`   → print the plan and exit (no browser)
if (process.argv.includes("--connect-batch")) {
  const argv = process.argv;
  const getArg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
  };
  const dry = argv.includes("--dry");
  const count = Number(getArg("--count") ?? getArg("-n"));
  const hasCount = Number.isFinite(count) && count > 0;

  try {
    if (dry) {
      const existing = await listCompanies();
      const taken = new Set(existing.map((c) => c.slug));
      log("Batch plan (dry run — nothing authorized):");
      log(`  environment : ${(process.env.QBO_ENVIRONMENT || "sandbox").toLowerCase()}`);
      log(`  redirect    : ${process.env.QBO_REDIRECT_URI || "http://localhost:3000/callback"}`);
      log(`  mode        : ${hasCount ? `fixed count = ${count}` : "interactive (asks 'add another?')"}`);
      log(`  already connected (${existing.length}): ${existing.map((c) => `${c.slug}(${c.environment})`).join(", ") || "none"}`);
      log(`  example new slug for realm 9999999999123456 → "${deriveSlugFromRealm("9999999999123456", taken)}"`);
      process.exit(0);
    }

    // Decide whether to authorize another company after each success.
    let shouldContinue;
    if (hasCount) {
      shouldContinue = (connected) => connected.length < count;
    } else {
      const rl = (await import("node:readline/promises")).createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      shouldContinue = async () => {
        const answer = (await rl.question("Connect another company? [y/N] ")).trim().toLowerCase();
        const yes = answer === "y" || answer === "yes";
        if (!yes) rl.close();
        return yes;
      };
    }

    log(hasCount
      ? `Batch authorizing ${count} companies. Log in once, then pick + Allow each.`
      : "Batch authorize started. Log in once; after each company you'll be asked to add another.");

    const connected = await runBatchAuthorization({ shouldContinue });

    log(`\nDone — ${connected.length} compan${connected.length === 1 ? "y" : "ies"} authorized:`);
    for (const c of connected) {
      log(`  • ${c.slug}  (realm ${c.realmId}, ${c.environment})${c.reused ? "  [refreshed]" : ""}`);
    }
    log("\nNo config change or restart needed — the unified `qbo` connector picks these up on the next call.");
    process.exit(0);
  } catch (e) {
    log("Batch authorization failed:", e.message);
    process.exit(1);
  }
}

// ---- Disconnect: revoke the grant, then remove the token file --------------
// `npm run disconnect -- <slug>`. Offboarding a client is not complete until
// the OAuth grant is revoked on Intuit's side; deleting the file alone would
// leave the grant live until it expires on its own.
if (process.argv.includes("--disconnect")) {
  const i = process.argv.indexOf("--disconnect");
  const next = process.argv[i + 1];
  const slug = next && !next.startsWith("--") ? next : process.env.QBO_COMPANY || "";
  try {
    const r = await disconnectCompany(slug);
    log(`Disconnected ${r.slug || "the default company"} (realm ${r.realmId ?? "unknown"}).`);
    log("If this company had its own qbo-<slug> entry in the Claude Desktop config, remove it and restart Claude Desktop.");
    process.exit(0);
  } catch (e) {
    log("Disconnect failed:", e.message);
    process.exit(1);
  }
}

// ---- helpers ---------------------------------------------------------------
const asText = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });

const asError = (msg) => ({
  content: [{ type: "text", text: `Error: ${msg}` }],
  isError: true,
});

// Wrap a handler so any thrown error is returned cleanly to Claude instead of crashing the server.
function tool(handler) {
  return async (args) => {
    try {
      return await handler(args || {});
    } catch (e) {
      log("tool error:", e.message);
      return asError(e.message);
    }
  };
}

// Build a QBO report query string from a params object, dropping empties.
function reportQuery(params) {
  const qs = Object.entries(params)
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  return qs ? `?${qs}` : "";
}

// ---- company selection -----------------------------------------------------
// The session default set via select_company (until the server restarts).
let sessionDefault = null;

const companyArg = z
  .string()
  .optional()
  .describe("Company slug to run against (see list_companies). Omit to use the active/default company.");

function formatCompanyList(companies) {
  return (
    companies.map((c) => `${c.slug} (${c.environment}, realm ${c.realmId})`).join("; ") ||
    "none — authorize one with `QBO_COMPANY=<slug> npm run connect`"
  );
}

function envDefaultCompany() {
  return sanitizeSlug(process.env.QBO_COMPANY || "");
}

// Resolve which company a call targets, enforcing the precedence + write-gate.
// Returns a concrete slug string ("" = the legacy default tokens.json).
async function resolveCompany(explicit, { write = false } = {}) {
  // 1. Explicit per-call argument — validated against what's actually authorized.
  if (explicit != null && String(explicit).trim() !== "") {
    const slug = sanitizeSlug(explicit);
    const companies = await listCompanies();
    if (!companies.some((c) => c.slug === slug)) {
      throw new Error(
        `No such company "${explicit}". Available: ${formatCompanyList(companies)}.`
      );
    }
    if (write) await checkWritePolicy(slug, null); // fail fast on read-only companies
    return slug;
  }
  // 2. Session default (set via select_company).
  if (sessionDefault) {
    if (write) await checkWritePolicy(sessionDefault, null);
    return sessionDefault;
  }
  // 3. Env default (legacy per-connector QBO_COMPANY).
  const envDefault = envDefaultCompany();
  if (envDefault) {
    if (write) await checkWritePolicy(envDefault, null);
    return envDefault;
  }
  // 4. Convenience fallbacks.
  const companies = await listCompanies();
  if (companies.length === 0) return ""; // pure legacy single-file / default connector
  if (companies.length === 1 && !write) return companies[0].slug;
  // 5. Ambiguous — never guess.
  const why = write
    ? "I won't guess which company to post a write to"
    : "multiple companies are connected";
  throw new Error(
    `No company selected — ${why}. Pass a \`company\` argument or call select_company first. Available: ${formatCompanyList(companies)}.`
  );
}

// ---- MCP server ------------------------------------------------------------
const server = new McpServer({ name: "qbo-mcp-server", version: "1.0.0" });

// Registration wrapper with verb-category kill switches (pattern from Intuit's
// MIT-licensed MCP server). QBO_DISABLE_WRITES=true suppresses registering any
// tool that can change the books or send anything outward; the narrower
// QBO_DISABLE_DELETES=true suppresses only deletes/voids. Suppressed tools
// never appear in the client at all, which is stronger than blocking at call
// time. Read tools are always registered.
const DISABLE_WRITES = (process.env.QBO_DISABLE_WRITES || "").toLowerCase() === "true";
const DISABLE_DELETES = DISABLE_WRITES || (process.env.QBO_DISABLE_DELETES || "").toLowerCase() === "true";
const WRITE_PREFIXES = /^(create_|update_|send_|void_|delete_|import_|attach_)/;
const WRITE_EXTRAS = new Set(["api_request"]);
const DELETE_PREFIXES = /^(delete_|void_)/;

const rawRegister = server.tool.bind(server);
let suppressedTools = 0;
function registerTool(name, description, schema, handler) {
  if (
    (DISABLE_DELETES && DELETE_PREFIXES.test(name)) ||
    (DISABLE_WRITES && (WRITE_PREFIXES.test(name) || WRITE_EXTRAS.has(name)))
  ) {
    suppressedTools++;
    return;
  }
  rawRegister(name, description, schema, handler);
}

/* ==================== COMPANY TOOLS & DIAGNOSTICS (4) ==================== */

registerTool(
  "list_companies",
  "List every QuickBooks company this connector can access (each an authorized tokens.<slug>.json), with realmId and environment, plus the current active default.",
  {},
  tool(async () => {
    const companies = await listCompanies();
    return asText({
      count: companies.length,
      active_default: sessionDefault || envDefaultCompany() || null,
      companies,
    });
  })
);

registerTool(
  "select_company",
  "Set the active QuickBooks company for subsequent tool calls (persists until changed or the server restarts). Individual tools can still override it with their own `company` argument.",
  { company: z.string().describe("Company slug from list_companies, e.g. 8315") },
  tool(async ({ company }) => {
    const slug = sanitizeSlug(company);
    const companies = await listCompanies();
    const info = companies.find((c) => c.slug === slug);
    if (!info) {
      throw new Error(`No such company "${company}". Available: ${formatCompanyList(companies)}.`);
    }
    sessionDefault = slug;
    return asText({ active_company: slug, realmId: info.realmId, environment: info.environment });
  })
);

registerTool(
  "get_active_company",
  "Show which QuickBooks company is currently active (the default for calls that omit `company`) and how it was determined.",
  {},
  tool(async () => {
    const active = sessionDefault || envDefaultCompany() || null;
    const source = sessionDefault ? "select_company" : envDefaultCompany() ? "env QBO_COMPANY" : "none";
    let info = null;
    if (active) {
      const companies = await listCompanies();
      info = companies.find((c) => c.slug === active) || null;
    }
    return asText({
      active_company: active,
      source,
      ...(info ? { realmId: info.realmId, environment: info.environment } : {}),
    });
  })
);

registerTool(
  "health_check",
  "Verify connectivity for one company or every connected company: token freshness (refreshing if due), realm, environment, and a live API round trip. The fastest first step when something is not working.",
  {
    company: companyArg,
    all: z.boolean().optional().describe("Check every connected company instead of one"),
  },
  tool(async ({ company, all }) => {
    const companies = await listCompanies();
    let targets;
    if (all) {
      targets = companies.length ? companies.map((x) => x.slug) : [""];
    } else {
      try {
        targets = [await resolveCompany(company)];
      } catch {
        // No single company resolvable (none selected, several connected):
        // fall back to checking them all.
        targets = companies.length ? companies.map((x) => x.slug) : [""];
      }
    }
    const now = Date.now();
    const results = [];
    for (const slug of targets) {
      const entry = { company: slug || "(default)" };
      try {
        const tokens = await getValidTokens(slug);
        entry.realmId = tokens.realmId;
        entry.environment = tokens.environment;
        entry.access_token_minutes_left = Math.max(0, Math.round((tokens.expires_at - now) / 60_000));
        entry.refresh_token_days_left = tokens.refresh_expires_at
          ? Math.max(0, Math.round((tokens.refresh_expires_at - now) / 86_400_000))
          : null;
        const info = await qboRequest(`/companyinfo/${tokens.realmId}`, { company: slug });
        entry.company_name = info.CompanyInfo?.CompanyName ?? null;
        entry.status = "ok";
      } catch (e) {
        entry.status = "error";
        entry.error = e.message;
      }
      results.push(entry);
    }
    const failing = results.filter((r) => r.status !== "ok").length;
    return asText({ checked: results.length, healthy: results.length - failing, failing, results });
  })
);

/* =========================== READ TOOLS (9) =========================== */

registerTool(
  "get_profit_and_loss",
  "Profit & Loss report for a date range (YYYY-MM-DD).",
  { start_date: z.string().describe("YYYY-MM-DD"), end_date: z.string().describe("YYYY-MM-DD"), company: companyArg },
  tool(async ({ start_date, end_date, company }) => {
    const c = await resolveCompany(company);
    return asText(await qboRequest(`/reports/ProfitAndLoss?start_date=${start_date}&end_date=${end_date}`, { company: c }));
  })
);

registerTool(
  "get_balance_sheet",
  "Balance Sheet report for a date range (YYYY-MM-DD).",
  { start_date: z.string(), end_date: z.string(), company: companyArg },
  tool(async ({ start_date, end_date, company }) => {
    const c = await resolveCompany(company);
    return asText(await qboRequest(`/reports/BalanceSheet?start_date=${start_date}&end_date=${end_date}`, { company: c }));
  })
);

registerTool(
  "get_cash_flow",
  "Statement of Cash Flows for a date range (YYYY-MM-DD).",
  { start_date: z.string(), end_date: z.string(), company: companyArg },
  tool(async ({ start_date, end_date, company }) => {
    const c = await resolveCompany(company);
    return asText(await qboRequest(`/reports/CashFlow?start_date=${start_date}&end_date=${end_date}`, { company: c }));
  })
);

registerTool(
  "get_aged_receivables",
  "Aged Receivables summary (who owes you, bucketed by age).",
  { company: companyArg },
  tool(async ({ company }) => {
    const c = await resolveCompany(company);
    return asText(await qboRequest(`/reports/AgedReceivables`, { company: c }));
  })
);

registerTool(
  "get_aged_payables",
  "Aged Payables summary (who you owe, bucketed by age).",
  { company: companyArg },
  tool(async ({ company }) => {
    const c = await resolveCompany(company);
    return asText(await qboRequest(`/reports/AgedPayables`, { company: c }));
  })
);

registerTool(
  "get_invoices",
  "List invoices, optionally filtered by status (paid|open|overdue), customer_id, and date range.",
  {
    status: z.enum(["paid", "open", "overdue"]).optional(),
    customer_id: z.string().optional(),
    start_date: z.string().optional(),
    end_date: z.string().optional(),
    verbose: z.boolean().optional().describe("Return full QBO entities instead of compact rows"),
    company: companyArg,
  },
  tool(async ({ status, customer_id, start_date, end_date, verbose, company }) => {
    const c = await resolveCompany(company);
    const where = [];
    if (customer_id) where.push(`CustomerRef = '${assertId(customer_id, "customer_id")}'`);
    if (start_date) where.push(`TxnDate >= '${esc(start_date)}'`);
    if (end_date) where.push(`TxnDate <= '${esc(end_date)}'`);
    // Status is part of the WHERE clause (not post-filtered on one page) so
    // counts stay honest across pagination.
    if (status === "paid") where.push(`Balance = '0'`);
    if (status === "open") where.push(`Balance > '0'`);
    if (status === "overdue") where.push(`Balance > '0'`, `DueDate < '${todayISO()}'`);
    const sql = `SELECT * FROM Invoice${where.length ? " WHERE " + where.join(" AND ") : ""} ORDERBY TxnDate DESC`;
    const { rows, truncated } = await qboQueryAll(sql, "Invoice", { company: c });
    return asText({ count: rows.length, truncated, invoices: compactList("Invoice", rows, verbose) });
  })
);

registerTool(
  "get_overdue_invoices",
  "All invoices with an outstanding balance whose due date has passed.",
  {
    verbose: z.boolean().optional().describe("Return full QBO entities instead of compact rows"),
    company: companyArg,
  },
  tool(async ({ verbose, company }) => {
    const c = await resolveCompany(company);
    const today = todayISO();
    const { rows, truncated } = await qboQueryAll(
      `SELECT * FROM Invoice WHERE DueDate < '${today}' AND Balance > '0'`,
      "Invoice",
      { company: c }
    );
    return asText({ as_of: today, count: rows.length, truncated, invoices: compactList("Invoice", rows, verbose) });
  })
);

registerTool(
  "query",
  "Run a QBO SQL-style query against any entity, e.g. \"SELECT * FROM Customer\".",
  { sql_query: z.string(), company: companyArg },
  tool(async ({ sql_query, company }) => {
    const c = await resolveCompany(company);
    const r = await qboQuery(sql_query, { company: c });
    // QBO silently caps un-paginated queries at its default page size. Flag a
    // full page so it is never mistaken for the complete result set.
    const arr = Object.values(r).find(Array.isArray);
    if (arr && arr.length >= QUERY_PAGE_SIZE && !/\bMAXRESULTS\b/i.test(sql_query)) {
      return asText({
        ...r,
        possibly_truncated: true,
        note: `Result hit QBO's default page cap (${arr.length} rows). Add STARTPOSITION/MAXRESULTS to page through the full set.`,
      });
    }
    return asText(r);
  })
);

registerTool(
  "get_company_info",
  "Basic information about the connected QuickBooks company.",
  { company: companyArg },
  tool(async ({ company }) => {
    const c = await resolveCompany(company);
    const realmId = await getRealmId(c);
    return asText(await qboRequest(`/companyinfo/${realmId}`, { company: c }));
  })
);

/* =========================== MORE REPORTS (6) =========================== */

const accountingMethodArg = z.enum(["Cash", "Accrual"]).optional().describe("Cash or Accrual (defaults to the company setting)");
const dateMacroArg = z.string().optional().describe("QBO date macro, e.g. \"This Fiscal Year\", \"Last Month\" (alternative to start/end dates)");

registerTool(
  "get_general_ledger",
  "General Ledger report for a date range — every account's transactions with running balances.",
  {
    start_date: z.string().optional().describe("YYYY-MM-DD"),
    end_date: z.string().optional().describe("YYYY-MM-DD"),
    accounting_method: accountingMethodArg,
    date_macro: dateMacroArg,
    columns: z.string().optional().describe("Comma-separated columns to include, e.g. \"tx_date,account_name,debt_amt,credit_amt\""),
    company: companyArg,
  },
  tool(async ({ start_date, end_date, accounting_method, date_macro, columns, company }) => {
    const c = await resolveCompany(company);
    const q = reportQuery({ start_date, end_date, accounting_method, date_macro, columns });
    return asText(await qboRequest(`/reports/GeneralLedger${q}`, { company: c }));
  })
);

registerTool(
  "get_trial_balance",
  "Trial Balance report for a date range — debit/credit balance of every account.",
  {
    start_date: z.string().optional().describe("YYYY-MM-DD"),
    end_date: z.string().optional().describe("YYYY-MM-DD"),
    accounting_method: accountingMethodArg,
    date_macro: dateMacroArg,
    company: companyArg,
  },
  tool(async ({ start_date, end_date, accounting_method, date_macro, company }) => {
    const c = await resolveCompany(company);
    const q = reportQuery({ start_date, end_date, accounting_method, date_macro });
    return asText(await qboRequest(`/reports/TrialBalance${q}`, { company: c }));
  })
);

registerTool(
  "get_transaction_list",
  "Transaction List report — all transactions in a date range, optionally filtered.",
  {
    start_date: z.string().optional().describe("YYYY-MM-DD"),
    end_date: z.string().optional().describe("YYYY-MM-DD"),
    date_macro: dateMacroArg,
    accounting_method: accountingMethodArg,
    transaction_type: z.string().optional().describe("Filter by type, e.g. Invoice, Bill, Payment, JournalEntry"),
    company: companyArg,
  },
  tool(async ({ start_date, end_date, date_macro, accounting_method, transaction_type, company }) => {
    const c = await resolveCompany(company);
    const q = reportQuery({ start_date, end_date, date_macro, accounting_method, transaction_type });
    return asText(await qboRequest(`/reports/TransactionList${q}`, { company: c }));
  })
);

registerTool(
  "get_transaction_list_by_vendor",
  "Transaction List grouped by vendor for a date range.",
  {
    start_date: z.string().optional().describe("YYYY-MM-DD"),
    end_date: z.string().optional().describe("YYYY-MM-DD"),
    date_macro: dateMacroArg,
    accounting_method: accountingMethodArg,
    vendor: z.string().optional().describe("Filter to a single vendor Id"),
    company: companyArg,
  },
  tool(async ({ start_date, end_date, date_macro, accounting_method, vendor, company }) => {
    const c = await resolveCompany(company);
    const q = reportQuery({ start_date, end_date, date_macro, accounting_method, vendor });
    return asText(await qboRequest(`/reports/TransactionListByVendor${q}`, { company: c }));
  })
);

registerTool(
  "get_transaction_list_by_customer",
  "Transaction List grouped by customer for a date range.",
  {
    start_date: z.string().optional().describe("YYYY-MM-DD"),
    end_date: z.string().optional().describe("YYYY-MM-DD"),
    date_macro: dateMacroArg,
    accounting_method: accountingMethodArg,
    customer: z.string().optional().describe("Filter to a single customer Id"),
    company: companyArg,
  },
  tool(async ({ start_date, end_date, date_macro, accounting_method, customer, company }) => {
    const c = await resolveCompany(company);
    const q = reportQuery({ start_date, end_date, date_macro, accounting_method, customer });
    return asText(await qboRequest(`/reports/TransactionListByCustomer${q}`, { company: c }));
  })
);

registerTool(
  "get_transaction_list_with_splits",
  "Transaction List with split lines (each line of every transaction) for a date range.",
  {
    start_date: z.string().optional().describe("YYYY-MM-DD"),
    end_date: z.string().optional().describe("YYYY-MM-DD"),
    date_macro: dateMacroArg,
    accounting_method: accountingMethodArg,
    company: companyArg,
  },
  tool(async ({ start_date, end_date, date_macro, accounting_method, company }) => {
    const c = await resolveCompany(company);
    const q = reportQuery({ start_date, end_date, date_macro, accounting_method });
    return asText(await qboRequest(`/reports/TransactionListWithSplits${q}`, { company: c }));
  })
);

/* =========================== WRITE TOOLS (8) =========================== */

registerTool(
  "create_customer",
  "Create a new customer.",
  {
    display_name: z.string(),
    email: z.string().optional(),
    phone: z.string().optional(),
    billing_address: z.string().optional().describe("Free-form billing address line"),
    company: companyArg,
  },
  tool(async ({ display_name, email, phone, billing_address, company }) => {
    const c = await resolveCompany(company, { write: true });
    const payload = { DisplayName: display_name };
    if (email) payload.PrimaryEmailAddr = { Address: email };
    if (phone) payload.PrimaryPhone = { FreeFormNumber: phone };
    if (billing_address) payload.BillAddr = { Line1: billing_address };
    const r = await qboRequest(`/customer`, { method: "POST", body: payload, company: c });
    return asText({ created: r.Customer });
  })
);

registerTool(
  "update_customer",
  "Update an existing customer (fetches current SyncToken first).",
  {
    customer_id: z.string(),
    display_name: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
    billing_address: z.string().optional(),
    company: companyArg,
  },
  tool(async ({ customer_id, display_name, email, phone, billing_address, company }) => {
    const c = await resolveCompany(company, { write: true });
    const current = (await qboQuery(`SELECT * FROM Customer WHERE Id = '${assertId(customer_id, "customer_id")}'`, { company: c })).Customer?.[0];
    if (!current) throw new Error(`No customer with Id ${customer_id}`);
    const payload = { Id: current.Id, SyncToken: current.SyncToken, sparse: true };
    if (display_name) payload.DisplayName = display_name;
    if (email) payload.PrimaryEmailAddr = { Address: email };
    if (phone) payload.PrimaryPhone = { FreeFormNumber: phone };
    if (billing_address) payload.BillAddr = { Line1: billing_address };
    const r = await qboRequest(`/customer`, { method: "POST", body: payload, company: c });
    return asText({ updated: r.Customer });
  })
);

registerTool(
  "create_item",
  "Create a product or service item.",
  {
    name: z.string(),
    type: z.enum(["Service", "Inventory", "NonInventory"]),
    unit_price: z.number().optional(),
    description: z.string().optional(),
    income_account_name: z.string().optional(),
    company: companyArg,
  },
  tool(async ({ name, type, unit_price, description, income_account_name, company }) => {
    const c = await resolveCompany(company, { write: true });
    let income = income_account_name ? await findAccountByName(income_account_name, c) : await findAnyIncomeAccount(c);
    if (!income) throw new Error("No income account found. Create one with create_account (account_type 'Income') first, or pass income_account_name.");
    const payload = {
      Name: name,
      Type: type,
      IncomeAccountRef: { value: income.Id, name: income.Name },
    };
    if (unit_price != null) payload.UnitPrice = unit_price;
    if (description) payload.Description = description;
    const r = await qboRequest(`/item`, { method: "POST", body: payload, company: c });
    return asText({ created: r.Item, note: type === "Inventory" ? "Inventory items may need asset/COGS accounts and a start date; create in QBO UI if this errors." : undefined });
  })
);

registerTool(
  "create_invoice",
  "Create an invoice for a customer. line_items is an array of {description, amount}. Optionally email it.",
  {
    customer_ref: z.string().describe("Customer Id or DisplayName"),
    line_items: z.array(z.object({ description: z.string(), amount: z.number() })),
    txn_date: z.string().optional().describe("YYYY-MM-DD (defaults to today)"),
    due_date: z.string().optional().describe("YYYY-MM-DD"),
    location: z.string().optional().describe("Location/department name or Id (requires location tracking)"),
    send_email: z.boolean().optional(),
    company: companyArg,
  },
  tool(async ({ customer_ref, line_items, txn_date, due_date, location, send_email, company }) => {
    const c = await resolveCompany(company, { write: true });
    // Resolve customer by Id (numeric) or by name.
    let customer;
    if (/^\d+$/.test(customer_ref)) {
      customer = (await qboQuery(`SELECT * FROM Customer WHERE Id = '${esc(customer_ref)}'`, { company: c })).Customer?.[0];
    } else {
      customer = await findCustomerByName(customer_ref, c);
    }
    if (!customer) throw new Error(`Customer not found: ${customer_ref}`);

    const item = await findAnyServiceItem(c);
    if (!item) throw new Error("No Service item exists to attach invoice lines to. Create one with create_item first.");

    const Line = line_items.map((li) => ({
      Amount: li.amount,
      DetailType: "SalesItemLineDetail",
      Description: li.description,
      SalesItemLineDetail: { ItemRef: { value: item.Id, name: item.Name } },
    }));

    const warnings = await closedPeriodWarnings(c, [txn_date]);
    const payload = { CustomerRef: { value: customer.Id }, Line };
    if (txn_date) payload.TxnDate = txn_date;
    if (due_date) payload.DueDate = due_date;
    if (location) payload.DepartmentRef = await departmentRef(location, c);
    if (customer.PrimaryEmailAddr?.Address) {
      payload.BillEmail = { Address: customer.PrimaryEmailAddr.Address };
    }

    const r = await qboRequest(`/invoice`, { method: "POST", body: payload, company: c });
    const invoice = r.Invoice;

    let emailed = false;
    if (send_email) {
      const addr = customer.PrimaryEmailAddr?.Address;
      if (!addr) throw new Error(`Invoice ${invoice.Id} created, but the customer has no email on file to send to.`);
      await qboRequest(`/invoice/${invoice.Id}/send?sendTo=${encodeURIComponent(addr)}`, { method: "POST", company: c });
      emailed = true;
    }
    return asText(withWarnings({ created: invoice, emailed }, warnings));
  })
);

registerTool(
  "create_bill",
  "Record a bill (money you owe a vendor), categorized to an expense account.",
  {
    vendor_name: z.string(),
    amount: z.number(),
    category: z.string().describe("Expense account name to categorize against"),
    transaction_date: z.string().describe("YYYY-MM-DD"),
    memo: z.string().optional(),
    location: z.string().optional().describe("Location/department name or Id (requires location tracking)"),
    create_vendor_if_missing: z.boolean().optional().describe("Create the vendor when no exact DisplayName match exists (default false, so a typo cannot mint a phantom vendor)"),
    company: companyArg,
  },
  tool(async ({ vendor_name, amount, category, transaction_date, memo, location, create_vendor_if_missing, company }) => {
    const c = await resolveCompany(company, { write: true });
    let vendor = await findVendorByName(vendor_name, c);
    if (!vendor) {
      if (!create_vendor_if_missing) {
        throw new Error(
          `Vendor not found: "${vendor_name}". Check the exact name (query \"SELECT * FROM Vendor\"), or pass create_vendor_if_missing: true to create it.`
        );
      }
      const created = await qboRequest(`/vendor`, { method: "POST", body: { DisplayName: vendor_name }, company: c });
      vendor = created.Vendor;
    }
    const account = await findAccountByName(category, c);
    if (!account) throw notFoundError("Account", category, await suggestNames("Account", category, c, "Name"));

    const warnings = await closedPeriodWarnings(c, [transaction_date]);
    const payload = {
      VendorRef: { value: vendor.Id },
      TxnDate: transaction_date,
      Line: [{
        Amount: amount,
        DetailType: "AccountBasedExpenseLineDetail",
        AccountBasedExpenseLineDetail: { AccountRef: { value: account.Id, name: account.Name } },
      }],
    };
    if (memo) payload.PrivateNote = memo;
    if (location) payload.DepartmentRef = await departmentRef(location, c);
    const r = await qboRequest(`/bill`, { method: "POST", body: payload, company: c });
    return asText(withWarnings({ created: r.Bill }, warnings));
  })
);

registerTool(
  "create_account",
  "Create a Chart of Accounts entry.",
  {
    name: z.string(),
    account_type: z.string().describe("e.g. Income, Expense, Bank, Credit Card"),
    account_sub_type: z.string().optional(),
    description: z.string().optional(),
    company: companyArg,
  },
  tool(async ({ name, account_type, account_sub_type, description, company }) => {
    const c = await resolveCompany(company, { write: true });
    const payload = { Name: name, AccountType: account_type };
    if (account_sub_type) payload.AccountSubType = account_sub_type;
    if (description) payload.Description = description;
    const r = await qboRequest(`/account`, { method: "POST", body: payload, company: c });
    return asText({ created: r.Account });
  })
);

registerTool(
  "send_invoice_email",
  "Email an existing invoice to the customer (or an override address).",
  { invoice_id: z.string(), email: z.string().optional(), company: companyArg },
  tool(async ({ invoice_id, email, company }) => {
    const c = await resolveCompany(company, { write: true });
    const q = email ? `?sendTo=${encodeURIComponent(email)}` : "";
    await qboRequest(`/invoice/${encodeURIComponent(assertId(invoice_id, "invoice_id"))}/send${q}`, { method: "POST", company: c });
    return asText({ sent: true, invoice_id, to: email || "email on file" });
  })
);

registerTool(
  "import_transactions_from_csv",
  "Read a bank-statement CSV, categorize money-out rows against the Chart of Accounts, and import them to QBO as expenses. Sign-aware (credits/deposits are never imported as expenses), idempotent (a re-run skips rows that already posted), and previewable with dry_run.",
  {
    file_path: z.string(),
    transaction_type: z.enum(["Expense"]).optional().describe("Only Expense (QBO Purchase) is supported"),
    bank_account_name: z.string(),
    amount_convention: z.enum(["negative_out", "positive_out"]).optional()
      .describe("For a single Amount column: which sign is money out (default negative_out). Ignored when separate Debit/Credit columns exist."),
    dry_run: z.boolean().optional(),
    company: companyArg,
  },
  tool(async ({ file_path, bank_account_name, amount_convention, dry_run, company }) => {
    // A dry_run only reads/previews, so allow the sole-company convenience for
    // it; a live import posts transactions and must name a company explicitly.
    const c = await resolveCompany(company, { write: !dry_run });
    const fileBytes = await readFile(expandHome(file_path));
    const plan = planImport(parseCSV(fileBytes.toString("utf8")), { amountConvention: amount_convention });

    const bank = await findAccountByName(bank_account_name, c);
    if (!bank) throw notFoundError("Account", bank_account_name, await suggestNames("Account", bank_account_name, c, "Name"));

    const { rows: accounts } = await qboQueryAll(`SELECT * FROM Account WHERE AccountType = 'Expense'`, "Account", { company: c });
    const uncategorized = accounts.find((a) => /uncategorized/i.test(a.Name)) || accounts[0];
    if (!uncategorized) throw new Error("No expense accounts exist to categorize into.");
    const categorize = (desc) => {
      const d = desc.toLowerCase();
      const match = accounts.find((a) => a.Name && d.includes(a.Name.toLowerCase().split(" ")[0]));
      return match || uncategorized;
    };

    // Stable identity for this exact file + target, and the rows any earlier
    // (possibly interrupted) run of it already posted.
    const importIdValue = importId({ company: c, bankAccount: bank.Id, fileBytes });
    const alreadyPosted = await postedRows(importIdValue);
    const planned = plan.outflows.map((p) => {
      const cat = categorize(p.description);
      return { ...p, category: cat.Name, category_id: cat.Id, already_posted: alreadyPosted.has(p.row) };
    });
    const toPost = planned.filter((p) => !p.already_posted);

    const warnings = await closedPeriodWarnings(c, planned.map((p) => p.date));
    const summary = {
      company: c || "(default)",
      import_id: importIdValue,
      bank_account: bank.Name,
      rows_out: planned.length,
      rows_already_posted: planned.length - toPost.length,
      inflow_rows_skipped: plan.inflows.length,
      error_rows: plan.errors,
      total_amount: Number(toPost.reduce((s, p) => s + p.amount, 0).toFixed(2)),
    };

    if (dry_run) {
      return asText(withWarnings({
        dry_run: true,
        ...summary,
        preview: planned,
        skipped_inflows: plan.inflows,
        note: "Nothing was posted. Re-run with dry_run: false to import the money-out rows.",
      }, warnings));
    }

    if (plan.errors.length) {
      throw new Error(
        `Cannot import: ${plan.errors.length} row(s) are unreadable (run dry_run to inspect): ` +
        plan.errors.slice(0, 3).map((e) => `row ${e.row}: ${e.reason}`).join("; ")
      );
    }
    if (!toPost.length) {
      return asText(withWarnings({ imported: 0, ...summary, note: "Every money-out row in this file already posted (idempotent re-run)." }, warnings));
    }

    const items = toPost.map((p, i) => ({
      bId: `bid${i}`,
      operation: "create",
      Purchase: {
        PaymentType: "Check",
        AccountRef: { value: bank.Id, name: bank.Name },
        TxnDate: p.date,
        PrivateNote: `${p.description} ${rowMarker(importIdValue, p.row)}`.trim(),
        Line: [{
          Amount: p.amount,
          DetailType: "AccountBasedExpenseLineDetail",
          AccountBasedExpenseLineDetail: { AccountRef: { value: p.category_id, name: p.category } },
        }],
      },
    }));

    const results = [];
    // QBO batch caps at 30 items per request. After each chunk, journal what
    // posted so a mid-run failure can resume without double-posting.
    for (let i = 0; i < items.length; i += 30) {
      const chunk = items.slice(i, i + 30);
      const r = await qboRequest(`/batch`, { method: "POST", body: { BatchItemRequest: chunk }, company: c });
      const responses = r.BatchItemResponse || [];
      results.push(...responses);
      const postedNow = responses
        .map((res) => {
          if (!res.Purchase) return null;
          const idx = Number(String(res.bId).replace("bid", ""));
          const src = toPost[idx];
          return src ? { row: src.row, purchase_id: res.Purchase.Id, amount: src.amount, date: src.date } : null;
        })
        .filter(Boolean);
      await recordPosted(importIdValue, postedNow);
    }
    const posted = results.filter((r) => r.Purchase).length;
    const errors = results.filter((r) => r.Fault).map((r) => r.Fault?.Error?.[0]?.Message);
    return asText(withWarnings({ imported: posted, errors, ...summary }, warnings));
  })
);

/* =========================== JOURNAL ENTRY TOOLS (6) =========================== */

registerTool(
  "create_journal_entry",
  "Create a journal entry from balanced lines (total Debits must equal total Credits). Each line posts an amount to an account as a Debit or Credit; lines may optionally be tagged to a customer/vendor/employee.",
  {
    lines: z.array(journalLineSchema).describe("At least two lines; debits must equal credits"),
    txn_date: z.string().optional().describe("YYYY-MM-DD (defaults to today)"),
    doc_number: z.string().optional().describe("Reference/journal number"),
    memo: z.string().optional().describe("Note on the entry (PrivateNote)"),
    adjustment: z.boolean().optional().describe("Mark as an adjusting journal entry"),
    company: companyArg,
  },
  tool(async ({ lines, txn_date, doc_number, memo, adjustment, company }) => {
    const c = await resolveCompany(company, { write: true });
    const warnings = await closedPeriodWarnings(c, [txn_date]);
    const payload = { Line: await buildJournalLines(lines, c) };
    if (txn_date) payload.TxnDate = txn_date;
    if (doc_number) payload.DocNumber = doc_number;
    if (memo) payload.PrivateNote = memo;
    if (adjustment != null) payload.Adjustment = adjustment;
    const r = await qboRequest(`/journalentry`, { method: "POST", body: payload, company: c });
    return asText(withWarnings({ created: r.JournalEntry }, warnings));
  })
);

registerTool(
  "update_journal_entry",
  "Full update of a journal entry: REPLACES all lines with the ones you provide (must stay balanced). Omitted header fields are carried over from the current entry. Fetches SyncToken automatically.",
  {
    journal_entry_id: z.string(),
    lines: z.array(journalLineSchema).describe("Complete replacement set of lines; debits must equal credits"),
    txn_date: z.string().optional(),
    doc_number: z.string().optional(),
    memo: z.string().optional(),
    adjustment: z.boolean().optional(),
    company: companyArg,
  },
  tool(async ({ journal_entry_id, lines, txn_date, doc_number, memo, adjustment, company }) => {
    const c = await resolveCompany(company, { write: true });
    const current = await readJournalEntry(journal_entry_id, c);
    const warnings = await closedPeriodWarnings(c, [txn_date ?? current.TxnDate]);
    const payload = {
      Id: current.Id,
      SyncToken: current.SyncToken,
      Line: await buildJournalLines(lines, c),
      TxnDate: txn_date ?? current.TxnDate,
    };
    const docN = doc_number ?? current.DocNumber;
    const note = memo ?? current.PrivateNote;
    const adj = adjustment ?? current.Adjustment;
    if (docN != null) payload.DocNumber = docN;
    if (note != null) payload.PrivateNote = note;
    if (adj != null) payload.Adjustment = adj;
    const r = await qboRequest(`/journalentry`, { method: "POST", body: payload, company: c });
    return asText(withWarnings({ updated: r.JournalEntry }, warnings));
  })
);

/* =========================== SALES TRANSACTIONS =========================== */

registerTool(
  "create_estimate",
  "Create an estimate (quote) for a customer, with line items.",
  {
    customer_ref: z.string().describe("Customer Id or DisplayName"),
    line_items: z.array(salesLineSchema),
    txn_date: z.string().optional().describe("YYYY-MM-DD"),
    expiration_date: z.string().optional().describe("YYYY-MM-DD"),
    email: z.string().optional().describe("BillEmail address"),
    memo: z.string().optional(),
    location: z.string().optional().describe("Location/department name or Id (requires location tracking)"),
    company: companyArg,
  },
  tool(async ({ customer_ref, line_items, txn_date, expiration_date, email, memo, location, company }) => {
    const c = await resolveCompany(company, { write: true });
    const payload = { CustomerRef: await resolveRef("Customer", customer_ref, c, "DisplayName"), Line: await buildSalesLines(line_items, c) };
    if (location) payload.DepartmentRef = await departmentRef(location, c);
    if (txn_date) payload.TxnDate = txn_date;
    if (expiration_date) payload.ExpirationDate = expiration_date;
    if (email) payload.BillEmail = { Address: email };
    if (memo) payload.CustomerMemo = { value: memo };
    const r = await qboRequest(`/estimate`, { method: "POST", body: payload, company: c });
    return asText({ created: r.Estimate });
  })
);

registerTool(
  "update_estimate",
  "Sparse-update an estimate (fetches SyncToken first). Pass line_items only to replace all lines.",
  {
    estimate_id: z.string(),
    line_items: z.array(salesLineSchema).optional(),
    txn_date: z.string().optional(),
    email: z.string().optional(),
    memo: z.string().optional(),
    company: companyArg,
  },
  tool(async ({ estimate_id, line_items, txn_date, email, memo, company }) => {
    const c = await resolveCompany(company, { write: true });
    const current = await fetchEntity("Estimate", estimate_id, c);
    const payload = { Id: current.Id, SyncToken: current.SyncToken, sparse: true };
    if (line_items) payload.Line = await buildSalesLines(line_items, c);
    if (txn_date != null) payload.TxnDate = txn_date;
    if (email != null) payload.BillEmail = { Address: email };
    if (memo != null) payload.CustomerMemo = { value: memo };
    const r = await qboRequest(`/estimate`, { method: "POST", body: payload, company: c });
    return asText({ updated: r.Estimate });
  })
);

registerTool(
  "send_estimate",
  "Email an existing estimate to the customer (or an override address).",
  { estimate_id: z.string(), email: z.string().optional(), company: companyArg },
  tool(async ({ estimate_id, email, company }) => {
    const c = await resolveCompany(company, { write: true });
    const q = email ? `?sendTo=${encodeURIComponent(email)}` : "";
    await qboRequest(`/estimate/${encodeURIComponent(estimate_id)}/send${q}`, { method: "POST", company: c });
    return asText({ sent: true, estimate_id, to: email || "email on file" });
  })
);

registerTool(
  "update_invoice",
  "Sparse-update an invoice (fetches SyncToken first). Pass line_items only to replace all lines.",
  {
    invoice_id: z.string(),
    line_items: z.array(salesLineSchema).optional(),
    due_date: z.string().optional(),
    customer_ref: z.string().optional(),
    email: z.string().optional(),
    memo: z.string().optional(),
    company: companyArg,
  },
  tool(async ({ invoice_id, line_items, due_date, customer_ref, email, memo, company }) => {
    const c = await resolveCompany(company, { write: true });
    const current = await fetchEntity("Invoice", invoice_id, c);
    const payload = { Id: current.Id, SyncToken: current.SyncToken, sparse: true };
    if (line_items) payload.Line = await buildSalesLines(line_items, c);
    if (due_date != null) payload.DueDate = due_date;
    if (customer_ref != null) payload.CustomerRef = await resolveRef("Customer", customer_ref, c, "DisplayName");
    if (email != null) payload.BillEmail = { Address: email };
    if (memo != null) payload.CustomerMemo = { value: memo };
    const r = await qboRequest(`/invoice`, { method: "POST", body: payload, company: c });
    return asText({ updated: r.Invoice });
  })
);

registerTool(
  "void_invoice",
  "Void an existing invoice (zeros it out but keeps the number). Fetches SyncToken first.",
  { invoice_id: z.string(), company: companyArg },
  tool(async ({ invoice_id, company }) => {
    const c = await resolveCompany(company, { write: true });
    const current = await fetchEntity("Invoice", invoice_id, c);
    const r = await qboRequest(`/invoice?operation=void`, { method: "POST", body: { Id: current.Id, SyncToken: current.SyncToken }, company: c });
    return asText({ voided: r.Invoice ?? { Id: invoice_id }, status: "Voided" });
  })
);

registerTool(
  "create_sales_receipt",
  "Create a sales receipt (paid-at-point-of-sale sale) with line items.",
  {
    customer_ref: z.string().optional().describe("Customer Id or DisplayName"),
    line_items: z.array(salesLineSchema),
    deposit_to_account: z.string().optional().describe("Account name/Id the money lands in"),
    txn_date: z.string().optional(),
    email: z.string().optional(),
    memo: z.string().optional(),
    location: z.string().optional().describe("Location/department name or Id (requires location tracking)"),
    company: companyArg,
  },
  tool(async ({ customer_ref, line_items, deposit_to_account, txn_date, email, memo, location, company }) => {
    const c = await resolveCompany(company, { write: true });
    const warnings = await closedPeriodWarnings(c, [txn_date]);
    const payload = { Line: await buildSalesLines(line_items, c) };
    if (customer_ref) payload.CustomerRef = await resolveRef("Customer", customer_ref, c, "DisplayName");
    if (deposit_to_account) payload.DepositToAccountRef = await resolveRef("Account", deposit_to_account, c, "Name");
    if (txn_date) payload.TxnDate = txn_date;
    if (email) payload.BillEmail = { Address: email };
    if (memo) payload.CustomerMemo = { value: memo };
    if (location) payload.DepartmentRef = await departmentRef(location, c);
    const r = await qboRequest(`/salesreceipt`, { method: "POST", body: payload, company: c });
    return asText(withWarnings({ created: r.SalesReceipt }, warnings));
  })
);

registerTool(
  "update_sales_receipt",
  "Sparse-update a sales receipt (fetches SyncToken first). Pass line_items only to replace all lines.",
  {
    sales_receipt_id: z.string(),
    line_items: z.array(salesLineSchema).optional(),
    txn_date: z.string().optional(),
    email: z.string().optional(),
    memo: z.string().optional(),
    company: companyArg,
  },
  tool(async ({ sales_receipt_id, line_items, txn_date, email, memo, company }) => {
    const c = await resolveCompany(company, { write: true });
    const current = await fetchEntity("SalesReceipt", sales_receipt_id, c);
    const payload = { Id: current.Id, SyncToken: current.SyncToken, sparse: true };
    if (line_items) payload.Line = await buildSalesLines(line_items, c);
    if (txn_date != null) payload.TxnDate = txn_date;
    if (email != null) payload.BillEmail = { Address: email };
    if (memo != null) payload.CustomerMemo = { value: memo };
    const r = await qboRequest(`/salesreceipt`, { method: "POST", body: payload, company: c });
    return asText({ updated: r.SalesReceipt });
  })
);

registerTool(
  "send_sales_receipt",
  "Email an existing sales receipt to the customer (or an override address).",
  { sales_receipt_id: z.string(), email: z.string().optional(), company: companyArg },
  tool(async ({ sales_receipt_id, email, company }) => {
    const c = await resolveCompany(company, { write: true });
    const q = email ? `?sendTo=${encodeURIComponent(email)}` : "";
    await qboRequest(`/salesreceipt/${encodeURIComponent(sales_receipt_id)}/send${q}`, { method: "POST", company: c });
    return asText({ sent: true, sales_receipt_id, to: email || "email on file" });
  })
);

registerTool(
  "create_credit_memo",
  "Create a credit memo for a customer, with line items.",
  {
    customer_ref: z.string().describe("Customer Id or DisplayName"),
    line_items: z.array(salesLineSchema),
    txn_date: z.string().optional(),
    memo: z.string().optional(),
    company: companyArg,
  },
  tool(async ({ customer_ref, line_items, txn_date, memo, company }) => {
    const c = await resolveCompany(company, { write: true });
    const warnings = await closedPeriodWarnings(c, [txn_date]);
    const payload = { CustomerRef: await resolveRef("Customer", customer_ref, c, "DisplayName"), Line: await buildSalesLines(line_items, c) };
    if (txn_date) payload.TxnDate = txn_date;
    if (memo) payload.CustomerMemo = { value: memo };
    const r = await qboRequest(`/creditmemo`, { method: "POST", body: payload, company: c });
    return asText(withWarnings({ created: r.CreditMemo }, warnings));
  })
);

registerTool(
  "create_refund_receipt",
  "Create a refund receipt (money returned to a customer), with line items.",
  {
    customer_ref: z.string().describe("Customer Id or DisplayName"),
    line_items: z.array(salesLineSchema),
    deposit_to_account: z.string().optional().describe("Account the refund is paid from (name/Id)"),
    txn_date: z.string().optional(),
    memo: z.string().optional(),
    company: companyArg,
  },
  tool(async ({ customer_ref, line_items, deposit_to_account, txn_date, memo, company }) => {
    const c = await resolveCompany(company, { write: true });
    const warnings = await closedPeriodWarnings(c, [txn_date]);
    const payload = { CustomerRef: await resolveRef("Customer", customer_ref, c, "DisplayName"), Line: await buildSalesLines(line_items, c) };
    if (deposit_to_account) payload.DepositToAccountRef = await resolveRef("Account", deposit_to_account, c, "Name");
    if (txn_date) payload.TxnDate = txn_date;
    if (memo) payload.CustomerMemo = { value: memo };
    const r = await qboRequest(`/refundreceipt`, { method: "POST", body: payload, company: c });
    return asText(withWarnings({ created: r.RefundReceipt }, warnings));
  })
);

registerTool(
  "create_payment",
  "Record a customer payment, optionally applied to a specific invoice.",
  {
    customer_ref: z.string().describe("Customer Id or DisplayName"),
    amount: z.number(),
    invoice_id: z.string().optional().describe("Invoice to apply the payment to"),
    txn_date: z.string().optional(),
    memo: z.string().optional(),
    company: companyArg,
  },
  tool(async ({ customer_ref, amount, invoice_id, txn_date, memo, company }) => {
    const c = await resolveCompany(company, { write: true });
    const warnings = await closedPeriodWarnings(c, [txn_date]);
    const payload = { CustomerRef: await resolveRef("Customer", customer_ref, c, "DisplayName"), TotalAmt: amount };
    if (invoice_id) {
      payload.Line = [{ Amount: amount, LinkedTxn: [{ TxnId: assertId(invoice_id, "invoice_id"), TxnType: "Invoice" }] }];
    }
    if (txn_date) payload.TxnDate = txn_date;
    if (memo) payload.PrivateNote = memo;
    const r = await qboRequest(`/payment`, { method: "POST", body: payload, company: c });
    return asText(withWarnings({ created: r.Payment }, warnings));
  })
);

registerTool(
  "create_deposit",
  "Create a bank deposit into an account, with one or more source lines.",
  {
    deposit_to_account: z.string().describe("Bank account to deposit into (name/Id)"),
    lines: z.array(depositLineSchema),
    txn_date: z.string().optional(),
    memo: z.string().optional(),
    company: companyArg,
  },
  tool(async ({ deposit_to_account, lines, txn_date, memo, company }) => {
    const c = await resolveCompany(company, { write: true });
    const warnings = await closedPeriodWarnings(c, [txn_date]);
    const payload = {
      DepositToAccountRef: await resolveRef("Account", deposit_to_account, c, "Name"),
      Line: await buildDepositLines(lines, c),
    };
    if (txn_date) payload.TxnDate = txn_date;
    if (memo) payload.PrivateNote = memo;
    const r = await qboRequest(`/deposit`, { method: "POST", body: payload, company: c });
    return asText(withWarnings({ created: r.Deposit }, warnings));
  })
);

/* =========================== PURCHASES / VENDORS =========================== */

registerTool(
  "create_expense",
  "Record an expense (Purchase) paid by cash, check, or credit card, categorized to expense accounts.",
  {
    payment_account: z.string().describe("Bank/credit-card account the money came from (name/Id)"),
    payment_type: z.enum(["Cash", "Check", "CreditCard"]),
    lines: z.array(accountLineSchema),
    payee_name: z.string().optional().describe("Vendor/Customer/Employee paid"),
    payee_type: z.enum(["Vendor", "Customer", "Employee"]).optional(),
    txn_date: z.string().optional(),
    memo: z.string().optional(),
    location: z.string().optional().describe("Location/department name or Id (requires location tracking)"),
    company: companyArg,
  },
  tool(async ({ payment_account, payment_type, lines, payee_name, payee_type, txn_date, memo, location, company }) => {
    const c = await resolveCompany(company, { write: true });
    const warnings = await closedPeriodWarnings(c, [txn_date]);
    const payload = {
      PaymentType: payment_type,
      AccountRef: await resolveRef("Account", payment_account, c, "Name"),
      Line: await buildAccountLines(lines, c),
    };
    if (location) payload.DepartmentRef = await departmentRef(location, c);
    if (payee_name) {
      if (!payee_type) throw new Error("payee_type is required when payee_name is set.");
      payload.EntityRef = await resolveRef(payee_type, payee_name, c, "DisplayName");
    }
    if (txn_date) payload.TxnDate = txn_date;
    if (memo) payload.PrivateNote = memo;
    const r = await qboRequest(`/purchase`, { method: "POST", body: payload, company: c });
    return asText(withWarnings({ created: r.Purchase }, warnings));
  })
);

registerTool(
  "update_purchase",
  "Sparse-update a purchase/expense (fetches SyncToken first). Pass lines only to replace all lines.",
  {
    purchase_id: z.string(),
    lines: z.array(accountLineSchema).optional(),
    txn_date: z.string().optional(),
    memo: z.string().optional(),
    company: companyArg,
  },
  tool(async ({ purchase_id, lines, txn_date, memo, company }) => {
    const c = await resolveCompany(company, { write: true });
    const current = await fetchEntity("Purchase", purchase_id, c);
    const warnings = txn_date ? await closedPeriodWarnings(c, [txn_date]) : [];
    const payload = { Id: current.Id, SyncToken: current.SyncToken, sparse: true, PaymentType: current.PaymentType, AccountRef: current.AccountRef };
    if (lines) payload.Line = await buildAccountLines(lines, c);
    if (txn_date != null) payload.TxnDate = txn_date;
    if (memo != null) payload.PrivateNote = memo;
    const r = await qboRequest(`/purchase`, { method: "POST", body: payload, company: c });
    return asText(withWarnings({ updated: r.Purchase }, warnings));
  })
);

registerTool(
  "create_bill_item_based",
  "Record a bill against product/service items (item-based lines), owed to a vendor.",
  {
    vendor_name: z.string(),
    line_items: z.array(itemLineSchema),
    transaction_date: z.string().optional().describe("YYYY-MM-DD"),
    memo: z.string().optional(),
    location: z.string().optional().describe("Location/department name or Id (requires location tracking)"),
    company: companyArg,
  },
  tool(async ({ vendor_name, line_items, transaction_date, memo, location, company }) => {
    const c = await resolveCompany(company, { write: true });
    const warnings = await closedPeriodWarnings(c, [transaction_date]);
    const payload = { VendorRef: await resolveRef("Vendor", vendor_name, c, "DisplayName"), Line: await buildItemExpenseLines(line_items, c) };
    if (transaction_date) payload.TxnDate = transaction_date;
    if (memo) payload.PrivateNote = memo;
    if (location) payload.DepartmentRef = await departmentRef(location, c);
    const r = await qboRequest(`/bill`, { method: "POST", body: payload, company: c });
    return asText(withWarnings({ created: r.Bill }, warnings));
  })
);

registerTool(
  "update_bill",
  "Sparse-update a bill (fetches SyncToken first). Pass account_lines only to replace all lines.",
  {
    bill_id: z.string(),
    account_lines: z.array(accountLineSchema).optional(),
    txn_date: z.string().optional(),
    memo: z.string().optional(),
    company: companyArg,
  },
  tool(async ({ bill_id, account_lines, txn_date, memo, company }) => {
    const c = await resolveCompany(company, { write: true });
    const current = await fetchEntity("Bill", bill_id, c);
    const warnings = txn_date ? await closedPeriodWarnings(c, [txn_date]) : [];
    // VendorRef is required even on a sparse Bill update — carry it forward.
    const payload = { Id: current.Id, SyncToken: current.SyncToken, sparse: true, VendorRef: current.VendorRef };
    if (account_lines) payload.Line = await buildAccountLines(account_lines, c);
    if (txn_date != null) payload.TxnDate = txn_date;
    if (memo != null) payload.PrivateNote = memo;
    const r = await qboRequest(`/bill`, { method: "POST", body: payload, company: c });
    return asText(withWarnings({ updated: r.Bill }, warnings));
  })
);

registerTool(
  "create_vendor_credit",
  "Record a vendor credit (money a vendor owes you), categorized to expense accounts.",
  {
    vendor_name: z.string(),
    lines: z.array(accountLineSchema),
    txn_date: z.string().optional(),
    memo: z.string().optional(),
    company: companyArg,
  },
  tool(async ({ vendor_name, lines, txn_date, memo, company }) => {
    const c = await resolveCompany(company, { write: true });
    const warnings = await closedPeriodWarnings(c, [txn_date]);
    const payload = { VendorRef: await resolveRef("Vendor", vendor_name, c, "DisplayName"), Line: await buildAccountLines(lines, c) };
    if (txn_date) payload.TxnDate = txn_date;
    if (memo) payload.PrivateNote = memo;
    const r = await qboRequest(`/vendorcredit`, { method: "POST", body: payload, company: c });
    return asText(withWarnings({ created: r.VendorCredit }, warnings));
  })
);

registerTool(
  "create_purchase_order",
  "Create a purchase order to a vendor, with item-based lines.",
  {
    vendor_name: z.string(),
    line_items: z.array(itemLineSchema),
    txn_date: z.string().optional(),
    memo: z.string().optional(),
    company: companyArg,
  },
  tool(async ({ vendor_name, line_items, txn_date, memo, company }) => {
    const c = await resolveCompany(company, { write: true });
    const payload = { VendorRef: await resolveRef("Vendor", vendor_name, c, "DisplayName"), Line: await buildItemExpenseLines(line_items, c) };
    // Purchase orders require an Accounts Payable account.
    const ap = (await qboQuery(`SELECT * FROM Account WHERE AccountType = 'Accounts Payable' MAXRESULTS 1`, { company: c })).Account?.[0];
    if (ap) payload.APAccountRef = { value: ap.Id, name: ap.Name };
    if (txn_date) payload.TxnDate = txn_date;
    if (memo) payload.PrivateNote = memo;
    const r = await qboRequest(`/purchaseorder`, { method: "POST", body: payload, company: c });
    return asText({ created: r.PurchaseOrder });
  })
);

registerTool(
  "create_vendor",
  "Create a new vendor.",
  {
    display_name: z.string(),
    email: z.string().optional(),
    phone: z.string().optional(),
    billing_address: z.string().optional(),
    company: companyArg,
  },
  tool(async ({ display_name, email, phone, billing_address, company }) => {
    const c = await resolveCompany(company, { write: true });
    const payload = { DisplayName: display_name };
    if (email) payload.PrimaryEmailAddr = { Address: email };
    if (phone) payload.PrimaryPhone = { FreeFormNumber: phone };
    if (billing_address) payload.BillAddr = { Line1: billing_address };
    const r = await qboRequest(`/vendor`, { method: "POST", body: payload, company: c });
    return asText({ created: r.Vendor });
  })
);

registerTool(
  "update_vendor",
  "Sparse-update an existing vendor (fetches SyncToken first).",
  {
    vendor_id: z.string(),
    display_name: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
    billing_address: z.string().optional(),
    active: z.boolean().optional(),
    company: companyArg,
  },
  tool(async ({ vendor_id, display_name, email, phone, billing_address, active, company }) => {
    const c = await resolveCompany(company, { write: true });
    const current = await fetchEntity("Vendor", vendor_id, c);
    const payload = { Id: current.Id, SyncToken: current.SyncToken, sparse: true };
    if (display_name != null) payload.DisplayName = display_name;
    if (email != null) payload.PrimaryEmailAddr = { Address: email };
    if (phone != null) payload.PrimaryPhone = { FreeFormNumber: phone };
    if (billing_address != null) payload.BillAddr = { Line1: billing_address };
    if (active != null) payload.Active = active;
    const r = await qboRequest(`/vendor`, { method: "POST", body: payload, company: c });
    return asText({ updated: r.Vendor });
  })
);

/* =========================== PEOPLE / ITEMS =========================== */

registerTool(
  "create_employee",
  "Create a new employee.",
  {
    display_name: z.string().optional().describe("If omitted, built from given/family name"),
    given_name: z.string().optional(),
    family_name: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
    company: companyArg,
  },
  tool(async ({ display_name, given_name, family_name, email, phone, company }) => {
    const c = await resolveCompany(company, { write: true });
    if (!display_name && !given_name && !family_name) throw new Error("Provide display_name or given_name/family_name.");
    const payload = {};
    if (display_name) payload.DisplayName = display_name;
    if (given_name) payload.GivenName = given_name;
    if (family_name) payload.FamilyName = family_name;
    if (email) payload.PrimaryEmailAddr = { Address: email };
    if (phone) payload.PrimaryPhone = { FreeFormNumber: phone };
    const r = await qboRequest(`/employee`, { method: "POST", body: payload, company: c });
    return asText({ created: r.Employee });
  })
);

registerTool(
  "create_time_activity",
  "Log a single time activity for an employee or vendor.",
  {
    name_of: z.enum(["Employee", "Vendor"]),
    person_name: z.string().describe("Employee/Vendor name or Id"),
    txn_date: z.string().describe("YYYY-MM-DD"),
    hours: z.number().int().optional(),
    minutes: z.number().int().optional(),
    description: z.string().optional(),
    customer_ref: z.string().optional().describe("Customer to bill the time to"),
    company: companyArg,
  },
  tool(async ({ name_of, person_name, txn_date, hours, minutes, description, customer_ref, company }) => {
    const c = await resolveCompany(company, { write: true });
    const ref = await resolveRef(name_of, person_name, c, "DisplayName");
    const payload = { NameOf: name_of, TxnDate: txn_date, Hours: hours ?? 0, Minutes: minutes ?? 0 };
    payload[name_of === "Employee" ? "EmployeeRef" : "VendorRef"] = ref;
    if (description) payload.Description = description;
    if (customer_ref) payload.CustomerRef = await resolveRef("Customer", customer_ref, c, "DisplayName");
    const r = await qboRequest(`/timeactivity`, { method: "POST", body: payload, company: c });
    return asText({ created: r.TimeActivity });
  })
);

registerTool(
  "update_item",
  "Sparse-update a product/service item (fetches SyncToken first).",
  {
    item_id: z.string(),
    name: z.string().optional(),
    unit_price: z.number().optional(),
    description: z.string().optional(),
    active: z.boolean().optional(),
    company: companyArg,
  },
  tool(async ({ item_id, name, unit_price, description, active, company }) => {
    const c = await resolveCompany(company, { write: true });
    const current = await fetchEntity("Item", item_id, c);
    const payload = { Id: current.Id, SyncToken: current.SyncToken, sparse: true };
    if (name != null) payload.Name = name;
    if (unit_price != null) payload.UnitPrice = unit_price;
    if (description != null) payload.Description = description;
    if (active != null) payload.Active = active;
    const r = await qboRequest(`/item`, { method: "POST", body: payload, company: c });
    return asText({ updated: r.Item });
  })
);

/* =========================== SEARCH & LISTS (7) =========================== */

const verboseArg = z.boolean().optional().describe("Return full QBO entities instead of compact rows");

// Typed, allowlisted advanced filters (see entities.js buildWhere).
const filterValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]);
const filtersArg = (fields) =>
  z.array(z.object({
    field: z.enum(fields),
    value: filterValue,
    operator: z.enum(["=", "<", ">", "<=", ">=", "LIKE", "IN"]).optional().describe("Default ="),
  })).optional().describe("Advanced filters, ANDed with the other arguments");

const BILL_FILTER_FIELDS = ["DocNumber", "TxnDate", "DueDate", "VendorRef", "Balance", "TotalAmt", "Id", "MetaData.LastUpdatedTime"];
const PAYMENT_FILTER_FIELDS = ["TxnDate", "CustomerRef", "TotalAmt", "Id", "MetaData.LastUpdatedTime"];
const ESTIMATE_FILTER_FIELDS = ["DocNumber", "TxnDate", "CustomerRef", "TotalAmt", "TxnStatus", "Id", "MetaData.LastUpdatedTime"];

function nameSearchTool(toolName, entity, plural, nameField, extraDesc = "", filterFields = [nameField, "Active", "Id", "MetaData.LastUpdatedTime"]) {
  registerTool(
    toolName,
    `Search ${plural} by name fragment (case-insensitive), with compact results and optional typed filters.${extraDesc}`,
    {
      term: z.string().optional().describe("Name fragment; omit to list all"),
      include_inactive: z.boolean().optional(),
      filters: filtersArg(filterFields),
      order_by: z.enum(filterFields).optional().describe("Sort field (defaults to the name)"),
      descending: z.boolean().optional(),
      verbose: verboseArg,
      company: companyArg,
    },
    tool(async ({ term, include_inactive, filters, order_by, descending, verbose, company }) => {
      const c = await resolveCompany(company);
      const where = [];
      if (term) where.push(`${nameField} LIKE '%${esc(term)}%'`);
      if (include_inactive) where.push(`Active IN (true, false)`);
      if (filters?.length) where.push(...buildWhere(filters, filterFields));
      const sql = `SELECT * FROM ${entity}${where.length ? " WHERE " + where.join(" AND ") : ""} ORDERBY ${order_by || nameField}${descending ? " DESC" : ""}`;
      const { rows, truncated } = await qboQueryAll(sql, entity, { company: c });
      return asText({ count: rows.length, truncated, [plural]: compactList(entity, rows, verbose) });
    })
  );
}

nameSearchTool("search_customers", "Customer", "customers", "DisplayName", "",
  ["DisplayName", "CompanyName", "GivenName", "FamilyName", "Active", "Balance", "Id", "MetaData.LastUpdatedTime"]);
nameSearchTool("search_vendors", "Vendor", "vendors", "DisplayName", "",
  ["DisplayName", "CompanyName", "Active", "Balance", "Id", "MetaData.LastUpdatedTime"]);
nameSearchTool("search_items", "Item", "items", "Name", "",
  ["Name", "Type", "Active", "Id", "MetaData.LastUpdatedTime"]);
nameSearchTool("search_accounts", "Account", "accounts", "Name", " Includes account type and current balance.",
  ["Name", "AccountType", "AccountSubType", "Active", "Id", "MetaData.LastUpdatedTime"]);
nameSearchTool("search_terms", "Term", "terms", "Name", " Payment terms (Net 30 etc.).");
nameSearchTool("search_payment_methods", "PaymentMethod", "payment_methods", "Name");
nameSearchTool("search_tax_codes", "TaxCode", "tax_codes", "Name");

registerTool(
  "get_bills",
  "List bills, optionally filtered by vendor, unpaid status, and date range.",
  {
    vendor: z.string().optional().describe("Vendor name or Id"),
    unpaid_only: z.boolean().optional(),
    start_date: z.string().optional().describe("YYYY-MM-DD"),
    end_date: z.string().optional().describe("YYYY-MM-DD"),
    filters: filtersArg(BILL_FILTER_FIELDS),
    verbose: verboseArg,
    company: companyArg,
  },
  tool(async ({ vendor, unpaid_only, start_date, end_date, filters, verbose, company }) => {
    const c = await resolveCompany(company);
    const where = [];
    if (vendor) where.push(`VendorRef = '${(await resolveRef("Vendor", vendor, c)).value}'`);
    if (unpaid_only) where.push(`Balance > '0'`);
    if (start_date) where.push(`TxnDate >= '${esc(start_date)}'`);
    if (end_date) where.push(`TxnDate <= '${esc(end_date)}'`);
    if (filters?.length) where.push(...buildWhere(filters, BILL_FILTER_FIELDS));
    const sql = `SELECT * FROM Bill${where.length ? " WHERE " + where.join(" AND ") : ""} ORDERBY TxnDate DESC`;
    const { rows, truncated } = await qboQueryAll(sql, "Bill", { company: c });
    return asText({ count: rows.length, truncated, bills: compactList("Bill", rows, verbose) });
  })
);

registerTool(
  "get_payments",
  "List customer payments received, optionally filtered by customer and date range.",
  {
    customer: z.string().optional().describe("Customer name or Id"),
    start_date: z.string().optional().describe("YYYY-MM-DD"),
    end_date: z.string().optional().describe("YYYY-MM-DD"),
    filters: filtersArg(PAYMENT_FILTER_FIELDS),
    verbose: verboseArg,
    company: companyArg,
  },
  tool(async ({ customer, start_date, end_date, filters, verbose, company }) => {
    const c = await resolveCompany(company);
    const where = [];
    if (customer) where.push(`CustomerRef = '${(await resolveRef("Customer", customer, c)).value}'`);
    if (start_date) where.push(`TxnDate >= '${esc(start_date)}'`);
    if (end_date) where.push(`TxnDate <= '${esc(end_date)}'`);
    if (filters?.length) where.push(...buildWhere(filters, PAYMENT_FILTER_FIELDS));
    const sql = `SELECT * FROM Payment${where.length ? " WHERE " + where.join(" AND ") : ""} ORDERBY TxnDate DESC`;
    const { rows, truncated } = await qboQueryAll(sql, "Payment", { company: c });
    return asText({ count: rows.length, truncated, payments: compactList("Payment", rows, verbose) });
  })
);

registerTool(
  "get_estimates",
  "List estimates (quotes), optionally filtered by customer and date range.",
  {
    customer: z.string().optional().describe("Customer name or Id"),
    start_date: z.string().optional().describe("YYYY-MM-DD"),
    end_date: z.string().optional().describe("YYYY-MM-DD"),
    filters: filtersArg(ESTIMATE_FILTER_FIELDS),
    verbose: verboseArg,
    company: companyArg,
  },
  tool(async ({ customer, start_date, end_date, filters, verbose, company }) => {
    const c = await resolveCompany(company);
    const where = [];
    if (customer) where.push(`CustomerRef = '${(await resolveRef("Customer", customer, c)).value}'`);
    if (start_date) where.push(`TxnDate >= '${esc(start_date)}'`);
    if (end_date) where.push(`TxnDate <= '${esc(end_date)}'`);
    if (filters?.length) where.push(...buildWhere(filters, ESTIMATE_FILTER_FIELDS));
    const sql = `SELECT * FROM Estimate${where.length ? " WHERE " + where.join(" AND ") : ""} ORDERBY TxnDate DESC`;
    const { rows, truncated } = await qboQueryAll(sql, "Estimate", { company: c });
    return asText({ count: rows.length, truncated, estimates: compactList("Estimate", rows, verbose) });
  })
);

/* ====================== AP PAYMENTS & TRANSFERS (3) ====================== */

registerTool(
  "create_bill_payment",
  "Pay one or more bills (or record an unapplied vendor payment) by check or credit card. Completes the AP cycle: create_bill enters the liability, this pays it.",
  {
    vendor_name: z.string().describe("Vendor name or Id"),
    amount: z.number().positive(),
    payment_account: z.string().describe("Bank account (Check) or credit card account (CreditCard), name or Id"),
    payment_type: z.enum(["Check", "CreditCard"]),
    bill_ids: z.array(z.string()).optional().describe("Bill Ids to apply the payment to, in order; the amount is allocated across their open balances"),
    txn_date: z.string().optional().describe("YYYY-MM-DD"),
    memo: z.string().optional(),
    company: companyArg,
  },
  tool(async ({ vendor_name, amount, payment_account, payment_type, bill_ids, txn_date, memo, company }) => {
    const c = await resolveCompany(company, { write: true });
    const warnings = await closedPeriodWarnings(c, [txn_date]);
    const payload = {
      VendorRef: await resolveRef("Vendor", vendor_name, c),
      TotalAmt: amount,
      PayType: payment_type,
    };
    const acctRef = await resolveRef("Account", payment_account, c, "Name");
    if (payment_type === "Check") payload.CheckPayment = { BankAccountRef: acctRef };
    else payload.CreditCardPayment = { CCAccountRef: acctRef };

    if (bill_ids?.length) {
      let remaining = amount;
      const lines = [];
      for (const id of bill_ids) {
        const bill = await fetchEntity("Bill", id, c);
        const open = Number(bill.Balance || 0);
        const applied = Math.min(remaining, open);
        if (applied > 0) {
          lines.push({ Amount: Number(applied.toFixed(2)), LinkedTxn: [{ TxnId: bill.Id, TxnType: "Bill" }] });
          remaining = Number((remaining - applied).toFixed(2));
        }
      }
      if (remaining > 0.005) {
        throw new Error(`Payment of ${amount} exceeds the open balance of the listed bills by ${remaining.toFixed(2)}. Lower the amount or add more bills.`);
      }
      payload.Line = lines;
    }
    if (txn_date) payload.TxnDate = txn_date;
    if (memo) payload.PrivateNote = memo;
    const r = await qboRequest(`/billpayment`, { method: "POST", body: payload, company: c });
    return asText(withWarnings({ created: r.BillPayment }, warnings));
  })
);

registerTool(
  "get_bill_payments",
  "List bill payments, optionally filtered by vendor and date range.",
  {
    vendor: z.string().optional().describe("Vendor name or Id"),
    start_date: z.string().optional().describe("YYYY-MM-DD"),
    end_date: z.string().optional().describe("YYYY-MM-DD"),
    verbose: verboseArg,
    company: companyArg,
  },
  tool(async ({ vendor, start_date, end_date, verbose, company }) => {
    const c = await resolveCompany(company);
    const where = [];
    if (vendor) where.push(`VendorRef = '${(await resolveRef("Vendor", vendor, c)).value}'`);
    if (start_date) where.push(`TxnDate >= '${esc(start_date)}'`);
    if (end_date) where.push(`TxnDate <= '${esc(end_date)}'`);
    const sql = `SELECT * FROM BillPayment${where.length ? " WHERE " + where.join(" AND ") : ""} ORDERBY TxnDate DESC`;
    const { rows, truncated } = await qboQueryAll(sql, "BillPayment", { company: c });
    return asText({ count: rows.length, truncated, bill_payments: compactList("BillPayment", rows, verbose) });
  })
);

registerTool(
  "create_transfer",
  "Move money between two balance-sheet accounts (e.g. checking to savings).",
  {
    from_account: z.string().describe("Source account name or Id"),
    to_account: z.string().describe("Destination account name or Id"),
    amount: z.number().positive(),
    txn_date: z.string().optional().describe("YYYY-MM-DD"),
    memo: z.string().optional(),
    company: companyArg,
  },
  tool(async ({ from_account, to_account, amount, txn_date, memo, company }) => {
    const c = await resolveCompany(company, { write: true });
    const warnings = await closedPeriodWarnings(c, [txn_date]);
    const payload = {
      FromAccountRef: await resolveRef("Account", from_account, c, "Name"),
      ToAccountRef: await resolveRef("Account", to_account, c, "Name"),
      Amount: amount,
    };
    if (txn_date) payload.TxnDate = txn_date;
    if (memo) payload.PrivateNote = memo;
    const r = await qboRequest(`/transfer`, { method: "POST", body: payload, company: c });
    return asText(withWarnings({ created: r.Transfer }, warnings));
  })
);

/* =========================== CHANGE TRACKING (1) ========================== */

registerTool(
  "get_changes_since",
  "Change Data Capture: everything that changed (created/updated/deleted) for the given entity types since a timestamp. QBO keeps roughly 30 days of change history. Ideal for \"what changed in this file this week\".",
  {
    entities: z.string().describe("Comma-separated entity names, e.g. \"Invoice,Bill,Customer,JournalEntry\""),
    changed_since: z.string().describe("ISO date or datetime, e.g. 2026-07-01 or 2026-07-01T00:00:00Z (must be within ~30 days)"),
    company: companyArg,
  },
  tool(async ({ entities, changed_since, company }) => {
    const c = await resolveCompany(company);
    const list = entities.split(",").map((s) => s.trim()).filter(Boolean);
    if (!list.length || list.some((e) => !/^[A-Za-z]+$/.test(e))) {
      throw new Error(`entities must be comma-separated QBO entity names, got "${entities}".`);
    }
    const sinceMs = Date.parse(changed_since);
    if (Number.isNaN(sinceMs)) throw new Error(`changed_since is not a valid date: "${changed_since}"`);
    if (Date.now() - sinceMs > 31 * 86_400_000) {
      throw new Error("changed_since is more than ~30 days back; QBO's change data capture only covers about 30 days.");
    }
    const q = `entities=${encodeURIComponent(list.join(","))}&changedSince=${encodeURIComponent(changed_since)}`;
    return asText(await qboRequest(`/cdc?${q}`, { company: c }));
  })
);

/* ===================== FLEET (MULTI-COMPANY) TOOLS (3) ==================== */

// Run one report across several companies and merge the rows side by side.
async function consolidatedReport(reportName, targetCompanies, params) {
  const known = await listCompanies();
  const slugs = targetCompanies?.length
    ? targetCompanies.map((s) => sanitizeSlug(s))
    : known.map((k) => k.slug);
  if (!slugs.length) throw new Error("No companies connected.");
  const byCompany = [];
  const errors = [];
  for (const slug of slugs) {
    if (!known.some((k) => k.slug === slug)) {
      errors.push({ company: slug, error: "not connected (see list_companies)" });
      continue;
    }
    try {
      const rep = await qboRequest(`/reports/${reportName}${reportQuery(params)}`, { company: slug });
      byCompany.push({ company: slug, flat: flattenReport(rep) });
    } catch (e) {
      errors.push({ company: slug, error: e.message });
    }
  }
  if (!byCompany.length) {
    throw new Error(`No reports could be fetched. ${errors.map((e) => `${e.company}: ${e.error}`).join("; ")}`);
  }
  const consolidated = consolidateReports(byCompany);
  return errors.length ? { ...consolidated, errors } : consolidated;
}

registerTool(
  "get_consolidated_profit_and_loss",
  "Profit & Loss across several companies at once: one table, a column per company, plus a combined total. Rows are merged by account name; summary rows (Total Income, Net Income) are included with is_summary: true.",
  {
    start_date: z.string().describe("YYYY-MM-DD"),
    end_date: z.string().describe("YYYY-MM-DD"),
    accounting_method: accountingMethodArg,
    companies: z.array(z.string()).optional().describe("Company slugs to include (default: every connected company)"),
  },
  tool(async ({ start_date, end_date, accounting_method, companies }) => {
    return asText(await consolidatedReport("ProfitAndLoss", companies, { start_date, end_date, accounting_method }));
  })
);

registerTool(
  "get_consolidated_balance_sheet",
  "Balance Sheet across several companies at once: one table, a column per company, plus a combined total.",
  {
    start_date: z.string().optional().describe("YYYY-MM-DD"),
    end_date: z.string().describe("YYYY-MM-DD (the as-of date)"),
    accounting_method: accountingMethodArg,
    companies: z.array(z.string()).optional().describe("Company slugs to include (default: every connected company)"),
  },
  tool(async ({ start_date, end_date, accounting_method, companies }) => {
    return asText(await consolidatedReport("BalanceSheet", companies, { start_date, end_date, accounting_method }));
  })
);

registerTool(
  "create_journal_entry_multi",
  "Post the same journal entry to several companies in one call (e.g. a monthly management fee across client files). Companies must be listed explicitly; account/entity names are resolved per company. Returns a per-company result, so one failure never blocks the rest.",
  {
    companies: z.array(z.string()).min(1).describe("Explicit company slugs to post to (never inferred)"),
    lines: z.array(journalLineSchema).describe("At least two lines; debits must equal credits"),
    txn_date: z.string().optional().describe("YYYY-MM-DD (defaults to today)"),
    doc_number: z.string().optional(),
    memo: z.string().optional(),
    adjustment: z.boolean().optional(),
  },
  tool(async ({ companies: targets, lines, txn_date, doc_number, memo, adjustment }) => {
    const known = await listCompanies();
    const results = [];
    for (const raw of targets) {
      const slug = sanitizeSlug(raw);
      const entry = { company: slug };
      try {
        if (!known.some((k) => k.slug === slug)) {
          throw new Error(`No such company "${raw}". Available: ${formatCompanyList(known)}.`);
        }
        await checkWritePolicy(slug, null);
        const warnings = await closedPeriodWarnings(slug, [txn_date]);
        const payload = { Line: await buildJournalLines(lines, slug) };
        if (txn_date) payload.TxnDate = txn_date;
        if (doc_number) payload.DocNumber = doc_number;
        if (memo) payload.PrivateNote = memo;
        if (adjustment != null) payload.Adjustment = adjustment;
        const r = await qboRequest(`/journalentry`, { method: "POST", body: payload, company: slug });
        entry.status = "ok";
        entry.journal_entry_id = r.JournalEntry?.Id;
        entry.doc_number = r.JournalEntry?.DocNumber;
        if (warnings.length) entry.warnings = warnings;
      } catch (e) {
        entry.status = "error";
        entry.error = e.message;
      }
      results.push(entry);
    }
    const failed = results.filter((r) => r.status !== "ok").length;
    return asText({ posted: results.length - failed, failed, results });
  })
);

/* ===================== RECONCILIATION & REVIEW (3) ======================== */

registerTool(
  "reconcile_bank_csv",
  "Compare a bank-statement CSV against the QBO register for that bank account: what matches, what is on the statement but not in the books, and what is in the books but not on the statement. Matches on exact amount within a date tolerance. Read-only.",
  {
    file_path: z.string(),
    bank_account_name: z.string(),
    start_date: z.string().optional().describe("YYYY-MM-DD (default: earliest statement date)"),
    end_date: z.string().optional().describe("YYYY-MM-DD (default: latest statement date)"),
    date_tolerance_days: z.number().int().min(0).max(14).optional().describe("Default 2"),
    amount_convention: z.enum(["negative_out", "positive_out"]).optional(),
    company: companyArg,
  },
  tool(async ({ file_path, bank_account_name, start_date, end_date, date_tolerance_days, amount_convention, company }) => {
    const c = await resolveCompany(company);
    const fileBytes = await readFile(expandHome(file_path));
    const plan = planImport(parseCSV(fileBytes.toString("utf8")), { amountConvention: amount_convention });
    if (plan.errors.length) {
      return asText({
        error_rows: plan.errors,
        note: "Fix or accept these unreadable rows first; they are excluded from the comparison below.",
      });
    }
    const bank = await findAccountByName(bank_account_name, c);
    if (!bank) throw notFoundError("Account", bank_account_name, await suggestNames("Account", bank_account_name, c, "Name"));

    const allDates = [...plan.outflows, ...plan.inflows].map((r) => r.date).sort();
    const from = start_date || allDates[0];
    const to = end_date || allDates[allDates.length - 1];
    if (!from || !to) throw new Error("The CSV has no readable rows to reconcile.");

    const purchases = await qboQueryAll(
      `SELECT * FROM Purchase WHERE AccountRef = '${bank.Id}' AND TxnDate >= '${esc(from)}' AND TxnDate <= '${esc(to)}'`,
      "Purchase", { company: c }
    );
    const deposits = await qboQueryAll(
      `SELECT * FROM Deposit WHERE DepositToAccountRef = '${bank.Id}' AND TxnDate >= '${esc(from)}' AND TxnDate <= '${esc(to)}'`,
      "Deposit", { company: c }
    );
    const registerOut = purchases.rows.map((p) => ({
      id: p.Id, type: "Purchase", date: p.TxnDate, amount: Number(p.TotalAmt || 0),
      payee: p.EntityRef?.name ?? null, memo: p.PrivateNote ?? null,
    }));
    const registerIn = deposits.rows.map((d) => ({
      id: d.Id, type: "Deposit", date: d.TxnDate, amount: Number(d.TotalAmt || 0), memo: d.PrivateNote ?? null,
    }));

    const tolerance = { toleranceDays: date_tolerance_days ?? 2 };
    const outflows = matchTransactions(plan.outflows, registerOut, tolerance);
    const inflows = matchTransactions(plan.inflows, registerIn, tolerance);

    return asText({
      company: c || "(default)",
      bank_account: bank.Name,
      period: { from, to },
      outflows: {
        matched: outflows.matched.length,
        on_statement_not_in_books: outflows.statement_only,
        in_books_not_on_statement: outflows.register_only,
      },
      inflows: {
        matched: inflows.matched.length,
        on_statement_not_in_books: inflows.statement_only,
        in_books_not_on_statement: inflows.register_only,
      },
      truncated: purchases.truncated || deposits.truncated || undefined,
      note: "Register scan covers Purchases and Deposits on this account. Transfers and bill payments are not scanned and can explain leftovers. Statement-only outflows can be imported with import_transactions_from_csv.",
    });
  })
);

registerTool(
  "find_duplicate_transactions",
  "Scan for likely duplicate transactions: same party and exact amount, dated within a few days of each other. Returns candidate groups for human review; nothing is changed.",
  {
    entity: z.enum(["Purchase", "Bill", "Invoice"]),
    start_date: z.string().optional().describe("YYYY-MM-DD"),
    end_date: z.string().optional().describe("YYYY-MM-DD"),
    date_window_days: z.number().int().min(0).max(31).optional().describe("Default 3"),
    company: companyArg,
  },
  tool(async ({ entity, start_date, end_date, date_window_days, company }) => {
    const c = await resolveCompany(company);
    const where = [];
    if (start_date) where.push(`TxnDate >= '${esc(start_date)}'`);
    if (end_date) where.push(`TxnDate <= '${esc(end_date)}'`);
    const sql = `SELECT * FROM ${entity}${where.length ? " WHERE " + where.join(" AND ") : ""}`;
    const { rows, truncated } = await qboQueryAll(sql, entity, { company: c });
    const party = (r) =>
      entity === "Invoice" ? r.CustomerRef?.name ?? r.CustomerRef?.value
      : entity === "Bill" ? r.VendorRef?.name ?? r.VendorRef?.value
      : r.EntityRef?.name ?? r.AccountRef?.name ?? null;
    const mapped = rows.map((r) => ({
      id: r.Id, doc_number: r.DocNumber ?? null, party: party(r),
      amount: Number(r.TotalAmt || 0), date: r.TxnDate,
    }));
    const groups = findDuplicateGroups(mapped, { dateWindowDays: date_window_days ?? 3 });
    return asText({
      entity,
      scanned: mapped.length,
      truncated,
      duplicate_groups: groups.length,
      candidates: groups,
      note: "Same party, same amount, close dates. Review before deleting anything; legitimate repeats (rent, subscriptions) look identical.",
    });
  })
);

registerTool(
  "get_general_ledger_flat",
  "General Ledger as flat transaction rows (account, date, type, num, name, memo, split, amount) instead of QBO's nested report tree. Optional review flags mark weekend postings, large or round amounts, and journal entries. Built for review and analysis passes.",
  {
    start_date: z.string().optional().describe("YYYY-MM-DD"),
    end_date: z.string().optional().describe("YYYY-MM-DD"),
    date_macro: dateMacroArg,
    accounting_method: accountingMethodArg,
    flags: z.boolean().optional().describe("Attach review-heuristic flags (default true)"),
    company: companyArg,
  },
  tool(async ({ start_date, end_date, date_macro, accounting_method, flags, company }) => {
    const c = await resolveCompany(company);
    const q = reportQuery({
      start_date, end_date, date_macro, accounting_method,
      columns: "tx_date,txn_type,doc_num,name,memo,split_acc,subt_nat_amount",
    });
    const rep = await qboRequest(`/reports/GeneralLedger${q}`, { company: c });
    let rows = glFlatten(flattenReport(rep));
    if (flags !== false) rows = flagGlRows(rows);
    return asText({
      count: rows.length,
      rows,
      ...(flags !== false ? { flag_meanings: {
        weekend: "posted on a Saturday or Sunday",
        round_amount: "1,000 or more in even hundreds",
        large: "absolute amount of 10,000 or more",
        journal_entry: "posted via journal entry",
      } } : {}),
    });
  })
);

/* =========================== DOCUMENTS (2) =========================== */

const EXPORTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "exports");

async function savePdf(kind, rec, buf, save_path) {
  const name = `${kind}-${String(rec.DocNumber || rec.Id).replace(/[^A-Za-z0-9_-]/g, "")}.pdf`;
  const dest = save_path ? expandHome(save_path) : path.join(EXPORTS_DIR, name);
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  return dest;
}

registerTool(
  "get_invoice_pdf",
  "Download an invoice as a client-ready PDF file (saved locally, default under exports/).",
  {
    invoice_id: z.string(),
    save_path: z.string().optional().describe("Full file path to save to (default exports/invoice-<doc>.pdf)"),
    company: companyArg,
  },
  tool(async ({ invoice_id, save_path, company }) => {
    const c = await resolveCompany(company);
    const inv = await fetchEntity("Invoice", invoice_id, c);
    const buf = await qboRequestBinary(`/invoice/${encodeURIComponent(inv.Id)}/pdf`, { company: c });
    const dest = await savePdf("invoice", inv, buf, save_path);
    return asText({ saved_to: dest, bytes: buf.length, doc_number: inv.DocNumber ?? null, total: inv.TotalAmt ?? null });
  })
);

registerTool(
  "get_estimate_pdf",
  "Download an estimate (quote) as a client-ready PDF file (saved locally, default under exports/).",
  {
    estimate_id: z.string(),
    save_path: z.string().optional().describe("Full file path to save to (default exports/estimate-<doc>.pdf)"),
    company: companyArg,
  },
  tool(async ({ estimate_id, save_path, company }) => {
    const c = await resolveCompany(company);
    const est = await fetchEntity("Estimate", estimate_id, c);
    const buf = await qboRequestBinary(`/estimate/${encodeURIComponent(est.Id)}/pdf`, { company: c });
    const dest = await savePdf("estimate", est, buf, save_path);
    return asText({ saved_to: dest, bytes: buf.length, doc_number: est.DocNumber ?? null, total: est.TotalAmt ?? null });
  })
);

/* ======================= BALANCES & BUDGET READS (5) ======================= */

registerTool(
  "get_customer_balance",
  "Customer Balance report: what every customer currently owes.",
  { customer: z.string().optional().describe("Limit to a single customer Id"), date_macro: dateMacroArg, company: companyArg },
  tool(async ({ customer, date_macro, company }) => {
    const c = await resolveCompany(company);
    return asText(await qboRequest(`/reports/CustomerBalance${reportQuery({ customer, date_macro })}`, { company: c }));
  })
);

registerTool(
  "get_sales_by_customer",
  "Sales by Customer summary report for a date range.",
  {
    start_date: z.string().optional().describe("YYYY-MM-DD"),
    end_date: z.string().optional().describe("YYYY-MM-DD"),
    date_macro: dateMacroArg,
    accounting_method: accountingMethodArg,
    company: companyArg,
  },
  tool(async ({ start_date, end_date, date_macro, accounting_method, company }) => {
    const c = await resolveCompany(company);
    return asText(await qboRequest(`/reports/CustomerSales${reportQuery({ start_date, end_date, date_macro, accounting_method })}`, { company: c }));
  })
);

registerTool(
  "get_vendor_balance",
  "Vendor Balance report: what you currently owe every vendor.",
  { vendor: z.string().optional().describe("Limit to a single vendor Id"), date_macro: dateMacroArg, company: companyArg },
  tool(async ({ vendor, date_macro, company }) => {
    const c = await resolveCompany(company);
    return asText(await qboRequest(`/reports/VendorBalance${reportQuery({ vendor, date_macro })}`, { company: c }));
  })
);

registerTool(
  "get_vendor_expenses",
  "Expenses by Vendor summary report for a date range.",
  {
    start_date: z.string().optional().describe("YYYY-MM-DD"),
    end_date: z.string().optional().describe("YYYY-MM-DD"),
    date_macro: dateMacroArg,
    vendor: z.string().optional().describe("Limit to a single vendor Id"),
    company: companyArg,
  },
  tool(async ({ start_date, end_date, date_macro, vendor, company }) => {
    const c = await resolveCompany(company);
    return asText(await qboRequest(`/reports/VendorExpenses${reportQuery({ start_date, end_date, date_macro, vendor })}`, { company: c }));
  })
);

registerTool(
  "get_budgets",
  "List budgets (name, period, type). Pass verbose for the full budget detail lines.",
  { verbose: verboseArg, company: companyArg },
  tool(async ({ verbose, company }) => {
    const c = await resolveCompany(company);
    const { rows, truncated } = await qboQueryAll(`SELECT * FROM Budget`, "Budget", { company: c });
    return asText({ count: rows.length, truncated, budgets: compactList("Budget", rows, verbose) });
  })
);

/* =========================== SETUP ENTITIES (6) =========================== */

registerTool(
  "create_class",
  "Create a class for class tracking (optionally as a sub-class).",
  { name: z.string(), parent_class: z.string().optional().describe("Parent class name or Id"), company: companyArg },
  tool(async ({ name, parent_class, company }) => {
    const c = await resolveCompany(company, { write: true });
    const payload = { Name: name };
    if (parent_class) { payload.ParentRef = await resolveRef("Class", parent_class, c, "Name"); payload.SubClass = true; }
    const r = await qboRequest(`/class`, { method: "POST", body: payload, company: c });
    return asText({ created: r.Class });
  })
);

registerTool(
  "update_class",
  "Rename or activate/deactivate a class (fetches SyncToken first).",
  { class_id: z.string(), name: z.string().optional(), active: z.boolean().optional(), company: companyArg },
  tool(async ({ class_id, name, active, company }) => {
    const c = await resolveCompany(company, { write: true });
    const current = await fetchEntity("Class", class_id, c);
    const payload = { Id: current.Id, SyncToken: current.SyncToken, sparse: true };
    if (name != null) payload.Name = name;
    if (active != null) payload.Active = active;
    const r = await qboRequest(`/class`, { method: "POST", body: payload, company: c });
    return asText({ updated: r.Class });
  })
);

registerTool(
  "create_department",
  "Create a location/department for location tracking (optionally as a sub-location).",
  { name: z.string(), parent_department: z.string().optional().describe("Parent location name or Id"), company: companyArg },
  tool(async ({ name, parent_department, company }) => {
    const c = await resolveCompany(company, { write: true });
    const payload = { Name: name };
    if (parent_department) { payload.ParentRef = await resolveRef("Department", parent_department, c, "Name"); payload.SubDepartment = true; }
    const r = await qboRequest(`/department`, { method: "POST", body: payload, company: c });
    return asText({ created: r.Department });
  })
);

registerTool(
  "update_department",
  "Rename or activate/deactivate a location/department (fetches SyncToken first).",
  { department_id: z.string(), name: z.string().optional(), active: z.boolean().optional(), company: companyArg },
  tool(async ({ department_id, name, active, company }) => {
    const c = await resolveCompany(company, { write: true });
    const current = await fetchEntity("Department", department_id, c);
    const payload = { Id: current.Id, SyncToken: current.SyncToken, sparse: true };
    if (name != null) payload.Name = name;
    if (active != null) payload.Active = active;
    const r = await qboRequest(`/department`, { method: "POST", body: payload, company: c });
    return asText({ updated: r.Department });
  })
);

registerTool(
  "create_payment_method",
  "Create a payment method (e.g. ACH, Wire).",
  { name: z.string(), type: z.enum(["CREDIT_CARD", "NON_CREDIT_CARD"]).optional(), company: companyArg },
  tool(async ({ name, type, company }) => {
    const c = await resolveCompany(company, { write: true });
    const payload = { Name: name };
    if (type) payload.Type = type;
    const r = await qboRequest(`/paymentmethod`, { method: "POST", body: payload, company: c });
    return asText({ created: r.PaymentMethod });
  })
);

registerTool(
  "create_term",
  "Create a payment term (e.g. Net 45).",
  { name: z.string(), due_days: z.number().int().positive(), company: companyArg },
  tool(async ({ name, due_days, company }) => {
    const c = await resolveCompany(company, { write: true });
    const r = await qboRequest(`/term`, { method: "POST", body: { Name: name, DueDays: due_days }, company: c });
    return asText({ created: r.Term });
  })
);

/* =========================== DANGER ZONE (1) =========================== */

registerTool(
  "delete_transaction",
  "PERMANENTLY delete a transaction; this cannot be undone (prefer void_invoice for invoices, which keeps the number trail). Pairs with find_duplicate_transactions for removing confirmed duplicates. Policy-checked, closed-period-checked, and audit-logged.",
  {
    entity: z.enum(["Invoice", "Bill", "BillPayment", "Payment", "Purchase", "JournalEntry", "Deposit", "Transfer", "VendorCredit", "CreditMemo", "RefundReceipt", "SalesReceipt", "Estimate", "TimeActivity"]),
    transaction_id: z.string(),
    company: companyArg,
  },
  tool(async ({ entity, transaction_id, company }) => {
    const c = await resolveCompany(company, { write: true });
    const current = await fetchEntity(entity, transaction_id, c);
    const warnings = await closedPeriodWarnings(c, [current.TxnDate]);
    const r = await qboRequest(`/${entity.toLowerCase()}?operation=delete`, {
      method: "POST",
      body: { Id: current.Id, SyncToken: current.SyncToken },
      company: c,
    });
    return asText(withWarnings({
      deleted: {
        entity,
        id: current.Id,
        doc_number: current.DocNumber ?? null,
        txn_date: current.TxnDate ?? null,
        total: current.TotalAmt ?? null,
      },
      qbo_status: r[entity]?.status ?? "Deleted",
    }, warnings));
  })
);

/* =========================== ATTACHMENTS & ADVANCED =========================== */

registerTool(
  "attach_file",
  "Attach a file (from a local path) and/or a note to a QuickBooks record, or upload a standalone file. Link it to a record with attach_to_entity + attach_to_id.",
  {
    note: z.string().optional(),
    file_path: z.string().optional().describe("Local path to a file to upload"),
    file_name: z.string().optional().describe("Override the stored file name"),
    content_type: z.string().optional().describe("MIME type; guessed from the extension if omitted"),
    attach_to_entity: z.string().optional().describe("e.g. Invoice, Bill, Customer, Vendor, Estimate, SalesReceipt, Purchase, JournalEntry"),
    attach_to_id: z.string().optional(),
    company: companyArg,
  },
  tool(async ({ note, file_path, file_name, content_type, attach_to_entity, attach_to_id, company }) => {
    const c = await resolveCompany(company, { write: true });
    if (!file_path && !note) throw new Error("Provide at least a file_path or a note.");
    const ref = (attach_to_entity && attach_to_id)
      ? [{ EntityRef: { type: attach_to_entity, value: String(attach_to_id) } }]
      : undefined;

    if (!file_path) {
      const body = { Note: note };
      if (ref) body.AttachableRef = ref;
      const r = await qboRequest(`/attachable`, { method: "POST", body, company: c });
      return asText({ created: r.Attachable });
    }

    const buf = await readFile(expandHome(file_path));
    const name = file_name || path.basename(file_path);
    const ctype = content_type || guessContentType(name);
    const meta = { FileName: name, ContentType: ctype };
    if (note) meta.Note = note;
    if (ref) meta.AttachableRef = ref;
    const fd = new FormData();
    fd.append("file_metadata_01", new Blob([JSON.stringify(meta)], { type: "application/json" }), "metadata.json");
    fd.append("file_content_01", new Blob([buf], { type: ctype }), name);
    const r = await qboUpload(fd, { company: c });
    return asText({ created: r.AttachableResponse?.[0]?.Attachable ?? r });
  })
);

registerTool(
  "get_attachments",
  "List attachments (files/notes), optionally only those linked to a specific record.",
  {
    attach_to_entity: z.string().optional(),
    attach_to_id: z.string().optional(),
    max_results: z.number().int().positive().max(1000).optional(),
    company: companyArg,
  },
  tool(async ({ attach_to_entity, attach_to_id, max_results, company }) => {
    const c = await resolveCompany(company);
    // AttachableRef is not queryable in QBO, so fetch (paginated) and filter
    // client-side; `truncated` says whether the scan hit the cap.
    const { rows: all, truncated } = await qboQueryAll(`SELECT * FROM Attachable`, "Attachable", {
      company: c,
      maxTotal: max_results || 1000,
    });
    const items = attach_to_id
      ? all.filter((a) => (a.AttachableRef || []).some((r) =>
          r.EntityRef?.value === String(attach_to_id) && (!attach_to_entity || r.EntityRef?.type === attach_to_entity)))
      : all;
    return asText({ count: items.length, scanned: all.length, truncated, attachments: items });
  })
);

registerTool(
  "api_request",
  "Advanced escape hatch: make a raw authenticated call to any QBO endpoint under /v3/company/{realmId}. Provide `path` (e.g. \"/reports/GeneralLedger?start_date=2026-01-01\", \"/query?query=SELECT * FROM Bill\", \"/invoice/145\"), an HTTP method, and an optional JSON body. Auth, realm, and minorversion are handled for you.",
  {
    path: z.string().describe("Path after /v3/company/{realmId}, starting with '/'"),
    method: z.enum(["GET", "POST"]).optional().describe("Default GET"),
    body: z.record(z.any()).optional().describe("JSON body for POST"),
    company: companyArg,
  },
  tool(async ({ path: reqPath, method, body, company }) => {
    const isWrite = (method || "GET").toUpperCase() !== "GET";
    const c = await resolveCompany(company, { write: isWrite });
    const p = reqPath.startsWith("/") ? reqPath : `/${reqPath}`;
    if (/[\r\n\t]/.test(p)) throw new Error("Control characters are not allowed in `path`.");
    let decodedPath;
    try {
      decodedPath = decodeURIComponent(p.split("?")[0]);
    } catch {
      throw new Error("Invalid percent-encoding in `path`.");
    }
    if (decodedPath.includes("..") || decodedPath.includes("\\")) {
      throw new Error("Path traversal sequences are not allowed in `path`; it must stay under /v3/company/{realmId}.");
    }
    return asText(await qboRequest(p, { method: method || "GET", body, company: c }));
  })
);

// Path validation shared with api_request, GET-only. Split out so permission
// settings can distinguish them: api_get is safe to always-allow, while
// api_request (which can write) should stay behind approval.
registerTool(
  "api_get",
  "Read-only escape hatch: GET any QBO endpoint under /v3/company/{realmId} (reports, queries, single records). Never writes; safe to always-allow. Use api_request when a POST is required.",
  {
    path: z.string().describe("Path after /v3/company/{realmId}, starting with '/'"),
    company: companyArg,
  },
  tool(async ({ path: reqPath, company }) => {
    const c = await resolveCompany(company);
    const p = reqPath.startsWith("/") ? reqPath : `/${reqPath}`;
    if (/[\r\n\t]/.test(p)) throw new Error("Control characters are not allowed in `path`.");
    let decodedPath;
    try {
      decodedPath = decodeURIComponent(p.split("?")[0]);
    } catch {
      throw new Error("Invalid percent-encoding in `path`.");
    }
    if (decodedPath.includes("..") || decodedPath.includes("\\")) {
      throw new Error("Path traversal sequences are not allowed in `path`; it must stay under /v3/company/{realmId}.");
    }
    return asText(await qboRequest(p, { company: c }));
  })
);

// ---- start -----------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
log(`QBO MCP server running (stdio).${suppressedTools ? ` ${suppressedTools} write tools suppressed by QBO_DISABLE_* env.` : ""}`);
