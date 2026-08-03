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
  beginAuthorization,
  authorizationStatus,
  cancelAuthorization,
  deriveSlugFromRealm,
  listCompanies,
  sanitizeSlug,
} from "./qbo.js";
import { todayISO, esc, assertId, guessContentType, resolveUserPath } from "./util.js";
import { record as auditRecord } from "./audit.js";
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
import { flattenReport, consolidateReports, glFlatten, flagGlRows, reportReceipt } from "./reports.js";
import { matchTransactions, findDuplicateGroups } from "./reconcile.js";
import { checkWritePolicy, policyFor, setCompanyPolicy, policyPath } from "./policy.js";
import { roster, resolveClient, registerClient, clientsPath } from "./clients.js";

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

// ---- Production authorization via the hosted catcher ----------------------
// `node src/index.js --connect-catcher <slug> [--sandbox]`
//
// Intuit refuses http://localhost as a production redirect URI, so --connect
// and connect_company (both of which catch the callback on localhost) work for
// sandbox files only. Real client books authorize through an HTTPS catcher page
// and a pasted line. See src/connect-catcher.js.
if (process.argv.includes("--connect-catcher")) {
  const i = process.argv.indexOf("--connect-catcher");
  const next = process.argv[i + 1];
  const slug = next && !next.startsWith("--") ? next : process.env.QBO_COMPANY || "";
  const environment = process.argv.includes("--sandbox") ? "sandbox" : "production";
  try {
    const { connectViaCatcher } = await import("./connect-catcher.js");
    const r = await connectViaCatcher(slug, environment);
    log(`Authorized "${r.slug}" → ${r.company_name ?? "(name unread)"} (realm ${r.realmId}, ${r.environment}).`);
    if (r.warning) log(r.warning);
    if (r.duplicate_slugs) log(`WARNING: realm ${r.realmId} is also authorized as: ${r.duplicate_slugs.join(", ")}`);
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
    process.exit(0);
  } catch (e) {
    log("Authorization failed:", e.message);
    process.exit(1);
  }
}

