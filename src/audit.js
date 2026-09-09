// audit.js: append-only JSONL audit log of every write sent to QuickBooks,
// plus the smaller mandatory recovery ledger used to make retries safe.
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
//
// QBO_AUDIT=off does NOT disable write-recovery.jsonl. That ledger contains no
// request bodies, only an exact request-envelope fingerprint and its outcome.
// A write intent must reach durable storage before the request is sent; without
// that record, a timed-out write cannot be replayed without risking a duplicate
// or silently discarding a changed request under Intuit's requestid semantics.

import { appendFile, mkdir, open, readFile } from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withOwnerDirectoryLock } from "./owner-lock.js";
import { isAmbiguousHttpStatus, resolveEnvPath } from "./util.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// Which tool is currently running. Audit records are built down in the API
// layer, which has no idea what the caller actually asked for, and threading a
// tool name through every one of the ~60 call sites would be pure noise. The
// tool wrapper in index.js puts the name here; the API layer reads it back.
export const toolContext = new AsyncLocalStorage();

export function currentToolName() {
  return toolContext.getStore()?.tool;
}

export function currentToolSupportsRecovery() {
  return toolContext.getStore()?.recoverySupported !== false;
}

// A recovery id is supplied once at the MCP tool boundary, then claimed by
// the one underlying QuickBooks write. High-level tools frequently do reads
// before that write. Composite tools are deliberately not given a generic
// request_id field at registration; this second-claim guard remains defense in
// depth in case a future handler accidentally performs another write.
export function claimRecoveryRequestId(explicitRequestId) {
  const store = toolContext.getStore();
  const supplied = explicitRequestId != null
    ? String(explicitRequestId).trim()
    : store?.recoveryRequestId;
  if (supplied == null) return null;
  if (!supplied) {
    throw new Error("request_id cannot be empty. Omit it for a new write, or pass the id from an unresolved-write record.");
  }
  if (store) {
    if (store.recoveryClaimed) {
      throw new Error(
        `request_id ${supplied} already recovered the first QuickBooks write in this tool call. ` +
        "A recovery id is bound to exactly one API request, so the later write was blocked. " +
        "Do not rerun a composite workflow; inspect the recovered result and continue with a dedicated single-record tool."
      );
    }
    store.recoveryClaimed = true;
  }
  return supplied;
}

