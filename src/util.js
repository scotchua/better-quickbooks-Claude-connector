// util.js: small helpers shared across the connector. Everything here is pure
// and unit-testable in isolation except resolveUserPath, which has to touch the
// filesystem: a containment check that cannot resolve symlinks is not a
// containment check.

import path from "node:path";
import os from "node:os";
import { realpath, stat } from "node:fs/promises";

export const todayISO = () => new Date().toISOString().slice(0, 10);

// A timeout response can arrive after a server or proxy accepted the request,
// just like a 5xx can arrive after the upstream applied it. Callers that have
// an exact replay mechanism must keep both outcomes unresolved.
export function isAmbiguousHttpStatus(status) {
  const value = Number(status);
  return value === 408 || value >= 500;
}

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

// Consume a Fetch Response body without first materializing an unbounded
// ArrayBuffer. The configured limit is validated at the edge, Content-Length
// can reject a known-oversized response before reading, and the running total
// protects responses that omit or lie about their length.
export async function readResponseBuffer(response, {
  maxBytes,
  label = "Response",
  capName = "maxBytes",
} = {}) {
  const cap = typeof maxBytes === "number" ? maxBytes : Number(String(maxBytes ?? "").trim());
  if (!Number.isSafeInteger(cap) || cap <= 0) {
    throw new Error(`${capName} must be a positive safe integer number of bytes; received ${JSON.stringify(maxBytes)}.`);
  }

  const declaredHeader = response?.headers?.get?.("content-length");
  const declaredText = declaredHeader == null ? "" : String(declaredHeader).trim();
  if (/^\d+$/.test(declaredText) && BigInt(declaredText) > BigInt(cap)) {
    const error = new Error(`${label} declares ${declaredText} bytes, above the ${cap}-byte cap (${capName}).`);
    // Cancel the untouched body so the transport does not continue buffering
    // a response we already know cannot be accepted.
    await response.body?.cancel?.(error).catch(() => {});
    throw error;
  }

  if (!response?.body) return Buffer.alloc(0);
  if (typeof response.body.getReader !== "function") {
    throw new Error(`${label} body is not a Web ReadableStream.`);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const length = value?.byteLength;
      if (!Number.isSafeInteger(length) || length < 0) {
        throw new Error(`${label} stream returned a chunk without a valid byteLength.`);
      }
      if (length > cap - total) {
        const observed = total + length;
        const error = new Error(
          `${label} exceeded the ${cap}-byte cap while downloading ` +
          `(received at least ${observed} bytes; ${capName}).`
        );
        await reader.cancel(error).catch(() => {});
        throw error;
      }
      // Copy only after the cap check. In particular, an oversized chunk never
      // causes a second oversized allocation inside this helper.
      chunks.push(Buffer.from(value));
      total += length;
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
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

// Is this a date that actually exists? A YYYY-MM-DD shape check accepts
// 2026-02-31 and 2026-13-01, which then fail deep inside QuickBooks as an
// opaque 400 (or, worse, get silently coerced). Round-tripping through Date
// rejects them at the edge, where the message can say which field is wrong.
export function isRealCalendarDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? ""));
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

// Does this raw QBO path ask to destroy or zero out a record? Used to hold the
// api_request escape hatch to the same rules as the named delete_/void_ tools.
// Covers the three shapes QBO accepts: ?operation=delete, ?operation=void, and
// the payment-void form ?operation=update&include=void. The trailing boundary
// keeps "operation=deleted" (not a thing, but cheap to exclude) from matching.
export function isDestructiveOperation(pathAndQuery) {
  const raw = String(pathAndQuery ?? "");
  const query = raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : "";
  try {
    const params = new URLSearchParams(query);
    for (const [name, value] of params) {
      const key = name.toLowerCase();
      const normalized = value.toLowerCase();
      if (key === "operation" && (normalized === "delete" || normalized === "void")) return true;
      if (key === "include" && normalized === "void") return true;
    }
    return false;
  } catch {
    // Validation rejects malformed encodings before the request is sent. Treat
    // an unparseable query as potentially destructive in this predicate too.
    return true;
  }
}

