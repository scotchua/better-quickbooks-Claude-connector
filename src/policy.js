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

import { readFile, writeFile, rename, copyFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const cache = { path: null, mtimeMs: -1, policy: null };

export function policyPath() {
  return process.env.QBO_POLICY_FILE || path.join(ROOT, "qbo-policy.json");
}

// mtime-cached load. ONLY a missing file means "no policy". An unreadable or
// malformed file THROWS, which blocks writes: the alternative is that one bad
// hand-edit silently turns every read-only company, amount cap, and date floor
// in this file into "no restrictions", with nothing anywhere saying so.
export async function loadPolicy() {
  const p = policyPath();
  const forget = () => {
    cache.path = null;
    cache.mtimeMs = -1;
    cache.policy = null;
  };

  let s;
  try {
    s = await stat(p);
  } catch (e) {
    forget();
    if (e.code === "ENOENT") return null; // no file: no rules, deliberately
    throw new Error(
      `Cannot read the write-policy file ${p} (${e.message}). Writes are blocked until it is readable. ` +
      `Fix the permissions, or delete the file if these companies genuinely have no guardrails.`
    );
  }

  // Key the cache on path AND mtime: two different files written within the
  // same millisecond must not serve each other's rules.
  if (cache.policy && cache.path === p && cache.mtimeMs === s.mtimeMs) return cache.policy;

  let raw;
  try {
    raw = (await readFile(p, "utf8")).trim();
  } catch (e) {
    forget();
    throw new Error(
      `Cannot read the write-policy file ${p} (${e.message}). Writes are blocked until it is readable.`
    );
  }

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

  cache.path = p;
  cache.mtimeMs = s.mtimeMs;
  cache.policy = parsed;
  return parsed;
}

export async function policyFor(slug) {
  const p = await loadPolicy();
  if (!p) return {};
  return { ...(p.defaults || {}), ...((p.companies || {})[slug || ""] || {}) };
}

// The money total of a QBO write body. Journal entries count debits only
// (debits equal credits, so summing both sides would double the entry).
export function writeAmount(body) {
  if (!body || typeof body !== "object") return 0;
  if (Array.isArray(body.BatchItemRequest)) {
    return body.BatchItemRequest.reduce((s, item) => {
      const inner = Object.values(item).find(
        (v) => v && typeof v === "object" && (Array.isArray(v.Line) || v.TotalAmt != null || v.Amount != null)
      );
      return s + writeAmount(inner);
    }, 0);
  }
  if (body.TotalAmt != null) return Number(body.TotalAmt) || 0;
  if (Array.isArray(body.Line)) {
    const journal = body.Line.filter((l) => l?.JournalEntryLineDetail);
    if (journal.length) {
      return journal
        .filter((l) => l.JournalEntryLineDetail.PostingType === "Debit")
        .reduce((s, l) => s + (Number(l.Amount) || 0), 0);
    }
    return body.Line.reduce((s, l) => s + (Number(l?.Amount) || 0), 0);
  }
  if (body.Amount != null) return Number(body.Amount) || 0;
  return 0;
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
export async function setCompanyPolicy(slug, { read_only, max_write_amount, min_txn_date } = {}) {
  const p = policyPath();
  let policy = {};
  try {
    const raw = (await readFile(p, "utf8")).trim();
    if (raw) policy = JSON.parse(raw);
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
  if (typeof max_write_amount === "number" && max_write_amount > 0) entry.max_write_amount = max_write_amount;
  if (max_write_amount === null || max_write_amount === 0) delete entry.max_write_amount;
  if (typeof min_txn_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(min_txn_date)) entry.min_txn_date = min_txn_date;
  else if (min_txn_date === null) delete entry.min_txn_date;
  else if (min_txn_date !== undefined) throw new Error(`min_txn_date must be YYYY-MM-DD or null, got "${min_txn_date}".`);
  if (Object.keys(entry).length === 0) delete companies[slug];

  let backup;
  try {
    backup = `${p}.bak-${new Date().toISOString().replace(/[:.]/g, "").slice(0, 15)}`;
    await copyFile(p, backup);
  } catch {
    backup = undefined; // no prior file to back up
  }
  const tmp = `${p}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(policy, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await rename(tmp, p);
  cache.path = null; // force a reload on the next check
  cache.mtimeMs = -1;
  return {
    company: slug || "(default)",
    rules: companies[slug] ?? {},
    policy_file: p,
    backup,
    other_companies: Object.keys(companies).filter((s) => s !== slug),
  };
}

// Throws when a write violates the company's policy. Pass a null body to
// check only the read_only gate (used by the company resolver).
export async function checkWritePolicy(slug, body) {
  const pol = await policyFor(slug);
  if (!pol || Object.keys(pol).length === 0) return;
  const label = slug || "(default)";
  if (pol.read_only) {
    throw new Error(`Policy: company "${label}" is read-only. Writes are disabled in ${policyPath()}.`);
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
    const bad = txnDates(body).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < pol.min_txn_date);
    if (bad.length) {
      throw new Error(
        `Policy: transaction date ${bad.join(", ")} is before the "${label}" floor of ${pol.min_txn_date} set in ${policyPath()}.`
      );
    }
  }
}
