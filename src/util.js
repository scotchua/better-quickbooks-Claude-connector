// util.js: small pure helpers shared across the connector. No I/O here, so
// everything in this file is unit-testable in isolation.

import path from "node:path";

export const todayISO = () => new Date().toISOString().slice(0, 10);

// Escape a string value for interpolation into a QBO query string literal.
// Backslashes first, then quotes. Otherwise a value ending in a backslash
// would escape the closing quote and break out of the string literal.
export function esc(v) {
  return String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

// QuickBooks entity Ids are numeric. Validate before interpolating one into a
// query or URL path so a crafted "Id" can never change the request shape.
export function assertId(v, what = "Id") {
  const s = String(v).trim();
  if (!/^\d+$/.test(s)) throw new Error(`${what} must be a numeric QuickBooks Id, got "${v}".`);
  return s;
}

export function guessContentType(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  const map = {
    pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif", csv: "text/csv", txt: "text/plain",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };
  return map[ext] || "application/octet-stream";
}

// Normalize a human-entered name for tolerant comparison: casefold, collapse
// whitespace, trim. Deliberately conservative (no punctuation stripping) so a
// normalized match is safe to act on for writes.
export function normalizeName(s) {
  return String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

// Sum journal lines and assert debits equal credits (half-cent tolerance for
// float noise). Returns {debit, credit} totals.
export function assertBalanced(lines) {
  let debit = 0, credit = 0;
  for (const li of lines) {
    if (li.posting_type === "Debit") debit += Number(li.amount);
    else credit += Number(li.amount);
  }
  if (Math.abs(debit - credit) > 0.005) {
    throw new Error(`Journal entry is not balanced: debits ${debit.toFixed(2)} vs credits ${credit.toFixed(2)}.`);
  }
  return { debit, credit };
}

// Expand a leading ~ to the user's home directory.
export function expandHome(p) {
  return String(p).replace(/^~(?=$|\/)/, process.env.HOME || "~");
}

// Names that user-supplied file paths may never touch, read or write: key
// material and credential files. Applies regardless of QBO_FILES_DIR.
const SENSITIVE_BASENAME = /^(\.env(\..*)?|tokens(\..*)?\.json|\.qbo-key(\..*)?|id_rsa.*|id_ed25519.*|.*\.pem|\.npmrc|\.netrc)$/i;

// Resolve a user/model-supplied local path for reading or writing.
// - Expands ~ and resolves to an absolute path.
// - Refuses credential-shaped basenames always.
// - When QBO_FILES_DIR is set, refuses anything outside that directory tree
//   (the recommended firm setting is the client-files root, e.g. ~/Claude).
export function resolveUserPath(p, { purpose = "read" } = {}) {
  const abs = path.resolve(expandHome(p));
  if (SENSITIVE_BASENAME.test(path.basename(abs))) {
    throw new Error(`Refusing to ${purpose} ${path.basename(abs)}: credential-shaped filename.`);
  }
  const base = process.env.QBO_FILES_DIR ? path.resolve(expandHome(process.env.QBO_FILES_DIR)) : null;
  if (base && abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error(
      `Refusing to ${purpose} outside QBO_FILES_DIR (${base}): ${abs}. Move the file inside it, or change QBO_FILES_DIR in .env.`
    );
  }
  return abs;
}