export function auditDir(env = process.env) {
  return resolveEnvPath(env.QBO_AUDIT_DIR, path.join(ROOT, "audit-log"));
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

// One non-rotating file keeps a recovery id verifiable across month boundaries.
// It remains deliberately compact: bodies are represented only by SHA-256.
export function writeRecoveryFilePath() {
  return path.join(auditDir(), "write-recovery.jsonl");
}

function writeRecoveryLockPath() {
  return path.join(auditDir(), ".write-recovery.lock");
}

function writeRecoveryRequestLockPath(requestId) {
  const digest = createHash("sha256")
    .update("qbo-write-recovery-request-lock-v1\0")
    .update(String(requestId))
    .digest("hex");
  return path.join(auditDir(), `.write-recovery-request-${digest}.lock`);
}

const RECOVERY_LOCK_TIMEOUT_MS = 5 * 60_000;
const RECOVERY_LOCK_STALE_MS = 5 * 60_000;

async function prepareRecoveryDirectory() {
  const directory = auditDir();
  const firstCreatedDirectory = await mkdir(directory, { recursive: true, mode: 0o700 });
  await fsyncRecoveryDirectoryChain(directory, firstCreatedDirectory);
}

async function withWriteRecoveryLock(fn, options = {}) {
  await prepareRecoveryDirectory();
  // This is always the innermost owner-aware lock. A caller may already hold a
  // workflow lock (for example CSV import -> recovery ledger), but callbacks
  // here perform only ledger filesystem I/O and never acquire token, realm,
  // policy, CSV-import, or CSV-journal locks. No reverse ordering exists.
  return withOwnerDirectoryLock(writeRecoveryLockPath(), "write-recovery ledger", fn, {
    timeoutMs: RECOVERY_LOCK_TIMEOUT_MS,
    staleAfterMs: RECOVERY_LOCK_STALE_MS,
    ...options,
  });
}

export async function withWriteRecoveryRequestLock(requestId, fn, options = {}) {
  const normalized = String(requestId ?? "").trim();
  if (!normalized) throw new Error("A non-empty request_id is required for the write-recovery request lock.");
  const lockPath = writeRecoveryRequestLockPath(normalized);
  // Request scope is outside the brief shared-ledger critical sections and may
  // span the QBO network call. It prevents a visible in-flight intent from
  // being replayed concurrently, and ensures a waiter re-verifies the latest
  // outcome before sending. Order: outer workflow -> request -> shared ledger.
  let callbackError;
  let callbackStarted = false;
  let directoryPrepared = false;
  try {
    await prepareRecoveryDirectory();
    directoryPrepared = true;
    return await withOwnerDirectoryLock(lockPath, "write-recovery request", async () => {
      callbackStarted = true;
      try {
        return await fn();
      } catch (error) {
        callbackError = error;
        throw error;
      }
    }, {
      timeoutMs: RECOVERY_LOCK_TIMEOUT_MS,
      staleAfterMs: RECOVERY_LOCK_STALE_MS,
      ...options,
    });
  } catch (error) {
    // A normal QBO/lifecycle error from the callback already carries its own
    // recovery semantics. Acquisition/release failure (or callback+release
    // failure combined by the primitive) needs stronger guidance: the caller
    // must not mistake a lock error after a durable outcome for permission to
    // repeat the bookkeeping operation under a fresh id.
    if (error === callbackError) throw error;
    if (!directoryPrepared) {
      throw new Error(
        `Could not prepare durable write recovery for request_id ${normalized} (${error?.message || error}). ` +
        "The QuickBooks request was NOT sent.",
        { cause: error }
      );
    }
    if (!callbackStarted) {
      throw new Error(
        `This invocation could not acquire the write-recovery owner lock for request_id ${normalized} ` +
        `(${error?.message || error}) and sent no QuickBooks request. Another owner may still be processing that same ` +
        `request_id. Inspect the durable ledger ${writeRecoveryFilePath()} and QuickBooks; do not retry this operation ` +
        "as a new write and do not issue a new request_id.",
        { cause: error }
      );
    }
    throw new Error(
      `The write-recovery owner lock failed for request_id ${normalized} (${error?.message || error}). ` +
      `Inspect the durable ledger ${writeRecoveryFilePath()} and QuickBooks; do not retry this operation as a new write ` +
      "and do not issue a new request_id.",
      { cause: error }
    );
  }
}

const WRITE_ENVELOPE_FIELDS = [
  "company",
  "realmId",
  "environment",
  "method",
  "path",
  "body_sha256",
];

const DEFAULT_RECOVERY_REPLAY_MAX_AGE_MS = 90_000;

export function recoveryReplayMaxAgeMs(raw = process.env.QBO_RECOVERY_REPLAY_MAX_AGE_MS) {
  if (raw == null || String(raw).trim() === "") return DEFAULT_RECOVERY_REPLAY_MAX_AGE_MS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new Error(
      "QBO_RECOVERY_REPLAY_MAX_AGE_MS must be a positive whole number no greater than 2147483647 milliseconds."
    );
  }
  return value;
}

function recoveryRecordIsAmbiguous(record) {
  return record?.kind === "api_write_intent" ||
    record?.outcome === "transport_error" ||
    record?.outcome === "response_body_error" ||
    (record?.outcome === "response" && isAmbiguousHttpStatus(record.status));
}

