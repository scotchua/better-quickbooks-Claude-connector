// entities.js: company-scoped entity lookups, tolerant name resolution, and
// accounting guardrails shared by the tools.

import { qboQuery, qboRequest } from "./qbo.js";
import { esc, assertId, normalizeName, isRealCalendarDate } from "./util.js";

// ---- paginated queries ------------------------------------------------------

export const QUERY_PAGE_SIZE = 100; // QBO's default page size

// Page a SELECT query with STARTPOSITION/MAXRESULTS until exhausted or a hard
// ceiling, so callers never mistake a single page for the full result set.
// `baseSql` must not already contain STARTPOSITION or MAXRESULTS.
export async function qboQueryAll(baseSql, entity, { company, maxTotal = 1000 } = {}) {
  const rows = [];
  let start = 1;
  let truncated = false;
  for (;;) {
    const page =
      (await qboQuery(`${baseSql} STARTPOSITION ${start} MAXRESULTS ${QUERY_PAGE_SIZE}`, { company }))[entity] || [];
    rows.push(...page);
    if (page.length < QUERY_PAGE_SIZE) break;
    if (rows.length >= maxTotal) { truncated = true; break; }
    start += QUERY_PAGE_SIZE;
  }
  return { rows, truncated };
}

// ---- name / id resolution ---------------------------------------------------

export function nameFieldFor(entity) {
  return ["Customer", "Vendor", "Employee"].includes(entity) ? "DisplayName" : "Name";
}

// All {Id, name} pairs for an entity (capped at 1000) for tolerant matching.
// Cached briefly per company+entity: multi-line builders and suggestion
// lookups otherwise refetch the same index many times in one tool call.
// Exact-match lookups always hit the API directly, so a just-created record
// resolves immediately; only fuzzy matching and suggestions can lag the TTL.
const nameIndexCache = new Map(); // key -> { at, rows }
const NAME_INDEX_TTL_MS = 60_000;

async function nameIndex(entity, company, nameField) {
  const key = `${company ?? ""}|${entity}|${nameField}`;
  const hit = nameIndexCache.get(key);
  if (hit && Date.now() - hit.at < NAME_INDEX_TTL_MS) return hit.rows;
  const { rows } = await qboQueryAll(`SELECT Id, ${nameField} FROM ${entity}`, entity, { company });
  const mapped = rows.map((r) => ({ id: r.Id, name: r[nameField] ?? "" }));
  nameIndexCache.set(key, { at: Date.now(), rows: mapped });
  return mapped;
}

// Find by exact name, then fall back to a case/whitespace-insensitive match
// when it is unique. Returns the full record or null. This keeps writes safe:
// only an unambiguous normalized match is ever used.
export async function findByName(entity, name, company, nameField = nameFieldFor(entity)) {
  const exact = (await qboQuery(`SELECT * FROM ${entity} WHERE ${nameField} = '${esc(name)}'`, { company }))[entity]?.[0];
  if (exact) return exact;
  const wanted = normalizeName(name);
  if (!wanted) return null;
  const candidates = (await nameIndex(entity, company, nameField)).filter((c) => normalizeName(c.name) === wanted);
  if (candidates.length !== 1) return null;
  return (await qboQuery(`SELECT * FROM ${entity} WHERE Id = '${assertId(candidates[0].id, `${entity} Id`)}'`, { company }))[entity]?.[0] || null;
}

// Up to `limit` existing names containing the term, for did-you-mean errors.
export async function suggestNames(entity, term, company, nameField = nameFieldFor(entity), limit = 5) {
  try {
    const wanted = normalizeName(term);
    const all = await nameIndex(entity, company, nameField);
    const hits = all.filter((c) => normalizeName(c.name).includes(wanted)).slice(0, limit);
    return hits.map((c) => c.name);
  } catch {
    return [];
  }
}

export function notFoundError(entity, name, suggestions) {
  const hint = suggestions?.length ? ` Did you mean: ${suggestions.map((s) => `"${s}"`).join(", ")}?` : "";
  return new Error(`${entity} not found: "${name}".${hint}`);
}

