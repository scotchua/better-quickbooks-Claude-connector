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
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { auditFilePath } from "./audit.js";
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

export function rowMarker(importIdValue, row) {
  return `[import ${importIdValue} row ${row}]`;
}

function journalPath() {
  return path.join(path.dirname(auditFilePath()), "imports-journal.jsonl");
}

async function appendJournal(records) {
  const file = journalPath();
  await mkdir(path.dirname(file), { recursive: true });
  const lines = records
    .map((r) => JSON.stringify({ ts: new Date().toISOString(), ...r }))
    .join("\n") + "\n";
  await appendFile(file, lines, { encoding: "utf8", mode: 0o600 });
}

// Everything the journal knows about one import. Three record kinds:
//   previewed  a dry run inspected this exact file against this exact target
//   intent     rows handed to QBO in a batch that has not been confirmed yet
//   posted     rows QBO confirmed, with the Purchase Ids it assigned
//
// `intent` exists because of a specific window: between QBO committing a batch
// and the posted records reaching this file, a crash leaves those rows looking
// unposted, and the obvious re-run posts them twice. Intent marks them
// "unknown, go ask QuickBooks" instead. Records written before this journal had
// a `kind` field are read as posted rows, so an in-flight import still resumes.
export async function readJournal(importIdValue) {
  const posted = new Set();
  const intended = new Set();
  let previewed = false;
  try {
    const text = await readFile(journalPath(), "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; /* skip corrupt line */ }
      if (rec.import_id !== importIdValue) continue;
      if (rec.kind === "previewed") previewed = true;
      else if (rec.kind === "intent") for (const r of rec.rows || []) intended.add(r);
      else if (rec.row != null) posted.add(rec.row);
    }
  } catch { /* no journal yet */ }
  return { previewed, posted, intended };
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
  await appendJournal([{ kind: "intent", import_id: importIdValue, rows }]);
}

export async function recordPosted(importIdValue, entries) {
  if (!entries.length) return;
  await appendJournal(entries.map((e) => ({ kind: "posted", import_id: importIdValue, ...e })));
}

// Read an import id and row number back out of a PrivateNote stamped by
// rowMarker. This is what lets a posted transaction be recognized in
// QuickBooks itself when the local journal is incomplete.
export function parseRowMarker(note) {
  const m = /\[import ([0-9a-f]+) row (\d+)\]/.exec(String(note ?? ""));
  return m ? { importId: m[1], row: Number(m[2]) } : null;
}
