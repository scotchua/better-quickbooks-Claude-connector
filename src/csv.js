// csv.js: bank-statement CSV parsing and import planning.
//
// Correctness rules that the naive v1 importer got wrong:
//   - Amounts keep their sign. "(50.00)", "-50.00", and "$1,234.56" all parse;
//     only money OUT becomes an expense, and inflow rows are reported, never
//     silently imported as expenses.
//   - Separate Debit/Credit columns are understood (debit = money out).
//   - Dates are normalized to YYYY-MM-DD; unparseable rows are surfaced.
//   - Every import gets a stable import_id (hash of company + bank account +
//     file bytes). A local JSONL journal records each posted row, so a re-run
//     after a mid-import failure skips what already posted instead of
//     double-posting.

import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { auditFilePath } from "./audit.js";
import { withOwnerDirectoryLock } from "./owner-lock.js";
import { isRealCalendarDate } from "./util.js";

// ---- low-level CSV ----------------------------------------------------------

// Parse a simple CSV (handles quoted fields, commas and newlines inside
// quotes, CRLF, and a UTF-8 BOM on the first field).
export function parseCSV(text) {
  const rows = [];
  let field = "", row = [], inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false;
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      if (field !== "" || row.length) { row.push(field); rows.push(row); row = []; field = ""; }
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  if (rows[0]?.[0]) rows[0][0] = rows[0][0].replace(/^﻿/, "");
  return rows;
}

// ---- value parsing ----------------------------------------------------------

// Signed amount: handles $, thousands separators, leading/trailing minus, and
// accounting-style parentheses negatives. Returns NaN when not a number.
export function parseAmount(raw) {
  let s = String(raw ?? "").trim();
  if (s === "") return NaN;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (/-\s*$/.test(s)) { negative = true; s = s.replace(/-\s*$/, ""); }
  s = s.replace(/[$,\s]/g, "");
  if (s.startsWith("-")) { negative = !negative ? true : negative; s = s.slice(1); }
  if (!/^\d*\.?\d+$/.test(s)) return NaN;
  const n = parseFloat(s);
  return negative ? -n : n;
}

// Normalize common bank-export date formats to YYYY-MM-DD, or null when the
// value cannot be read unambiguously. Accepts ISO, US MM/DD/YYYY (and 2-digit
// years as 20xx), and YYYY/MM/DD.
export function normalizeDate(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s);
  if (m) return toISO(m[1], m[2], m[3]);
  m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{2}|\d{4})$/.exec(s);
  if (m) {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    return toISO(year, m[1], m[2]);
  }
  return null;
}