// Recovery records are stronger than the optional accountability audit. Each
// append is fsynced before it returns, and any failure is raised to the caller.
// For an intent, the caller therefore knows it is still safe not to send.
async function appendRecoveryRecordUnlocked(entry, {
  makeDirectory = mkdir,
  openFile = open,
  platform = process.platform,
} = {}) {
  const file = writeRecoveryFilePath();
  const directory = path.dirname(file);
  const firstCreatedDirectory = await makeDirectory(directory, { recursive: true, mode: 0o700 });
  const fh = await openFile(file, "a", 0o600);
  try {
    const line = Buffer.from(JSON.stringify(entry) + "\n", "utf8");
    await fh.writeFile(line);
    await fh.sync();
  } finally {
    await fh.close();
  }

  // fsyncing the ledger makes its contents durable, but when the ledger (or
  // one of its parent directories) is new, the directory entries can still be
  // lost in a crash. Sync the containing directory after every append so a
  // concurrently-created ledger is covered too, then sync each newly-created
  // ancestor up to the first directory that already existed.
  await fsyncRecoveryDirectoryChain(directory, firstCreatedDirectory, { openFile, platform });
}

async function appendRecoveryRecord(entry, options = {}) {
  // FileHandle.writeFile may require multiple writes internally. O_APPEND
  // protects the file offset but does not promise a whole JSON line is one
  // indivisible cross-platform append, so serialize the complete write+fsync.
  return withWriteRecoveryLock(() => appendRecoveryRecordUnlocked(entry, options));
}

