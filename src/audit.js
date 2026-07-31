// audit.js: append-only JSONL audit log of every write sent to QuickBooks.
//
// Hooked at the API layer (every non-GET request), so it covers all write
// tools including the api_request escape hatch with no per-tool wiring. One
// file per month under audit-log/ (gitignored), created with 0600 permissions.
// This is the firm's local record of AI-performed bookkeeping: what was
// posted, to which company, when, and Intuit's trace id for support.
//
// Disable with QBO_AUDIT=off; relocate with QBO_AUDIT_DIR.

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function auditDir() {
  return process.env.QBO_AUDIT_DIR || path.join(ROOT, "audit-log");
}

export function auditEnabled() {
  return (process.env.QBO_AUDIT || "on").toLowerCase() !== "off";
}

export function auditFilePath(now = new Date()) {
  const month = now.toISOString().slice(0, 7); // YYYY-MM
  return path.join(auditDir(), `audit-${month}.jsonl`);
}

// Pull a one-line summary of the affected entity out of a QBO response body:
// the first object-valued property carrying an Id (Invoice, Bill, ...), or a
// batch item count.
export function summarizeResponse(data) {
  if (!data || typeof data !== "object") return {};
  if (Array.isArray(data.BatchItemResponse)) {
    return { entity: "Batch", count: data.BatchItemResponse.length };
  }
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === "object" && !Array.isArray(v) && v.Id) {
      const out = { entity: k, entityId: v.Id };
      if (v.DocNumber != null) out.docNumber = v.DocNumber;
      if (v.TotalAmt != null) out.total = v.TotalAmt;
      if (v.DisplayName != null) out.name = v.DisplayName;
      return out;
    }
  }
  return {};
}

// Append one audit record. Never throws: an audit failure must not break the
// underlying accounting call, so problems are logged to stderr instead.
export async function record(entry) {
  if (!auditEnabled()) return;
  try {
    const file = auditFilePath();
    await mkdir(path.dirname(file), { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
    await appendFile(file, line, { encoding: "utf8", mode: 0o600 });
  } catch (e) {
    console.error("[qbo-audit] failed to write audit record:", e.message);
  }
}
