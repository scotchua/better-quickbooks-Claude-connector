// policy.js: optional per-company write policies, loaded from qbo-policy.json
// (or QBO_POLICY_FILE). Enforced centrally at the API layer, so every write
// tool, including the api_request escape hatch, obeys them.
//
// File shape (see qbo-policy.example.json):
//   {
//     "defaults":  { "read_only": false, "max_write_amount": null, "min_txn_date": null },
//     "companies": { "<slug>": { "read_only": true } }
//   }
//
// Supported rules:
//   read_only        boolean: refuse every write to this company
//   max_write_amount number: refuse writes whose money total exceeds this
//   min_txn_date     "YYYY-MM-DD": refuse writes dated before this floor
//
// The file is keyed by slug; resolution is keyed by REALM. A slug is a local
// nickname in a filename, while the realm is the actual set of books a rule is
// meant to protect, so every slug addressing one realm contributes and the
// strictest value of each rule wins. See policyFor() and the STRICTEST table.

import { readFile, rename, open, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { realmSiblingSlugs } from "./company-registry.js";
import { withOwnerDirectoryLock } from "./owner-lock.js";
import { resolveEnvPath } from "./util.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const cache = { path: null, identity: null, policy: null };
let policyWriteQueue = Promise.resolve();

const POLICY_LOCK_TIMEOUT_MS = 30_000;
const POLICY_LOCK_STALE_MS = 5 * 60_000;

function policyFileIdentity(fileStat) {
  // Atomic replacement creates a new inode/file id even when the replacement
  // has the same size and timestamp. ctime is a useful fallback on filesystems
  // whose Node stat implementation does not expose a meaningful inode.
  return [
    fileStat.dev,
    fileStat.ino,
    fileStat.size,
    fileStat.mtimeMs,
    fileStat.ctimeMs,
  ].map((value) => String(value ?? "")).join(":");
}

async function fsyncParentDirectory(file, {
  openFile = open,
  platform = process.platform,
} = {}) {
  // Node cannot portably open directory handles on Windows. The file itself is
  // still flushed; on POSIX, directory fsync is required for create/rename
  // metadata to survive a power loss.
  if (platform === "win32") return;
  const directoryHandle = await openFile(path.dirname(file), "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

async function durableCreateFile(file, data, {
  encoding = "utf8",
  mode = 0o600,
  flag = "wx",
} = {}, {
  openFile = open,
  platform = process.platform,
} = {}) {
  const fh = await openFile(file, flag, mode);
  let operationError;
  try {
    await fh.writeFile(data, { encoding });
    await fh.sync();
  } catch (e) {
    operationError = e;
  }
  try {
    await fh.close();
  } catch (closeError) {
    operationError = operationError
      ? new AggregateError([operationError, closeError], `Writing ${file} failed and its handle could not be closed.`)
      : closeError;
  }
  if (operationError) throw operationError;
  await fsyncParentDirectory(file, { openFile, platform });
}

async function durableAtomicReplace(file, tmp, data, {
  openFile = open,
  move = rename,
  remove = unlink,
  platform = process.platform,
} = {}) {
  let tempOwned = false;
  let moved = false;
  try {
    const fh = await openFile(tmp, "wx", 0o600);
    tempOwned = true;
    let operationError;
    try {
      await fh.writeFile(data, { encoding: "utf8" });
      await fh.sync();
    } catch (e) {
      operationError = e;
    }
    try {
      await fh.close();
    } catch (closeError) {
      operationError = operationError
        ? new AggregateError([operationError, closeError], `Writing ${tmp} failed and its handle could not be closed.`)
        : closeError;
    }
    if (operationError) throw operationError;

    // Persist the recoverable temp entry before replacing the policy, then
    // persist the rename itself. The first sync also makes a pre-rename crash
    // leave a complete temp file rather than an acknowledged but lost write.
    await fsyncParentDirectory(tmp, { openFile, platform });
    await move(tmp, file);
    moved = true;
    await fsyncParentDirectory(file, { openFile, platform });
  } catch (primaryError) {
    if (tempOwned && !moved) {
      try {
        await remove(tmp);
      } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") {
          throw new AggregateError(
            [primaryError, cleanupError],
            `Policy replacement failed and its temporary file could not be removed (${cleanupError.message}).`
          );
        }
      }
    }
    throw primaryError;
  }
}

function policyLockPath(policyFile) {
  return `${policyFile}.lock`;
}

async function withPolicyFileLock(policyFile, fn, options = {}) {
  return withOwnerDirectoryLock(policyLockPath(policyFile), "write-policy update", fn, {
    timeoutMs: POLICY_LOCK_TIMEOUT_MS,
    staleAfterMs: POLICY_LOCK_STALE_MS,
    ...options,
  });
}

const RULE_KEYS = new Set(["read_only", "max_write_amount", "min_txn_date"]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function realIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

function validateRules(rules, where) {
  if (!isPlainObject(rules)) throw new Error(`${where} must be an object.`);
  for (const key of Object.keys(rules)) {
    if (!RULE_KEYS.has(key)) {
      throw new Error(`${where} contains unknown rule "${key}". Writes are blocked until the typo is fixed.`);
    }
  }
  if (rules.read_only != null && typeof rules.read_only !== "boolean") {
    throw new Error(`${where}.read_only must be true, false, or null.`);
  }
  if (
    rules.max_write_amount != null &&
    (typeof rules.max_write_amount !== "number" || !Number.isFinite(rules.max_write_amount) || rules.max_write_amount < 0)
  ) {
    throw new Error(`${where}.max_write_amount must be a nonnegative finite number or null.`);
  }
  if (rules.min_txn_date != null && (typeof rules.min_txn_date !== "string" || !realIsoDate(rules.min_txn_date))) {
    throw new Error(`${where}.min_txn_date must be a real YYYY-MM-DD date or null.`);
  }
}

export function validatePolicy(policy, label = "write-policy file") {
  if (!isPlainObject(policy)) throw new Error(`${label} must contain a JSON object.`);
  for (const key of Object.keys(policy)) {
    if (key !== "defaults" && key !== "companies") {
      throw new Error(`${label} contains unknown top-level key "${key}". Writes are blocked until it is fixed.`);
    }
  }
  if (policy.defaults != null) validateRules(policy.defaults, `${label}.defaults`);
  if (policy.companies != null) {
    if (!isPlainObject(policy.companies)) throw new Error(`${label}.companies must be an object.`);
    for (const [slug, rules] of Object.entries(policy.companies)) {
      if (slug && !/^[A-Za-z0-9_-]+$/.test(slug)) {
        throw new Error(`${label}.companies has invalid slug "${slug}".`);
      }
      validateRules(rules, `${label}.companies.${slug || "(default)"}`);
    }
  }
  return policy;
}

export function policyPath(env = process.env) {
  return resolveEnvPath(env.QBO_POLICY_FILE, path.join(ROOT, "qbo-policy.json"));
}

// mtime-cached load. ONLY a missing file means "no policy". An unreadable or
// malformed file THROWS, which blocks writes: the alternative is that one bad
// hand-edit silently turns every read-only company, amount cap, and date floor
// in this file into "no restrictions", with nothing anywhere saying so.
export async function loadPolicy() {
  const p = policyPath();
  const forget = () => {
    cache.path = null;
    cache.identity = null;
    cache.policy = null;
  };

  let policyHandle;
  try {
    policyHandle = await open(p, "r");
  } catch (e) {
    forget();
    if (e.code === "ENOENT") return null; // no file: no rules, deliberately
    throw new Error(
      `Cannot read the write-policy file ${p} (${e.message}). Writes are blocked until it is readable. ` +
      `Fix the permissions, or delete the file if these companies genuinely have no guardrails.`
    );
  }

  let identity;
  let raw;
  let cachedPolicy;
  let readError;
  try {
    // fstat the same open file we read. A pathname stat followed by readFile can
    // observe two generations when another process renames between those calls.
    // dev+ino/file id also distinguishes atomic replacements whose mtimes match.
    identity = policyFileIdentity(await policyHandle.stat());
    if (cache.policy && cache.path === p && cache.identity === identity) {
      cachedPolicy = cache.policy;
    } else {
      raw = (await policyHandle.readFile("utf8")).trim();
    }
  } catch (e) {
    readError = e;
  }
  try {
    await policyHandle.close();
  } catch (closeError) {
    readError = readError
      ? new AggregateError([readError, closeError], `Reading ${p} failed and its handle could not be closed.`)
      : closeError;
  }
  if (readError) {
    forget();
    throw new Error(`Cannot read the write-policy file ${p} (${readError.message}). Writes are blocked until it is readable.`);
  }
  if (cachedPolicy) return cachedPolicy;

  let parsed;
  try {
    // An empty file means "no rules", matching setCompanyPolicy's read path.
    parsed = raw ? JSON.parse(raw) : {};
  } catch (e) {
    forget();
    throw new Error(
      `${p} is not valid JSON (${e.message}). Writes are blocked until it parses. ` +
      `Fix the file (an empty object {} means "no rules") or move it aside.`
    );
  }

  try {
    validatePolicy(parsed, p);
  } catch (e) {
    forget();
    throw new Error(`${e.message} Writes are blocked until the policy is valid.`);
  }

  cache.path = p;
  cache.identity = identity;
  cache.policy = parsed;
  return parsed;
}

// How two values for the same rule combine when one realm is reachable under
// more than one slug. Always the stricter of the two, never the looser.
//
// A future rule added to RULE_KEYS without an entry in this table would be
// silently ignored by the merge, so a guardrail could be set on one label and
// quietly not apply. assertMergeRulesComplete() below turns that into a
// startup-time failure instead of a silent gap.
const STRICTEST = Object.freeze({
  // Any label saying "these books are read-only" makes them read-only.
  read_only: (a, b) => Boolean(a) || Boolean(b),
  // The lowest ceiling wins.
  max_write_amount: (a, b) => Math.min(Number(a), Number(b)),
  // The latest floor wins; ISO dates compare correctly as strings.
  min_txn_date: (a, b) => (String(a) > String(b) ? a : b),
});

function assertMergeRulesComplete() {
  const missing = [...RULE_KEYS].filter((key) => !Object.hasOwn(STRICTEST, key));
  if (missing.length) {
    throw new Error(
      `Write-policy rule(s) ${missing.join(", ")} have no strictness rule in policy.js. ` +
      "Refusing to resolve any policy: without one, a guardrail set on one slug for a realm " +
      "would be silently dropped when that realm is reachable under another slug."
    );
  }
}

/** Merge one company's rules into an accumulator, strictest value winning. */
function mergeStrictest(into, rules) {
  for (const [key, value] of Object.entries(rules || {})) {
    if (value == null) continue;
    if (!Object.hasOwn(STRICTEST, key)) {
      // Unreachable while validateRules rejects unknown keys at load time; kept
      // as the fail-closed backstop for a rule added to only one of the two.
      throw new Error(`Write-policy rule "${key}" has no strictness rule; refusing to resolve a policy that may be incomplete.`);
    }
    into[key] = Object.hasOwn(into, key) ? STRICTEST[key](into[key], value) : value;
  }
  return into;
}

/**
 * The effective write guardrails for a company.
 *
 * Resolved by REALM, not by slug. Guardrails protect a set of books; a realm is
 * that set; a slug is only a local nickname in a filename. Keying on the slug
 * meant a company authorized twice under two names could have `read_only` set
 * on one label while writes addressed to the other label still posted. Every
 * slug pointing at the same realm now contributes, and the strictest value of
 * each rule wins.
 *
 * `siblings` is injectable so tests and callers that already hold the company
 * list do not have to re-scan the token directory.
 */
export async function policyFor(slug, { siblings = null } = {}) {
  assertMergeRulesComplete();
  const p = await loadPolicy();
  if (!p) return {};
  const defaults = p.defaults || {};
  const companies = p.companies || {};
  const key = slug || "";

  const labels = siblings ?? await realmSiblingSlugs(key);
  const relevant = labels.includes(key) ? labels : [...labels, key];

  // Within one slug, a company rule OVERRIDES the default. That has to stay:
  // the deny-by-default pattern (defaults.read_only true, one company reopened
  // with an explicit false) depends on it, and merging defaults strictest would
  // make a locked company impossible to reopen.
  const perSlug = relevant.map((label) => ({ ...defaults, ...(companies[label] || {}) }));
  if (perSlug.length === 1) return perSlug[0];

  // ACROSS slugs for the same realm, the strictest value wins. These are not
  // competing configurations of one company; they are two labels for one set
  // of books, and the guardrail belongs to the books.
  return perSlug.reduce((into, rules) => mergeStrictest(into, rules), {});
}

function moneyMagnitude(value, field) {
  const amount = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : NaN;
  if (!Number.isFinite(amount)) {
    throw new Error(
      `Policy: monetary field ${field} must be a finite number; the write is blocked while max_write_amount is active.`
    );
  }
  return Math.abs(amount);
}

function addMagnitudes(total, amount) {
  const result = total + amount;
  if (!Number.isFinite(result)) {
    throw new Error(
      "Policy: monetary magnitudes overflowed a finite number; the write is blocked while max_write_amount is active."
    );
  }
  return result;
}

// Conservatively measure the gross monetary exposure of a QBO write. Header
// totals are never allowed to hide larger lines, negative values cannot cancel
// positive ones, and batches add each item's independent magnitude. A journal
// counts the larger side (debits or credits) rather than double-counting a
// balanced entry.
function writeAmountAt(body, field) {
  if (!body || typeof body !== "object") return 0;
  if (Array.isArray(body.BatchItemRequest)) {
    let batchTotal = 0;
    for (const [itemIndex, item] of body.BatchItemRequest.entries()) {
      if (!item || typeof item !== "object") continue;
      let itemTotal = 0;
      for (const [key, value] of Object.entries(item)) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        itemTotal = addMagnitudes(itemTotal, writeAmountAt(value, `${field}.BatchItemRequest[${itemIndex}].${key}`));
      }
      batchTotal = addMagnitudes(batchTotal, itemTotal);
    }
    return batchTotal;
  }

  const candidates = [0];
  if (body.TotalAmt != null) candidates.push(moneyMagnitude(body.TotalAmt, `${field}.TotalAmt`));
  if (body.Amount != null) candidates.push(moneyMagnitude(body.Amount, `${field}.Amount`));

  if (Array.isArray(body.Line)) {
    const isJournal = body.Line.some((line) => line?.JournalEntryLineDetail);
    let debitMagnitude = 0;
    let creditMagnitude = 0;
    let otherMagnitude = 0;
    for (const [lineIndex, line] of body.Line.entries()) {
      if (line?.Amount == null) continue;
      const magnitude = moneyMagnitude(line.Amount, `${field}.Line[${lineIndex}].Amount`);
      if (!isJournal) {
        otherMagnitude = addMagnitudes(otherMagnitude, magnitude);
        continue;
      }
      const postingType = line?.JournalEntryLineDetail?.PostingType;
      if (postingType === "Debit") debitMagnitude = addMagnitudes(debitMagnitude, magnitude);
      else if (postingType === "Credit") creditMagnitude = addMagnitudes(creditMagnitude, magnitude);
      // A malformed/mixed journal line still represents monetary exposure. Add
      // it on top of the larger known side rather than letting it disappear.
      else otherMagnitude = addMagnitudes(otherMagnitude, magnitude);
    }
    const linesMagnitude = isJournal
      ? addMagnitudes(Math.max(debitMagnitude, creditMagnitude), otherMagnitude)
      : otherMagnitude;
    candidates.push(linesMagnitude);
  }

  return Math.max(...candidates);
}

export function writeAmount(body) {
  return writeAmountAt(body, "body");
}

export function txnDates(body) {
  const dates = [];
  if (body?.TxnDate) dates.push(body.TxnDate);
  if (Array.isArray(body?.BatchItemRequest)) {
    for (const item of body.BatchItemRequest) {
      const inner = Object.values(item).find((v) => v && typeof v === "object" && v.TxnDate);
      if (inner?.TxnDate) dates.push(inner.TxnDate);
    }
  }
  return dates;
}

// Merge one company's rules into the policy file. Kept here rather than left to
// callers because the file holds every company: a careless rewrite silently
// opens books that were meant to stay closed. Backs up first, writes atomically,
// and refuses to touch a file it cannot parse.
//
// Pass null for a rule to clear it. Returns the resulting entry.
async function setCompanyPolicyUnlocked(slug, { read_only, max_write_amount, min_txn_date } = {}, p = policyPath()) {
  let policy = {};
  let existingContents = null;
  try {
    existingContents = await readFile(p, "utf8");
    const raw = existingContents.trim();
    if (raw) policy = validatePolicy(JSON.parse(raw), p);
  } catch (e) {
    if (e.code !== "ENOENT") {
      throw new Error(
        `${p} is not valid JSON (${e.message}). Fix or move it by hand; refusing to overwrite rules that may be protecting client books.`
      );
    }
  }

  const companies = (policy.companies ??= {});
  const entry = (companies[slug] ??= {});
  // false must be STORED, not deleted. Deleting it makes the company fall back
  // to defaults.read_only, so under a deny-by-default policy a company could be
  // locked but never reopened. null is the way to say "inherit the default".
  if (read_only === true) entry.read_only = true;
  else if (read_only === false) entry.read_only = false;
  else if (read_only === null) delete entry.read_only;
  if (max_write_amount !== undefined && max_write_amount !== null && max_write_amount !== 0 &&
      (typeof max_write_amount !== "number" || !Number.isFinite(max_write_amount) || max_write_amount < 0)) {
    throw new Error(`max_write_amount must be a positive finite number, 0, or null.`);
  }
  if (typeof max_write_amount === "number" && max_write_amount > 0) entry.max_write_amount = max_write_amount;
  if (max_write_amount === null || max_write_amount === 0) delete entry.max_write_amount;
  if (typeof min_txn_date === "string" && realIsoDate(min_txn_date)) entry.min_txn_date = min_txn_date;
  else if (min_txn_date === null) delete entry.min_txn_date;
  else if (min_txn_date !== undefined) throw new Error(`min_txn_date must be YYYY-MM-DD or null, got "${min_txn_date}".`);
  if (Object.keys(entry).length === 0) delete companies[slug];

  let backup;
  if (existingContents !== null) {
    // Unique even when several policy changes land in the same second. A backup
    // is part of the recovery contract, so do not silently overwrite the prior
    // backup or continue until its bytes and directory entry are durable.
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
    backup = `${p}.bak-${stamp}-${process.pid}-${randomUUID()}`;
    try {
      await durableCreateFile(backup, existingContents);
    } catch (e) {
      throw new Error(
        `Could not back up the existing write-policy file ${p} (${e.message}); refusing to replace it.`,
        { cause: e }
      );
    }
  }
  validatePolicy(policy, p);
  const tmp = `${p}.${process.pid}.${randomUUID()}.tmp`;
  await durableAtomicReplace(p, tmp, JSON.stringify(policy, null, 2) + "\n");
  cache.path = null; // force a reload on the next check
  cache.identity = null;
  return {
    company: slug || "(default)",
    rules: companies[slug] ?? {},
    policy_file: p,
    backup,
    other_companies: Object.keys(companies).filter((s) => s !== slug),
  };
}

export function setCompanyPolicy(slug, patch = {}) {
  // Serialize the read-modify-write sequence. Concurrent calls otherwise read
  // the same old document and whichever rename lands last silently loses the
  // other company's guardrail. The owner-marker directory lock extends that
  // guarantee to other connector processes; the promise queue still avoids
  // needless local contention and preserves call order within this process.
  const run = () => {
    const p = policyPath();
    return withPolicyFileLock(p, () => setCompanyPolicyUnlocked(slug, patch, p));
  };
  const result = policyWriteQueue.then(run, run);
  policyWriteQueue = result.catch(() => {});
  return result;
}

// Narrow hooks for focused lock tests. Production callers should use
// setCompanyPolicy so the read-modify-write operation cannot escape the lock.
export const __test = {
  durableAtomicReplace,
  durableCreateFile,
  fsyncParentDirectory,
  policyFileIdentity,
  withPolicyFileLock,
  policyLockPath,
};

// Throws when a write violates the company's policy. Pass a null body to
// check only the read_only gate (used by the company resolver).
export async function checkWritePolicy(slug, body, {
  siblings = null,
  postingCreatesWithoutValidTxnDate = [],
} = {}) {
  const pol = await policyFor(slug, { siblings });
  if (!pol || Object.keys(pol).length === 0) return;
  const label = slug || "(default)";
  if (pol.read_only) {
    throw new Error(`Policy: company "${label}" is read-only. Writes are disabled in ${policyPath()}.`);
  }
  // A raw posting create can omit its body entirely. The absence of a body
  // must not bypass the explicit-date requirement merely because there are no
  // body fields for the amount/date scanners below to inspect.
  if (!body && pol.min_txn_date && postingCreatesWithoutValidTxnDate.length) {
    const entities = [...new Set(postingCreatesWithoutValidTxnDate)].join(", ");
    throw new Error(
      `Policy: ${entities} posting create${postingCreatesWithoutValidTxnDate.length === 1 ? "" : "s"} omitted TxnDate or supplied an invalid TxnDate while ` +
      `the "${label}" date floor ${pol.min_txn_date} is active in ${policyPath()}. Intuit defaults an omitted TxnDate ` +
      "from QuickBooks server time without documenting its timezone, so the connector will not guess or rely on API coercion. Supply TxnDate explicitly as YYYY-MM-DD; invalid values are refused."
    );
  }
  if (!body) return;
  if (pol.max_write_amount != null) {
    const amt = writeAmount(body);
    if (amt > Number(pol.max_write_amount)) {
      throw new Error(
        `Policy: this write totals ${amt.toFixed(2)}, above the "${label}" limit of ${pol.max_write_amount} set in ${policyPath()}.`
      );
    }
  }
  if (pol.min_txn_date) {
    if (postingCreatesWithoutValidTxnDate.length) {
      const entities = [...new Set(postingCreatesWithoutValidTxnDate)].join(", ");
      throw new Error(
        `Policy: ${entities} posting create${postingCreatesWithoutValidTxnDate.length === 1 ? "" : "s"} omitted TxnDate or supplied an invalid TxnDate while ` +
        `the "${label}" date floor ${pol.min_txn_date} is active in ${policyPath()}. Intuit defaults an omitted TxnDate ` +
        "from QuickBooks server time without documenting its timezone, so the connector will not guess or rely on API coercion. Supply TxnDate explicitly as YYYY-MM-DD; invalid values are refused."
      );
    }
    const bad = txnDates(body).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < pol.min_txn_date);
    if (bad.length) {
      throw new Error(
        `Policy: transaction date ${bad.join(", ")} is before the "${label}" floor of ${pol.min_txn_date} set in ${policyPath()}.`
      );
    }
  }
}