// ---- Production authorization via Intuit's OAuth Playground ----------------
// `node src/index.js --connect-playground <slug> [--sandbox] [--no-browser]`
//
// Alternative to the catcher that keeps every hop on Intuit-hosted pages: the
// operator mints tokens in the OAuth 2.0 Playground and pastes the refresh
// token + realm back here (input hidden). See src/connect-playground.js.
if (process.argv.includes("--connect-playground")) {
  const i = process.argv.indexOf("--connect-playground");
  const next = process.argv[i + 1];
  const slug = next && !next.startsWith("--") ? next : process.env.QBO_COMPANY || "";
  const environment = process.argv.includes("--sandbox") ? "sandbox" : "production";
  try {
    const { connectViaPlayground } = await import("./connect-playground.js");
    const r = await connectViaPlayground(slug, environment, { openBrowserWindow: !process.argv.includes("--no-browser") });
    log(`Authorized "${r.slug}" → ${r.company_name ?? "(name unread)"} (realm ${r.realmId}, ${r.environment}).`);
    if (r.warning) log(r.warning);
    if (r.duplicate_slugs) log(`WARNING: realm ${r.realmId} is also authorized as: ${r.duplicate_slugs.join(", ")}`);
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
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

// ---- Token broker: hand a fresh access token to another local process ------
// `node src/index.js --access-token <slug>` prints
// {"slug","realmId","environment","access_token","expires_at"} on stdout and
// nothing else, so a sibling tool can read it with one JSON.parse.
//
// This exists so there is exactly ONE process that ever calls Intuit's refresh
// endpoint. Intuit rotates the refresh token on every use and invalidates the
// previous one, so two stores refreshing the same realm independently will
// eventually knock each other offline. The Python services under
// ~/Claude/qbo-collector call this instead of holding their own tokens.
//
// Logs go to stderr (as everywhere else in this file), never stdout.
if (process.argv.includes("--access-token")) {
  const i = process.argv.indexOf("--access-token");
  const next = process.argv[i + 1];
  const slug = next && !next.startsWith("--") ? next : process.env.QBO_COMPANY || "";
  try {
    // allowInteractive stays false: a broker call must never try to open a
    // browser. A missing or 100-day-expired token is an error the caller
    // surfaces, with the re-authorize command in the message.
    const t = await getValidTokens(slug);
    // Token handout is part of the firm's accountability trail: any local
    // process can call this, so each issuance lands in the same audit log
    // as writes (caller identified by parent pid).
    await auditRecord({
      kind: "token_brokered",
      company: sanitizeSlug(slug) || "(default)",
      realmId: t.realmId,
      environment: t.environment,
      caller_ppid: process.ppid,
    });
    process.stdout.write(JSON.stringify({
      slug: sanitizeSlug(slug),
      realmId: t.realmId,
      environment: t.environment,
      access_token: t.access_token,
      expires_at: t.expires_at,
    }) + "\n");
    process.exit(0);
  } catch (e) {
    log("Access token request failed:", e.message);
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

// Report payloads are large: an 18-month monthly P&L runs past 150KB. When the
// caller names save_path the JSON is written there and only a short receipt comes
// back, so a downstream script reads the file and the payload never has to travel
// through the conversation. Omit save_path and behaviour is exactly as before.
async function reportResult(obj, save_path) {
  if (!save_path) return asText(obj);
  const dest = resolveUserPath(save_path, { purpose: "write" });
  await mkdir(path.dirname(dest), { recursive: true });
  const text = JSON.stringify(obj, null, 2);
  await writeFile(dest, text);
  return asText(reportReceipt(obj, dest, text.length));
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

// Every literal date argument is validated at the schema layer so a malformed
// date fails instantly with a plain message instead of an opaque QBO 400.
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

const accountingMethodArg = z.enum(["Cash", "Accrual"]).optional().describe("Cash or Accrual (defaults to the company setting)");
const dateMacroArg = z.string().optional().describe("QBO date macro, e.g. \"This Fiscal Year\", \"Last Month\" (alternative to start/end dates)");
const savePathArg = z.string().optional()
  .describe("Write the report JSON to this path and return a short receipt instead of the full payload. Use it for anything a script will read (an 18-month monthly P&L exceeds 150KB); the file also gives the downstream work a dated artifact to cite.");
const summarizeColumnArg = z.string().optional()
  .describe("Break columns out by e.g. \"Month\", \"Quarter\", \"Year\", \"Classes\", \"Departments\", \"Customers\", \"Vendors\"");

function formatCompanyList(companies) {
  return (
    companies.map((c) => `${c.slug} (${c.environment}, realm ${c.realmId})`).join("; ") ||
    "none — authorize one with `QBO_COMPANY=<slug> npm run connect`"
  );
}

function envDefaultCompany() {
  return sanitizeSlug(process.env.QBO_COMPANY || "");
}

// Strict mode: writes always require an explicit per-call company argument.
// Session and env defaults are process-global (one server serves every open
// conversation), so a firm can set this to make a cross-chat select_company
// unable to retarget a write.
const REQUIRE_EXPLICIT_COMPANY =
  (process.env.QBO_REQUIRE_EXPLICIT_COMPANY || "").toLowerCase() === "true";

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
  if (write && REQUIRE_EXPLICIT_COMPANY) {
    throw new Error(
      "QBO_REQUIRE_EXPLICIT_COMPANY is on: writes need an explicit `company` argument on every call; session and env defaults do not apply to writes."
    );
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
const WRITE_EXTRAS = new Set(["api_request", "execute_batch"]);
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
    // Checks run concurrently: a 50-company fleet answers in one round trip's
    // time, and one broken company cannot stall the rest.
    const results = await Promise.all(targets.map(async (slug) => {
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
      return entry;
    }));
    const failing = results.filter((r) => r.status !== "ok").length;
    return asText({ checked: results.length, healthy: results.length - failing, failing, results });
  })
);

/* =========================== CLIENT ROSTER (3) =========================== */
// Human names for the companies this connector can reach. Authorization stays
// the truth for existence; these tools add the labels people actually type.

registerTool(
  "list_clients",
  "The client roster: every company this connector can reach, with the firm's name for it, aliases, engagement type, and service lines. Also reports drift, meaning companies with no labels yet and labels with no authorization. Start here when you need to know who is set up.",
  {},
  tool(async () => {
    const r = await roster();
    return asText({
      count: r.clients.length,
      ...r,
      unlabeled: r.unlabeled.length ? r.unlabeled : undefined,
      labeled_but_not_authorized: r.labeled_but_not_authorized.length ? r.labeled_but_not_authorized : undefined,
      hint: r.unlabeled.length
        ? "Unlabeled companies resolve only by slug. Give them names and aliases with register_client."
        : undefined,
      roster_file: clientsPath(),
    });
  })
);

registerTool(
  "resolve_client",
  "Turn what someone typed (a name, nickname, abbreviation, or slug) into the right company slug. Returns candidates instead of guessing when the term is ambiguous, so a wrong client can never be assumed. Use before any per-client work when the user named a client in prose.",
  { term: z.string().describe("What the user called the client, e.g. \"Advance\", \"PSSA\", \"the firm\"") },
  tool(async ({ term }) => {
    const r = await resolveClient(term);
    if (r.match) return asText({ resolved: r.match.slug, matched_by: r.how, client: r.match });
    return asText({
      resolved: null,
      matched_by: r.how,
      candidates: r.candidates,
      all_clients: r.all,
      guidance: r.candidates?.length
        ? "Ambiguous. Ask the user which of these they meant; do not pick one."
        : "No match. Ask which client they mean, or onboard them if they are new.",
    });
  })
);

registerTool(
  "register_client",
  "Record or update the firm's labels for a company: display name, aliases people type, engagement type, service lines, and working folder. Aliases merge rather than replace, so short forms accumulate. Use during onboarding, and any time someone refers to a client by a name the connector did not recognize.",
  {
    company: z.string().describe("Company slug these labels belong to"),
    name: z.string().optional().describe("The firm's name for this client"),
    company_name: z.string().optional().describe("Legal or QuickBooks company name, when it differs"),
    aliases: z.array(z.string()).optional().describe("Short forms people type, e.g. [\"PSSA\", \"Power Systems\"]"),
    remove_aliases: z.array(z.string()).optional(),
    engagement: z.string().optional().describe("e.g. monthly bookkeeping, tax only, fractional CFO, cleanup diagnostic"),
    service_lines: z.array(z.string()).optional().describe("e.g. [\"tax\", \"CAS\"]"),
    data_folder: z.string().optional().describe("Absolute path to this client's working folder"),
  },
  tool(async ({ company, ...patch }) => asText(await registerClient(company, patch)))
);

/* ==================== INTERACTIVE AUTHORIZATION (3) ==================== */
// Connecting a company without a terminal. connect_company hands back a link,
// the human clicks Allow, then check_connection confirms which file landed.

registerTool(
  "connect_company",
  "Start connecting a NEW QuickBooks company from this conversation, no terminal needed. Returns an Intuit authorization link for the user to click; it does not wait for them. After they click Allow, call check_connection to confirm. Give each company a short slug (letters, numbers, hyphens) that stays with it.",
  {
    company: z.string().describe("Short slug for this company, e.g. acme or mhpe. Becomes tokens.<slug>.json"),
    environment: z.enum(["sandbox", "production"]).describe("production for real client books, sandbox for Intuit test files"),
    open_browser: z.boolean().optional().describe("Also try to open the link locally (default true)"),
  },
  tool(async ({ company, environment, open_browser }) => {
    const slug = sanitizeSlug(company);
    if (!slug) throw new Error("company must contain at least one letter, number, or hyphen.");
    const existing = (await listCompanies()).find((c) => c.slug === slug);
    const r = await beginAuthorization({ company: slug, environment, openBrowserWindow: open_browser !== false });
    return asText({
      ...r,
      already_connected: existing
        ? { realmId: existing.realmId, environment: existing.environment, note: "Completing this will replace that authorization." }
        : undefined,
      next_step: "Give the user the authorize_url to click, have them log in and pick the right company, then call check_connection.",
      reminder: environment === "production"
        ? "Production: these are real books. Confirm the company name with check_connection before anything is posted."
        : undefined,
    });
  })
);

registerTool(
  "check_connection",
  "Check whether an in-progress connect_company authorization finished, and confirm which QuickBooks company actually landed. Call this after the user clicks Allow. Safe to call repeatedly.",
  {},
  tool(async () => {
    const status = authorizationStatus();
    if (status.state !== "connected") {
      const guidance = {
        idle: "No authorization in progress. Start one with connect_company.",
        waiting: "Still waiting on the browser. Ask the user to finish at the authorize_url, then check again.",
        failed: "Authorization failed. Read the error, fix the cause, then call connect_company again.",
        expired: "The authorization window closed before the callback arrived. Call connect_company again.",
      }[status.state];
      return asText({ ...status, guidance });
    }
    // Connected: name the file so a wrong-company authorization cannot pass silently.
    let company_name = null, legal_name = null, address_state = null, warning;
    try {
      const info = await qboRequest(`/companyinfo/${status.realmId}`, { company: status.slug });
      company_name = info.CompanyInfo?.CompanyName ?? null;
      legal_name = info.CompanyInfo?.LegalName ?? null;
      address_state = info.CompanyInfo?.CompanyAddr?.CountrySubDivisionCode ?? null;
    } catch (e) {
      warning = `Connected, but reading company info failed: ${e.message}`;
    }
    const twins = (await listCompanies()).filter((c) => c.realmId === status.realmId && c.slug !== status.slug);
    return asText({
      ...status,
      company_name,
      legal_name,
      address_state,
      warning,
      duplicate_slugs: twins.length ? twins.map((c) => c.slug) : undefined,
      verify: "Confirm company_name is the client you intended. If it is not, connect_company again and pick the right file.",
    });
  })
);

// Guardrail tools. Deliberately not named with a write prefix, so locking a
// company down stays available even when QBO_DISABLE_WRITES has suppressed
// every posting tool.
registerTool(
  "set_company_policy",
  "Set the write guardrail for one company: make it read-only, cap the size of a single write, or refuse writes dated before a floor. Takes effect immediately with no restart, and leaves other companies' rules alone. Use read_only when onboarding, during a diagnostic engagement, or any time a client's books should not be posted to.",
  {
    company: z.string().describe("Company slug the rule applies to"),
    read_only: z.union([z.boolean(), z.literal("inherit")]).optional()
      .describe("true refuses all writes; false explicitly allows them, which is what reopens a company when the file denies writes by default; \"inherit\" drops the company's own setting and falls back to the default"),
    max_write_amount: z.number().min(0).optional().describe("Refuse writes above this total; 0 removes the cap"),
    min_txn_date: z.string().optional().describe("YYYY-MM-DD floor for transaction dates; \"clear\" removes it"),
  },
  tool(async ({ company, read_only, max_write_amount, min_txn_date }) => {
    const slug = sanitizeSlug(company);
    if (!slug) throw new Error("company must contain at least one letter, number, or hyphen.");
    const known = await listCompanies();
    if (known.length && !known.some((c) => c.slug === slug)) {
      throw new Error(`No such company "${company}". Available: ${formatCompanyList(known)}.`);
    }
    if (read_only === undefined && max_write_amount === undefined && min_txn_date === undefined) {
      throw new Error("Nothing to change. Pass read_only, max_write_amount, or min_txn_date.");
    }
    const r = await setCompanyPolicy(slug, {
      read_only: read_only === "inherit" ? null : read_only,
      max_write_amount,
      min_txn_date: min_txn_date === "clear" ? null : min_txn_date,
    });
    // "No restrictions" has to mean the effective policy, not the company's own
    // entry: read_only:false is a rule, and an empty entry still inherits the
    // file's defaults. Report what actually applies.
    const effectivePolicy = await policyFor(slug);
    const restricted = effectivePolicy.read_only
      || effectivePolicy.max_write_amount != null
      || effectivePolicy.min_txn_date != null;
    return asText({
      ...r,
      effective_policy: effectivePolicy,
      effective: "Immediately. The connector re-reads this file on every write.",
      note: restricted ? undefined : "No restrictions apply to this company.",
    });
  })
);

registerTool(
  "get_company_policy",
  "Show the write guardrails currently in force, for one company or all of them. Worth checking before posting anything to a client's books, and when a write is refused and the reason is unclear.",
  { company: companyArg },
  tool(async ({ company }) => {
    if (company) {
      const slug = sanitizeSlug(company);
      return asText({ company: slug, rules: await policyFor(slug), policy_file: policyPath() });
    }
    const companies = await listCompanies();
    const rows = [];
    for (const c of companies) rows.push({ company: c.slug, rules: await policyFor(c.slug) });
    const restricted = rows.filter((r) => Object.keys(r.rules).length);
    return asText({
      policy_file: policyPath(),
      restricted_companies: restricted.length,
      companies: rows,
      note: restricted.length ? undefined : "No guardrails in force; every connected company is writable.",
    });
  })
);

registerTool(
  "cancel_connection",
  "Abandon an in-progress company authorization and release the callback port. Use when the user gives up, picked the wrong company, or wants to restart with different keys.",
  {},
  tool(async () => asText(cancelAuthorization()))
);

/* =========================== READ TOOLS (9) =========================== */

registerTool(
  "get_profit_and_loss",
  "Profit & Loss report for a date range. summarize_column_by=\"Month\" gives a monthly trend in one call; \"Classes\" or \"Departments\" gives a segmented P&L.",
  {
    start_date: isoDate.describe("YYYY-MM-DD"),
    end_date: isoDate.describe("YYYY-MM-DD"),
    accounting_method: accountingMethodArg,
    summarize_column_by: summarizeColumnArg,
    date_macro: dateMacroArg,
    save_path: savePathArg,
    company: companyArg,
  },
  tool(async ({ start_date, end_date, accounting_method, summarize_column_by, date_macro, save_path, company }) => {
    const c = await resolveCompany(company);
    const q = reportQuery({ start_date, end_date, accounting_method, summarize_column_by, date_macro });
    return reportResult(await qboRequest(`/reports/ProfitAndLoss${q}`, { company: c }), save_path);
  })
);

registerTool(
  "get_profit_and_loss_detail",
  "P&L Detail report: every transaction behind each income and expense line for a date range.",
  {
    start_date: isoDate.optional().describe("YYYY-MM-DD"),
    end_date: isoDate.optional().describe("YYYY-MM-DD"),
    accounting_method: accountingMethodArg,
    date_macro: dateMacroArg,
    columns: z.string().optional().describe("Comma-separated columns, e.g. \"tx_date,txn_type,doc_num,name,memo,subt_nat_amount\""),
    save_path: savePathArg,
    company: companyArg,
  },
  tool(async ({ start_date, end_date, accounting_method, date_macro, columns, save_path, company }) => {
    const c = await resolveCompany(company);
    const q = reportQuery({ start_date, end_date, accounting_method, date_macro, columns });
    return reportResult(await qboRequest(`/reports/ProfitAndLossDetail${q}`, { company: c }), save_path);
  })
);

registerTool(
  "get_balance_sheet",
  "Balance Sheet as of end_date (YYYY-MM-DD). A balance sheet is point-in-time, so start_date is optional and only shapes the Net Income row; omit it to run as of end_date.",
  {
    end_date: isoDate.describe("YYYY-MM-DD, the as-of date"),
    start_date: isoDate.optional().describe("YYYY-MM-DD, only shapes the Net Income row; defaults to end_date"),
    accounting_method: accountingMethodArg,
    summarize_column_by: summarizeColumnArg,
    save_path: savePathArg,
    company: companyArg,
  },
  tool(async ({ start_date, end_date, accounting_method, summarize_column_by, save_path, company }) => {
    const c = await resolveCompany(company);
    const from = start_date || end_date;
    const q = reportQuery({ start_date: from, end_date, accounting_method, summarize_column_by });
    return reportResult(await qboRequest(`/reports/BalanceSheet${q}`, { company: c }), save_path);
  })
);

registerTool(
  "get_cash_flow",
  "Statement of Cash Flows for a date range (YYYY-MM-DD).",
  {
    start_date: isoDate.describe("YYYY-MM-DD"),
    end_date: isoDate.describe("YYYY-MM-DD"),
    summarize_column_by: summarizeColumnArg,
    date_macro: dateMacroArg,
    save_path: savePathArg,
    company: companyArg,
  },
  tool(async ({ start_date, end_date, summarize_column_by, date_macro, save_path, company }) => {
    const c = await resolveCompany(company);
    const q = reportQuery({ start_date, end_date, summarize_column_by, date_macro });
    return reportResult(await qboRequest(`/reports/CashFlow${q}`, { company: c }), save_path);
  })
);

// The firm rule every aging consumer must follow, stated once and attached to
// every aging response so no downstream skill has to restate it.
const AGING_ROLLUP_NOTE =
  "Customer:job structures: use only the parent-level totals that tie to the balance sheet; never sum parent and sub rows (double counts 2x-3x).";

const agingMethodArg = z.enum(["Report_Date", "Current"]).optional()
  .describe("Age as of the report date (Report_Date) or as of today (Current); defaults to the company setting");

registerTool(
  "get_aged_receivables",
  "Aged Receivables summary (who owes you, bucketed by age), optionally as of a specific date. For per-invoice rows use get_aged_receivables_detail.",
  {
    report_date: isoDate.optional().describe("As-of date (YYYY-MM-DD); omit for today"),
    aging_method: agingMethodArg,
    date_macro: dateMacroArg,
    save_path: savePathArg,
    company: companyArg,
  },
  tool(async ({ report_date, aging_method, date_macro, save_path, company }) => {
    const c = await resolveCompany(company);
    const rep = await qboRequest(`/reports/AgedReceivables${reportQuery({ report_date, aging_method, date_macro })}`, { company: c });
    return reportResult({ note: AGING_ROLLUP_NOTE, ...rep }, save_path);
  })
);

registerTool(
  "get_aged_receivables_detail",
  "Aged Receivables DETAIL: every open invoice with its aging bucket, as of a date. The right source for close tie-outs; grand total ties to balance-sheet A/R.",
  {
    report_date: isoDate.optional().describe("As-of date (YYYY-MM-DD); omit for today"),
    aging_method: agingMethodArg,
    date_macro: dateMacroArg,
    save_path: savePathArg,
    company: companyArg,
  },
  tool(async ({ report_date, aging_method, date_macro, save_path, company }) => {
    const c = await resolveCompany(company);
    const rep = await qboRequest(`/reports/AgedReceivableDetail${reportQuery({ report_date, aging_method, date_macro })}`, { company: c });
    return reportResult({ note: AGING_ROLLUP_NOTE, ...rep }, save_path);
  })
);

registerTool(
  "get_aged_payables",
  "Aged Payables summary (who you owe, bucketed by age), optionally as of a specific date. For per-bill rows use get_aged_payables_detail.",
  {
    report_date: isoDate.optional().describe("As-of date (YYYY-MM-DD); omit for today"),
    aging_method: agingMethodArg,
    date_macro: dateMacroArg,
    save_path: savePathArg,
    company: companyArg,
  },
  tool(async ({ report_date, aging_method, date_macro, save_path, company }) => {
    const c = await resolveCompany(company);
    const rep = await qboRequest(`/reports/AgedPayables${reportQuery({ report_date, aging_method, date_macro })}`, { company: c });
    return reportResult({ note: AGING_ROLLUP_NOTE, ...rep }, save_path);
  })
);

registerTool(
  "get_aged_payables_detail",
  "Aged Payables DETAIL: every open bill with its aging bucket, as of a date. Grand total ties to balance-sheet A/P.",
  {
    report_date: isoDate.optional().describe("As-of date (YYYY-MM-DD); omit for today"),
    aging_method: agingMethodArg,
    date_macro: dateMacroArg,
    save_path: savePathArg,
    company: companyArg,
  },
  tool(async ({ report_date, aging_method, date_macro, save_path, company }) => {
    const c = await resolveCompany(company);
    const rep = await qboRequest(`/reports/AgedPayableDetail${reportQuery({ report_date, aging_method, date_macro })}`, { company: c });
    return reportResult({ note: AGING_ROLLUP_NOTE, ...rep }, save_path);
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

registerTool(
  "get_preferences",
  "Company preferences in one call: fiscal year start month, book close date, class and location tracking, multicurrency, sales tax on. The shared context read for onboarding, close checklists, and file reviews; verbose returns the raw Preferences object.",
  { verbose: z.boolean().optional().describe("Return the full raw Preferences object"), company: companyArg },
  tool(async ({ verbose, company }) => {
    const c = await resolveCompany(company);
    const r = await qboRequest(`/preferences`, { company: c });
    if (verbose) return asText(r);
    const p = r.Preferences || {};
    const acct = p.AccountingInfoPrefs || {};
    return asText({
      company: c || "(default)",
      fiscal_year_start_month: acct.FirstMonthOfFiscalYear ?? null,
      tax_year_start_month: acct.FirstMonthOfTaxYear ?? null,
      book_close_date: acct.BookCloseDate ?? null,
      class_tracking_per_txn: acct.ClassTrackingPerTxn ?? false,
      class_tracking_per_txn_line: acct.ClassTrackingPerTxnLine ?? false,
      track_departments: acct.TrackDepartments ?? false,
      customer_terminology: acct.CustomerTerminology ?? null,
      multicurrency: p.CurrencyPrefs?.MultiCurrencyEnabled ?? false,
      home_currency: p.CurrencyPrefs?.HomeCurrency?.value ?? null,
      sales_tax_on: p.TaxPrefs?.UsingSalesTax ?? false,
      automated_sales_tax: p.TaxPrefs?.PartnerTaxEnabled ?? null,
      inventory_on: p.ProductAndServicesPrefs?.QuantityOnHand ?? false,
      note: "book_close_date is the closed-period gate the write tools warn against; null means the books have never been closed.",
    });
  })
);

/* =========================== MORE REPORTS =========================== */

registerTool(
  "get_general_ledger",
  "General Ledger report for a date range — every account's transactions with running balances.",
  {
    start_date: isoDate.optional().describe("YYYY-MM-DD"),
    end_date: isoDate.optional().describe("YYYY-MM-DD"),
    accounting_method: accountingMethodArg,
    date_macro: dateMacroArg,
    columns: z.string().optional().describe("Comma-separated columns to include, e.g. \"tx_date,account_name,debt_amt,credit_amt\""),
    save_path: savePathArg,
    company: companyArg,
  },
  tool(async ({ start_date, end_date, accounting_method, date_macro, columns, save_path, company }) => {
    const c = await resolveCompany(company);
    const q = reportQuery({ start_date, end_date, accounting_method, date_macro, columns });
    return reportResult(await qboRequest(`/reports/GeneralLedger${q}`, { company: c }), save_path);
  })
);

registerTool(
  "get_trial_balance",
  "Trial Balance report for a date range — debit/credit balance of every account.",
  {
    start_date: isoDate.optional().describe("YYYY-MM-DD"),
    end_date: isoDate.optional().describe("YYYY-MM-DD"),
    accounting_method: accountingMethodArg,
    date_macro: dateMacroArg,
    save_path: savePathArg,
    company: companyArg,
  },
  tool(async ({ start_date, end_date, accounting_method, date_macro, save_path, company }) => {
    const c = await resolveCompany(company);
    const q = reportQuery({ start_date, end_date, accounting_method, date_macro });
    return reportResult(await qboRequest(`/reports/TrialBalance${q}`, { company: c }), save_path);
  })
);

registerTool(
  "get_inventory_valuation",
  "Inventory Valuation Summary: quantity, asset value, and average cost per inventory item as of a date.",
  {
    report_date: isoDate.optional().describe("As-of date (YYYY-MM-DD); omit for today"),
    date_macro: dateMacroArg,
    save_path: savePathArg,
    company: companyArg,
  },
  tool(async ({ report_date, date_macro, save_path, company }) => {
    const c = await resolveCompany(company);
    return reportResult(await qboRequest(`/reports/InventoryValuationSummary${reportQuery({ report_date, date_macro })}`, { company: c }), save_path);
  })
);

registerTool(
  "get_item_sales",
  "Sales by Product/Service (ItemSales report) for a date range: quantity, amount, and margin per item. Note: the endpoint name is ItemSales; \"SalesByProduct\" 400s.",
  {
    start_date: isoDate.optional().describe("YYYY-MM-DD"),
    end_date: isoDate.optional().describe("YYYY-MM-DD"),
    date_macro: dateMacroArg,
    accounting_method: accountingMethodArg,
    save_path: savePathArg,
    company: companyArg,
  },
  tool(async ({ start_date, end_date, date_macro, accounting_method, save_path, company }) => {
    const c = await resolveCompany(company);
    return reportResult(await qboRequest(`/reports/ItemSales${reportQuery({ start_date, end_date, date_macro, accounting_method })}`, { company: c }), save_path);
  })
);

registerTool(
  "get_unbilled_time",
  "Unbilled Time report: billable time entries not yet invoiced, for a date range. Pairs with unbilled-cost review on close.",
  {
    start_date: isoDate.optional().describe("YYYY-MM-DD"),
    end_date: isoDate.optional().describe("YYYY-MM-DD"),
    date_macro: dateMacroArg,
    save_path: savePathArg,
    company: companyArg,
  },
  tool(async ({ start_date, end_date, date_macro, save_path, company }) => {
    const c = await resolveCompany(company);
    return reportResult(await qboRequest(`/reports/UnbilledTime${reportQuery({ start_date, end_date, date_macro })}`, { company: c }), save_path);
  })
);

registerTool(
  "get_transaction_list",
  "Transaction List report — all transactions in a date range, optionally filtered.",
  {
    start_date: isoDate.optional().describe("YYYY-MM-DD"),
    end_date: isoDate.optional().describe("YYYY-MM-DD"),
    date_macro: dateMacroArg,
    accounting_method: accountingMethodArg,
    transaction_type: z.string().optional().describe("Filter by type, e.g. Invoice, Bill, Payment, JournalEntry"),
    save_path: savePathArg,
    company: companyArg,
  },
  tool(async ({ start_date, end_date, date_macro, accounting_method, transaction_type, save_path, company }) => {
    const c = await resolveCompany(company);
    const q = reportQuery({ start_date, end_date, date_macro, accounting_method, transaction_type });
    return reportResult(await qboRequest(`/reports/TransactionList${q}`, { company: c }), save_path);
  })
);

registerTool(
  "get_transaction_list_by_vendor",
  "Transaction List grouped by vendor for a date range.",
  {
    start_date: isoDate.optional().describe("YYYY-MM-DD"),
    end_date: isoDate.optional().describe("YYYY-MM-DD"),
    date_macro: dateMacroArg,
    accounting_method: accountingMethodArg,
    vendor: z.string().optional().describe("Filter to a single vendor Id"),
    save_path: savePathArg,
    company: companyArg,
  },
  tool(async ({ start_date, end_date, date_macro, accounting_method, vendor, save_path, company }) => {
    const c = await resolveCompany(company);
    const q = reportQuery({ start_date, end_date, date_macro, accounting_method, vendor });
    return reportResult(await qboRequest(`/reports/TransactionListByVendor${q}`, { company: c }), save_path);
  })
);

registerTool(
  "get_transaction_list_by_customer",
  "Transaction List grouped by customer for a date range.",
  {
    start_date: isoDate.optional().describe("YYYY-MM-DD"),
    end_date: isoDate.optional().describe("YYYY-MM-DD"),
    date_macro: dateMacroArg,
    accounting_method: accountingMethodArg,
    customer: z.string().optional().describe("Filter to a single customer Id"),
    save_path: savePathArg,
    company: companyArg,
  },
  tool(async ({ start_date, end_date, date_macro, accounting_method, customer, save_path, company }) => {
    const c = await resolveCompany(company);
    const q = reportQuery({ start_date, end_date, date_macro, accounting_method, customer });
    return reportResult(await qboRequest(`/reports/TransactionListByCustomer${q}`, { company: c }), save_path);
  })
);

registerTool(
  "get_transaction_list_with_splits",
  "Transaction List with split lines (each line of every transaction) for a date range.",
  {
    start_date: isoDate.optional().describe("YYYY-MM-DD"),
    end_date: isoDate.optional().describe("YYYY-MM-DD"),
    date_macro: dateMacroArg,
    accounting_method: accountingMethodArg,
    save_path: savePathArg,
    company: companyArg,
  },
  tool(async ({ start_date, end_date, date_macro, accounting_method, save_path, company }) => {
    const c = await resolveCompany(company);
    const q = reportQuery({ start_date, end_date, date_macro, accounting_method });
    return reportResult(await qboRequest(`/reports/TransactionListWithSplits${q}`, { company: c }), save_path);
  })
);

/* =========================== WRITE TOOLS (8) =========================== */

registerTool(
  "create_customer",
  "Create a new customer, optionally as a sub-customer/job under a parent (customer:job structure).",
  {
    display_name: z.string(),
    parent_customer: z.string().optional().describe("Parent customer name or Id; makes this a sub-customer (job). Aging then rolls up to the parent, which is the total that ties to the balance sheet."),
    bill_with_parent: z.boolean().optional().describe("Bill through the parent (default false: bill this sub-customer directly)"),
    email: z.string().optional(),
    phone: z.string().optional(),
    billing_address: z.string().optional().describe("Free-form billing address line"),
    company: companyArg,
  },
  tool(async ({ display_name, parent_customer, bill_with_parent, email, phone, billing_address, company }) => {
    const c = await resolveCompany(company, { write: true });
    const payload = { DisplayName: display_name };
    if (parent_customer) {
      payload.ParentRef = await resolveRef("Customer", parent_customer, c, "DisplayName");
      payload.Job = true;
      if (bill_with_parent != null) payload.BillWithParent = bill_with_parent;
    }
    if (email) payload.PrimaryEmailAddr = { Address: email };
    if (phone) payload.PrimaryPhone = { FreeFormNumber: phone };
    if (billing_address) payload.BillAddr = { Line1: billing_address };
    const r = await qboRequest(`/customer`, { method: "POST", body: payload, company: c });
    return asText({ company: c, created: r.Customer });
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
    return asText({ company: c, updated: r.Customer });
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
    return asText({ company: c, created: r.Item, note: type === "Inventory" ? "Inventory items may need asset/COGS accounts and a start date; create in QBO UI if this errors." : undefined });
  })
);

registerTool(
  "create_invoice",
  "Create an invoice for a customer, with full line items (item, quantity, unit price, class, tax code per line, same schema as estimates). Name the item per line so revenue posts to the right income account. Optionally email it.",
  {
    customer_ref: z.string().describe("Customer Id or DisplayName"),
    line_items: z.array(salesLineSchema).describe("Lines; set `item` per line (falls back to the company's first Service item, reported in the response)"),
    txn_date: isoDate.optional().describe("YYYY-MM-DD (defaults to today)"),
    due_date: isoDate.optional().describe("YYYY-MM-DD"),
    doc_number: z.string().optional().describe("Invoice number (DocNumber); omit to let QBO assign"),
    location: z.string().optional().describe("Location/department name or Id (requires location tracking)"),
    send_email: z.boolean().optional(),
    company: companyArg,
  },
  tool(async ({ customer_ref, line_items, txn_date, due_date, doc_number, location, send_email, company }) => {
    const c = await resolveCompany(company, { write: true });
    // Resolve customer by Id (numeric) or by name.
    let customer;
    if (/^\d+$/.test(customer_ref)) {
      customer = (await qboQuery(`SELECT * FROM Customer WHERE Id = '${esc(customer_ref)}'`, { company: c })).Customer?.[0];
    } else {
      customer = await findCustomerByName(customer_ref, c);
    }
    if (!customer) throw new Error(`Customer not found: ${customer_ref}`);

    // Lines without an explicit item fall back to the first Service item,
    // which means THAT item's income account receives the revenue. Allowed,
    // but never silent: the response names the item and its income account.
    const linesWithoutItem = line_items.filter((li) => !li.item).length;
    let fallbackItem = null;
    if (linesWithoutItem) {
      fallbackItem = await findAnyServiceItem(c);
      if (!fallbackItem) {
        throw new Error("Some lines have no `item` and no Service item exists to fall back to. Name an item per line, or create one with create_item first.");
      }
    }

    const warnings = await closedPeriodWarnings(c, [txn_date]);
    const payload = { CustomerRef: { value: customer.Id }, Line: await buildSalesLines(line_items, c) };
    if (txn_date) payload.TxnDate = txn_date;
    if (due_date) payload.DueDate = due_date;
    if (doc_number) payload.DocNumber = doc_number;
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
    return asText(withWarnings({
      company: c,
      created: invoice,
      emailed,
      ...(linesWithoutItem ? {
        default_item_note: `${linesWithoutItem} line(s) had no item and used "${fallbackItem.Name}" (income account: ${fallbackItem.IncomeAccountRef?.name ?? "unknown"}). Verify that is the right revenue account.`,
      } : {}),
    }, warnings));
  })
);

registerTool(
  "create_bill",
  "Record a bill (money you owe a vendor). Single-category form: pass amount + category. Split form: pass `lines` (account, amount, description, class per line) instead.",
  {
    vendor_name: z.string(),
    amount: z.number().optional().describe("Single-line form: total, categorized to `category`"),
    category: z.string().optional().describe("Single-line form: expense account name"),
    lines: z.array(accountLineSchema).optional().describe("Split form: replaces amount/category with per-account lines"),
    transaction_date: isoDate.describe("YYYY-MM-DD"),
    doc_number: z.string().optional().describe("Vendor bill/reference number"),
    memo: z.string().optional(),
    location: z.string().optional().describe("Location/department name or Id (requires location tracking)"),
    create_vendor_if_missing: z.boolean().optional().describe("Create the vendor when no exact DisplayName match exists (default false, so a typo cannot mint a phantom vendor)"),
    company: companyArg,
  },
  tool(async ({ vendor_name, amount, category, lines, transaction_date, doc_number, memo, location, create_vendor_if_missing, company }) => {
    const c = await resolveCompany(company, { write: true });
    if (!lines?.length && (amount == null || !category)) {
      throw new Error("Pass either `lines` (split bill) or both `amount` and `category` (single-line bill).");
    }
    if (lines?.length && (amount != null || category)) {
      throw new Error("Pass `lines` OR amount/category, not both; ambiguous which set is intended.");
    }
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

    let Line;
    if (lines?.length) {
      Line = await buildAccountLines(lines, c);
    } else {
      const account = await findAccountByName(category, c);
      if (!account) throw notFoundError("Account", category, await suggestNames("Account", category, c, "Name"));
      Line = [{
        Amount: amount,
        DetailType: "AccountBasedExpenseLineDetail",
        AccountBasedExpenseLineDetail: { AccountRef: { value: account.Id, name: account.Name } },
      }];
    }

    const warnings = await closedPeriodWarnings(c, [transaction_date]);
    const payload = { VendorRef: { value: vendor.Id }, TxnDate: transaction_date, Line };
    if (doc_number) payload.DocNumber = doc_number;
    if (memo) payload.PrivateNote = memo;
    if (location) payload.DepartmentRef = await departmentRef(location, c);
    const r = await qboRequest(`/bill`, { method: "POST", body: payload, company: c });
    return asText(withWarnings({ company: c, created: r.Bill }, warnings));
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
    return asText({ company: c, created: r.Account });
  })
);

registerTool(
  "update_account",
  "Sparse-update a Chart of Accounts entry: rename, renumber, describe, change sub-type, or deactivate (deactivating an account with a balance is refused by QBO). Fetches SyncToken first. The cleanup staple for chart hygiene and duplicate-account merges.",
  {
    account_id: z.string(),
    name: z.string().optional(),
    acct_num: z.string().optional().describe("Account number"),
    description: z.string().optional(),
    account_sub_type: z.string().optional(),
    active: z.boolean().optional().describe("false deactivates (QBO merges by rename-then-deactivate patterns; balances must be zero)"),
    company: companyArg,
  },
  tool(async ({ account_id, name, acct_num, description, account_sub_type, active, company }) => {
    const c = await resolveCompany(company, { write: true });
    const current = await fetchEntity("Account", account_id, c);
    const payload = { Id: current.Id, SyncToken: current.SyncToken, sparse: true };
    if (name != null) payload.Name = name;
    if (acct_num != null) payload.AcctNum = acct_num;
    if (description != null) payload.Description = description;
    if (account_sub_type != null) payload.AccountSubType = account_sub_type;
    if (active != null) payload.Active = active;
    const r = await qboRequest(`/account`, { method: "POST", body: payload, company: c });
    return asText({ company: c, updated: r.Account });
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
    return asText({ company: c, sent: true, invoice_id, to: email || "email on file" });
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
    const fileBytes = await readFile(resolveUserPath(file_path));
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
    txn_date: isoDate.optional().describe("YYYY-MM-DD (defaults to today)"),
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
    return asText(withWarnings({ company: c, created: r.JournalEntry }, warnings));
  })
);

registerTool(
  "update_journal_entry",
  "Full update of a journal entry: REPLACES all lines with the ones you provide (must stay balanced). Omitted header fields are carried over from the current entry. Fetches SyncToken automatically.",
  {
    journal_entry_id: z.string(),
    lines: z.array(journalLineSchema).describe("Complete replacement set of lines; debits must equal credits"),
    txn_date: isoDate.optional(),
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
    return asText(withWarnings({ company: c, updated: r.JournalEntry }, warnings));
  })
);

registerTool(
  "create_reversing_journal_entry",
  "Create the reversing entry for an existing journal entry: same lines with debits and credits flipped, dated when you say (defaults to today). The month-end accrual reversal in one call.",
  {
    journal_entry_id: z.string(),
    txn_date: isoDate.optional().describe("Reversal date (YYYY-MM-DD, defaults to today; typically the 1st of the next period)"),
    doc_number: z.string().optional().describe("Defaults to the original number with -REV appended"),
    memo: z.string().optional().describe("Defaults to naming the reversed entry"),
    company: companyArg,
  },
  tool(async ({ journal_entry_id, txn_date, doc_number, memo, company }) => {
    const c = await resolveCompany(company, { write: true });
    const orig = await readJournalEntry(journal_entry_id, c);
    const lines = (orig.Line || [])
      .filter((l) => l.JournalEntryLineDetail)
      .map(({ Id, LineNum, ...rest }) => ({
        ...rest,
        JournalEntryLineDetail: {
          ...rest.JournalEntryLineDetail,
          PostingType: rest.JournalEntryLineDetail.PostingType === "Debit" ? "Credit" : "Debit",
        },
      }));
    if (!lines.length) throw new Error(`Journal entry ${journal_entry_id} has no postable lines.`);
    const warnings = await closedPeriodWarnings(c, [txn_date]);
    const payload = {
      Line: lines,
      DocNumber: doc_number ?? `${orig.DocNumber ?? orig.Id}-REV`,
      PrivateNote: memo ?? `Reversal of JE ${orig.DocNumber ?? orig.Id}`,
    };
    if (txn_date) payload.TxnDate = txn_date;
    if (orig.Adjustment != null) payload.Adjustment = orig.Adjustment;
    const r = await qboRequest(`/journalentry`, { method: "POST", body: payload, company: c });
    return asText(withWarnings({
      company: c,
      created: r.JournalEntry,
      reverses: { id: orig.Id, doc_number: orig.DocNumber ?? null, txn_date: orig.TxnDate ?? null },
    }, warnings));
  })
);

/* =========================== SALES TRANSACTIONS =========================== */

registerTool(
  "create_estimate",
  "Create an estimate (quote) for a customer, with line items.",
  {
    customer_ref: z.string().describe("Customer Id or DisplayName"),
    line_items: z.array(salesLineSchema),
    txn_date: isoDate.optional().describe("YYYY-MM-DD"),
    expiration_date: isoDate.optional().describe("YYYY-MM-DD"),
    doc_number: z.string().optional().describe("Estimate number; omit to let QBO assign"),
    email: z.string().optional().describe("BillEmail address"),
    memo: z.string().optional(),
    location: z.string().optional().describe("Location/department name or Id (requires location tracking)"),
    company: companyArg,
  },
  tool(async ({ customer_ref, line_items, txn_date, expiration_date, doc_number, email, memo, location, company }) => {
    const c = await resolveCompany(company, { write: true });
    const payload = { CustomerRef: await resolveRef("Customer", customer_ref, c, "DisplayName"), Line: await buildSalesLines(line_items, c) };
    if (location) payload.DepartmentRef = await departmentRef(location, c);
    if (txn_date) payload.TxnDate = txn_date;
    if (expiration_date) payload.ExpirationDate = expiration_date;
    if (doc_number) payload.DocNumber = doc_number;
    if (email) payload.BillEmail = { Address: email };
    if (memo) payload.CustomerMemo = { value: memo };
    const r = await qboRequest(`/estimate`, { method: "POST", body: payload, company: c });
    return asText({ company: c, created: r.Estimate });
  })
);

registerTool(
  "update_estimate",
  "Sparse-update an estimate (fetches SyncToken first). Pass line_items only to replace all lines.",
  {
    estimate_id: z.string(),
    line_items: z.array(salesLineSchema).optional(),
    txn_date: isoDate.optional(),
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
    return asText({ company: c, updated: r.Estimate });
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
    return asText({ company: c, sent: true, estimate_id, to: email || "email on file" });
  })
);

registerTool(
  "create_invoice_from_estimate",
  "Convert an estimate into an invoice: copies the estimate's customer and line items and links the two (LinkedTxn), so QBO closes the estimate as it gets invoiced. The everyday accepted-quote workflow in one call.",
  {
    estimate_id: z.string(),
    txn_date: isoDate.optional().describe("Invoice date (YYYY-MM-DD, defaults to today)"),
    due_date: isoDate.optional().describe("YYYY-MM-DD"),
    doc_number: z.string().optional().describe("Invoice number; omit to let QBO assign"),
    company: companyArg,
  },
  tool(async ({ estimate_id, txn_date, due_date, doc_number, company }) => {
    const c = await resolveCompany(company, { write: true });
    const est = await fetchEntity("Estimate", estimate_id, c);
    const lines = (est.Line || [])
      .filter((l) => l.DetailType === "SalesItemLineDetail")
      .map(({ Id, LineNum, ...rest }) => rest);
    if (!lines.length) throw new Error(`Estimate ${estimate_id} has no item lines to invoice.`);
    const warnings = await closedPeriodWarnings(c, [txn_date]);
    const payload = {
      CustomerRef: est.CustomerRef,
      Line: lines,
      LinkedTxn: [{ TxnId: est.Id, TxnType: "Estimate" }],
    };
    if (est.BillEmail) payload.BillEmail = est.BillEmail;
    if (est.CustomerMemo) payload.CustomerMemo = est.CustomerMemo;
    if (est.DepartmentRef) payload.DepartmentRef = est.DepartmentRef;
    if (txn_date) payload.TxnDate = txn_date;
    if (due_date) payload.DueDate = due_date;
    if (doc_number) payload.DocNumber = doc_number;
    const r = await qboRequest(`/invoice`, { method: "POST", body: payload, company: c });
    return asText(withWarnings({
      company: c,
      created: r.Invoice,
      from_estimate: { id: est.Id, doc_number: est.DocNumber ?? null },
      note: "The estimate remains on file; QBO marks it Closed once fully invoiced.",
    }, warnings));
  })
);

registerTool(
  "update_invoice",
  "Sparse-update an invoice (fetches SyncToken first). Pass line_items only to replace all lines.",
  {
    invoice_id: z.string(),
    line_items: z.array(salesLineSchema).optional(),
    due_date: isoDate.optional(),
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
    return asText({ company: c, updated: r.Invoice });
  })
);

registerTool(
  "void_invoice",
  "Void an existing invoice (zeros it out but keeps the number). Fetches SyncToken first.",
  { invoice_id: z.string(), company: companyArg },
  tool(async ({ invoice_id, company }) => {
    const c = await resolveCompany(company, { write: true });
    const current = await fetchEntity("Invoice", invoice_id, c);
    // Void bodies carry no amount/date; gate on the fetched entity (see delete_transaction).
    await checkWritePolicy(c, { TotalAmt: current.TotalAmt, TxnDate: current.TxnDate });
    const r = await qboRequest(`/invoice?operation=void`, { method: "POST", body: { Id: current.Id, SyncToken: current.SyncToken }, company: c });
    return asText({ company: c, voided: r.Invoice ?? { Id: invoice_id }, status: "Voided" });
  })
);

registerTool(
  "void_payment",
  "Void a customer payment (keeps the record, zeroes it). Uses QBO's payment void semantics (operation=update with include=void). Fetches SyncToken first; policy-checked against the payment's amount and date.",
  { payment_id: z.string(), company: companyArg },
  tool(async ({ payment_id, company }) => {
    const c = await resolveCompany(company, { write: true });
    const current = await fetchEntity("Payment", payment_id, c);
    await checkWritePolicy(c, { TotalAmt: current.TotalAmt, TxnDate: current.TxnDate });
    const warnings = await closedPeriodWarnings(c, [current.TxnDate]);
    const r = await qboRequest(`/payment?operation=update&include=void`, {
      method: "POST",
      body: { Id: current.Id, SyncToken: current.SyncToken, sparse: true },
      company: c,
    });
    return asText(withWarnings({ company: c, voided: r.Payment ?? { Id: payment_id }, status: "Voided" }, warnings));
  })
);

registerTool(
  "void_sales_receipt",
  "Void a sales receipt (keeps the number trail, zeroes the amounts). Fetches SyncToken first; policy-checked against the receipt's amount and date.",
  { sales_receipt_id: z.string(), company: companyArg },
  tool(async ({ sales_receipt_id, company }) => {
    const c = await resolveCompany(company, { write: true });
    const current = await fetchEntity("SalesReceipt", sales_receipt_id, c);
    await checkWritePolicy(c, { TotalAmt: current.TotalAmt, TxnDate: current.TxnDate });
    const warnings = await closedPeriodWarnings(c, [current.TxnDate]);
    const r = await qboRequest(`/salesreceipt?operation=void`, {
      method: "POST",
      body: { Id: current.Id, SyncToken: current.SyncToken },
      company: c,
    });
    return asText(withWarnings({ company: c, voided: r.SalesReceipt ?? { Id: sales_receipt_id }, status: "Voided" }, warnings));
  })
);

registerTool(
  "create_sales_receipt",
  "Create a sales receipt (paid-at-point-of-sale sale) with line items.",
  {
    customer_ref: z.string().optional().describe("Customer Id or DisplayName"),
    line_items: z.array(salesLineSchema),
    deposit_to_account: z.string().optional().describe("Account name/Id the money lands in"),
    txn_date: isoDate.optional(),
    doc_number: z.string().optional().describe("Receipt number; omit to let QBO assign"),
    email: z.string().optional(),
    memo: z.string().optional(),
    location: z.string().optional().describe("Location/department name or Id (requires location tracking)"),
    company: companyArg,
  },
  tool(async ({ customer_ref, line_items, deposit_to_account, txn_date, doc_number, email, memo, location, company }) => {
    const c = await resolveCompany(company, { write: true });
    const warnings = await closedPeriodWarnings(c, [txn_date]);
    const payload = { Line: await buildSalesLines(line_items, c) };
    if (customer_ref) payload.CustomerRef = await resolveRef("Customer", customer_ref, c, "DisplayName");
    if (deposit_to_account) payload.DepositToAccountRef = await resolveRef("Account", deposit_to_account, c, "Name");
    if (txn_date) payload.TxnDate = txn_date;
    if (doc_number) payload.DocNumber = doc_number;
    if (email) payload.BillEmail = { Address: email };
    if (memo) payload.CustomerMemo = { value: memo };
    if (location) payload.DepartmentRef = await departmentRef(location, c);
    const r = await qboRequest(`/salesreceipt`, { method: "POST", body: payload, company: c });
    return asText(withWarnings({ company: c, created: r.SalesReceipt }, warnings));
  })
);

registerTool(
  "update_sales_receipt",
  "Sparse-update a sales receipt (fetches SyncToken first). Pass line_items only to replace all lines.",
  {
    sales_receipt_id: z.string(),
    line_items: z.array(salesLineSchema).optional(),
    txn_date: isoDate.optional(),
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
    return asText({ company: c, updated: r.SalesReceipt });
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
    return asText({ company: c, sent: true, sales_receipt_id, to: email || "email on file" });
  })
);

registerTool(
  "create_credit_memo",
  "Create a credit memo for a customer, with line items.",
  {
    customer_ref: z.string().describe("Customer Id or DisplayName"),
    line_items: z.array(salesLineSchema),
    txn_date: isoDate.optional(),
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
    return asText(withWarnings({ company: c, created: r.CreditMemo }, warnings));
  })
);

registerTool(
  "create_refund_receipt",
  "Create a refund receipt (money returned to a customer), with line items.",
  {
    customer_ref: z.string().describe("Customer Id or DisplayName"),
    line_items: z.array(salesLineSchema),
    deposit_to_account: z.string().optional().describe("Account the refund is paid from (name/Id)"),
    txn_date: isoDate.optional(),
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
    return asText(withWarnings({ company: c, created: r.RefundReceipt }, warnings));
  })
);