// Resolve a name-or-Id to a QBO {value, name} reference for any entity, with
// tolerant matching and suggestions on a miss.
export async function resolveRef(entity, nameOrId, company, nameField = nameFieldFor(entity)) {
  if (/^\d+$/.test(String(nameOrId).trim())) {
    const id = assertId(nameOrId, `${entity} Id`);
    const rec = (await qboQuery(`SELECT * FROM ${entity} WHERE Id = '${id}'`, { company }))[entity]?.[0];
    return rec ? { value: rec.Id, name: rec[nameField] || rec.Name } : { value: id };
  }
  const rec = await findByName(entity, nameOrId, company, nameField);
  if (!rec) throw notFoundError(entity, nameOrId, await suggestNames(entity, nameOrId, company, nameField));
  return { value: rec.Id, name: rec[nameField] || rec.Name };
}

// Fetch a full entity record (for its SyncToken) before a sparse update /
// void / delete.
export async function fetchEntity(entity, id, company) {
  const cleanId = assertId(id, `${entity} Id`);
  const rec = (await qboQuery(`SELECT * FROM ${entity} WHERE Id = '${cleanId}'`, { company }))[entity]?.[0];
  if (!rec) throw new Error(`No ${entity} with Id ${cleanId}`);
  return rec;
}

export async function readJournalEntry(id, company) {
  const r = await qboRequest(`/journalentry/${encodeURIComponent(assertId(id, "journal_entry_id"))}`, { company });
  const entry = r.JournalEntry;
  if (!entry) throw new Error(`No journal entry with Id ${id}`);
  return entry;
}

// Convenience single-record lookups used by the core tools.
export const findCustomerByName = (name, company) => findByName("Customer", name, company);
export const findVendorByName = (name, company) => findByName("Vendor", name, company);
export const findAccountByName = (name, company) => findByName("Account", name, company);

export async function findAnyIncomeAccount(company) {
  const r = await qboQuery(`SELECT * FROM Account WHERE AccountType = 'Income' MAXRESULTS 1`, { company });
  return r.Account?.[0] || null;
}
export async function findAnyServiceItem(company) {
  const r = await qboQuery(`SELECT * FROM Item WHERE Type = 'Service' MAXRESULTS 1`, { company });
  return r.Item?.[0] || null;
}

// ---- closed-period guardrail ------------------------------------------------

// The books-closed date from company Preferences, cached for 5 minutes per
// company. In block mode, an unreadable close date blocks the write: treating
// an outage as "books are open" defeats the purpose of a fail-closed setting.
const prefsCache = new Map(); // company -> { at, closeDate }
const PREFS_TTL_MS = 5 * 60 * 1000;
const CLOSED_PERIOD_MODES = new Set(["warn", "block", "off"]);

export function closedPeriodMode(raw = process.env.QBO_CLOSED_PERIOD) {
  const mode = String(raw || "warn").trim().toLowerCase();
  if (!CLOSED_PERIOD_MODES.has(mode)) {
    throw new Error(
      `QBO_CLOSED_PERIOD must be warn, block, or off; received ${JSON.stringify(raw)}. ` +
      "Refusing to guess which accounting-period guardrail was intended."
    );
  }
  return mode;
}

async function getBookCloseDateState(company) {
  const mode = closedPeriodMode();
  const key = company ?? "";
  const hit = prefsCache.get(key);
  if (hit && Date.now() - hit.at < PREFS_TTL_MS) return { closeDate: hit.closeDate, warning: null };
  let closeDate = null;
  try {
    const r = await qboRequest(`/preferences`, { company });
    closeDate = r.Preferences?.AccountingInfoPrefs?.BookCloseDate || null;
  } catch (e) {
    if (mode === "block") {
      throw new Error(
        `Cannot verify the QuickBooks book-close date (${e.message}). QBO_CLOSED_PERIOD=block therefore refuses this write; ` +
        `restore connectivity or explicitly choose warn/off after reviewing the risk.`
      );
    }
    // A stale known value is safer than pretending the books were never
    // closed during a transient Preferences failure.
    if (hit) {
      return {
        closeDate: hit.closeDate,
        warning:
          `Could not refresh the QuickBooks book-close date (${e.message}); using the last verified value ` +
          `${hit.closeDate || "that the books were open"} from ${new Date(hit.at).toISOString()}.`,
      };
    }
    return {
      closeDate: null,
      warning:
        `Could not verify the QuickBooks book-close date (${e.message}). QBO_CLOSED_PERIOD=warn permits the write, ` +
        "but the connector could not determine whether it affects closed books; review the transaction in QuickBooks.",
    };
  }
  if (closeDate != null && !isRealCalendarDate(closeDate)) {
    throw new Error(
      `QuickBooks returned an invalid BookCloseDate (${JSON.stringify(closeDate)}) for ${key || "the default company"}. ` +
      "The connector will not treat malformed accounting preferences as open books; correct the preference in QuickBooks and retry."
    );
  }
  prefsCache.set(key, { at: Date.now(), closeDate });
  return { closeDate, warning: null };
}

