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

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const cache = { mtimeMs: -1, policy: null };

export function policyPath() {
  return process.env.QBO_POLICY_FILE || path.join(ROOT, "qbo-policy.json");
}

// mtime-cached load; a missing or unreadable file means "no policy".
export async function loadPolicy() {
  try {
    const p = policyPath();
    const s = await stat(p);
    if (cache.policy && cache.mtimeMs === s.mtimeMs) return cache.policy;
    const parsed = JSON.parse(await readFile(p, "utf8"));
    cache.mtimeMs = s.mtimeMs;
    cache.policy = parsed;
    return parsed;
  } catch {
    cache.mtimeMs = -1;
    cache.policy = null;
    return null;
  }
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
