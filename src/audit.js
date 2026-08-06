// audit.js: append-only JSONL audit log of every write sent to QuickBooks.
//
// Hooked at the API layer (every non-GET request), so it covers all write
// tools including the api_request escape hatch with no per-tool wiring. One
// file per month under audit-log/ (gitignored), created with 0600 permissions.
// This is the firm's local record of AI-performed bookkeeping: what was
// posted, to which company, when, and Intuit's trace id for support.
//
// QBO_AUDIT=on (default) | strict | off; relocate with QBO_AUDIT_DIR.
//   on      a failed append is logged to stderr and the call continues
//   strict  a failed append is raised to the caller (see record() for what
//           that does and does not guarantee)
//   off     no audit log at all

import { appendFile, mkdir } from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// Which tool is currently running. Audit records are built down in the API
// layer, which has no idea what the caller actually asked for, and threading a
// tool name through every one of the ~60 call sites would be pure noise. The
// tool wrapper in index.js puts the name here; the API layer reads it back.
export const toolContext = new AsyncLocalStorage();

export function currentToolName() {
  return toolContext.getStore()?.tool;
}

function auditDir() {
  return process.env.QBO_AUDIT_DIR || path.join(ROOT, "audit-log");
}

export function auditMode() {
  return (process.env.QBO_AUDIT || "on").toLowerCase();
}

export function auditEnabled() {
  return auditMode() !== "off";
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
    // A bare count is not an accountability record: a 30-item batch where 11
    // items failed and 19 posted needs to say which is which, or the log
    // cannot answer "what did Claude actually change".
    return {
      entity: "Batch",
      count: data.BatchItemResponse.length,
      items: data.BatchItemResponse.map((res) => {
        const fault = res.Fault?.Error?.[0];
        if (fault) {
          return { bId: res.bId, ok: false, error: String(fault.Message ?? "error").slice(0, 200) };
        }
        const key = Object.keys(res).find((k) => k !== "bId" && res[k] && typeof res[k] === "object");
        const ent = key ? res[key] : null;
        return { bId: res.bId, ok: true, entity: key ?? null, entityId: ent?.Id ?? null };
      }),
    };
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

// Append one audit record.
//
// Default mode logs a failure to stderr and lets the accounting call stand: an
// audit problem should not turn a posted transaction into an error the caller
// might retry. QBO_AUDIT=strict raises it instead, for deployments where an
// unrecorded write is itself the incident.
//
// What strict does NOT do is make the write conditional on the record. Audit
// happens after the API responds, so by the time an append can fail the
// transaction already exists in QuickBooks. Strict converts a silent gap in the
// accountability trail into a loud one; it cannot roll anything back.
export async function record(entry) {
  const mode = auditMode();
  if (mode === "off") return;
  try {
    const file = auditFilePath();
    await mkdir(path.dirname(file), { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
    await appendFile(file, line, { encoding: "utf8", mode: 0o600 });
  } catch (e) {
    console.error("[qbo-audit] failed to write audit record:", e.message);
    if (mode === "strict") {
      throw new Error(
        `Audit record could not be written (${e.message}) and QBO_AUDIT=strict. The QuickBooks call this ` +
        `record describes HAS ALREADY BEEN SENT and is not undone by this error. Fix the audit directory, ` +
        `then reconcile what was posted by hand.`
      );
    }
  }
}