registerTool(
  "create_payment",
  "Record a customer payment, optionally applied to a specific invoice.",
  {
    customer_ref: z.string().describe("Customer Id or DisplayName"),
    amount: z.number(),
    invoice_id: z.string().optional().describe("Invoice to apply the payment to"),
    txn_date: isoDate.optional(),
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
    return asText(withWarnings({ company: c, created: r.Payment }, warnings));
  })
);

registerTool(
  "create_deposit",
  "Create a bank deposit into an account, with one or more source lines.",
  {
    deposit_to_account: z.string().describe("Bank account to deposit into (name/Id)"),
    lines: z.array(depositLineSchema),
    txn_date: isoDate.optional(),
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
    return asText(withWarnings({ company: c, created: r.Deposit }, warnings));
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
    txn_date: isoDate.optional(),
    doc_number: z.string().optional().describe("Reference/check number"),
    memo: z.string().optional(),
    location: z.string().optional().describe("Location/department name or Id (requires location tracking)"),
    company: companyArg,
  },
  tool(async ({ payment_account, payment_type, lines, payee_name, payee_type, txn_date, doc_number, memo, location, company }) => {
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
    if (doc_number) payload.DocNumber = doc_number;
    if (memo) payload.PrivateNote = memo;
    const r = await qboRequest(`/purchase`, { method: "POST", body: payload, company: c });
    return asText(withWarnings({ company: c, created: r.Purchase }, warnings));
  })
);