async function fsyncDirectory(directory, {
  openFile = open,
  platform = process.platform,
} = {}) {
  // Windows does not support opening directories through fs.open(). File
  // handles are still fsynced above; NTFS rename/create durability is left to
  // the platform rather than turning every write into an unsupported error.
  if (platform === "win32") return;
  const directoryHandle = await openFile(directory, "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

async function fsyncRecoveryDirectoryChain(directory, firstCreatedDirectory, options = {}) {
  const target = path.resolve(directory);
  await fsyncDirectory(target, options);
  if (!firstCreatedDirectory) return;

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

async function readRecoveryLedgerText() {
  // Use the same lock as appenders. The immutable string can be parsed after
  // release, but readFile itself must finish while no conforming writer can
  // expose a prefix of its next JSONL record.
  return withWriteRecoveryLock(() => readFile(writeRecoveryFilePath(), "utf8"));
}

export async function recordWriteIntent(entry) {
  try {
    await appendRecoveryRecord({
      ...entry,
      kind: "api_write_intent",
      ts: new Date().toISOString(),
    });
  } catch (e) {
    throw new Error(
      `Could not persist the durable write intent (${e.message}). The QuickBooks request was NOT sent.`,
      { cause: e }
    );
  }
}

export async function recordWriteOutcome(entry) {
  try {
    await appendRecoveryRecord({
      ...entry,
      kind: "api_write_outcome",
      ts: new Date().toISOString(),
    });
  } catch (e) {
    throw new Error(`Could not persist the durable write outcome (${e.message}).`, { cause: e });
  }
}

// Return both the original durable intent and the latest durable state for a
// request id. Unlike the optional accountability audit lookup below, this
// fails closed on corruption or an unreadable ledger: either condition could
// hide the evidence needed to decide whether a replay is still safe.
async function findWriteRecoveryStateByRequestId(requestId) {
  if (!requestId) return null;
  let text;
  try {
    text = await readRecoveryLedgerText();
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Error(
      `Cannot read the durable write-recovery ledger (${e.message}); refusing to guess whether request_id ${requestId} is safe to replay.`,
      { cause: e }
    );
  }

  const intents = [];
  let latest = null;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch (e) {
      throw new Error(
        `The durable write-recovery ledger is corrupt at line ${i + 1} (${e.message}); refusing to replay request_id ${requestId}.`,
        { cause: e }
      );
    }
    if (rec.request_id !== requestId || !["api_write_intent", "api_write_outcome"].includes(rec.kind)) continue;
    latest = rec;
    if (rec.kind === "api_write_intent") intents.push(rec);
  }
  if (!intents.length) return null;

  // Replays append another intent using the same binding. Conflicting bindings
  // mean the ledger has been corrupted or an id was reused unsafely; neither is
  // a condition under which another request should leave this process.
  const original = intents[0];
  for (const rec of intents.slice(1)) {
    const conflicts = WRITE_ENVELOPE_FIELDS.filter((field) => rec[field] !== original[field]);
    if (conflicts.length) {
      throw new Error(
        `Durable intents for request_id ${requestId} conflict on ${conflicts.join(", ")}; refusing to replay it.`
      );
    }
  }
  return { intent: original, latest };
}

// Public compatibility helper used by diagnostics and tests. Replay callers
// must use verifyWriteReplay(), which also checks latest outcome and age.
export async function findWriteIntentByRequestId(requestId) {
  return (await findWriteRecoveryStateByRequestId(requestId))?.intent ?? null;
}

// Verify every field that determines where and what Intuit receives. A matching
// body alone is not enough: the same requestid on another realm or endpoint can
// return a plausible old entity while discarding the caller's intended write.
export async function verifyWriteReplay(requestId, envelope, {
  now = Date.now(),
  maxAgeMs = recoveryReplayMaxAgeMs(),
} = {}) {
  const state = await findWriteRecoveryStateByRequestId(requestId);
  const prior = state?.intent;
  if (!prior) {
    throw new Error(
      `request_id ${requestId} has no durable write intent, so its original request cannot be verified. ` +
      "Refusing to send it; use a new request without request_id only if this is genuinely a new posting."
    );
  }
  const differences = WRITE_ENVELOPE_FIELDS.filter((field) => prior[field] !== envelope[field]);
  if (differences.length) {
    const detail = differences
      .map((field) => `${field} was ${JSON.stringify(prior[field])}, now ${JSON.stringify(envelope[field])}`)
      .join("; ");
    throw new Error(
      `request_id ${requestId} is bound to a DIFFERENT durable request envelope (${detail}). ` +
      "Replay it only against the identical company, realm, environment, method, full path, and body."
    );
  }

  if (!recoveryRecordIsAmbiguous(state.latest)) {
    throw new Error(
      `request_id ${requestId} already has a definitive durable outcome ` +
      `(HTTP ${state.latest?.status ?? "unknown"}, ok=${state.latest?.ok ?? "unknown"}). ` +
      "Replaying a resolved id is refused; use the recorded result or create a genuinely new request without request_id."
    );
  }

  const intentAt = Date.parse(prior.ts);
  if (!Number.isFinite(intentAt)) {
    throw new Error(`request_id ${requestId} has no valid durable intent timestamp; refusing to guess whether it is still safe to replay.`);
  }
  const ageMs = Math.max(0, Number(now) - intentAt);
  if (!Number.isSafeInteger(Number(maxAgeMs)) || Number(maxAgeMs) <= 0) {
    throw new Error("The recovery replay age limit must be a positive whole number of milliseconds.");
  }
  if (ageMs > Number(maxAgeMs)) {
    throw new Error(
      `request_id ${requestId} is ${ageMs}ms old, beyond the ${maxAgeMs}ms recovery replay window. ` +
      "Intuit publishes no request-id retention guarantee, so a late replay could duplicate a create after its dedupe record expires. " +
      "Inspect and reconcile the QuickBooks record instead; do not issue a new request_id for the same uncertain write."
    );
  }
  return prior;
}

// Read the recovery ledger into a small operator-facing work queue. A request
// is unresolved when its latest durable state is only an intent, a transport
// or response-body failure, or an HTTP 408/5xx. A later successful replay (or
// another clean 4xx rejection) resolves it. Bodies never enter this ledger; callers
// receive only the exact SHA-256 binding needed to identify the request.
export async function listUnresolvedWrites({ company, limit = 100 } = {}) {
  let text;
  try {
    text = await readRecoveryLedgerText();
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw new Error(`Cannot read the durable write-recovery ledger (${e.message}).`, { cause: e });
  }

  const latest = new Map();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch (e) {
      throw new Error(`The durable write-recovery ledger is corrupt at line ${i + 1} (${e.message}).`, { cause: e });
    }
    if (!rec.request_id || !["api_write_intent", "api_write_outcome"].includes(rec.kind)) continue;
    const state = latest.get(rec.request_id) || { intent: null, last: null };
    if (rec.kind === "api_write_intent") state.intent = rec;
    state.last = rec;
    latest.set(rec.request_id, state);
  }

  const unresolved = [];
  for (const [requestId, state] of latest) {
    const { intent, last } = state;
    if (!intent || (company && intent.company !== company)) continue;
    const ambiguousOutcome = recoveryRecordIsAmbiguous(last);
    if (!ambiguousOutcome) continue;
    const intentAt = Date.parse(intent.original_intent_ts ?? intent.ts);
    const maxAgeMs = recoveryReplayMaxAgeMs();
    const ageMs = Number.isFinite(intentAt) ? Math.max(0, Date.now() - intentAt) : null;
    const replayEligible = ageMs != null && ageMs <= maxAgeMs;
    unresolved.push({
      request_id: requestId,
      company: intent.company,
      realmId: intent.realmId,
      environment: intent.environment,
      tool: intent.tool ?? null,
      method: intent.method,
      path: intent.path,
      body_sha256: intent.body_sha256,
      intent_at: intent.original_intent_ts ?? intent.ts,
      latest_at: last.ts,
      outcome: last.kind === "api_write_intent" ? "no_outcome_recorded" : last.outcome,
      status: last.status ?? null,
      intuit_tid: last.intuit_tid ?? null,
      error: last.error ? String(last.error).slice(0, 500) : null,
      replay_eligible: replayEligible,
      replay_age_ms: ageMs,
      replay_deadline: Number.isFinite(intentAt) ? new Date(intentAt + maxAgeMs).toISOString() : null,
      ...(!replayEligible ? {
        replay_block_reason: ageMs == null
          ? "The original durable intent timestamp is invalid."
          : `The ${maxAgeMs}ms replay window has elapsed; Intuit publishes no request-id retention guarantee.`,
      } : {}),
    });
  }
  return unresolved
    .sort((a, b) => String(b.latest_at).localeCompare(String(a.latest_at)))
    .slice(0, Math.max(1, Math.min(Number(limit) || 100, 500)));
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

// The most recent audit record for a given Intuit requestid, or null.
//
// This is what makes replaying a requestid safe. Measured against a sandbox
// company on 2026-08-06: replaying an id with the SAME body returns the
// original record and creates nothing (good, that is the recovery path), but
// replaying it with a DIFFERENT body also returns the original, with an HTTP
// 200 and a plausible entity, while the new write is silently discarded.
// Comparing body_sha256 against the prior record is the only way to tell those
// apart before sending, and the audit log has recorded that hash all along.
//
// Scans this month and last, newest line first, so a replay near a month
// boundary still finds its original.
export async function findWriteByRequestId(requestId, now = new Date()) {
  if (!requestId || !auditEnabled()) return null;
  const previous = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  for (const month of [now, previous]) {
    let text;
    try { text = await readFile(auditFilePath(month), "utf8"); } catch { continue; }
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      // Cheap substring reject before paying for JSON.parse on every line.
      if (!line || !line.includes(requestId)) continue;
      try {
        const rec = JSON.parse(line);
        if (rec.request_id === requestId) return rec;
      } catch { /* skip a corrupt line rather than failing the write */ }
    }
  }
  return null;
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

// Narrow hooks for deterministic lock and durability tests. Production callers
// use recordWriteIntent/recordWriteOutcome and the public recovery readers.
export const __test = Object.freeze({
  appendRecoveryRecord,
  appendRecoveryRecordUnlocked,
  fsyncRecoveryDirectoryChain,
  readRecoveryLedgerText,
  withWriteRecoveryLock,
  writeRecoveryLockPath,
  writeRecoveryRequestLockPath,
});