export async function getBookCloseDate(company) {
  return (await getBookCloseDateState(company)).closeDate;
}

// Check transaction dates against the books-closed date.
// QBO_CLOSED_PERIOD=warn (default): returns a warnings array to include in the
// tool response. QBO_CLOSED_PERIOD=block: throws instead.
// QBO_CLOSED_PERIOD=off: skips the check.
export async function closedPeriodWarnings(company, dates) {
  const mode = closedPeriodMode();
  if (mode === "off") return [];
  const { closeDate, warning: verificationWarning } = await getBookCloseDateState(company);
  if (!closeDate) return verificationWarning ? [verificationWarning] : [];
  const supplied = dates || [];
  const checked = supplied.filter((date) => isRealCalendarDate(date));
  const unverifiable = supplied.length - checked.length;
  const warnings = verificationWarning ? [verificationWarning] : [];
  if (unverifiable) {
    const msg =
      `Books are closed through ${closeDate}, but ${unverifiable === 1 ? "a posting write has" : `${unverifiable} posting writes have`} ` +
      "no valid explicit TxnDate. Intuit defaults an omitted date from QuickBooks server time without documenting its " +
      "timezone, so the connector cannot prove the write is outside the closed period. Supply TxnDate explicitly as YYYY-MM-DD.";
    if (mode === "block") {
      throw new Error(`${msg} QBO_CLOSED_PERIOD=block therefore refuses this write.`);
    }
    warnings.push(msg);
  }
  const inClosed = checked.filter((d) => d <= closeDate);
  if (inClosed.length) {
    const msg = `Books are closed through ${closeDate}; this write affects the closed period (date ${inClosed.join(", ")}).`;
    if (mode === "block") {
      throw new Error(`${msg} Set QBO_CLOSED_PERIOD=warn to allow with a warning, or use a date after ${closeDate}.`);
    }
    warnings.push(msg);
  }
  return warnings;
}

// Attach warnings to a tool response payload when there are any.
export function withWarnings(payload, warnings) {
  return warnings?.length ? { ...payload, warnings } : payload;
}

// ---- advanced search filters --------------------------------------------------

// Typed, allowlisted filters for the search/list tools (field allowlists follow
// Intuit's documented filterable columns; the pattern follows Intuit's MIT
// MCP server). Fields are validated against the allowlist, so only values are
// interpolated, and those are escaped.
const QUERY_OPERATORS = new Set(["=", "<", ">", "<=", ">=", "LIKE", "IN"]);

function queryLiteral(v) {
  return typeof v === "boolean" ? String(v) : `'${esc(v)}'`;
}

export function buildWhere(filters = [], allowedFields = []) {
  return filters.map((f) => {
    if (!allowedFields.includes(f.field)) {
      throw new Error(`Field "${f.field}" is not filterable here. Filterable: ${allowedFields.join(", ")}.`);
    }
    const op = (f.operator || "=").toUpperCase();
    if (!QUERY_OPERATORS.has(op)) throw new Error(`Unsupported operator "${f.operator}". Use ${[...QUERY_OPERATORS].join(", ")}.`);
    if (op === "IN") {
      const vals = Array.isArray(f.value) ? f.value : [f.value];
      if (!vals.length) throw new Error(`IN filter on "${f.field}" needs at least one value.`);
      return `${f.field} IN (${vals.map(queryLiteral).join(", ")})`;
    }
    if (Array.isArray(f.value)) throw new Error(`Array values require the IN operator (field "${f.field}").`);
    return `${f.field} ${op} ${queryLiteral(f.value)}`;
  });
}