registerTool(
  "update_purchase",
  "Sparse-update a purchase/expense (fetches SyncToken first). Pass lines only to replace all lines.",
  {
    purchase_id: z.string(),
    lines: z.array(accountLineSchema).optional(),
    txn_date: isoDate.optional(),
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
    return asText(withWarnings({ company: c, updated: r.Purchase }, warnings));
  })
);

registerTool(
  "create_bill_item_based",
  "Record a bill against product/service items (item-based lines), owed to a vendor.",
  {
    vendor_name: z.string(),
    line_items: z.array(itemLineSchema),
    transaction_date: isoDate.optional().describe("YYYY-MM-DD"),
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
    return asText(withWarnings({ company: c, created: r.Bill }, warnings));
  })
);

registerTool(
  "update_bill",
  "Sparse-update a bill (fetches SyncToken first). Pass account_lines only to replace all lines.",
  {
    bill_id: z.string(),
    account_lines: z.array(accountLineSchema).optional(),
    txn_date: isoDate.optional(),
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
    return asText(withWarnings({ company: c, updated: r.Bill }, warnings));
  })
);

registerTool(
  "create_vendor_credit",
  "Record a vendor credit (money a vendor owes you), categorized to expense accounts.",
  {
    vendor_name: z.string(),
    lines: z.array(accountLineSchema),
    txn_date: isoDate.optional(),
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
    return asText(withWarnings({ company: c, created: r.VendorCredit }, warnings));
  })
);