function toISO(y, mo, d) {
  const month = Number(mo), day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const iso = `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  // Reject dates that pass the range check but do not exist (2026-02-31,
  // 2025-02-29). A bank export should never contain one; if it does, the row
  // belongs in the errors list rather than posted against a coerced date.
  return isRealCalendarDate(iso) ? iso : null;
}

// ---- header detection -------------------------------------------------------

export function detectColumns(headerRow) {
  const header = headerRow.map((h) => h.trim().toLowerCase());
  const find = (pred) => header.findIndex(pred);
  const dateIdx = find((h) => h.includes("date"));
  const descIdx = find((h) => h.includes("desc") || h.includes("memo") || h.includes("payee") || h.includes("name"));
  const debitIdx = find((h) => h.includes("debit") || h.includes("withdrawal"));
  const creditIdx = find((h) => h.includes("credit") || h.includes("deposit"));
  const amountIdx = find((h) => h.includes("amount") || h === "amt");
  return { dateIdx, descIdx, debitIdx, creditIdx, amountIdx };
}

// ---- planning ---------------------------------------------------------------

// Build the import plan from parsed rows. Returns:
//   outflows: rows to import as expenses [{row, date, description, amount>0}]
//   inflows:  money-in rows (reported, not imported as expenses)
//   errors:   rows that could not be read [{row, reason}]
//
// amount_convention (single amount column only):
//   negative_out (default): negative amounts are money out (most bank exports)
//   positive_out:           positive amounts are money out
// With separate Debit/Credit columns the convention is unambiguous.
export function planImport(rows, { amountConvention = "negative_out" } = {}) {
  if (rows.length < 2) throw new Error("CSV appears empty or has no data rows.");
  const cols = detectColumns(rows[0]);
  const { dateIdx, descIdx, debitIdx, creditIdx, amountIdx } = cols;
  const hasDebitCredit = debitIdx >= 0 && creditIdx >= 0 && debitIdx !== creditIdx;
  if (dateIdx < 0 || descIdx < 0 || (!hasDebitCredit && amountIdx < 0)) {
    throw new Error(`Could not detect Date/Description/Amount (or Debit+Credit) columns. Found headers: ${rows[0].join(", ")}`);
  }

  const outflows = [], inflows = [], errors = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r.length || r.every((f) => String(f).trim() === "")) continue;
    const description = (r[descIdx] || "").trim();
    const date = normalizeDate(r[dateIdx]);
    if (!date) { errors.push({ row: i + 1, reason: `Unreadable date "${r[dateIdx] ?? ""}"` }); continue; }

    let signed; // negative = money out
    if (hasDebitCredit) {
      const debit = parseAmount(r[debitIdx]);
      const credit = parseAmount(r[creditIdx]);
      if (Number.isNaN(debit) && Number.isNaN(credit)) {
        errors.push({ row: i + 1, reason: "No amount in Debit or Credit column" });
        continue;
      }
      signed = !Number.isNaN(debit) && debit !== 0 ? -Math.abs(debit) : Math.abs(credit || 0);
    } else {
      const amt = parseAmount(r[amountIdx]);
      if (Number.isNaN(amt)) { errors.push({ row: i + 1, reason: `Unreadable amount "${r[amountIdx] ?? ""}"` }); continue; }
      signed = amountConvention === "positive_out" ? -amt : amt;
    }

    if (signed === 0) continue;
    const entry = { row: i + 1, date, description, amount: Math.abs(signed) };
    if (signed < 0) outflows.push(entry);
    else inflows.push(entry);
  }
  return { columns: cols, hasDebitCredit, outflows, inflows, errors };
}

// ---- import identity + resume journal ---------------------------------------

export function importId({ company, bankAccount, fileBytes }) {
  return createHash("sha256")
    .update(String(company)).update("\0")
    .update(String(bankAccount)).update("\0")
    .update(fileBytes)
    .digest("hex").slice(0, 12);
}

export function normalizeAmountConvention(value) {
  const normalized = value ?? "negative_out";
  if (normalized !== "negative_out" && normalized !== "positive_out") {
    throw new Error(`Unsupported CSV amount convention "${normalized}".`);
  }
  return normalized;
}

// Fingerprint the exact posting plan a human reviewed. importId deliberately
// remains the stable resume identity for a file + target account, while this
// hash also binds the interpretation of that file and the expense accounts
// selected from the current Chart of Accounts. A live import must match the
// latest preview hash, so changing the sign convention or account resolution
// cannot silently change what gets posted.
export function previewPlanHash({
  company,
  bankAccount,
  fileBytes,
  amountConvention,
  plannedRows,
}) {
  const rows = (plannedRows || []).map((entry) => {
    const row = Number(entry.row);
    const amount = Number(entry.amount);
    if (!Number.isInteger(row) || row < 1) {
      throw new Error("CSV preview plan contains an invalid source row number.");
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error(`CSV preview plan row ${row} contains an invalid amount.`);
    }
    if (entry.category_id == null || String(entry.category_id) === "") {
      throw new Error(`CSV preview plan row ${row} has no resolved expense category ID.`);
    }
    return {
      row,
      date: String(entry.date),
      amount,
      description: String(entry.description ?? ""),
      category_id: String(entry.category_id),
    };
  });
  const fileSha256 = createHash("sha256").update(fileBytes).digest("hex");
  const canonical = JSON.stringify({
    version: 1,
    company: String(company),
    bank_account_id: String(bankAccount),
    file_sha256: fileSha256,
    amount_convention: normalizeAmountConvention(amountConvention),
    rows,
  });
  return createHash("sha256")
    .update("qbo-bank-csv-preview-plan-v1\0")
    .update(canonical)
    .digest("hex");
}

export function rowMarker(importIdValue, row) {
  return `[import ${importIdValue} row ${row}]`;
}

function journalPath() {
  return path.join(path.dirname(auditFilePath()), "imports-journal.jsonl");
}

const IMPORT_LOCK_TIMEOUT_MS = 5 * 60_000;
const IMPORT_LOCK_STALE_MS = 5 * 60_000;
const JOURNAL_LOCK_TIMEOUT_MS = 5 * 60_000;
const JOURNAL_LOCK_STALE_MS = 5 * 60_000;

function importLockPath(importIdValue) {
  // Never place caller-derived text in a pathname. The normal import_id is
  // already hexadecimal, but hashing here keeps this helper safe for legacy
  // journals, tests, and any future identity format.
  const digest = createHash("sha256")
    .update("qbo-csv-import-lock-v1\0")
    .update(String(importIdValue))
    .digest("hex");
  return path.join(path.dirname(journalPath()), `.csv-import-${digest}.lock`);
}

function journalLockPath() {
  return path.join(path.dirname(journalPath()), ".csv-import-journal.lock");
}

async function prepareJournalDirectory() {
  const directory = path.dirname(journalPath());
  const firstCreatedDirectory = await mkdir(directory, { recursive: true, mode: 0o700 });
  await fsyncJournalDirectoryChain(directory, firstCreatedDirectory);
  return directory;
}

export async function withImportLock(importIdValue, fn, options = {}) {
  const lockPath = importLockPath(importIdValue);
  // Creating the lock directory must not steal appendJournal's one chance to
  // make a brand-new journal path durable. Flush the same new-directory chain
  // before the lock itself is published.
  await prepareJournalDirectory();
  return withOwnerDirectoryLock(lockPath, `CSV import ${String(importIdValue)}`, fn, {
    timeoutMs: IMPORT_LOCK_TIMEOUT_MS,
    staleAfterMs: IMPORT_LOCK_STALE_MS,
    ...options,
  });
}

async function withJournalLock(fn, options = {}) {
  await prepareJournalDirectory();
  return withOwnerDirectoryLock(journalLockPath(), "CSV import journal", fn, {
    timeoutMs: JOURNAL_LOCK_TIMEOUT_MS,
    staleAfterMs: JOURNAL_LOCK_STALE_MS,
    ...options,
  });
}

async function fsyncDirectory(directory, {
  openFile = open,
  platform = process.platform,
} = {}) {
  // FileHandle.sync() is portable, but Node cannot open directory handles on
  // Windows. The file itself is still flushed there; directory-entry
  // durability is left to the platform instead of making every import fail.
  if (platform === "win32") return;
  const directoryHandle = await openFile(directory, "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

async function fsyncJournalDirectoryChain(directory, firstCreatedDirectory, options = {}) {
  const target = path.resolve(directory);
  await fsyncDirectory(target, options);
  if (!firstCreatedDirectory) return;

  // mkdir({recursive:true}) returns the first directory it created. Flush each
  // new directory entry through the first parent that already existed so a
  // crash cannot lose the newly-created journal path after the file was synced.
  const firstExistingParent = path.dirname(path.resolve(firstCreatedDirectory));
  let current = path.dirname(target);
  for (;;) {
    await fsyncDirectory(current, options);
    if (current === firstExistingParent) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function appendJournalUnlocked(records, {
  openFile = open,
  makeDirectory = mkdir,
  platform = process.platform,
} = {}) {
  const file = journalPath();
  const directory = path.dirname(file);
  const firstCreatedDirectory = await makeDirectory(directory, { recursive: true, mode: 0o700 });
  const lines = records
    .map((r) => JSON.stringify({ ts: new Date().toISOString(), ...r }))
    .join("\n") + "\n";
  const fh = await openFile(file, "a", 0o600);
  try {
    // One buffer + O_APPEND keeps concurrent writers from sharing a mutable
    // offset. Do not return until the complete record has reached durable
    // storage; the caller relies on that before it sends anything to QBO.
    await fh.writeFile(Buffer.from(lines, "utf8"));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsyncJournalDirectoryChain(directory, firstCreatedDirectory, { openFile, platform });
}

async function appendJournal(records, options = {}) {
  // Import-specific locks prevent duplicate planning for the same import, but
  // all imports share this JSONL file. Serialize the complete durable append:
  // FileHandle.writeFile may require more than one write, so O_APPEND alone is
  // not a cross-platform guarantee against two writers interleaving bytes.
  return withJournalLock(() => appendJournalUnlocked(records, options));
}

// Everything the journal knows about one import. Four record kinds:
//   previewed  a dry run inspected this exact file against this exact target
//   intent     rows handed to QBO in a batch that has not been confirmed yet
//   posted     rows QBO confirmed, with the Purchase Ids it assigned
//   rejected   rows QBO definitively rejected in a successful batch response
//
// `intent` exists because of a specific window: between QBO committing a batch
// and the posted records reaching this file, a crash leaves those rows looking
// unposted, and the obvious re-run posts them twice. Intent marks them
// "unknown, go ask QuickBooks" instead. Records written before this journal had
// a `kind` field are read as posted rows, so an in-flight import still resumes.
async function readJournalUnlocked(importIdValue) {
  const rowStates = new Map();
  let previewed = false;
  let previewPlanHash = null;
  const file = journalPath();
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { previewed, previewPlanHash, posted: new Set(), intended: new Set(), rejected: new Set() };
    }
    throw new Error(
      `Could not read the durable CSV import journal at ${file}: ${error?.message || error}. ` +
      "Refusing to continue because prior import outcomes may be recorded there. Restore access to the journal and retry.",
      { cause: error }
    );
  }

  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
      if (!rec || typeof rec !== "object" || Array.isArray(rec) || typeof rec.import_id !== "string") {
        throw new Error("record is not a journal object with an import_id");
      }
      if (rec.kind === "previewed") {
        if (rec.plan_hash != null && typeof rec.plan_hash !== "string") {
          throw new Error("previewed record has an invalid plan_hash");
        }
      } else if (rec.kind === "intent") {
        if (!Array.isArray(rec.rows) || rec.rows.some((row) => !Number.isInteger(row) || row < 1)) {
          throw new Error("intent record has invalid rows");
        }
      } else if (rec.kind === "rejected") {
        if (!Number.isInteger(rec.row) || rec.row < 1 || (rec.error != null && typeof rec.error !== "string")) {
          throw new Error("rejected record has an invalid row or error");
        }
      } else if (rec.kind === "posted" || rec.kind == null) {
        if (!Number.isInteger(rec.row) || rec.row < 1) {
          throw new Error("posted record has an invalid row");
        }
      } else {
        throw new Error(`unknown journal record kind "${rec.kind}"`);
      }
    } catch (error) {
      throw new Error(
        `Malformed durable CSV import journal at ${file}, line ${index + 1}: ${error?.message || error}. ` +
        "Refusing to continue because this line could hide a prior intent or posted outcome. Preserve the file, " +
        "reconcile any uncertain rows against QuickBooks, then repair or restore the journal before retrying.",
        { cause: error }
      );
    }

    if (rec.import_id !== importIdValue) continue;
    if (rec.kind === "previewed") {
      previewed = true;
      // The newest preview for this import is authoritative. A legacy preview
      // without a hash intentionally resets this to null and requires another
      // preview before a live import.
      previewPlanHash = rec.plan_hash || null;
    } else if (rec.kind === "intent") {
      for (const row of rec.rows) {
        // A confirmed posting is terminal. This also preserves safety for
        // journals written by two old connector processes whose append order
        // may contain a late intent after an already-confirmed posting.
        if (rowStates.get(row) !== "posted") rowStates.set(row, "intended");
      }
    } else if (rec.kind === "rejected") {
      if (rowStates.get(rec.row) !== "posted") rowStates.set(rec.row, "rejected");
    } else {
      rowStates.set(rec.row, "posted");
    }
  }
  const posted = new Set();
  const intended = new Set();
  const rejected = new Set();
  for (const [row, state] of rowStates) {
    if (state === "posted") posted.add(row);
    else if (state === "intended") intended.add(row);
    else if (state === "rejected") rejected.add(row);
  }
  return { previewed, previewPlanHash, posted, intended, rejected };
}

export async function readJournal(importIdValue) {
  // Readers share the append lock so they never parse an append that is only
  // partly written or not yet durable. Production lock ordering is always the
  // per-import lock first and this short journal lock second.
  return withJournalLock(() => readJournalUnlocked(importIdValue));
}

// Rows announced to QBO whose outcome never made it back into the journal.
export function unconfirmedRows({ posted, intended }) {
  return new Set([...intended].filter((r) => !posted.has(r)));
}

// Rows already posted for this import_id (from prior, possibly partial, runs).
export async function postedRows(importIdValue) {
  return (await readJournal(importIdValue)).posted;
}

export async function recordPreviewed(importIdValue, meta = {}) {
  await appendJournal([{ kind: "previewed", import_id: importIdValue, ...meta }]);
}

export async function recordIntent(importIdValue, rows) {
  if (!rows.length) return;
  try {
    await appendJournal([{ kind: "intent", import_id: importIdValue, rows }]);
  } catch (e) {
    throw new Error(
      `Could not persist the durable CSV import intent (${e.message}). The QuickBooks batch was NOT sent.`,
      { cause: e }
    );
  }
}

export async function recordPosted(importIdValue, entries) {
  if (!entries.length) return;
  try {
    await appendJournal(entries.map((e) => ({ kind: "posted", import_id: importIdValue, ...e })));
  } catch (e) {
    throw new Error(
      `Could not persist the durable CSV import outcome (${e.message}). QuickBooks may already contain these rows; ` +
      "do not retry until the import is reconciled against QuickBooks.",
      { cause: e }
    );
  }
}

export async function recordRejected(importIdValue, entries) {
  if (!entries.length) return;
  try {
    await appendJournal(entries.map((entry) => ({
      kind: "rejected",
      import_id: importIdValue,
      row: entry.row,
      ...(entry.error != null ? { error: String(entry.error).slice(0, 500) } : {}),
    })));
  } catch (e) {
    throw new Error(
      `Could not persist the durable CSV import rejection outcome (${e.message}). QuickBooks rejected these rows, ` +
      "but automatic retry will remain blocked until the journal is repaired; do not bypass that refusal.",
      { cause: e }
    );
  }
}

export async function recordBatchOutcomes(importIdValue, { posted = [], rejected = [] } = {}) {
  if (!posted.length && !rejected.length) return;
  const records = [
    ...posted.map((entry) => ({ kind: "posted", import_id: importIdValue, ...entry })),
    ...rejected.map((entry) => ({
      kind: "rejected",
      import_id: importIdValue,
      row: entry.row,
      ...(entry.error != null ? { error: String(entry.error).slice(0, 500) } : {}),
    })),
  ];
  try {
    // Persist every terminal result from one QBO batch in the same fsynced
    // append. Separate posted/rejected appends would introduce an avoidable
    // crash window where a known rejection reverted to an ambiguous intent.
    await appendJournal(records);
  } catch (e) {
    throw new Error(
      `Could not persist the durable CSV batch outcomes (${e.message}). QuickBooks may already contain successful rows, ` +
      "and rejected rows cannot be retried automatically until the journal is repaired; reconcile this batch before retrying.",
      { cause: e }
    );
  }
}

// Read an import id and row number back out of a PrivateNote stamped by
// rowMarker. This is what lets a posted transaction be recognized in
// QuickBooks itself when the local journal is incomplete.
export function parseRowMarker(note) {
  const m = /\[import ([0-9a-f]+) row (\d+)\]/.exec(String(note ?? ""));
  return m ? { importId: m[1], row: Number(m[2]) } : null;
}

export const __test = Object.freeze({
  appendJournal,
  appendJournalUnlocked,
  fsyncJournalDirectoryChain,
  importLockPath,
  journalLockPath,
  withJournalLock,
});