// Validate a caller-supplied path for the raw API escape hatches. The client
// appends its own minorversion and, for writes, requestid; allowing either in
// the caller's query (or allowing a fragment to hide the appended suffix)
// breaks the durable idempotency binding.
export function validateRawQboPath(value) {
  const raw = String(value ?? "");
  const normalized = raw.startsWith("/") ? raw : `/${raw}`;
  if (!raw.trim()) throw new Error("`path` cannot be empty.");
  if (normalized.startsWith("//")) throw new Error("`path` must be relative to the selected QuickBooks company, not a network URL.");
  if (/[\r\n\t\0]/.test(normalized)) throw new Error("Control characters are not allowed in `path`.");
  if (normalized.includes("#")) {
    throw new Error("URL fragments are not allowed in `path`; they would hide the connector-managed request parameters.");
  }

  const question = normalized.indexOf("?");
  const rawPathname = question === -1 ? normalized : normalized.slice(0, question);
  let decodedPathname;
  try {
    decodedPathname = decodeURIComponent(rawPathname);
  } catch {
    throw new Error("Invalid percent-encoding in `path`.");
  }
  if (/[\r\n\t\0#]/.test(decodedPathname)) throw new Error("Encoded control characters or fragments are not allowed in `path`.");
  if (decodedPathname.includes("..") || decodedPathname.includes("\\")) {
    throw new Error("Path traversal sequences are not allowed in `path`; it must stay under /v3/company/{realmId}.");
  }

  if (question !== -1) {
    let params;
    try {
      params = new URLSearchParams(normalized.slice(question + 1));
    } catch {
      throw new Error("Invalid query encoding in `path`.");
    }
    for (const [name] of params) {
      const key = name.toLowerCase();
      if (key === "requestid" || key === "minorversion") {
        throw new Error(`Query parameter "${name}" is reserved; the connector manages requestid and minorversion.`);
      }
    }
  }
  return normalized;
}

// Expand a leading ~ to the user's home directory. Accept both separator
// styles because .env examples are commonly copied between macOS/Linux and
// Windows; path.join then emits the separator native to the current host.
export function expandHome(p) {
  const input = String(p);
  if (input === "~") return os.homedir();
  if (!/^~[\\/]/.test(input)) return input;
  const parts = input.slice(2).split(/[\\/]+/).filter(Boolean);
  return path.join(os.homedir(), ...parts);
}

// Names that user-supplied file paths may never touch, read or write: key
// material and credential files. Applies regardless of QBO_FILES_DIR.
const SENSITIVE_BASENAME = /^(\.env(\..*)?|tokens(\..*)?\.json|\.qbo-key(\..*)?|id_rsa.*|id_ed25519.*|.*\.pem|\.npmrc|\.netrc)$/i;

// Resolve the deepest existing ancestor of a path through symlinks, then
// re-attach the part that does not exist yet. A write target usually does not
// exist, so plain realpath() on it would just throw; what matters is that the
// directory it lands in is where it appears to be.
async function realpathDeepest(p) {
  let head = p;
  const tail = [];
  for (;;) {
    try {
      const real = await realpath(head);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch (e) {
      if (e.code !== "ENOENT") return p; // unreadable: fall back to the lexical path
      const parent = path.dirname(head);
      if (parent === head) return p; // hit the root having found nothing
      tail.push(path.basename(head));
      head = parent;
    }
  }
}

async function pathExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// Resolve a user/model-supplied local path for reading or writing.
// - Expands ~ and resolves to an absolute path.
// - Refuses credential-shaped basenames always.
// - Resolves symlinks BEFORE the containment check, so a link planted inside
//   QBO_FILES_DIR cannot be used to reach outside it.
// - When QBO_FILES_DIR is set, refuses anything outside that directory tree
//   (the recommended firm setting is the client-files root, e.g. ~/Claude).
// - `requireBase` refuses to proceed at all unless QBO_FILES_DIR is set. Used
//   where an unconstrained read is an exfiltration route, not just a mistake.
// - Writes refuse to replace an existing file unless `overwrite` is passed.
export async function resolveUserPath(p, { purpose = "read", requireBase = false, overwrite = false } = {}) {
  const abs = path.resolve(expandHome(p));
  if (SENSITIVE_BASENAME.test(path.basename(abs))) {
    throw new Error(`Refusing to ${purpose} ${path.basename(abs)}: credential-shaped filename.`);
  }

  const base = process.env.QBO_FILES_DIR ? path.resolve(expandHome(process.env.QBO_FILES_DIR)) : null;
  if (!base && requireBase) {
    throw new Error(
      `Refusing to ${purpose} ${abs}: QBO_FILES_DIR is not set, so there is nothing constraining which local ` +
      `file this could be. Set QBO_FILES_DIR in .env to the client-files root (e.g. ~/Claude) and put the file inside it.`
    );
  }
  if (base) {
    const realAbs = await realpathDeepest(abs);
    const realBase = await realpathDeepest(base);
    if (realAbs !== realBase && !realAbs.startsWith(realBase + path.sep)) {
      const via = realAbs === abs ? "" : ` (a symlink resolving to ${realAbs})`;
      throw new Error(
        `Refusing to ${purpose} outside QBO_FILES_DIR (${base}): ${abs}${via}. ` +
        `Move the file inside it, or change QBO_FILES_DIR in .env.`
      );
    }
  }

  if (purpose === "write" && !overwrite && (await pathExists(abs))) {
    throw new Error(
      `Refusing to overwrite the existing file ${abs}. Pick a different path, or pass overwrite: true if replacing it is intended.`
    );
  }
  return abs;
}