registerTool(
  "create_purchase_order",
  "Create a purchase order to a vendor, with item-based lines.",
  {
    vendor_name: z.string(),
    line_items: z.array(itemLineSchema),
    txn_date: isoDate.optional(),
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
    return asText({ company: c, created: r.PurchaseOrder });
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
    return asText({ company: c, created: r.Vendor });
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
    return asText({ company: c, updated: r.Vendor });
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
    return asText({ company: c, created: r.Employee });
  })
);

registerTool(
  "update_employee",
  "Sparse-update an employee (name, email, phone, active). Fetches SyncToken first.",
  {
    employee_id: z.string(),
    display_name: z.string().optional(),
    given_name: z.string().optional(),
    family_name: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
    active: z.boolean().optional(),
    company: companyArg,
  },
  tool(async ({ employee_id, display_name, given_name, family_name, email, phone, active, company }) => {
    const c = await resolveCompany(company, { write: true });
    const current = await fetchEntity("Employee", employee_id, c);
    const payload = { Id: current.Id, SyncToken: current.SyncToken, sparse: true };
    if (display_name != null) payload.DisplayName = display_name;
    if (given_name != null) payload.GivenName = given_name;
    if (family_name != null) payload.FamilyName = family_name;
    if (email != null) payload.PrimaryEmailAddr = { Address: email };
    if (phone != null) payload.PrimaryPhone = { FreeFormNumber: phone };
    if (active != null) payload.Active = active;
    const r = await qboRequest(`/employee`, { method: "POST", body: payload, company: c });
    return asText({ company: c, updated: r.Employee });
  })
);

registerTool(
  "create_time_activity",
  "Log a single time activity for an employee or vendor.",
  {
    name_of: z.enum(["Employee", "Vendor"]),
    person_name: z.string().describe("Employee/Vendor name or Id"),
    txn_date: isoDate.describe("YYYY-MM-DD"),
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
    return asText({ company: c, created: r.TimeActivity });
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
    return asText({ company: c, updated: r.Item });
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
      limit: z.number().int().min(1).optional()
        .describe("Cap the rows returned. `count` still reports the full match total, so limit 1 answers \"how many are there\" without listing them."),
      verbose: verboseArg,
      company: companyArg,
    },
    tool(async ({ term, include_inactive, filters, order_by, descending, limit, verbose, company }) => {
      const c = await resolveCompany(company);
      const where = [];
      if (term) where.push(`${nameField} LIKE '%${esc(term)}%'`);
      if (include_inactive) where.push(`Active IN (true, false)`);
      if (filters?.length) where.push(...buildWhere(filters, filterFields));
      const sql = `SELECT * FROM ${entity}${where.length ? " WHERE " + where.join(" AND ") : ""} ORDERBY ${order_by || nameField}${descending ? " DESC" : ""}`;
      const { rows, truncated } = await qboQueryAll(sql, entity, { company: c });
      // `count` stays the full match total and `truncated` keeps its own meaning
      // (the 1000-row ceiling in qboQueryAll). The cap is applied after, so a
      // caller that only needs the size of a list can ask for one row and still
      // read an accurate count. Client onboarding does exactly that when it
      // sizes up a chart of accounts.
      const shown = limit === undefined ? rows : rows.slice(0, limit);
      return asText({
        count: rows.length,
        returned: shown.length,
        truncated,
        ...(shown.length < rows.length ? { limited: true } : {}),
        [plural]: compactList(entity, shown, verbose),
      });
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
    start_date: isoDate.optional().describe("YYYY-MM-DD"),
    end_date: isoDate.optional().describe("YYYY-MM-DD"),
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
    start_date: isoDate.optional().describe("YYYY-MM-DD"),
    end_date: isoDate.optional().describe("YYYY-MM-DD"),
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
    start_date: isoDate.optional().describe("YYYY-MM-DD"),
    end_date: isoDate.optional().describe("YYYY-MM-DD"),
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
    txn_date: isoDate.optional().describe("YYYY-MM-DD"),
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
    return asText(withWarnings({ company: c, created: r.BillPayment }, warnings));
  })
);

registerTool(
  "get_bill_payments",
  "List bill payments, optionally filtered by vendor and date range.",
  {
    vendor: z.string().optional().describe("Vendor name or Id"),
    start_date: isoDate.optional().describe("YYYY-MM-DD"),
    end_date: isoDate.optional().describe("YYYY-MM-DD"),
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
    txn_date: isoDate.optional().describe("YYYY-MM-DD"),
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
    return asText(withWarnings({ company: c, created: r.Transfer }, warnings));
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

registerTool(
  "get_recurring_transactions",
  "List recurring transaction templates (schedules for bills, invoices, journal entries, and more). The close-work question this answers: which recurring entries should have posted this month. Each row wraps the underlying entity type.",
  { company: companyArg },
  tool(async ({ company }) => {
    const c = await resolveCompany(company);
    const r = await qboQuery(`SELECT * FROM RecurringTransaction`, { company: c });
    const rows = r.RecurringTransaction || [];
    return asText({
      count: rows.length,
      note: "Each row nests the transaction under its entity key (Bill, Invoice, JournalEntry, Purchase, ...) with a RecurringInfo block carrying the schedule (interval, next date, active).",
      recurring_transactions: rows,
    });
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
    start_date: isoDate.describe("YYYY-MM-DD"),
    end_date: isoDate.describe("YYYY-MM-DD"),
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
    start_date: isoDate.optional().describe("YYYY-MM-DD"),
    end_date: isoDate.describe("YYYY-MM-DD (the as-of date)"),
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
    txn_date: isoDate.optional().describe("YYYY-MM-DD (defaults to today)"),
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
    start_date: isoDate.optional().describe("YYYY-MM-DD (default: earliest statement date)"),
    end_date: isoDate.optional().describe("YYYY-MM-DD (default: latest statement date)"),
    date_tolerance_days: z.number().int().min(0).max(14).optional().describe("Default 2"),
    amount_convention: z.enum(["negative_out", "positive_out"]).optional(),
    company: companyArg,
  },
  tool(async ({ file_path, bank_account_name, start_date, end_date, date_tolerance_days, amount_convention, company }) => {
    const c = await resolveCompany(company);
    const fileBytes = await readFile(resolveUserPath(file_path));
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
    start_date: isoDate.optional().describe("YYYY-MM-DD"),
    end_date: isoDate.optional().describe("YYYY-MM-DD"),
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
    start_date: isoDate.optional().describe("YYYY-MM-DD"),
    end_date: isoDate.optional().describe("YYYY-MM-DD"),
    date_macro: dateMacroArg,
    accounting_method: accountingMethodArg,
    flags: z.boolean().optional().describe("Attach review-heuristic flags (default true)"),
    save_path: savePathArg,
    company: companyArg,
  },
  tool(async ({ start_date, end_date, date_macro, accounting_method, flags, save_path, company }) => {
    const c = await resolveCompany(company);
    const q = reportQuery({
      start_date, end_date, date_macro, accounting_method,
      columns: "tx_date,txn_type,doc_num,name,memo,split_acc,subt_nat_amount",
    });
    const rep = await qboRequest(`/reports/GeneralLedger${q}`, { company: c });
    let rows = glFlatten(flattenReport(rep));
    if (flags !== false) rows = flagGlRows(rows);
    return reportResult({
      count: rows.length,
      rows,
      ...(flags !== false ? { flag_meanings: {
        weekend: "posted on a Saturday or Sunday",
        round_amount: "1,000 or more in even hundreds",
        large: "absolute amount of 10,000 or more",
        journal_entry: "posted via journal entry",
      } } : {}),
    }, save_path);
  })
);

/* =========================== DOCUMENTS (2) =========================== */

const EXPORTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "exports");

async function savePdf(kind, rec, buf, save_path) {
  const name = `${kind}-${String(rec.DocNumber || rec.Id).replace(/[^A-Za-z0-9_-]/g, "")}.pdf`;
  const dest = save_path ? resolveUserPath(save_path, { purpose: "write" }) : path.join(EXPORTS_DIR, name);
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
    start_date: isoDate.optional().describe("YYYY-MM-DD"),
    end_date: isoDate.optional().describe("YYYY-MM-DD"),
    date_macro: dateMacroArg,
    accounting_method: accountingMethodArg,
    save_path: savePathArg,
    company: companyArg,
  },
  tool(async ({ start_date, end_date, date_macro, accounting_method, save_path, company }) => {
    const c = await resolveCompany(company);
    return reportResult(await qboRequest(`/reports/CustomerSales${reportQuery({ start_date, end_date, date_macro, accounting_method })}`, { company: c }), save_path);
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
    start_date: isoDate.optional().describe("YYYY-MM-DD"),
    end_date: isoDate.optional().describe("YYYY-MM-DD"),
    date_macro: dateMacroArg,
    vendor: z.string().optional().describe("Limit to a single vendor Id"),
    save_path: savePathArg,
    company: companyArg,
  },
  tool(async ({ start_date, end_date, date_macro, vendor, save_path, company }) => {
    const c = await resolveCompany(company);
    return reportResult(await qboRequest(`/reports/VendorExpenses${reportQuery({ start_date, end_date, date_macro, vendor })}`, { company: c }), save_path);
  })
);

registerTool(
  "get_budgets",
  "List budgets (name, period, type). Pass verbose for the full budget detail lines. For budget-vs-actual, join these budget rows to get_profit_and_loss months yourself; the BudgetVsActuals REPORT is known-broken (its Actual column is inception-to-date regardless of the dates requested) and is deliberately not exposed.",
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
    return asText({ company: c, created: r.Class });
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
    return asText({ company: c, updated: r.Class });
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
    return asText({ company: c, created: r.Department });
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
    return asText({ company: c, updated: r.Department });
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
    return asText({ company: c, created: r.PaymentMethod });
  })
);

registerTool(
  "create_term",
  "Create a payment term (e.g. Net 45).",
  { name: z.string(), due_days: z.number().int().positive(), company: companyArg },
  tool(async ({ name, due_days, company }) => {
    const c = await resolveCompany(company, { write: true });
    const r = await qboRequest(`/term`, { method: "POST", body: { Name: name, DueDays: due_days }, company: c });
    return asText({ company: c, created: r.Term });
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
    // A delete's own body carries no amount or date, which would let it slip
    // past max_write_amount and min_txn_date. Feed the gate from the fetched
    // entity so destroying a $50k transaction obeys the same policy as
    // posting one.
    await checkWritePolicy(c, { TotalAmt: current.TotalAmt, TxnDate: current.TxnDate });
    const warnings = await closedPeriodWarnings(c, [current.TxnDate]);
    const r = await qboRequest(`/${entity.toLowerCase()}?operation=delete`, {
      method: "POST",
      body: { Id: current.Id, SyncToken: current.SyncToken },
      company: c,
    });
    return asText(withWarnings({
      company: c,
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
      return asText({ company: c, created: r.Attachable });
    }

    const buf = await readFile(resolveUserPath(file_path));
    const name = file_name || path.basename(file_path);
    const ctype = content_type || guessContentType(name);
    const meta = { FileName: name, ContentType: ctype };
    if (note) meta.Note = note;
    if (ref) meta.AttachableRef = ref;
    const fd = new FormData();
    fd.append("file_metadata_01", new Blob([JSON.stringify(meta)], { type: "application/json" }), "metadata.json");
    fd.append("file_content_01", new Blob([buf], { type: ctype }), name);
    const r = await qboUpload(fd, { company: c });
    return asText({ company: c, created: r.AttachableResponse?.[0]?.Attachable ?? r });
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
    // Pre-signed download URIs carry live auth material; they are stripped
    // from listings so they can never land in a transcript. Fetch a file
    // with download_attachment instead.
    const scrubbed = items.map((a) => {
      const copy = { ...a };
      for (const k of Object.keys(copy)) {
        if (k.includes("TempDownloadUri") || k.includes("FileAccessUri")) delete copy[k];
      }
      return copy;
    });
    return asText({ count: scrubbed.length, scanned: all.length, truncated, attachments: scrubbed });
  })
);

registerTool(
  "download_attachment",
  "Download an attachment's file content to a local path (default under exports/). Fetches a fresh single-use download link and never exposes it.",
  {
    attachable_id: z.string(),
    save_path: z.string().optional().describe("Full file path to save to (default exports/<original filename>)"),
    company: companyArg,
  },
  tool(async ({ attachable_id, save_path, company }) => {
    const c = await resolveCompany(company);
    const row = (await qboQuery(`SELECT * FROM Attachable WHERE Id = '${assertId(attachable_id, "attachable_id")}'`, { company: c })).Attachable?.[0];
    if (!row) throw new Error(`No attachment with Id ${attachable_id}`);
    const uri = row.TempDownloadUri;
    if (!uri) throw new Error(`Attachment ${attachable_id} has no downloadable file (note-only attachment).`);
    // The URI is a pre-signed, time-limited link; use it immediately, save the
    // bytes, and never include it in the response or any log.
    const res = await fetch(uri, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}). The link may have expired; try again.`);
    const buf = Buffer.from(await res.arrayBuffer());
    const cap = Number(process.env.QBO_PDF_MAX_BYTES) || 50 * 1024 * 1024;
    if (buf.length > cap) throw new Error(`File is ${buf.length} bytes, above the ${cap}-byte cap.`);
    const safeName = String(row.FileName || `attachment-${attachable_id}`).replace(/[^A-Za-z0-9._-]/g, "_");
    const dest = save_path ? resolveUserPath(save_path, { purpose: "write" }) : path.join(EXPORTS_DIR, safeName);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, buf);
    return asText({
      company: c,
      saved_to: dest,
      bytes: buf.length,
      file_name: row.FileName ?? null,
      content_type: row.ContentType ?? null,
      linked_to: (row.AttachableRef || []).map((r) => r.EntityRef).filter(Boolean),
    });
  })
);

registerTool(
  "execute_batch",
  "Run up to 30 create/update/delete operations against QBO in ONE request (the /batch endpoint). Updates need Id + SyncToken in each body. Per-item results return independently, so one failure never blocks the rest. Policy limits (read-only, amount cap, date floor) apply to the batch as a whole.",
  {
    operations: z.array(z.object({
      operation: z.enum(["create", "update", "delete"]),
      entity: z.string().describe("QBO entity name, e.g. Invoice, Bill, Customer, JournalEntry"),
      body: z.record(z.any()).describe("The entity payload; for update/delete include Id and SyncToken"),
    })).min(1).max(30).describe("At most 30 (QBO's batch cap)"),
    company: companyArg,
  },
  tool(async ({ operations, company }) => {
    const c = await resolveCompany(company, { write: true });
    for (const op of operations) {
      if (!/^[A-Za-z]+$/.test(op.entity)) throw new Error(`Invalid entity name "${op.entity}".`);
    }
    const items = operations.map((op, i) => ({
      bId: `bid${i}`,
      operation: op.operation,
      [op.entity]: op.body,
    }));
    const dates = operations.map((op) => op.body?.TxnDate).filter(Boolean);
    const warnings = await closedPeriodWarnings(c, dates.length ? dates : [undefined]);
    const r = await qboRequest(`/batch`, { method: "POST", body: { BatchItemRequest: items }, company: c });
    const responses = r.BatchItemResponse || [];
    const results = responses.map((res) => {
      const fault = res.Fault?.Error?.[0];
      if (fault) return { bId: res.bId, ok: false, error: `${fault.Message}${fault.Detail ? ": " + fault.Detail : ""}` };
      const entityKey = Object.keys(res).find((k) => k !== "bId" && res[k] && typeof res[k] === "object");
      const ent = entityKey ? res[entityKey] : null;
      return { bId: res.bId, ok: true, entity: entityKey ?? null, id: ent?.Id ?? null, doc_number: ent?.DocNumber ?? null, status: ent?.status ?? null };
    });
    const failed = results.filter((x) => !x.ok).length;
    return asText(withWarnings({ company: c, succeeded: results.length - failed, failed, results }, warnings));
  })
);

registerTool(
  "api_request",
  "Advanced escape hatch: make a raw authenticated call to any QBO endpoint under /v3/company/{realmId}. Provide `path` (e.g. \"/reports/GeneralLedger?start_date=2026-01-01\", \"/query?query=SELECT * FROM Bill\", \"/invoice/145\"), an HTTP method, and an optional JSON body. Auth, realm, and minorversion are handled for you. Known-broken endpoints, do not call: /reports/BudgetVsActuals (Actual column is inception-to-date regardless of dates; join the Budget entity to monthly P&L instead) and the sales-tax report family (/reports/TaxSummary etc.; compute from the liability account's GL).",
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
  "Read-only escape hatch: GET any QBO endpoint under /v3/company/{realmId} (reports, queries, single records). Never writes; safe to always-allow. Use api_request when a POST is required. Known-broken endpoints, do not call: /reports/BudgetVsActuals (inception-to-date actuals regardless of dates) and the sales-tax report family (/reports/TaxSummary etc.; use the liability account's GL).",
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

/* =========================== MCP RESOURCES (2) =========================== */
// Read-only context surfaces for MCP clients that support resources: the
// client roster and the effective write policies. Same data the list_clients
// and get_company_policy tools return, reachable without a tool call.

server.resource(
  "client-roster",
  "qbo://clients",
  { description: "The firm's client roster: every authorized company with names, aliases, engagement type, and drift.", mimeType: "application/json" },
  async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await roster(), null, 2) }],
  })
);

server.resource(
  "write-policies",
  "qbo://policy",
  { description: "Effective write guardrails per company (read-only, amount cap, date floor).", mimeType: "application/json" },
  async (uri) => {
    const companies = await listCompanies();
    const rows = [];
    for (const c of companies) rows.push({ company: c.slug, rules: await policyFor(c.slug) });
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ policy_file: policyPath(), companies: rows }, null, 2) }] };
  }
);

/* ============================ MCP PROMPTS (1) ============================ */

server.prompt(
  "month-end-data-pack",
  "Pull the standard month-end report package for one client into context: P&L (monthly columns), balance sheet, cash flow, trial balance, aged detail as of month end, and what changed since the prior close.",
  { client: z.string().describe("Client slug or name"), month: z.string().describe("YYYY-MM") },
  ({ client, month }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: [
          `Pull the month-end data pack for ${client}, period ${month}. Steps:`,
          `1. resolve_client("${client}") and use the returned slug as the company argument on every call; never guess.`,
          `2. get_preferences for fiscal year start and the book close date.`,
          `3. get_profit_and_loss for the trailing 13 months ending ${month} with summarize_column_by="Month".`,
          `4. get_balance_sheet as of the last day of ${month}.`,
          `5. get_cash_flow for ${month}.`,
          `6. get_trial_balance for ${month}.`,
          `7. get_aged_receivables_detail and get_aged_payables_detail with report_date = last day of ${month} (use parent-level totals only; the response note explains).`,
          `8. get_changes_since for Invoice,Bill,Payment,BillPayment,JournalEntry since the 1st of ${month} if within 30 days.`,
          `Then summarize: cash, A/R and A/P ties, month-over-month P&L movements above materiality, and anything posted into the closed period. Every figure names its report. No em dashes.`,
        ].join("\n"),
      },
    }],
  })
);

// ---- start -----------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
log(`QBO MCP server running (stdio).${suppressedTools ? ` ${suppressedTools} write tools suppressed by QBO_DISABLE_* env.` : ""}`);
