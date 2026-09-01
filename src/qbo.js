// qbo.js — QuickBooks Online OAuth 2.0 handling + authenticated API client.
// All logs go to STDERR (console.error) because STDOUT is the MCP protocol channel.
//
// Multi-company: this connector can talk to any company that has an authorized
// tokens.<slug>.json file. The company is chosen PER CALL via the `company`
// option on qboRequest / qboQuery / getRealmId. QBO_COMPANY, if set, is only the
// fallback default used by the one-time `--connect` flow and by callers that
// pass no slug (backwards compatible with the legacy per-connector setup).

import http from "node:http";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { readFile, readdir, rename, unlink, open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { encryptionEnabled, encryptTokens, decryptTokens, isEncrypted } from "./secure-store.js";
import {
  record as auditRecord,
  summarizeResponse,
  currentToolName,
  currentToolSupportsRecovery,
  recordWriteIntent,
  recordWriteOutcome,
  verifyWriteReplay,
  claimRecoveryRequestId,
  recoveryReplayMaxAgeMs,
  withWriteRecoveryRequestLock,
} from "./audit.js";
import { checkWritePolicy } from "./policy.js";
import { isAmbiguousHttpStatus, isRealCalendarDate, readResponseBuffer, validateRawQboPath } from "./util.js";
import { listAuthorizedCompanies, listAuthorizationIdentities } from "./company-registry.js";
import { withOwnerDirectoryLock } from "./owner-lock.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";
const SCOPE = "com.intuit.quickbooks.accounting";
// Intuit sunset minor versions 1-74 on 2025-08-01; 75 is the supported baseline.
let MINOR_VERSION = "75";

// Network policy for every Intuit call: a hard timeout, plus retries with
// exponential backoff and jitter. 429 (throttled) is normally retried because
// the request was rejected before processing; the refresh-token endpoint opts
// out because Intuit explicitly warns against repeated refresh attempts with
// the same token. 5xx and network errors are retried
// only for idempotent requests, so a write is never blindly re-sent after the
// server may have applied it.
//
// QBO_RETRY_WRITES=true extends those retries to writes. Measured against a
// sandbox company on 2026-08-06: a POST replayed with the same `requestid`
// returns the original record and creates nothing, verified against a control
// proving duplicates are otherwise possible, and the window was still open at
// 90 seconds. Every retry in this loop reuses the same URL, so the requestid
// carries over automatically, and the entire retry sequence is bounded by the
// same conservative replay-age ceiling rather than receiving a fresh timeout
// on each attempt.
//
// It stays OFF by default anyway. The evidence covers one entity type, in
// sandbox, at one point in time; a firm posting to real client books should
// opt in deliberately rather than inherit it.
function configuredTimeoutMs(raw = process.env.QBO_TIMEOUT_MS) {
  if (raw == null || String(raw).trim() === "") return 60_000;
  const value = Number(raw);
  // AbortSignal.timeout validates synchronously. Validate once at module load,
  // before any refresh/disconnect recovery marker can be written, so bad local
  // configuration can never masquerade as an ambiguous network outcome.
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new Error("QBO_TIMEOUT_MS must be a positive whole number no greater than 2147483647 milliseconds.");
  }
  return value;
}

let TIMEOUT_MS = 60_000;
let RESPONSE_MAX_BYTES = 32 * 1024 * 1024;
const MAX_RETRIES = 3;
let RETRY_WRITES = false;

function configuredResponseMaxBytes(raw = process.env.QBO_RESPONSE_MAX_BYTES) {
  if (raw == null || String(raw).trim() === "") return 32 * 1024 * 1024;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new Error("QBO_RESPONSE_MAX_BYTES must be a positive safe integer no greater than 2147483647 bytes.");
  }
  return value;
}

async function readQboResponseText(response, label = "QBO JSON response") {
  const bytes = await readResponseBuffer(response, {
    maxBytes: RESPONSE_MAX_BYTES,
    label,
    capName: "QBO_RESPONSE_MAX_BYTES",
  });
  return bytes.toString("utf8");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function qboFetch(url, init = {}, {
  idempotent = false,
  retryThrottled = true,
  retryDeadlineMs = null,
  now = Date.now,
  wait = sleep,
} = {}) {
  if (typeof now !== "function" || typeof wait !== "function") {
    throw new TypeError("QBO retry timing hooks must be functions.");
  }
  let deadline = retryDeadlineMs == null ? null : Number(retryDeadlineMs);
  if (deadline != null) {
    if (!Number.isSafeInteger(deadline) || deadline <= 0) {
      throw new Error("The QBO retry deadline must be a positive whole-number Unix timestamp in milliseconds.");
    }
  }
  const remainingMs = () => {
    if (deadline == null) return null;
    const current = Number(now());
    if (!Number.isFinite(current)) throw new TypeError("QBO retry clock must return a finite millisecond timestamp.");
    return Math.max(0, deadline - current);
  };
  const canRetryAfter = (delay) => deadline == null || delay < remainingMs();

  for (let attempt = 0; ; attempt++) {
    const backoff = Math.min(1000 * 2 ** attempt, 8000) + Math.floor(Math.random() * 250);
    const remaining = remainingMs();
    if (remaining != null && remaining <= 0) {
      throw new Error(
        "The conservative QBO request-id replay deadline elapsed before another request could be sent. " +
        "No request was sent after that deadline; inspect and reconcile the original ambiguous write in QuickBooks."
      );
    }
    const attemptTimeout = remaining == null
      ? TIMEOUT_MS
      : Math.min(TIMEOUT_MS, remaining);
    let res;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(attemptTimeout) });
    } catch (e) {
      const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
      if (idempotent && attempt < MAX_RETRIES && canRetryAfter(backoff)) {
        await wait(backoff);
        if (deadline == null || remainingMs() > 0) continue;
      }
      throw timedOut ? new Error(`Request timed out after ${attemptTimeout / 1000}s`) : e;
    }
    if (res.status === 429 && retryThrottled && attempt < MAX_RETRIES) {
      const ra = Number(res.headers.get("retry-after"));
      const delay = Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoff;
      if (canRetryAfter(delay)) {
        await wait(delay);
        if (deadline == null || remainingMs() > 0) continue;
      }
    }
    if (res.status >= 500 && idempotent && attempt < MAX_RETRIES) {
      if (canRetryAfter(backoff)) {
        await wait(backoff);
        if (deadline == null || remainingMs() > 0) continue;
      }
    }
    return res;
  }
}

function writeRetryDeadlineMs(priorIntent = null) {
  const maxAgeMs = recoveryReplayMaxAgeMs();
  if (!priorIntent?.ts) return Date.now() + maxAgeMs;
  const originalAt = Date.parse(priorIntent.ts);
  if (!Number.isFinite(originalAt)) return Date.now() + maxAgeMs;
  return originalAt + maxAgeMs;
}

// Retaining a token file without exposing it as a company is a matter of
// WHERE it lives, not what it is called: company discovery reads this
// directory only, so anything parked in backups/ is kept and ignored. That
// rule, and the one-time warning about the former hardcoded "sandbox-backup"
// slug, now live with the scan itself in company-registry.js.

function log(...args) {
  console.error("[qbo]", ...args);
}

// Sanitize any user/env-supplied company slug to a safe filename fragment so it
// can never escape the project directory. Empty string → the legacy tokens.json.
function sanitizeSlug(s) {
  return String(s ?? "").trim().replace(/[^a-zA-Z0-9_-]/g, "");
}

// sanitizeSlug stays lenient on purpose: it is the last line of defence before
// a slug reaches a filename, and something that must never throw there. But
// silently rewriting input is the wrong behaviour at the API boundary, where
// "acme!" quietly becoming "acme" means a typo resolves to a real
// company's books. Anything taking a slug from a person or a model uses this.
function assertSlug(s) {
  const raw = String(s ?? "").trim();
  const clean = sanitizeSlug(raw);
  if (raw !== clean) {
    throw new Error(
      `"${raw}" is not a valid company slug: only letters, numbers, hyphens, and underscores are allowed.` +
      (clean ? ` Did you mean "${clean}"?` : "")
    );
  }
  return clean;
}

// The --connect flow and no-arg callers fall back to this env-configured default.
let DEFAULT_COMPANY = "";

// qbo.js is evaluated as a dependency before index.js executes its dotenv
// setup. Initialize from the process for direct module/CLI use, and let the
// server call this once more immediately after loading .env so module-level
// network/default settings honor that file too.
function configureQboRuntime(env = process.env) {
  MINOR_VERSION = String(env.QBO_MINOR_VERSION || "75");
  TIMEOUT_MS = configuredTimeoutMs(env.QBO_TIMEOUT_MS);
  RESPONSE_MAX_BYTES = configuredResponseMaxBytes(env.QBO_RESPONSE_MAX_BYTES);
  RETRY_WRITES = String(env.QBO_RETRY_WRITES || "").toLowerCase() === "true";
  const recoveryReplayMaxAge = recoveryReplayMaxAgeMs(env.QBO_RECOVERY_REPLAY_MAX_AGE_MS);
  DEFAULT_COMPANY = sanitizeSlug(env.QBO_COMPANY || "");
  return {
    minorVersion: MINOR_VERSION,
    timeoutMs: TIMEOUT_MS,
    responseMaxBytes: RESPONSE_MAX_BYTES,
    retryWrites: RETRY_WRITES,
    recoveryReplayMaxAgeMs: recoveryReplayMaxAge,
    defaultCompany: DEFAULT_COMPANY,
  };
}

configureQboRuntime(process.env);

function tokensPathFor(slug) {
  const clean = sanitizeSlug(slug);
  return path.join(ROOT, clean ? `tokens.${clean}.json` : "tokens.json");
}

// A Playground refresh can return new token state. Keep the freshly returned
// credential in an encrypted, fsynced sidecar until CompanyInfo proves
// that it can read the intended realm. The filename deliberately cannot match
// listCompanies()' tokens.<slug>.json pattern.
function tokenStagePathFor(slug) {
  const clean = sanitizeSlug(slug) || "default";
  return path.join(ROOT, `.qbo-token-stage-${clean}.json`);
}

// Normal refreshes use a separate encrypted recovery journal from Playground
// imports. It is durably created BEFORE the refresh POST: if the process is
// killed after upload, the old canonical refresh token can therefore never be
// mistaken for a safe retry on the next process start.
function refreshRecoveryPathFor(slug) {
  const clean = sanitizeSlug(slug) || "default";
  return path.join(ROOT, `.qbo-refresh-recovery-${clean}.json`);
}

// A partial disconnect also needs a durable, non-credential receipt so a
// successfully revoked first credential is not sent again merely because a
// later credential failed. The contents are encrypted anyway because the
// connector already has a token-storage key and this is authorization state.
function disconnectRecoveryPathFor(slug) {
  const clean = sanitizeSlug(slug) || "default";
  return path.join(ROOT, `.qbo-disconnect-recovery-${clean}.json`);
}

// Credentials + redirect come from the environment. Intuit issues SEPARATE
// development and production keys for the same app, and each pair authenticates
// only against its own environment, so a connector serving both needs both:
//   QBO_CLIENT_ID / QBO_CLIENT_SECRET                  production, and the default
//   QBO_CLIENT_ID_SANDBOX / QBO_CLIENT_SECRET_SANDBOX  used when the company's
//                                                      token file says sandbox
// Pass the target environment so the right pair is picked; with only one pair
// configured this behaves exactly as it did before. The API host is chosen
// separately, per company, in apiBaseFor.
function credentials(environment) {
  const sandbox = String(environment || "").toLowerCase() === "sandbox";
  const {
    QBO_CLIENT_ID,
    QBO_CLIENT_SECRET,
    QBO_CLIENT_ID_SANDBOX,
    QBO_CLIENT_SECRET_SANDBOX,
    QBO_REDIRECT_URI = "http://localhost:3000/callback",
  } = process.env;

  const clientId = (sandbox && QBO_CLIENT_ID_SANDBOX) || QBO_CLIENT_ID;
  const clientSecret = (sandbox && QBO_CLIENT_SECRET_SANDBOX) || QBO_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "Missing QBO_CLIENT_ID / QBO_CLIENT_SECRET. Copy .env.example to .env and fill in your "
      + "Intuit app keys (README Step 5), then run this again."
      + (sandbox
        ? " For sandbox companies you can also set QBO_CLIENT_ID_SANDBOX / QBO_CLIENT_SECRET_SANDBOX to your"
          + " app's development keys; Intuit's production keys do not work against sandbox."
        : "")
    );
  }
  return { clientId, clientSecret, redirectUri: QBO_REDIRECT_URI };
}

// Environment used when authorizing a NEW company (no token file exists yet).
function connectEnvironment() {
  return (process.env.QBO_ENVIRONMENT || "sandbox").toLowerCase() === "production"
    ? "production"
    : "sandbox";
}

function localhostRedirect(creds, flowName) {
  let redirect;
  try {
    redirect = new URL(creds.redirectUri);
  } catch {
    throw new Error(`QBO_REDIRECT_URI is not a valid URL: "${creds.redirectUri}".`);
  }
  if (redirect.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(redirect.hostname.toLowerCase())) {
    throw new Error(
      `${flowName} is sandbox-only and requires an http://localhost (or 127.0.0.1) QBO_REDIRECT_URI. ` +
      `Got "${creds.redirectUri}". Production books must use the Intuit Playground or HTTPS catcher flow.`
    );
  }
  return redirect;
}

// Per-company API host, derived from the token file's stored environment.
function apiBaseFor(environment) {
  return String(environment).toLowerCase() === "production"
    ? "https://quickbooks.api.intuit.com"
    : "https://sandbox-quickbooks.api.intuit.com";
}

function basicAuthHeader({ clientId, clientSecret }) {
  return "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
}

function reconnectCommand(slug, environment, { replaceExisting = false } = {}) {
  const clean = sanitizeSlug(slug);
  if (String(environment || "").toLowerCase() === "production") {
    return `\`npm run connect:playground -- ${clean || "<slug>"}${replaceExisting ? " --replace-existing" : ""}\``;
  }
  const prefix = clean ? `QBO_COMPANY=${clean} ` : "";
  return `\`${prefix}npm run connect${replaceExisting ? " -- --replace-existing" : ""}\``;
}

function quarantinedImportGuidance(slug, environment) {
  const clean = sanitizeSlug(slug);
  const disconnect = clean ? `\`npm run disconnect -- ${clean}\`` : "`npm run disconnect`";
  return (
    `This staged credential cannot be resumed or refreshed safely. Run ${disconnect} first so the connector can revoke ` +
    "and remove the uncertain stored credential, then mint a fresh Playground authorization and reconnect. If Intuit " +
    "cannot confirm revocation, remove the app connection in QuickBooks/Intuit before deleting the named encrypted stage file. " +
    `Do not rerun ${reconnectCommand(slug, environment, { replaceExisting: true })} while the quarantine remains.`
  );
}

function assertSafeTokenReplacement(existing, {
  slug,
  environment,
  realmId,
  replaceExisting = false,
} = {}) {
  if (!existing) return;
  const label = sanitizeSlug(slug) || "(default)";
  if (replaceExisting !== true) {
    throw new Error(
      `Company slug "${label}" is already authorized to realm ${existing.realmId ?? "unknown"} ` +
      `(${existing.environment ?? "unknown environment"}). Refusing to replace it without --replace-existing.`
    );
  }
  if (String(existing.environment || "").toLowerCase() !== String(environment || "").toLowerCase()) {
    throw new Error(
      `Company slug "${label}" is already ${existing.environment ?? "an unknown environment"}, but this flow is ` +
      `${environment}. Refusing to overwrite it; use a new slug for a different environment.`
    );
  }
  if (realmId != null && String(existing.realmId ?? "") !== String(realmId)) {
    throw new Error(
      `Company slug "${label}" is already realm ${existing.realmId ?? "unknown"}, but Intuit returned realm ${realmId}. ` +
      "Refusing to overwrite it; use a new slug for a different company."
    );
  }
}

// Validate freshly exchanged credentials before they can replace a token file.
// This bypasses the on-disk company selector deliberately: the whole point is
// to prove the new access token and returned realm directly.
async function getCompanyInfoWithTokens(tokens) {
  if (!tokens?.access_token || !tokens?.realmId || !tokens?.environment) {
    throw new Error("Fresh authorization is missing its access token, realmId, or environment; no canonical authorization was saved.");
  }
  const requestPath = `/companyinfo/${encodeURIComponent(String(tokens.realmId))}?minorversion=${encodeURIComponent(MINOR_VERSION)}`;
  const res = await qboFetch(`${apiBaseFor(tokens.environment)}/v3/company/${tokens.realmId}${requestPath}`, {
    headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: "application/json" },
  }, { idempotent: true });
  const tid = res.headers.get("intuit_tid") || undefined;
  const text = await readQboResponseText(res, "QBO CompanyInfo response");
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  if (!res.ok || !data.CompanyInfo) {
    const fault = data?.Fault?.Error?.[0];
    const detail = String(fault ? `${fault.Message}${fault.Detail ? `: ${fault.Detail}` : ""}` : text).slice(0, 300);
    throw new Error(
      `Fresh authorization could not verify realm ${tokens.realmId} (HTTP ${res.status}): ${detail || "no CompanyInfo returned"}` +
      `${tid ? ` (intuit_tid: ${tid})` : ""}. No canonical authorization was saved.`
    );
  }
  return data.CompanyInfo;
}

async function loadTokens(slug) {
  let raw;
  try {
    raw = await readFile(tokensPathFor(slug), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Error(`The token file ${tokensPathFor(slug)} exists but cannot be read (${e.message}). Refusing to treat it as disconnected.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `The token file ${tokensPathFor(slug)} is malformed JSON (${e.message}). ` +
      `Refusing to hide or overwrite a potentially recoverable authorization.`
    );
  }
  try {
    if (isEncrypted(parsed)) return await decryptTokens(parsed);
    // Keep reads side-effect free. An older implementation encrypted legacy
    // plaintext here without the slug refresh lock; a stale reader could then
    // overwrite a successor whose refresh token another process had just
    // rotated. The next successful refresh/reauthorization saves this bundle
    // through the locked canonical path and encrypts it safely.
    return parsed;
  } catch (e) {
    // Deliberately not null. Returning null made an undecryptable token file
    // indistinguishable from a company that was never connected, so the error
    // the operator saw said "run npm run connect" when the actual problem was
    // a missing key — and re-authorizing to fix a key problem is the wrong move.
    throw new Error(
      `The token file ${tokensPathFor(slug)} exists but could not be decrypted (${e.message}). That usually means ` +
      `the encryption key changed (different machine, cleared Keychain entry, or a different QBO_TOKEN_KEY), ` +
      `NOT that this company was disconnected. Restore the original key if you can; otherwise re-authorize with ` +
      `${reconnectCommand(slug, parsed?.environment, { replaceExisting: true })}.`
    );
  }
}

async function fsyncTokenDirectory(file, {
  openFile = open,
  platform = process.platform,
} = {}) {
  // FileHandle.sync() above is portable. Directory handles are not supported
  // by Node on Windows, so only that platform skips the metadata flush.
  if (platform === "win32") return;
  const directoryHandle = await openFile(path.dirname(file), "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

async function durableAtomicReplace(file, tmp, contents, {
  openFile = open,
  move = rename,
  remove = unlink,
  platform = process.platform,
} = {}) {
  let tempCreated = false;
  let moved = false;
  try {
    const fh = await openFile(tmp, "wx", 0o600);
    tempCreated = true;
    try {
      await fh.writeFile(contents, { encoding: "utf8" });
      await fh.sync();
    } finally {
      await fh.close();
    }
    await move(tmp, file);
    moved = true;
    await fsyncTokenDirectory(file, { openFile, platform });
  } catch (primaryError) {
    if (tempCreated && !moved) {
      try {
        await remove(tmp);
      } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") {
          throw new AggregateError(
            [primaryError, cleanupError],
            `Token write failed and its temporary file could not be removed (${cleanupError.message}).`
          );
        }
      }
    }
    throw primaryError;
  }
}

async function saveTokens(slug, tokens, { atomicOptions } = {}) {
  const p = tokensPathFor(slug);
  // Credentials are encrypted at rest (realmId/environment stay plaintext for
  // company discovery). Owner-only permissions, written atomically: a temp
  // file with 0600 perms is renamed over the target so concurrent readers
  // never see a torn file.
  const payload = encryptionEnabled() ? await encryptTokens(tokens) : tokens;
  const tmp = `${p}.${process.pid}.${randomUUID()}.tmp`;
  await durableAtomicReplace(p, tmp, JSON.stringify(payload, null, 2), atomicOptions);
  log("Tokens saved to", p);
}

async function saveEncryptedTokenSidecar(p, contents) {
  // Recovery state is always encrypted, even when an operator has explicitly
  // chosen plaintext canonical token files. An interrupted operation may
  // leave bearer credentials behind, so sidecars never store them in clear.
  const payload = await encryptTokens(contents);
  const tmp = `${p}.${process.pid}.${randomUUID()}.tmp`;
  await durableAtomicReplace(p, tmp, JSON.stringify(payload, null, 2));
  return p;
}

async function loadEncryptedTokenSidecar(p, label) {
  let raw;
  try {
    raw = await readFile(p, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Error(`The ${label} ${p} cannot be read (${e.message}); refusing to replace or ignore it.`, { cause: e });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`The ${label} ${p} is malformed (${e.message}); refusing to overwrite recoverable OAuth state.`, { cause: e });
  }
  if (!isEncrypted(parsed)) {
    throw new Error(`The ${label} ${p} is not encrypted; refusing to use or overwrite it.`);
  }
  try {
    return await decryptTokens(parsed);
  } catch (e) {
    throw new Error(`The ${label} ${p} cannot be decrypted (${e.message}); restore the token key before reconnecting.`, { cause: e });
  }
}

async function removeDurableSidecar(p, label) {
  try {
    await unlink(p);
  } catch (e) {
    if (e.code === "ENOENT") return;
    throw new Error(`The ${label} ${p} could not be removed (${e.message}).`, { cause: e });
  }
  await fsyncTokenDirectory(p);
}

async function saveTokenStage(slug, tokens) {
  return saveEncryptedTokenSidecar(tokenStagePathFor(slug), tokens);
}

async function loadTokenStage(slug) {
  return loadEncryptedTokenSidecar(tokenStagePathFor(slug), "staged token file");
}

async function removeTokenStage(slug) {
  return removeDurableSidecar(
    tokenStagePathFor(slug),
    "verified token was saved, but its encrypted staging file"
  );
}

async function saveRefreshRecovery(slug, recovery) {
  return saveEncryptedTokenSidecar(refreshRecoveryPathFor(slug), recovery);
}

async function loadRefreshRecovery(slug) {
  const recovery = await loadEncryptedTokenSidecar(
    refreshRecoveryPathFor(slug),
    "refresh recovery journal"
  );
  if (!recovery) return null;
  if (recovery.refresh_recovery_version !== 1 ||
      recovery.refresh_recovery_kind !== "normal_refresh" ||
      !["prepared", "ambiguous", "successor", "confirmed_rejected"].includes(recovery.refresh_recovery_state) ||
      !recovery.refresh_recovery_id || !recovery.token_bundle?.refresh_token) {
    throw new Error(
      `The refresh recovery journal ${refreshRecoveryPathFor(slug)} has an unsupported or incomplete shape; ` +
      "refusing to ignore it or reuse the canonical refresh token."
    );
  }
  return recovery;
}

async function removeRefreshRecovery(slug) {
  return removeDurableSidecar(refreshRecoveryPathFor(slug), "refresh recovery journal");
}

async function saveDisconnectRecovery(slug, recovery) {
  return saveEncryptedTokenSidecar(disconnectRecoveryPathFor(slug), recovery);
}

async function loadDisconnectRecovery(slug) {
  const recovery = await loadEncryptedTokenSidecar(
    disconnectRecoveryPathFor(slug),
    "disconnect recovery journal"
  );
  if (!recovery) return null;
  if (recovery.disconnect_recovery_version !== 1 ||
      recovery.disconnect_recovery_kind !== "disconnect" ||
      !recovery.credentials || typeof recovery.credentials !== "object") {
    throw new Error(
      `The disconnect recovery journal ${disconnectRecoveryPathFor(slug)} has an unsupported or incomplete shape; ` +
      "refusing to ignore an incomplete authorization removal."
    );
  }
  return recovery;
}

async function removeDisconnectRecovery(slug) {
  return removeDurableSidecar(disconnectRecoveryPathFor(slug), "disconnect recovery journal");
}

// Every authorized company is a tokens.<slug>.json file in THIS directory
// (excluding the legacy default tokens.json). Returns, sorted by slug,
// [{ slug, realmId, environment }] — the source of truth for what this connector
// can reach right now.
//
// The scan itself moved to company-registry.js so policy.js can resolve write
// guardrails by realm without importing this module (which would be circular).
// This stays the name every caller already uses.
const listCompanies = listAuthorizedCompanies;

// Refuse to authorize a realm that is already reachable under a DIFFERENT slug.
// Two names for one set of books make provenance, audit, and guardrails
// ambiguous at once: policy resolution now merges the strictest rule across
// every slug for a realm, but a duplicate still means an operator cannot tell
// which label a posting used. Replacing a slug with its own realm is fine, so
// this only fires on a genuinely new alias.
async function assertRealmNotAlreadyAuthorized(slug, realmId, { replaceExisting = false } = {}) {
  // Fail closed on a missing realm rather than skipping the check. Every caller
  // validates realmId before reaching here, so this is unreachable today, but
  // an early `return` would mean any future path that persists a
  // realm-less credential silently bypasses uniqueness entirely.
  if (realmId == null || String(realmId).trim() === "") {
    throw new Error(
      `Refusing to persist an authorization for "${sanitizeSlug(slug) || "(default)"}" without a QuickBooks realm id: ` +
      "company identity, write provenance, and duplicate detection all key off it."
    );
  }
  const clean = sanitizeSlug(slug);
  const others = (await listAuthorizationIdentities()).filter(
    (c) => String(c.realmId) === String(realmId) && c.slug !== clean
  );
  if (!others.length) return;
  const names = others.map((c) =>
    `${c.slug ? `"${c.slug}"` : "the legacy default"} (${c.environment ?? "unknown environment"})`
  ).join(", ");
  throw new Error(
    `Realm ${realmId} is already authorized as ${names}. Refusing to create a second slug for the same ` +
    `QuickBooks company: duplicate labels make write provenance and audit records ambiguous. ` +
    `Use the existing authorization, or disconnect the old one first with ` +
    `${others[0].slug ? `\`npm run disconnect -- ${others[0].slug}\`` : "`npm run disconnect`"}.` +
    (replaceExisting ? " --replace-existing authorizes replacing a slug, not aliasing a realm." : "")
  );
}

function openBrowser(url) {
  const [command, args] = process.platform === "darwin"
    ? ["open", [url]]
    : process.platform === "win32"
      ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
      : ["xdg-open", [url]];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.once("error", () => log("Could not auto-open your browser. Open this URL manually:\n", url));
  child.unref();
}

// Full first-run authorization: open browser, catch the redirect on localhost:3000,
// exchange the code for tokens, save them to tokens.<DEFAULT_COMPANY>.json.
async function runAuthorizationFlow({ replaceExisting = false } = {}) {
  const environment = connectEnvironment();
  if (environment === "production") {
    throw new Error(
      "npm run connect uses a localhost callback and is sandbox-only. " +
      "For production run `npm run connect:playground -- <slug>` or use the documented HTTPS catcher."
    );
  }
  const creds = credentials(environment);
  const configuredSlug = process.env.QBO_COMPANY || "";
  const slug = configuredSlug ? assertSlug(configuredSlug) : "";
  const existing = await loadTokens(slug);
  assertSafeTokenReplacement(existing, { slug, environment, replaceExisting });
  const state = randomBytes(16).toString("hex");
  const redirect = localhostRedirect(creds, "npm run connect");
  const port = Number(redirect.port || 80);

  const authUrl =
    `${AUTHORIZE_URL}?client_id=${encodeURIComponent(creds.clientId)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent(SCOPE)}` +
    `&redirect_uri=${encodeURIComponent(creds.redirectUri)}` +
    `&state=${state}`;

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, `http://localhost:${port}`);
        if (url.pathname !== redirect.pathname) {
          res.writeHead(404).end("Not found");
          return;
        }
        const code = url.searchParams.get("code");
        const realmId = url.searchParams.get("realmId");
        const returnedState = url.searchParams.get("state");

        if (returnedState !== state) {
          res.writeHead(400).end("State mismatch — possible CSRF. Close this and retry.");
          server.close();
          reject(new Error("OAuth state mismatch"));
          return;
        }
        if (!code || !realmId) {
          res.writeHead(400).end("Missing code or realmId in callback.");
          server.close();
          reject(new Error("Missing code/realmId in callback"));
          return;
        }

        const body = new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: creds.redirectUri,
        });
        const tokenRes = await qboFetch(TOKEN_URL, {
          method: "POST",
          headers: {
            Authorization: basicAuthHeader(creds),
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body,
        }, { idempotent: false });
        const tokenText = await readQboResponseText(tokenRes, "Intuit token-exchange response");
        let data;
        try { data = tokenText ? JSON.parse(tokenText) : {}; }
        catch { throw new Error("Token exchange returned malformed JSON."); }
        if (!tokenRes.ok) {
          res.writeHead(500).end("Token exchange failed. Check the server console.");
          server.close();
          reject(new Error("Token exchange failed: " + JSON.stringify(data).slice(0, 1_000)));
          return;
        }

        const now = Date.now();
        const tokens = {
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          realmId,
          environment,
          expires_at: now + data.expires_in * 1000,
          refresh_expires_at: data.x_refresh_token_expires_in
            ? now + data.x_refresh_token_expires_in * 1000
            : undefined,
        };
        assertSafeTokenReplacement(existing, { slug, environment, realmId, replaceExisting });
        const companyInfo = await getCompanyInfoWithTokens(tokens);
        // Re-read immediately before persistence so another local process
        // cannot quietly create or retarget this slug while OAuth is open.
        const current = await loadTokens(slug);
        assertSafeTokenReplacement(current, { slug, environment, realmId, replaceExisting });
        await persistAuthorization(slug, tokens, { replaceExisting });

        res.writeHead(200, { "Content-Type": "text/html" }).end(
          `<html><body style="font-family:sans-serif;padding:3rem;text-align:center">
             <h2>✅ QuickBooks connected</h2>
             <p>You can close this tab and return to Claude Desktop.</p>
           </body></html>`
        );
        server.close();
        log(
          `Connected to ${companyInfo.CompanyName ?? companyInfo.LegalName ?? `realmId ${realmId}`} ` +
          `(${environment})${slug ? ` as company "${slug}"` : ""}.`
        );
        resolve({ ...tokens, companyInfo });
      } catch (e) {
        try { res.writeHead(500).end("Error"); } catch {}
        server.close();
        reject(e);
      }
    });

    // Loopback only: the callback listener must never be reachable from the LAN.
    server.listen(port, "127.0.0.1", () => {
      log(`Waiting for QBO login on ${creds.redirectUri} ...`);
      log("Opening your browser to authorize QuickBooks.");
      // Always surface the URL, not just on failure — if the auto-open misfires
      // (no default browser, sandboxed shell, etc.) the user still has a link to
      // click. The delimiters make it easy to lift out of the logs.
      log("If it doesn't pop up, open this URL manually:");
      log("AUTHORIZE_URL>>> " + authUrl + " <<<");
      openBrowser(authUrl);
    });
    server.on("error", reject);
  });
}

// ---- interactive authorization (no terminal) --------------------------------
// The CLI flow above blocks until the browser callback lands, which is fine for
// `npm run connect` but wrong for a tool call: a human clicking through Intuit
// takes minutes and a tool must answer in seconds. So the interactive flow is
// split in two. beginAuthorization starts a loopback listener and returns the
// URL immediately; the listener keeps running in this long-lived MCP process
// and parks its result here. authorizationStatus reads that result.
//
// One authorization at a time, because they all want the same callback port.
let pending = null;

function authorizationStatus() {
  if (!pending) return { state: "idle" };
  const { slug, environment, startedAt, expiresAt, result, error } = pending;
  const base = { slug, environment, started_at: new Date(startedAt).toISOString() };
  if (result) return {
    ...base,
    state: "connected",
    realmId: result.realmId,
    company_name: result.companyInfo?.CompanyName ?? null,
    legal_name: result.companyInfo?.LegalName ?? null,
    address_state: result.companyInfo?.CompanyAddr?.CountrySubDivisionCode ?? null,
  };
  if (error) return { ...base, state: "failed", error };
  if (Date.now() > expiresAt) return { ...base, state: "expired" };
  return { ...base, state: "waiting", seconds_remaining: Math.round((expiresAt - Date.now()) / 1000) };
}

function cancelAuthorization() {
  if (!pending) return { state: "idle" };
  const slug = pending.slug;
  try { pending.server?.close(); } catch { /* already closed */ }
  pending = null;
  return { state: "cancelled", slug };
}

// Returns { authorize_url, slug, environment, expires_in_seconds } right away.
// `ttlMs` bounds how long the listener stays open, so an abandoned attempt
// cannot leave a port bound for the life of the process.
async function beginAuthorization({
  company,
  environment,
  openBrowserWindow = true,
  replaceExisting = false,
  ttlMs = 10 * 60_000,
} = {}) {
  const slug = company == null || String(company).trim() === "" ? "" : assertSlug(company);
  const env = (environment || connectEnvironment()).toLowerCase();
  if (env !== "sandbox" && env !== "production") {
    throw new Error(`environment must be "sandbox" or "production", got "${environment}".`);
  }
  if (env === "production") {
    throw new Error(
      "Interactive localhost authorization is sandbox-only. For production use " +
      "`npm run connect:playground -- <slug>` or the documented HTTPS catcher."
    );
  }
  const existing = await loadTokens(slug);
  assertSafeTokenReplacement(existing, { slug, environment: env, replaceExisting });
  const creds = credentials(env); // throws early if .env is missing keys

  const live = authorizationStatus();
  if (live.state === "waiting") {
    throw new Error(
      `An authorization for "${live.slug || "(default)"}" is already waiting (${live.seconds_remaining}s left). ` +
      `Finish it in the browser, or cancel it first.`
    );
  }
  if (pending) cancelAuthorization(); // clear a finished or expired attempt

  const state = randomBytes(16).toString("hex");
  const redirect = localhostRedirect(creds, "Interactive authorization");
  const port = Number(redirect.port || 80);
  const authUrl =
    `${AUTHORIZE_URL}?client_id=${encodeURIComponent(creds.clientId)}` +
    `&response_type=code&scope=${encodeURIComponent(SCOPE)}` +
    `&redirect_uri=${encodeURIComponent(creds.redirectUri)}&state=${state}`;

  const server = http.createServer(async (req, res) => {
    const finish = (code, body) => { try { res.writeHead(code, { "Content-Type": "text/html" }).end(body); } catch {} };
    try {
      const url = new URL(req.url, `http://localhost:${port}`);
      if (url.pathname !== redirect.pathname) return finish(404, "Not found");

      const authCode = url.searchParams.get("code");
      const realmId = url.searchParams.get("realmId");
      if (url.searchParams.get("state") !== state) {
        if (pending) pending.error = "OAuth state mismatch, possible CSRF. Start over.";
        finish(400, "<h2>State mismatch</h2><p>Close this tab and start the authorization again.</p>");
        server.close();
        return;
      }
      if (!authCode || !realmId) {
        if (pending) pending.error = "Callback arrived without a code or realmId.";
        finish(400, "<h2>Incomplete callback</h2><p>Close this tab and start over.</p>");
        server.close();
        return;
      }

      const tokens = await exchangeCodeForTokens(authCode, env);
      tokens.realmId = realmId;
      assertSafeTokenReplacement(existing, {
        slug, environment: env, realmId, replaceExisting,
      });
      const companyInfo = await getCompanyInfoWithTokens(tokens);
      const current = await loadTokens(slug);
      assertSafeTokenReplacement(current, {
        slug, environment: env, realmId, replaceExisting,
      });
      await persistAuthorization(slug, tokens, { replaceExisting });
      if (pending) pending.result = { ...tokens, companyInfo };
      finish(200,
        `<html><body style="font-family:sans-serif;padding:3rem;text-align:center">
           <h2>QuickBooks connected</h2>
           <p>You can close this tab and return to Claude.</p>
         </body></html>`);
      server.close();
      log(
        `Connected ${companyInfo.CompanyName ?? companyInfo.LegalName ?? `realmId ${realmId}`} ` +
        `(${env})${slug ? ` as "${slug}"` : ""} via interactive authorization.`
      );
    } catch (e) {
      if (pending) pending.error = e.message;
      finish(500, "<h2>Authorization failed</h2><p>Return to Claude for the details.</p>");
      server.close();
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", (e) => {
      reject(e.code === "EADDRINUSE"
        ? new Error(`Port ${port} is busy. Another authorization or process holds it; stop that first.`)
        : e);
    });
    server.listen(port, "127.0.0.1", resolve);
  });

  const startedAt = Date.now();
  pending = { slug, environment: env, state, server, startedAt, expiresAt: startedAt + ttlMs, result: null, error: null };
  setTimeout(() => {
    if (pending?.startedAt === startedAt && !pending.result && !pending.error) {
      try { pending.server?.close(); } catch { /* already closed */ }
    }
  }, ttlMs).unref?.();

  if (openBrowserWindow) openBrowser(authUrl);
  return { authorize_url: authUrl, slug, environment: env, expires_in_seconds: Math.round(ttlMs / 1000) };
}

// Decide what a refresh should do, given what is on disk, what the caller
// holds, and whether the caller is IMPORTING a credential.
//
// Normal path (force=false): prefer the newest state on disk. Intuit can return
// a new refresh token (currently periodically rather than on every call), and
// requires clients to retain the latest response, so another caller's persisted
// state takes precedence over a stale in-memory copy.
//
// Import path (force=true): the caller is supplying a refresh token that a
// human just obtained (the OAuth Playground flow). It MUST be exchanged, and
// it MUST be the token used, or the import silently validates nothing and
// stores nothing: with force=false a re-authorization of an existing slug
// would short-circuit to the on-disk tokens and report success for a paste
// that was never checked.
export function chooseRefreshSource(onDisk, existing, force = false, now = Date.now()) {
  if (force) return { use: "existing", reason: "import: exchange the supplied token" };
  if (onDisk && onDisk.access_token !== existing.access_token &&
      now < (onDisk.expires_at ?? 0) - 60_000) {
    return { use: "on-disk-fresh", reason: "a fresher access token is already on disk" };
  }
  return onDisk?.refresh_token
    ? { use: "on-disk", reason: "on-disk refresh token is the newest known" }
    : { use: "existing", reason: "nothing usable on disk" };
}

// Intuit can replace the refresh token in a successful response, so the
// read-decide-exchange-write sequence below has to be atomic.
// The in-flight Map further down only dedupes within ONE process; two processes
// (Claude Desktop alongside Claude Code, or the --access-token broker racing a
// tool call) can each exchange a token the other just invalidated, and the
// company drops offline until someone re-authorizes. An owner-marker lock
// directory is the part that crosses process boundaries.
async function withRefreshLock(slug, fn) {
  const lockPath = path.join(ROOT, `.refresh-${sanitizeSlug(slug) || "default"}.lock`);
  return withOwnerDirectoryLock(lockPath, "token refresh", fn, {
    staleAfterMs: Math.max(5 * 60_000, TIMEOUT_MS * 2 + 30_000),
  });
}

function realmAuthorizationLockPath(realmId) {
  const identity = String(realmId ?? "").trim();
  if (!identity) throw new Error("Cannot lock an authorization without a QuickBooks realm id.");
  // Hash the opaque realm value so an unexpected value can never become a
  // pathname and so lock filenames disclose no company identifier.
  const key = createHash("sha256").update(identity).digest("hex").slice(0, 32);
  return path.join(ROOT, `.realm-authorization-${key}.lock`);
}

async function withRealmAuthorizationLock(realmId, fn) {
  return withOwnerDirectoryLock(realmAuthorizationLockPath(realmId), "realm authorization", fn, {
    staleAfterMs: Math.max(5 * 60_000, TIMEOUT_MS * 2 + 30_000),
  });
}

async function withRealmAuthorizationLocks(realmIds, fn) {
  const ordered = [...new Set(realmIds.map((realmId) => String(realmId ?? "").trim()).filter(Boolean))].sort();
  const acquire = async (position) => {
    if (position >= ordered.length) return fn();
    return withRealmAuthorizationLock(ordered[position], () => acquire(position + 1));
  };
  return acquire(0);
}

function persistedTokenBundleMatches(actual, expected) {
  if (!actual || !expected) return false;
  const normalized = (value) => Object.fromEntries(
    Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => [key, value[key]])
  );
  return JSON.stringify(normalized(actual)) === JSON.stringify(normalized(expected));
}

async function rollbackAuthorizationSave(slug, previous, justWritten) {
  const current = await loadTokens(slug);
  if (!persistedTokenBundleMatches(current, justWritten)) {
    throw new Error(
      `Authorization verification failed for "${sanitizeSlug(slug) || "(default)"}", but its token file changed again ` +
      "before rollback. Refusing to overwrite the newer unknown state; stop other connector processes and inspect it."
    );
  }
  if (previous) {
    await saveTokens(slug, previous);
    return;
  }
  try {
    await unlink(tokensPathFor(slug));
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
  }
  await fsyncTokenDirectory(tokensPathFor(slug));
}

// Commit a freshly authorized credential while the caller already owns the
// slug refresh lock. Lock order is always slug -> realm. Different slugs for
// the same realm can therefore wait on one another without deadlocking, and
// the duplicate check plus atomic save becomes one serialized operation.
async function persistAuthorizationLocked(slug, tokens, { replaceExisting = false } = {}) {
  const clean = sanitizeSlug(slug);
  if (await loadDisconnectRecovery(clean)) {
    throw new Error(
      `Cannot save a new authorization for "${clean || "(default)"}" while its disconnect recovery journal exists. ` +
      `Finish ${clean ? `\`npm run disconnect -- ${clean}\`` : "`npm run disconnect`"} or manually resolve the ` +
      "ambiguous revocation before creating another Intuit grant."
    );
  }
  const realmId = String(tokens?.realmId ?? "").trim();
  const environment = String(tokens?.environment ?? "").toLowerCase();
  if (!realmId || !tokens?.access_token || !tokens?.refresh_token) {
    throw new Error("A canonical QuickBooks authorization requires realmId, access_token, and refresh_token.");
  }
  if (environment !== "sandbox" && environment !== "production") {
    throw new Error(`A canonical QuickBooks authorization has invalid environment "${tokens?.environment ?? ""}".`);
  }

  return withRealmAuthorizationLock(realmId, async () => {
    const previous = await loadTokens(clean);
    assertSafeTokenReplacement(previous, {
      slug: clean,
      environment,
      realmId,
      replaceExisting,
    });
    await assertRealmNotAlreadyAuthorized(clean, realmId, { replaceExisting });
    await saveTokens(clean, tokens);

    try {
      const persisted = await loadTokens(clean);
      if (!persistedTokenBundleMatches(persisted, tokens)) {
        throw new Error("the token file does not contain the credential that was just committed");
      }
      const identities = await listAuthorizationIdentities();
      const self = identities.find((company) => company.slug === clean);
      if (!self || String(self.realmId) !== realmId || String(self.environment ?? "").toLowerCase() !== environment) {
        throw new Error("the company registry does not resolve the committed slug to its expected realm and environment");
      }
      const aliases = identities.filter((company) =>
        String(company.realmId) === realmId && company.slug !== clean
      );
      if (aliases.length) {
        throw new Error(
          `realm ${realmId} also resolves as ${aliases.map((company) => company.slug || "(default)").join(", ")}`
        );
      }
    } catch (verificationError) {
      try {
        await rollbackAuthorizationSave(clean, previous, tokens);
      } catch (rollbackError) {
        throw new AggregateError(
          [verificationError, rollbackError],
          `Authorization save verification failed and rollback was not safe (${rollbackError.message}).`
        );
      }
      throw new Error(
        `Authorization save verification failed (${verificationError.message}); the prior token state was restored.`,
        { cause: verificationError }
      );
    }
    // A complete reauthorization supersedes any prepared/ambiguous normal
    // refresh journal for this slug. Clear it only after the new canonical
    // credential has passed every identity and persistence check above.
    try {
      await removeRefreshRecovery(clean);
    } catch (e) {
      throw new Error(
        `The fresh authorization was saved, but obsolete refresh recovery state could not be removed (${e.message}). ` +
        "Fix the local file permissions before using this company; the connector will continue to fail closed.",
        { cause: e }
      );
    }
    return tokens;
  });
}

async function persistAuthorization(slug, tokens, options = {}) {
  return withRefreshLock(slug, () => persistAuthorizationLocked(slug, tokens, options));
}

async function refreshTokens(slug, existing, { force = false, persist = true } = {}) {
  return withRefreshLock(slug, () => refreshTokensLocked(slug, existing, force, persist));
}

// Narrow fault-injection seam used by durability tests. Production callers use
// refreshTokens above; tests can fail only canonical persistence after the
// real encrypted recovery journal has already been fsynced.
async function refreshTokensWithStorageForTest(slug, existing, storage) {
  return withRefreshLock(slug, () => refreshTokensLocked(slug, existing, false, true, storage));
}

function sameAuthorizationIdentity(a, b) {
  return String(a?.realmId ?? "") === String(b?.realmId ?? "") &&
    String(a?.environment ?? "").toLowerCase() === String(b?.environment ?? "").toLowerCase();
}

function tokenMaterialChanged(a, b) {
  return String(a?.access_token ?? "") !== String(b?.access_token ?? "") ||
    String(a?.refresh_token ?? "") !== String(b?.refresh_token ?? "");
}

function makeRefreshRecovery(tokens, state, {
  id = randomUUID(),
  createdAt = new Date().toISOString(),
  reason,
  predecessor,
} = {}) {
  return {
    realmId: tokens?.realmId,
    environment: tokens?.environment,
    refresh_recovery_version: 1,
    refresh_recovery_kind: "normal_refresh",
    refresh_recovery_state: state,
    refresh_recovery_id: id,
    refresh_recovery_created_at: createdAt,
    refresh_recovery_updated_at: new Date().toISOString(),
    ...(reason ? { refresh_recovery_reason: String(reason).slice(0, 300) } : {}),
    ...(predecessor ? { predecessor_token_bundle: predecessor } : {}),
    token_bundle: tokens,
  };
}

function updateRefreshRecovery(recovery, state, tokens = recovery.token_bundle, reason) {
  return makeRefreshRecovery(tokens, state, {
    id: recovery.refresh_recovery_id,
    createdAt: recovery.refresh_recovery_created_at,
    reason,
    predecessor: recovery.predecessor_token_bundle ?? recovery.token_bundle,
  });
}

function refreshRecoveryOperatorError(slug, recovery, detail) {
  const label = sanitizeSlug(slug) || "the default company";
  const error = new Error(
    `Token refresh is quarantined and recovery is required for ${label}: ${detail} The connector will not reuse the prior refresh token. ` +
    `Re-authorize with ${reconnectCommand(slug, recovery?.environment ?? recovery?.token_bundle?.environment, { replaceExisting: true })}.`
  );
  error.refreshOutcomeQuarantined = true;
  error.refreshRecoveryRequired = true;
  return error;
}

// Called only while the slug refresh lock is held. A successor journal can be
// promoted without contacting Intuit. A prepared/ambiguous journal means a
// process may have uploaded the old refresh token but never durably recorded a
// result, so it must fail closed across every later process.
async function recoverNormalRefreshLocked(slug, { saveCanonical = saveTokens } = {}) {
  const recovery = await loadRefreshRecovery(slug);
  if (!recovery) return null;

  if (recovery.refresh_recovery_state === "confirmed_rejected") {
    await removeRefreshRecovery(slug);
    return null;
  }

  const canonical = await loadTokens(slug);
  const recorded = recovery.token_bundle;
  if (recovery.refresh_recovery_state === "successor") {
    if (!recorded?.access_token || !recorded?.refresh_token ||
        !sameAuthorizationIdentity(recorded, recovery)) {
      throw refreshRecoveryOperatorError(
        slug,
        recovery,
        `The encrypted successor journal ${refreshRecoveryPathFor(slug)} is incomplete or has mismatched identity metadata.`
      );
    }

    if (!persistedTokenBundleMatches(canonical, recorded)) {
      // Preserve the global lock order (slug refresh -> realm authorization)
      // and serialize recovery with every authorization path. Otherwise a
      // vanished canonical file could be recreated under this slug after the
      // same realm was authorized elsewhere.
      await withRealmAuthorizationLock(recorded.realmId, async () => {
        const latest = await loadTokens(slug);
        if (persistedTokenBundleMatches(latest, recorded)) return;

        // A manually replaced authorization is potentially newer than this
        // journal. Never overwrite it merely because an older recovery record
        // is present; an operator must reconcile the two states.
        if (latest && tokenMaterialChanged(latest, recovery.predecessor_token_bundle) &&
            !persistedTokenBundleMatches(latest, recovery.predecessor_token_bundle)) {
          throw refreshRecoveryOperatorError(
            slug,
            recovery,
            `The canonical token changed after successor ${recovery.refresh_recovery_id} was staged; refusing to overwrite the newer unknown state.`
          );
        }
        await assertRealmNotAlreadyAuthorized(slug, recorded.realmId, { replaceExisting: true });
        try {
          await saveCanonical(slug, recorded);
        } catch (e) {
          throw refreshRecoveryOperatorError(
            slug,
            recovery,
            `A confirmed successor is encrypted in ${refreshRecoveryPathFor(slug)}, but canonical promotion failed (${e.message}).`
          );
        }
        const promoted = await loadTokens(slug);
        if (!persistedTokenBundleMatches(promoted, recorded)) {
          throw refreshRecoveryOperatorError(
            slug,
            recovery,
            `Canonical promotion returned without persisting the confirmed successor from ${refreshRecoveryPathFor(slug)}.`
          );
        }
      });
    }
    try {
      await removeRefreshRecovery(slug);
    } catch (e) {
      throw refreshRecoveryOperatorError(
        slug,
        recovery,
        `The confirmed successor is canonical, but its recovery journal could not be removed (${e.message}).`
      );
    }
    return recorded;
  }

  // A fresh, complete, identity-matching canonical credential written by a
  // separate reauthorization is the one safe escape from a prepared or
  // ambiguous attempt. This never replays the attempted token.
  const independentlyReauthorized = canonical &&
    sameAuthorizationIdentity(canonical, recorded) &&
    tokenMaterialChanged(canonical, recorded) &&
    canonical.access_token && canonical.refresh_token &&
    Date.now() < Number(canonical.expires_at ?? 0) - 60_000;
  if (independentlyReauthorized) {
    await removeRefreshRecovery(slug);
    return canonical;
  }

  throw refreshRecoveryOperatorError(
    slug,
    recovery,
    recovery.refresh_recovery_state === "ambiguous"
      ? `A prior token-endpoint result was ambiguous at ${recovery.refresh_recovery_updated_at}.`
      : `A refresh POST was prepared at ${recovery.refresh_recovery_created_at}, but no definitive response was durably recorded.`
  );
}

// A token-endpoint timeout is not replay-safe. Intuit's OAuth FAQ warns that
// multiple/concurrent refresh requests can produce invalid_grant and can
// invalidate the grant; it does not promise that a timed-out refresh POST can
// be repeated. The only safe recovery available locally is to notice that a
// different actor independently persisted a complete, fresh successor while
// this caller was in flight. Never use this escape hatch for a forced
// Playground import: that flow must prove the operator-supplied credential,
// not substitute an unrelated canonical token.
function isFreshCanonicalSuccessor(latest, before, attempted) {
  if (!latest || !sameAuthorizationIdentity(latest, attempted)) return null;
  if (!latest.access_token || !latest.refresh_token) return null;
  if (!tokenMaterialChanged(latest, before)) return null;
  if (Date.now() >= Number(latest.expires_at ?? 0) - 60_000) return null;
  return latest;
}

async function failAmbiguousRefresh(slug, before, attempted, cause, {
  stagedImport = false,
  recovery = null,
} = {}) {
  // Re-read while the caller still owns the cross-process slug lock. A writer
  // outside this module may have completed an independent authorization; only
  // a complete, fresh, identity-matching successor is safe to adopt.
  const latest = await loadTokens(slug);
  const successor = stagedImport ? null : isFreshCanonicalSuccessor(latest, before, attempted);
  if (successor) {
    if (recovery) await removeRefreshRecovery(slug);
    log(
      `Token refresh response was ambiguous, but a different complete fresh credential was already persisted` +
      `${sanitizeSlug(slug) ? ` for "${sanitizeSlug(slug)}"` : ""}; adopting that canonical state without replaying the POST.`
    );
    return successor;
  }

  // Failing only this call is not enough: the next process would load the same
  // possibly-consumed refresh token and try it again. Persist a non-secret
  // quarantine marker inside the encrypted token payload before releasing the
  // lock. A forced import is quarantined in its encrypted staging sidecar so it
  // cannot overwrite a still-working canonical authorization.
  const quarantine = {
    ...(stagedImport ? attempted : (latest && sameAuthorizationIdentity(latest, attempted) ? latest : attempted)),
    refresh_outcome_unknown_at: new Date().toISOString(),
    refresh_outcome_unknown_reason: String(cause?.message ?? cause).slice(0, 300),
  };
  const persistenceFailures = [];
  if (stagedImport) {
    try {
      await saveTokenStage(slug, quarantine);
    } catch (e) {
      // The pre-POST staged marker remains the fail-closed source of truth if
      // replacing it with richer ambiguity details failed.
      persistenceFailures.push(`the Playground quarantine update failed (${e.message})`);
    }
  } else {
    if (recovery) {
      try {
        await saveRefreshRecovery(
          slug,
          updateRefreshRecovery(recovery, "ambiguous", recovery.token_bundle, cause?.message ?? cause)
        );
      } catch (e) {
        // The already-durable prepared journal is intentionally retained.
        persistenceFailures.push(`the refresh recovery detail update failed (${e.message})`);
      }
    }
    if (latest && sameAuthorizationIdentity(latest, attempted)) {
      try {
        await saveTokens(slug, quarantine);
      } catch (e) {
        // This is why the distinct preflight journal exists: even when the
        // canonical file cannot be marked, later processes still cannot reuse
        // the possibly consumed token.
        persistenceFailures.push(`the canonical quarantine update failed (${e.message})`);
      }
    }
  }

  const label = sanitizeSlug(slug) || "the default company";
  const error = new Error(
    `Token refresh for ${label} had an ambiguous outcome (${cause.message}). The refresh POST was not replayed: ` +
    `Intuit does not document timeout replay as safe, and another attempt with the same token can invalidate the grant. ` +
    `${stagedImport
      ? `The uncertain credential is quarantined encrypted in ${tokenStagePathFor(slug)}. ` +
        quarantinedImportGuidance(slug, attempted.environment)
      : `The credential is durably quarantined: encrypted recovery journal ${refreshRecoveryPathFor(slug)} blocks every later refresh attempt. ` +
        `Re-authorize with ${reconnectCommand(slug, attempted.environment, { replaceExisting: true })}.`}` +
    (persistenceFailures.length ? ` Additional local persistence issue: ${persistenceFailures.join("; ")}.` : ""),
    { cause }
  );
  error.refreshOutcomeQuarantined = true;
  error.refreshRecoveryRequired = true;
  throw error;
}

async function prepareRefreshAttempt(slug, current, { stagedImport }) {
  if (stagedImport) {
    const prepared = {
      ...current,
      refresh_outcome_unknown_at: new Date().toISOString(),
      refresh_outcome_unknown_reason:
        "A Playground refresh POST was durably prepared, but no definitive response has been recorded yet.",
    };
    try {
      await saveTokenStage(slug, prepared);
    } catch (e) {
      // The request has not been sent. Do not unlink this path: when resuming
      // an older staged import, a pre-rename failure means the original valid
      // recovery credential is still there. A post-rename sync failure may
      // leave the prepared marker, which safely fails closed on inspection.
      let observed = null;
      let inspectionError = null;
      try { observed = await loadTokenStage(slug); }
      catch (readError) { inspectionError = readError; }
      throw new Error(
        `Could not durably prepare encrypted Playground refresh recovery (${e.message}); no token request was sent.` +
        (observed?.refresh_outcome_unknown_at
          ? " A prepared marker may remain; fix local storage, then discard this false quarantine or reconnect as instructed."
          : inspectionError
            ? ` The prior stage could not be inspected (${inspectionError.message}); fix local storage before retrying.`
            : " The prior encrypted stage remains available for a safe retry."),
        { cause: e }
      );
    }
    return { stagedImport: true, prepared };
  }

  const recovery = makeRefreshRecovery(current, "prepared");
  try {
    await saveRefreshRecovery(slug, recovery);
  } catch (e) {
    // As above, no POST has occurred. Remove any maybe-renamed journal if the
    // directory fsync was the failing step; a leftover journal still fails
    // closed if removal cannot itself be made durable.
    let cleanup = null;
    try { await removeRefreshRecovery(slug); } catch (cleanupError) { cleanup = cleanupError; }
    throw new Error(
      `Could not durably prepare token refresh recovery (${e.message}); no token request was sent.` +
      (cleanup ? ` Its incomplete journal also could not be removed (${cleanup.message}); fix local storage before retrying.` : ""),
      { cause: e }
    );
  }
  return { stagedImport: false, recovery };
}

async function clearRefreshAttemptAfterDefiniteFailure(slug, attempt) {
  if (attempt.stagedImport) {
    await removeTokenStage(slug);
    return;
  }
  // Persisting the definite-rejection state before unlink makes a crash in the
  // cleanup window recoverable without treating the old token as ambiguous.
  const rejected = updateRefreshRecovery(
    attempt.recovery,
    "confirmed_rejected",
    attempt.recovery.token_bundle,
    "The token endpoint returned an explicit non-ambiguous failure."
  );
  await saveRefreshRecovery(slug, rejected);
  await removeRefreshRecovery(slug);
}

async function persistSuccessfulRefresh(slug, tokens, attempt, {
  saveCanonical = saveTokens,
} = {}) {
  if (attempt.stagedImport) {
    try {
      // Replaces the preflight unknown marker with the confirmed successor
      // before returning to CompanyInfo validation/promotion.
      await saveTokenStage(slug, tokens);
    } catch (e) {
      const error = refreshRecoveryOperatorError(
        slug,
        { environment: tokens.environment },
        `Intuit returned a confirmed successor, but its encrypted Playground stage could not be made durable (${e.message}). ` +
        `Do not reuse the supplied refresh token; inspect ${tokenStagePathFor(slug)} and reconnect with a fresh authorization if it still contains the prepared marker.`
      );
      error.cause = e;
      throw error;
    }
    return tokens;
  }

  const successorRecovery = updateRefreshRecovery(
    attempt.recovery,
    "successor",
    tokens,
    "Intuit returned a complete successful token response; canonical promotion is pending."
  );
  try {
    // This fsynced encrypted successor is the point of no return. Canonical
    // persistence cannot begin until the newest refresh token is recoverable.
    await saveRefreshRecovery(slug, successorRecovery);
  } catch (e) {
    throw refreshRecoveryOperatorError(
      slug,
      attempt.recovery,
      `Intuit returned a confirmed successor, but updating ${refreshRecoveryPathFor(slug)} failed (${e.message}). ` +
      "The earlier prepared journal remains fail-closed; do not reuse the prior refresh token."
    );
  }

  try {
    await saveCanonical(slug, tokens);
  } catch (e) {
    const error = refreshRecoveryOperatorError(
      slug,
      successorRecovery,
      `The confirmed successor is encrypted in ${refreshRecoveryPathFor(slug)}, but canonical token persistence failed (${e.message}). ` +
      "A later process will retry only the local promotion, never the refresh POST."
    );
    error.cause = e;
    throw error;
  }
  const canonical = await loadTokens(slug);
  if (!persistedTokenBundleMatches(canonical, tokens)) {
    throw refreshRecoveryOperatorError(
      slug,
      successorRecovery,
      `Canonical token verification failed after saving; the confirmed successor remains in ${refreshRecoveryPathFor(slug)}.`
    );
  }
  try {
    await removeRefreshRecovery(slug);
  } catch (e) {
    const error = refreshRecoveryOperatorError(
      slug,
      successorRecovery,
      `The confirmed successor is canonical, but success-path recovery cleanup failed (${e.message}).`
    );
    error.cause = e;
    throw error;
  }
  return tokens;
}

async function refreshTokensLocked(slug, existing, force, persist, storage = {}) {
  if (await loadDisconnectRecovery(slug)) {
    throw new Error(
      `Refusing to refresh ${sanitizeSlug(slug) || "the default company"} while a disconnect is incomplete. ` +
      `Retry ${sanitizeSlug(slug) ? `\`npm run disconnect -- ${sanitizeSlug(slug)}\`` : "`npm run disconnect`"}.`
    );
  }
  const stagedImport = force && !persist;
  if (!persist && !stagedImport) {
    throw new Error(
      "A normal refresh cannot disable persistence: a successful Intuit response must be durably stored before the call returns."
    );
  }

  // Resolve a journal left by an earlier process before even considering the
  // caller's stale in-memory token. This may promote a confirmed successor or
  // fail closed on an upload whose outcome was never recorded.
  if (persist) await recoverNormalRefreshLocked(slug, storage);

  // Re-read INSIDE the lock: whoever held it before us may have persisted a
  // newer token response, which must take precedence over our in-memory copy.
  const onDisk = await loadTokens(slug);
  const choice = chooseRefreshSource(onDisk, existing, force);
  if (choice.use === "on-disk-fresh") return onDisk;
  const current = choice.use === "on-disk" ? onDisk : existing;

  if (current?.refresh_outcome_unknown_at) {
    const label = sanitizeSlug(slug) || "the default company";
    const error = new Error(
      `Token refresh is quarantined for ${label} because a prior refresh response was lost at ` +
      `${current.refresh_outcome_unknown_at}. Reusing that token could invalidate the Intuit grant. ` +
      `${stagedImport
        ? quarantinedImportGuidance(slug, current.environment)
        : `Re-authorize with ${reconnectCommand(slug, current.environment, { replaceExisting: true })}.`}`
    );
    error.refreshOutcomeQuarantined = true;
    throw error;
  }

  const creds = credentials(current.environment);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: current.refresh_token,
  });
  // This durable marker must precede the first byte sent to Intuit. If the
  // process dies anywhere after this point, the next process will recover or
  // refuse; it will never replay `current.refresh_token` blindly.
  const attempt = await prepareRefreshAttempt(slug, current, { stagedImport });
  let res;
  try {
    res = await qboFetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: basicAuthHeader(creds),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
    }, { idempotent: false, retryThrottled: false });
  } catch (e) {
    return failAmbiguousRefresh(slug, onDisk, current, e, {
      stagedImport,
      recovery: attempt.recovery,
    });
  }

  let responseText;
  try {
    responseText = await readQboResponseText(res, "Intuit token-refresh response");
  } catch (e) {
    if (res.ok || isAmbiguousHttpStatus(res.status)) {
      return failAmbiguousRefresh(
        slug,
        onDisk,
        current,
        new Error(`Intuit returned HTTP ${res.status}, but its token response could not be read (${e.message})`, { cause: e }),
        { stagedImport, recovery: attempt.recovery }
      );
    }
    try {
      await clearRefreshAttemptAfterDefiniteFailure(slug, attempt);
    } catch (cleanupError) {
      const error = new Error(
        `Token refresh received definite HTTP ${res.status}, but its encrypted recovery marker could not be cleared ` +
        `(${cleanupError.message}). No refresh POST will be replayed until local recovery succeeds.`,
        { cause: cleanupError }
      );
      error.refreshOutcomeQuarantined = true;
      error.refreshRecoveryRequired = true;
      throw error;
    }
    throw new Error(`Token refresh failed with HTTP ${res.status}, and its error response could not be read (${e.message}).`, { cause: e });
  }
  let data;
  try {
    data = responseText ? JSON.parse(responseText) : {};
  } catch (e) {
    if (res.ok) {
      return failAmbiguousRefresh(
        slug,
        onDisk,
        current,
        new Error(`Intuit returned HTTP ${res.status} with a malformed token response`, { cause: e }),
        { stagedImport, recovery: attempt.recovery }
      );
    }
    data = { error: responseText.slice(0, 500) };
  }
  if (isAmbiguousHttpStatus(res.status)) {
    const detail = data?.error_description || data?.error || data?.message;
    return failAmbiguousRefresh(
      slug,
      onDisk,
      current,
      new Error(
        `Intuit returned ambiguous HTTP ${res.status} from the token endpoint` +
        (detail ? ` (${String(detail).slice(0, 200)})` : "")
      ),
      { stagedImport, recovery: attempt.recovery }
    );
  }
  if (!res.ok) {
    try {
      await clearRefreshAttemptAfterDefiniteFailure(slug, attempt);
    } catch (cleanupError) {
      const error = new Error(
        `Token refresh received definite HTTP ${res.status}, but its encrypted recovery marker could not be cleared ` +
        `(${cleanupError.message}). No refresh POST will be replayed until local recovery succeeds.`,
        { cause: cleanupError }
      );
      error.refreshOutcomeQuarantined = true;
      error.refreshRecoveryRequired = true;
      throw error;
    }
    const label = sanitizeSlug(slug) || "the default company";
    const failureDetail = String(JSON.stringify(data) ?? "{}").slice(0, 1_000);
    if (res.status === 429) {
      throw new Error(
        `Token refresh failed for ${label}: ${failureDetail}. Intuit throttled the request; the connector did not ` +
        "replay the refresh POST. Wait before trying again. Reauthorization is not required solely because of this 429."
      );
    }
    const reconnect = reconnectCommand(slug, current.environment, { replaceExisting: true });
    throw new Error(
      `Token refresh failed for ${label}: ${failureDetail}. Re-authorize with ${reconnect}.`
    );
  }
  if (!data?.access_token || !data?.refresh_token || !Number.isFinite(Number(data.expires_in))) {
    return failAmbiguousRefresh(
      slug,
      onDisk,
      current,
      new Error("Intuit returned HTTP 200 without a complete access token, refresh token, and expiry"),
      { stagedImport, recovery: attempt.recovery }
    );
  }
  const now = Date.now();
  const tokens = {
    ...current,
    access_token: data.access_token,
    // Every successful response must replace stored state with the latest
    // refresh token Intuit returned, whether or not its value changed.
    refresh_token: data.refresh_token || current.refresh_token,
    expires_at: now + data.expires_in * 1000,
    // Carry the prior expiry forward when Intuit omits the field. For a newly
    // imported credential with no prior value, leave it unknown rather than
    // inventing a lifetime that Intuit may change.
    refresh_expires_at: data.x_refresh_token_expires_in
      ? now + data.x_refresh_token_expires_in * 1000
      : (Number.isFinite(current.refresh_expires_at)
          ? current.refresh_expires_at
          : undefined),
  };
  await persistSuccessfulRefresh(slug, tokens, attempt, storage);
  if (persist) {
    log(`Access token refreshed${sanitizeSlug(slug) ? ` for "${sanitizeSlug(slug)}"` : ""}.`);
  }
  return tokens;
}

async function validateAndPromoteStagedTokens(slug, tokens, validate, { replaceExisting = false } = {}) {
  if (typeof validate !== "function") {
    throw new Error("A staged OAuth import requires a validation callback before it can replace a company authorization.");
  }
  const validation = await validate(tokens);
  await persistAuthorizationLocked(slug, tokens, { replaceExisting });
  await removeTokenStage(slug);
  return { tokens, validation };
}

// Resume a Playground import whose refresh succeeded but was interrupted
// before CompanyInfo verification or canonical persistence. The same
// cross-process refresh lock covers optional re-refresh, validation, promotion,
// and deletion of the recovery sidecar.
async function recoverStagedTokenImport(slug, { validate, replaceExisting = false } = {}) {
  return withRefreshLock(slug, async () => {
    let tokens = await loadTokenStage(slug);
    if (!tokens) return null;
    try {
      if (tokens.refresh_outcome_unknown_at) {
        const error = new Error(
          `The staged token import for "${sanitizeSlug(slug) || "(default)"}" is quarantined because a prior refresh ` +
          `response was lost at ${tokens.refresh_outcome_unknown_at}. A fresh-looking access-token expiry does not prove ` +
          `which refresh token Intuit accepted. ${quarantinedImportGuidance(slug, tokens.environment)}`
        );
        error.refreshOutcomeQuarantined = true;
        throw error;
      }
      if (!tokens.access_token || Date.now() > Number(tokens.expires_at ?? 0) - 60_000) {
        tokens = await refreshTokensLocked(slug, tokens, true, false);
      }
      return await validateAndPromoteStagedTokens(slug, tokens, validate, { replaceExisting });
    } catch (e) {
      if (e?.refreshOutcomeQuarantined === true) {
        const wrapped = new Error(e.message, { cause: e });
        wrapped.refreshOutcomeQuarantined = true;
        throw wrapped;
      }
      throw new Error(
        `${e.message} The fresh credential remains encrypted in ${tokenStagePathFor(slug)}. ` +
        "Fix the verification problem and rerun the same Playground command to resume it; do not mint another token yet.",
        { cause: e }
      );
    }
  });
}

// Exchange an operator-supplied Playground refresh token without creating a
// crash window. Rotation, encrypted durable staging, realm verification, and
// canonical promotion all happen while one owner-aware slug lock is held.
async function importRefreshToken(slug, seedTokens, { validate, replaceExisting = false } = {}) {
  return withRefreshLock(slug, async () => {
    const priorStage = await loadTokenStage(slug);
    if (priorStage) {
      if (priorStage.refresh_outcome_unknown_at) {
        const error = new Error(
          `The staged token import for "${sanitizeSlug(slug) || "(default)"}" is quarantined because a refresh POST ` +
          `was prepared but no definitive response was durably recorded at ${priorStage.refresh_outcome_unknown_at}. ` +
          quarantinedImportGuidance(slug, priorStage.environment)
        );
        error.refreshOutcomeQuarantined = true;
        throw error;
      }
      throw new Error(
        `An interrupted OAuth import is already staged for "${sanitizeSlug(slug) || "default"}". ` +
        "Rerun the Playground command so it can resume that encrypted credential before minting another one."
      );
    }
    let tokens;
    let stageWritten = false;
    try {
      tokens = await refreshTokensLocked(slug, seedTokens, true, false);
      // refreshTokensLocked has already replaced the pre-POST unknown marker
      // with this confirmed successor and fsynced it.
      stageWritten = true;
      return await validateAndPromoteStagedTokens(slug, tokens, validate, { replaceExisting });
    } catch (e) {
      const quarantined = e?.refreshOutcomeQuarantined === true;
      if (quarantined) {
        const wrapped = new Error(e.message, { cause: e });
        wrapped.refreshOutcomeQuarantined = true;
        throw wrapped;
      }
      throw new Error(
        `${e.message}` + (stageWritten
          ? ` The fresh or quarantined credential remains encrypted in ${tokenStagePathFor(slug)}. ` +
            "Fix the verification problem and rerun the same Playground command to resume it; do not mint another token yet."
          : /no token request was sent/i.test(e?.message || "")
            ? " Fix local token storage and retry the same Playground credential; the token endpoint was not contacted."
            : " Nothing was persisted; mint a fresh Playground token before retrying."),
        { cause: e }
      );
    }
  });
}

// In-flight refresh per company, so concurrent tool calls share one refresh
// instead of issuing unsafe overlapping requests with the same token.
const refreshInFlight = new Map();

function refreshTokensOnce(slug, tokens) {
  const key = sanitizeSlug(slug) || "__default__";
  if (!refreshInFlight.has(key)) {
    refreshInFlight.set(
      key,
      refreshTokens(slug, tokens).finally(() => refreshInFlight.delete(key))
    );
  }
  return refreshInFlight.get(key);
}

// Returns valid tokens for a company, refreshing or (on --connect) launching the
// browser flow as needed. `slug` selects the tokens.<slug>.json file; empty →
// the legacy tokens.json.
async function getValidTokens(slug, { allowInteractive = false } = {}) {
  const label = sanitizeSlug(slug) || "the default company";

  const incompleteDisconnect = await loadDisconnectRecovery(slug);
  if (incompleteDisconnect) {
    throw new Error(
      `Authorization removal is incomplete for ${label}. The connector will not use or refresh credentials while ` +
      `disconnect recovery state exists. Retry ${sanitizeSlug(slug) ? `\`npm run disconnect -- ${sanitizeSlug(slug)}\`` : "`npm run disconnect`"}; ` +
      "confirmed revocations will not be sent again."
    );
  }

  // Recovery precedes every canonical expiry/not-connected decision. A
  // confirmed successor may be newer than an expired (or vanished) canonical
  // file, while a prepared journal must block even a still-valid old access
  // token from hiding unsafe refresh state until later.
  let tokens;
  if (await loadRefreshRecovery(slug)) {
    tokens = await withRefreshLock(slug, async () => {
      const recovered = await recoverNormalRefreshLocked(slug);
      return recovered ?? await loadTokens(slug);
    });
  } else {
    tokens = await loadTokens(slug);
  }

  if (!tokens) {
    const reconnect = reconnectCommand(slug, connectEnvironment());
    if (!allowInteractive) {
      throw new Error(
        `Not connected to QuickBooks for ${label}. Run ${reconnect} once to authorize.`
      );
    }
    return runAuthorizationFlow();
  }

  if (tokens.refresh_outcome_unknown_at) {
    const error = new Error(
      `Token refresh is quarantined for ${label} because a prior refresh outcome was lost at ` +
      `${tokens.refresh_outcome_unknown_at}. The connector will not use or refresh this credential. ` +
      `Re-authorize with ${reconnectCommand(slug, tokens.environment, { replaceExisting: true })}.`
    );
    error.refreshOutcomeQuarantined = true;
    throw error;
  }

  const now = Date.now();
  if (tokens.refresh_expires_at && now > tokens.refresh_expires_at) {
    const reconnect = reconnectCommand(slug, tokens.environment, { replaceExisting: true });
    if (!allowInteractive) {
      throw new Error(
        `Refresh token expired for ${label}. Re-authorize with ${reconnect}.`
      );
    }
    return runAuthorizationFlow({ replaceExisting: true });
  }

  // Refresh if the access token expires within 60 seconds.
  if (now > tokens.expires_at - 60_000) {
    tokens = await refreshTokensOnce(slug, tokens);
  }
  return tokens;
}

// Core authenticated request to the QBO API. `pathAndQuery` is everything after
// /v3/company/{realmId}, e.g. "/reports/ProfitAndLoss?start_date=...". The
// `company` option selects which company's tokens (and thus realmId + API host)
// to use; omit it to use DEFAULT_COMPANY.
function recoveryGuidance(requestId, noun = "write") {
  if (currentToolSupportsRecovery()) {
    return `To re-send it safely, call the same single-request tool with request_id ${requestId} and identical arguments; ` +
      "the connector will refuse any envelope mismatch.";
  }
  return `The originating ${noun} is a composite workflow and deliberately does not accept a generic request_id replay. ` +
    `Use list_unresolved_writes and inspect QuickBooks for request_id ${requestId}; reconcile or resume with a dedicated ` +
    "single-record tool instead of rerunning the whole workflow.";
}

// QBO supplies its server's current date when many posting transaction creates
// omit TxnDate, but Intuit does not document the timezone behind that date. A
// local floor therefore cannot safely guess it. Keep this list deliberately
// limited to entities that affect the books: estimates, purchase orders, time
// activities, and change orders are non-posting and must not inherit this gate.
const POSTING_CREATE_ENTITIES = new Set([
  "invoice",
  "salesreceipt",
  "refundreceipt",
  "creditmemo",
  "payment",
  "bill",
  "billpayment",
  "vendorcredit",
  "purchase",
  "deposit",
  "transfer",
  "journalentry",
  "inventoryadjustment",
  "creditcardpayment",
]);

function postingCreatesWithoutValidTxnDate(pathAndQuery, method, body) {
  if (String(method).toUpperCase() !== "POST") return [];

  const [rawPathname, rawQuery = ""] = String(pathAndQuery).split("?", 2);
  const pathname = decodeURIComponent(rawPathname);
  const segments = pathname.split("/").filter(Boolean);

  if (segments.length === 1 && segments[0].toLowerCase() === "batch" && Array.isArray(body?.BatchItemRequest)) {
    const missing = [];
    for (const item of body.BatchItemRequest) {
      if (!item || typeof item !== "object" || String(item.operation || "").toLowerCase() !== "create") continue;
      const entityKey = Object.keys(item).find((key) => POSTING_CREATE_ENTITIES.has(key.toLowerCase()));
      const entityBody = entityKey ? item[entityKey] : null;
      if (entityKey && entityBody && typeof entityBody === "object" && entityBody.Id == null && !isRealCalendarDate(entityBody.TxnDate)) {
        missing.push(entityKey);
      }
    }
    return missing;
  }

  if (segments.length !== 1 || !POSTING_CREATE_ENTITIES.has(segments[0].toLowerCase())) return [];
  const operation = new URLSearchParams(rawQuery).get("operation")?.toLowerCase();
  if ((operation && operation !== "create") ||
      (body && typeof body === "object" && (body.Id != null || isRealCalendarDate(body.TxnDate)))) return [];
  return [segments[0]];
}

async function qboRequest(pathAndQuery, { method = "GET", body, company, requestId: requestIdOverride } = {}) {
  pathAndQuery = validateRawQboPath(pathAndQuery);
  const normalizedMethod = String(method || "GET").toUpperCase();
  const isWrite = normalizedMethod !== "GET";
  const companySlug = sanitizeSlug(company ?? DEFAULT_COMPANY);
  const companyLabel = companySlug || "(default)";

  // Central policy gate: every write, from any tool, passes through here.
  if (isWrite) {
    await checkWritePolicy(companySlug, body ?? null, {
      postingCreatesWithoutValidTxnDate: postingCreatesWithoutValidTxnDate(pathAndQuery, normalizedMethod, body),
    });
  }
  const tokens = await getValidTokens(company ?? DEFAULT_COMPANY);
  const apiBase = apiBaseFor(tokens.environment);
  const sep = pathAndQuery.includes("?") ? "&" : "?";
  // Intuit's idempotency key, on every write. Without it a timed-out or
  // interrupted write is ambiguous: the caller cannot tell "never applied" from
  // "applied, response lost", and the natural response (retry) posts the
  // transaction twice. Replaying the SAME requestid returns the original
  // outcome instead, confirmed by measurement (see qboFetch above). It goes
  // into the audit record and into the error text so a deliberate retry can
  // reuse it.
  const recoveredRequestId = isWrite ? claimRecoveryRequestId(requestIdOverride) : null;
  const hasRequestIdOverride = recoveredRequestId != null;
  let requestId;
  if (isWrite) {
    requestId = hasRequestIdOverride ? recoveredRequestId : randomUUID();
    if (!requestId) {
      throw new Error("request_id cannot be empty. Omit it for a new write, or pass the id from an ambiguous-write error.");
    }
  }

  // Serialize once: this exact byte sequence is both hashed and sent. The full
  // SHA-256 (rather than the former 64-bit prefix) is the durable binding used
  // to decide whether a replay is the same write.
  const serializedBody = body ? JSON.stringify(body) : undefined;
  const bodyHash = isWrite
    ? createHash("sha256").update(serializedBody ?? "").digest("hex")
    : undefined;
  const requestPath =
    `${pathAndQuery}${sep}minorversion=${encodeURIComponent(MINOR_VERSION)}` +
    (requestId ? `&requestid=${encodeURIComponent(requestId)}` : "");
  const url = `${apiBase}/v3/company/${tokens.realmId}${requestPath}`;

  const envelope = isWrite ? {
    request_id: requestId,
    company: companyLabel,
    realmId: String(tokens.realmId),
    environment: String(tokens.environment ?? ""),
    method: normalizedMethod,
    path: requestPath,
    body_sha256: bodyHash,
  } : null;

  const executeWithRecoveryScope = async () => {

  // An override is recovery, never a caller-selected id for a new posting. It
  // must match the complete durable envelope; an absent, unreadable, corrupt,
  // or partial record is a refusal, not permission to guess.
  let priorIntent;
  if (hasRequestIdOverride) {
    priorIntent = await verifyWriteReplay(requestId, envelope);
  }

  // This is the commit point on our side. It is deliberately before fetch: if
  // it cannot be fsynced, recordWriteIntent throws and no QBO write is sent.
  if (isWrite) {
    await recordWriteIntent({
      ...envelope,
      tool: currentToolName(),
      replay: hasRequestIdOverride,
      ...(priorIntent?.ts ? { original_intent_ts: priorIntent.ts } : {}),
    });
  }

  let res;
  try {
    res = await qboFetch(url, {
      method: normalizedMethod,
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        Accept: "application/json",
        ...(serializedBody ? { "Content-Type": "application/json" } : {}),
      },
      body: serializedBody,
    }, {
      idempotent: !isWrite || RETRY_WRITES,
      retryThrottled: !isWrite || RETRY_WRITES,
      ...(isWrite && (RETRY_WRITES || hasRequestIdOverride)
        ? { retryDeadlineMs: writeRetryDeadlineMs(priorIntent) }
        : {}),
    });
  } catch (e) {
    let outcomeError;
    if (isWrite) {
      try {
        await recordWriteOutcome({
          ...envelope,
          tool: currentToolName(),
          outcome: "transport_error",
          status: null,
          ok: null,
          error: String(e?.message ?? e).slice(0, 500),
        });
      } catch (ledgerError) {
        outcomeError = ledgerError;
      }
    }
    // The ambiguous case, and the reason request_id exists: the write may or
    // may not have landed. The id is useless to the operator unless it reaches
    // them, and this error is the only place they will see it.
    if (requestId) {
      throw new Error(
        `${e.message}. This write may or may not have been applied. Check QuickBooks first. ` +
        recoveryGuidance(requestId) +
        (outcomeError ? ` The durable intent exists, but recording the transport outcome also failed: ${outcomeError.message}` : ""),
        { cause: e }
      );
    }
    throw e;
  }

  // intuit_tid is Intuit's per-request trace id; it goes into errors and both
  // ledgers because Intuit support asks for it.
  const tid = res.headers.get("intuit_tid") || undefined;
  let text;
  try {
    text = await readQboResponseText(res);
  } catch (e) {
    let outcomeError;
    if (isWrite) {
      try {
        await recordWriteOutcome({
          ...envelope,
          tool: currentToolName(),
          outcome: "response_body_error",
          status: res.status,
          ok: res.ok,
          intuit_tid: tid,
          error: String(e?.message ?? e).slice(0, 500),
        });
      } catch (ledgerError) {
        outcomeError = ledgerError;
      }
    }
    if (requestId) {
      throw new Error(
        `QBO returned HTTP ${res.status}, but its response body could not be read (${e.message}). ` +
        `This write may or may not have been applied. Check QuickBooks first. ${recoveryGuidance(requestId)}` +
        (outcomeError ? ` The durable intent exists, but recording this outcome also failed: ${outcomeError.message}` : ""),
        { cause: e }
      );
    }
    throw e;
  }
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

  const fault = data?.Fault?.Error?.[0];
  const detail = String(fault
    ? `${fault.Message}${fault.Detail ? ": " + fault.Detail : ""}`
    : text).slice(0, 2_000);

  if (isWrite) {
    try {
      await recordWriteOutcome({
        ...envelope,
        tool: currentToolName(),
        outcome: "response",
        status: res.status,
        ok: res.ok,
        intuit_tid: tid,
        ...(res.ok ? summarizeResponse(data) : { error: String(detail).slice(0, 500) }),
      });
    } catch (e) {
      throw new Error(
        `QBO returned HTTP ${res.status} for request_id ${requestId}, but its durable outcome could not be recorded ` +
        `(${e.message}). The durable intent remains; do not issue a new request_id. Fix the recovery-ledger path, ` +
        `then inspect QuickBooks. ${recoveryGuidance(requestId)}`,
        { cause: e }
      );
    }

    // Keep the established human-facing monthly audit in addition to the
    // mandatory recovery ledger. QBO_AUDIT=off still disables this record.
    await auditRecord({
      kind: "api_write",
      tool: currentToolName(),
      method: normalizedMethod,
      path: pathAndQuery.split("?")[0],
      request_path: requestPath,
      company: companyLabel,
      realmId: tokens.realmId,
      environment: tokens.environment,
      status: res.status,
      ok: res.ok,
      intuit_tid: tid,
      request_id: requestId,
      body_sha256: bodyHash,
      ...(res.ok ? summarizeResponse(data) : { error: String(detail).slice(0, 500) }),
    });
  }

  if (!res.ok) {
    throw new Error(
      `QBO API ${res.status} on ${normalizedMethod} ${pathAndQuery}: ${detail}${tid ? ` (intuit_tid: ${tid})` : ""}` +
      // HTTP 408 and 5xx are ambiguous: Intuit or a proxy may have accepted the
      // write before failing to answer. Other 4xx responses are clean rejections.
      (requestId && isAmbiguousHttpStatus(res.status)
        ? ` (${recoveryGuidance(requestId)})`
        : "")
    );
  }
  return data;
  };

  // Own the request id before its durable intent becomes visible and keep that
  // ownership through the terminal/ambiguous outcome record. A concurrent
  // replay of an in-flight original therefore waits, re-verifies the outcome,
  // and cannot send merely because it observed the intermediate intent.
  return isWrite
    ? withWriteRecoveryRequestLock(requestId, executeWithRecoveryScope)
    : executeWithRecoveryScope();
}

async function qboQuery(sql, { company } = {}) {
  const data = await qboRequest(`/query?query=${encodeURIComponent(sql)}`, { company });
  return data.QueryResponse || {};
}

// Binary GET (invoice/estimate PDFs). Returns a Buffer, capped so a runaway
// response cannot balloon memory (override with QBO_PDF_MAX_BYTES).
async function qboRequestBinary(pathAndQuery, { company, accept = "application/pdf" } = {}) {
  const tokens = await getValidTokens(company ?? DEFAULT_COMPANY);
  const apiBase = apiBaseFor(tokens.environment);
  const sep = pathAndQuery.includes("?") ? "&" : "?";
  const url = `${apiBase}/v3/company/${tokens.realmId}${pathAndQuery}${sep}minorversion=${MINOR_VERSION}`;
  const res = await qboFetch(url, {
    headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: accept },
  }, { idempotent: true });
  const tid = res.headers.get("intuit_tid") || undefined;
  const buf = await readResponseBuffer(res, {
    maxBytes: process.env.QBO_PDF_MAX_BYTES ?? 50 * 1024 * 1024,
    label: `QBO binary response (HTTP ${res.status})`,
    capName: "QBO_PDF_MAX_BYTES",
  });
  if (!res.ok) {
    const text = buf.toString("utf8");
    throw new Error(`QBO API ${res.status} on GET ${pathAndQuery}: ${text.slice(0, 300)}${tid ? ` (intuit_tid: ${tid})` : ""}`);
  }
  return buf;
}

// Multipart upload to /v3/company/{realmId}/upload (the Attachable file endpoint).
// `formData` is a FormData with the file_metadata_0N / file_content_0N parts;
// fetch sets the multipart boundary header itself.
//
// A multipart boundary is an incidental transport detail chosen by fetch, so
// hashing the raw wire representation would make an otherwise identical replay
// look different. Hash an unambiguous, length-prefixed representation of every
// ordered part instead: field name, string/file kind, filename, content type,
// and exact part bytes. That binds a request id to everything QBO can observe
// in the body without retaining the uploaded document in the ledger.
async function formDataBodyHash(formData) {
  const hash = createHash("sha256");
  let index = 0;
  const add = (label, value) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ""), "utf8");
    hash.update(`${label}:${bytes.length}:`, "utf8");
    hash.update(bytes);
  };
  for (const [name, value] of formData.entries()) {
    add("part", index++);
    add("name", name);
    if (typeof value === "string") {
      add("kind", "string");
      add("value", value);
    } else {
      add("kind", "file");
      add("filename", value.name ?? "");
      add("content-type", value.type ?? "");
      add("value", Buffer.from(await value.arrayBuffer()));
    }
  }
  add("part-count", index);
  return hash.digest("hex");
}

async function qboUpload(formData, { company, requestId: requestIdOverride } = {}) {
  // An upload is a write, and it did not pass through qboRequest's gate. The
  // body is multipart with no amount or date, so this is the read_only check;
  // amount caps and date floors have nothing to act on here.
  const companySlug = sanitizeSlug(company ?? DEFAULT_COMPANY);
  const companyLabel = companySlug || "(default)";
  await checkWritePolicy(companySlug, null);
  const tokens = await getValidTokens(company ?? DEFAULT_COMPANY);
  const apiBase = apiBaseFor(tokens.environment);
  const recoveredRequestId = claimRecoveryRequestId(requestIdOverride);
  const hasRequestIdOverride = recoveredRequestId != null;
  const requestId = hasRequestIdOverride ? recoveredRequestId : randomUUID();
  if (!requestId) {
    throw new Error("request_id cannot be empty. Omit it for a new upload, or pass the id from an ambiguous-write error.");
  }
  const requestPath = `/upload?minorversion=${encodeURIComponent(MINOR_VERSION)}&requestid=${encodeURIComponent(requestId)}`;
  const bodyHash = await formDataBodyHash(formData);
  const envelope = {
    request_id: requestId,
    company: companyLabel,
    realmId: String(tokens.realmId),
    environment: String(tokens.environment ?? ""),
    method: "POST",
    path: requestPath,
    body_sha256: bodyHash,
  };

  const executeWithRecoveryScope = async () => {

  let priorIntent;
  if (hasRequestIdOverride) {
    priorIntent = await verifyWriteReplay(requestId, envelope);
  }
  await recordWriteIntent({
    ...envelope,
    tool: currentToolName(),
    replay: hasRequestIdOverride,
    ...(priorIntent?.ts ? { original_intent_ts: priorIntent.ts } : {}),
  });

  const url = `${apiBase}/v3/company/${tokens.realmId}${requestPath}`;
  let res;
  try {
    res = await qboFetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: "application/json" },
      body: formData,
    }, {
      idempotent: RETRY_WRITES,
      retryThrottled: RETRY_WRITES,
      ...(RETRY_WRITES || hasRequestIdOverride
        ? { retryDeadlineMs: writeRetryDeadlineMs(priorIntent) }
        : {}),
    });
  } catch (e) {
    let outcomeError;
    try {
      await recordWriteOutcome({
        ...envelope,
        tool: currentToolName(),
        outcome: "transport_error",
        status: null,
        ok: null,
        error: String(e?.message ?? e).slice(0, 500),
      });
    } catch (ledgerError) {
      outcomeError = ledgerError;
    }
    throw new Error(
      `${e.message}. This upload may or may not have been applied. Check QuickBooks first; ` +
      `to re-send it safely, use request_id ${requestId} with the identical multipart body.` +
      (outcomeError ? ` The durable intent exists, but recording the transport outcome also failed: ${outcomeError.message}` : ""),
      { cause: e }
    );
  }

  const tid = res.headers.get("intuit_tid") || undefined;
  let text;
  try {
    text = await readQboResponseText(res, "QBO upload response");
  } catch (e) {
    let outcomeError;
    try {
      await recordWriteOutcome({
        ...envelope,
        tool: currentToolName(),
        outcome: "response_body_error",
        status: res.status,
        ok: res.ok,
        intuit_tid: tid,
        error: String(e?.message ?? e).slice(0, 500),
      });
    } catch (ledgerError) {
      outcomeError = ledgerError;
    }
    throw new Error(
      `QBO returned HTTP ${res.status}, but its upload response body could not be read (${e.message}). ` +
      `The upload may or may not have been applied; replay only with request_id ${requestId} and the identical multipart body.` +
      (outcomeError ? ` The durable intent exists, but recording this outcome also failed: ${outcomeError.message}` : ""),
      { cause: e }
    );
  }
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

  const fault = data?.Fault?.Error?.[0];
  const detail = String(fault ? `${fault.Message}${fault.Detail ? ": " + fault.Detail : ""}` : text).slice(0, 2_000);
  try {
    await recordWriteOutcome({
      ...envelope,
      tool: currentToolName(),
      outcome: "response",
      status: res.status,
      ok: res.ok,
      intuit_tid: tid,
      ...(res.ok ? summarizeResponse(data) : { error: String(detail).slice(0, 500) }),
    });
  } catch (e) {
    throw new Error(
      `QBO returned HTTP ${res.status} for upload request_id ${requestId}, but its durable outcome could not be recorded ` +
      `(${e.message}). The durable intent remains; do not issue a new request_id. Fix the recovery-ledger path, ` +
      `then inspect QuickBooks or replay the identical upload with request_id ${requestId}.`,
      { cause: e }
    );
  }

  await auditRecord({
    kind: "api_write",
    tool: currentToolName(),
    method: "POST",
    path: "/upload",
    request_path: requestPath,
    company: companyLabel,
    realmId: tokens.realmId,
    environment: tokens.environment,
    status: res.status,
    ok: res.ok,
    intuit_tid: tid,
    request_id: requestId,
    body_sha256: bodyHash,
  });
  if (!res.ok) {
    throw new Error(
      `QBO upload ${res.status}: ${detail}${tid ? ` (intuit_tid: ${tid})` : ""}` +
      (isAmbiguousHttpStatus(res.status)
        ? ` (request_id: ${requestId}. Re-send with this same request_id and multipart body to replay safely.)`
        : "")
    );
  }
  return data;
  };

  return withWriteRecoveryRequestLock(requestId, executeWithRecoveryScope);
}

async function getRealmId(company) {
  const tokens = await getValidTokens(company ?? DEFAULT_COMPANY);
  return tokens.realmId;
}

// Revoke a company's OAuth grant with Intuit and delete its token file. This
// is the offboarding step: deleting the file alone would leave the grant live
// on Intuit's side until it expires on its own.
async function disconnectCompany(slug) {
  const label = sanitizeSlug(slug) || "the default company";
  return withRefreshLock(slug, async () => {
    const canonical = await loadTokens(slug);
    const staged = await loadTokenStage(slug);
    const refreshRecovery = await loadRefreshRecovery(slug);
    let disconnectRecovery = await loadDisconnectRecovery(slug);

    const recoveryBundles = [
      staged,
      refreshRecovery?.token_bundle,
      ...Object.values(disconnectRecovery?.credentials ?? {}).map((entry) => entry.token_bundle),
    ].filter(Boolean);
    const candidateRealms = [canonical, ...recoveryBundles]
      .map((tokens) => tokens?.realmId)
      .filter((realmId) => realmId != null && String(realmId).trim());

    return withRealmAuthorizationLocks(candidateRealms, async () => {
      // A realm visible under another slug is ambiguous even when this slug
      // has a canonical token. Legacy/manual copies often contain the same
      // refresh credential, so revoking either alias can invalidate the one an
      // operator intended to keep. Refuse before writing a journal or making a
      // network call. Sidecar-only realms need the same protection when a
      // newer authorization won their realm while recovery was pending.
      const identities = await listAuthorizationIdentities();
      const canonicalRealm = canonical?.realmId == null ? null : String(canonical.realmId);
      const cleanSlug = sanitizeSlug(slug);
      for (const realmId of [...new Set(candidateRealms.map(String))]) {
        const otherOwners = identities.filter((identity) =>
          String(identity.realmId) === realmId && identity.slug !== cleanSlug
        );
        if (otherOwners.length) {
          const scope = realmId === canonicalRealm ? "canonical" : "recovery-only";
          throw new Error(
            `Cannot continue disconnect for ${label}: ${scope} realm ${realmId} is also authorized under ` +
            `${otherOwners.map((owner) => owner.slug || "(default)").join(", ")}. Revoking the stored credential ` +
            "could invalidate that newer grant or the retained alias. No revocation was attempted. " +
            "Reconcile the duplicate local token files first; keep a verified working identity and move confirmed copies " +
            "into backups/ rather than calling disconnect on an alias."
          );
        }
      }

      const byHash = new Map();
    const addCandidate = (tokens, source) => {
      if (!tokens?.refresh_token) return;
      const hash = createHash("sha256").update(String(tokens.refresh_token)).digest("hex");
      const existing = byHash.get(hash);
      if (existing) {
        if (!existing.sources.includes(source)) existing.sources.push(source);
        return;
      }
      byHash.set(hash, { sources: [source], token_bundle: tokens, state: "unattempted" });
    };
    addCandidate(canonical, "canonical");
    addCandidate(staged, "playground_stage");
    addCandidate(refreshRecovery?.token_bundle, "refresh_recovery");
    for (const [hash, entry] of Object.entries(disconnectRecovery?.credentials ?? {})) {
      const current = byHash.get(hash);
      byHash.set(hash, {
        ...(current ?? {}),
        ...entry,
        sources: [...new Set([...(current?.sources ?? []), ...(entry.sources ?? [])])],
        token_bundle: entry.token_bundle ?? current?.token_bundle,
      });
    }
    if (!byHash.size) {
      throw new Error(`No stored, staged, or recovery tokens for ${label}; nothing to disconnect.`);
    }

    const now = new Date().toISOString();
    disconnectRecovery = {
      realmId: canonical?.realmId ?? staged?.realmId ?? refreshRecovery?.realmId ?? disconnectRecovery?.realmId,
      environment: canonical?.environment ?? staged?.environment ?? refreshRecovery?.environment ?? disconnectRecovery?.environment,
      disconnect_recovery_version: 1,
      disconnect_recovery_kind: "disconnect",
      disconnect_recovery_created_at: disconnectRecovery?.disconnect_recovery_created_at ?? now,
      disconnect_recovery_updated_at: now,
      credentials: Object.fromEntries(byHash),
    };
    // The journal blocks ordinary token use before the first revoke request.
    await saveDisconnectRecovery(slug, disconnectRecovery);

    const outcomes = [];
    let journalError = null;
    for (const [hash, entry] of Object.entries(disconnectRecovery.credentials)) {
      if (entry.state === "confirmed") {
        outcomes.push({ sources: entry.sources, ok: true, prior_confirmed: true });
        continue;
      }
      if (entry.state === "attempting" || entry.state === "ambiguous") {
        outcomes.push({
          sources: entry.sources,
          ok: false,
          ambiguous: true,
          error: "A prior revocation request has no durably confirmed outcome; it was not replayed.",
        });
        continue;
      }
      if (entry.state === "manual_required") {
        outcomes.push({
          sources: entry.sources,
          ok: false,
          manual_required: true,
          error: entry.last_error || "Repeated explicit revocation failures require manual Intuit app-connection review.",
        });
        continue;
      }
      if (!entry.token_bundle?.refresh_token) {
        outcomes.push({
          sources: entry.sources,
          ok: false,
          ambiguous: true,
          error: "The recovery journal no longer contains the encrypted credential needed for revocation.",
        });
        continue;
      }

      // Resolve every deterministic local prerequisite before writing the
      // in-flight marker. A missing client secret or serialization bug means
      // no HTTP request was possible and must remain safely retryable after the
      // operator fixes local configuration.
      let revokeRequest;
      try {
        const creds = credentials(entry.token_bundle.environment);
        revokeRequest = {
          method: "POST",
          headers: {
            Authorization: basicAuthHeader(creds),
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ token: entry.token_bundle.refresh_token }),
        };
      } catch (e) {
        entry.last_error = `Local revocation preparation failed before any request was sent: ${String(e.message).slice(0, 300)}`;
        outcomes.push({
          sources: entry.sources,
          ok: false,
          local_error: true,
          error: entry.last_error,
        });
        disconnectRecovery.disconnect_recovery_updated_at = new Date().toISOString();
        try { await saveDisconnectRecovery(slug, disconnectRecovery); }
        catch (saveError) { journalError = saveError; }
        continue;
      }

      // Mark the individual credential in-flight before POST. A kill after
      // upload leaves `attempting`, which is never replayed automatically.
      entry.state = "attempting";
      entry.attempted_at = new Date().toISOString();
      entry.attempt_count = Number(entry.attempt_count ?? 0) + 1;
      disconnectRecovery.disconnect_recovery_updated_at = entry.attempted_at;
      await saveDisconnectRecovery(slug, disconnectRecovery);

      let res;
      try {
        res = await qboFetch(REVOKE_URL, revokeRequest, { idempotent: false, retryThrottled: false });
      } catch (e) {
        entry.state = "ambiguous";
        entry.last_error = String(e.message).slice(0, 300);
        outcomes.push({ sources: entry.sources, ok: false, ambiguous: true, error: entry.last_error });
        try { await saveDisconnectRecovery(slug, disconnectRecovery); }
        catch (saveError) { journalError = saveError; }
        continue;
      }

      let detail = "";
      try { detail = await readQboResponseText(res, "Intuit token-revocation response"); }
      catch (e) { detail = `response body unreadable: ${e.message}`; }
      if (res.ok) {
        entry.state = "confirmed";
        entry.confirmed_at = new Date().toISOString();
        entry.last_status = res.status;
        delete entry.last_error;
        outcomes.push({ sources: entry.sources, ok: true, status: res.status });
      } else if (res.status === 408 || res.status >= 500) {
        entry.state = "ambiguous";
        entry.last_status = res.status;
        entry.last_error = `HTTP ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`;
        outcomes.push({ sources: entry.sources, ok: false, status: res.status, ambiguous: true, error: entry.last_error });
      } else {
        // Permit one later explicit retry for a definite 4xx/429 while
        // confirmed successes from earlier candidates are skipped. Repeating
        // the same explicit failure forever can never make local cleanup safe,
        // so the second failure moves to manual reconciliation.
        entry.state = entry.attempt_count >= 2 ? "manual_required" : "failed_explicit";
        entry.last_status = res.status;
        entry.last_error = `HTTP ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`;
        outcomes.push({
          sources: entry.sources,
          ok: false,
          status: res.status,
          ...(entry.state === "manual_required" ? { manual_required: true } : {}),
          error: entry.last_error,
        });
      }
      disconnectRecovery.disconnect_recovery_updated_at = new Date().toISOString();
      try { await saveDisconnectRecovery(slug, disconnectRecovery); }
      catch (saveError) { journalError = saveError; }
    }

    try {
      await auditRecord({
        kind: "disconnect_attempt",
        company: sanitizeSlug(slug) || "(default)",
        realmId: disconnectRecovery.realmId ?? null,
        revocation_outcomes: outcomes,
      });
    } catch (e) {
      journalError ??= e;
    }

    const failed = outcomes.filter((outcome) => !outcome.ok);
    if (failed.length || journalError) {
      const summary = outcomes.map((outcome) =>
        `${outcome.sources.join("+")}: ${outcome.ok ? (outcome.prior_confirmed ? "already confirmed" : `confirmed HTTP ${outcome.status}`) : outcome.error}`
      ).join("; ");
      const error = new Error(
        `QuickBooks disconnect is incomplete for ${label}; no local credential files were removed. ${summary}. ` +
        (journalError ? `The recovery journal also could not record all outcomes (${journalError.message}). ` : "") +
        (failed.some((outcome) => outcome.ambiguous)
          ? "At least one revocation outcome is ambiguous and will not be replayed automatically. Confirm/remove the app connection in QuickBooks/Intuit, then archive or delete the named local token and recovery files."
          : failed.some((outcome) => outcome.manual_required)
            ? "A credential was explicitly rejected twice and is now blocked from further automatic replay. Manually confirm/remove the app connection in QuickBooks/Intuit, then archive or delete the named local token and recovery files."
            : `Fix the explicit failure and retry ${sanitizeSlug(slug) ? `\`npm run disconnect -- ${sanitizeSlug(slug)}\`` : "`npm run disconnect`"}; already confirmed revocations will be skipped.`)
      );
      error.revocationOutcomes = outcomes;
      throw error;
    }

    // Only after every distinct credential is confirmed revoked may any local
    // authorization/recovery source be removed. Keep the disconnect receipt
    // until last so an interrupted cleanup can safely resume without replay.
    if (canonical) {
      try { await unlink(tokensPathFor(slug)); }
      catch (e) { if (e?.code !== "ENOENT") throw e; }
      await fsyncTokenDirectory(tokensPathFor(slug));
    }
    if (staged) await removeTokenStage(slug);
    if (refreshRecovery) await removeRefreshRecovery(slug);
    await removeDisconnectRecovery(slug);
    await auditRecord({
      kind: "disconnect",
      company: sanitizeSlug(slug) || "(default)",
      realmId: disconnectRecovery.realmId ?? null,
      revoked_credentials: outcomes.length,
      revocation_outcomes: outcomes,
    });
    log(`Revoked Intuit access and removed ${outcomes.length} token credential(s) for ${label}.`);
      return {
        slug: sanitizeSlug(slug),
        realmId: disconnectRecovery.realmId ?? null,
        revoked_credentials: outcomes.length,
        revocation_outcomes: outcomes,
      };
    });
  });
}

// Derive a short, stable, filesystem-safe slug from a realmId: the last 4 digits,
// extended one digit at a time until it no longer collides with a taken slug.
function deriveSlugFromRealm(realmId, taken = new Set()) {
  const digits = String(realmId).replace(/\D/g, "");
  for (let n = 4; n <= digits.length; n++) {
    const s = digits.slice(-n);
    if (!taken.has(s)) return s;
  }
  return digits || sanitizeSlug(String(realmId)) || "company";
}

// Exchange an authorization code for a token bundle (no realmId — that comes from
// the callback query). Shared shape with runAuthorizationFlow's inline exchange.
async function exchangeCodeForTokens(code, environment) {
  const creds = credentials(environment);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: creds.redirectUri,
  });
  const res = await qboFetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(creds),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  }, { idempotent: false });
  const responseText = await readQboResponseText(res, "Intuit token-exchange response");
  let data;
  try { data = responseText ? JSON.parse(responseText) : {}; }
  catch { throw new Error("Token exchange returned malformed JSON."); }
  if (!res.ok) throw new Error("Token exchange failed: " + JSON.stringify(data).slice(0, 1_000));
  const now = Date.now();
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    environment,
    expires_at: now + data.expires_in * 1000,
    refresh_expires_at: data.x_refresh_token_expires_in
      ? now + data.x_refresh_token_expires_in * 1000
      : undefined,
  };
}

// Pattern A — sequential batch authorization on ONE persistent localhost listener.
// The Intuit login session is reused across companies, so after the first login
// each additional company is just pick-in-the-picker → Allow. `shouldContinue`
// (async, receives the list connected so far) decides whether to authorize
// another; return false to stop. A company whose realmId is already on disk is
// refreshed in place under its existing slug instead of creating a duplicate.
// The whole batch uses one environment (QBO_ENVIRONMENT); run separate batches
// for sandbox vs production. Returns [{ slug, realmId, environment, reused }].
async function runBatchAuthorization({ shouldContinue } = {}) {
  const environment = connectEnvironment();
  if (environment === "production") {
    throw new Error(
      "Batch localhost authorization is sandbox-only. Connect production companies one at a time with " +
      "`npm run connect:playground -- <slug>` or the documented HTTPS catcher."
    );
  }
  const creds = credentials(environment);
  const redirect = localhostRedirect(creds, "Batch authorization");
  const port = Number(redirect.port || 80);

  const connected = [];
  let pending = null; // { state, resolve }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    if (url.pathname !== redirect.pathname) { res.writeHead(404).end("Not found"); return; }
    if (!pending) { res.writeHead(409).end("No authorization in progress."); return; }
    const code = url.searchParams.get("code");
    const realmId = url.searchParams.get("realmId");
    const returnedState = url.searchParams.get("state");
    if (returnedState !== pending.state) { res.writeHead(400).end("State mismatch — close this tab and retry."); return; }
    if (!code || !realmId) { res.writeHead(400).end("Missing code or realmId in callback."); return; }
    res.writeHead(200, { "Content-Type": "text/html" }).end(
      `<html><body style="font-family:sans-serif;padding:3rem;text-align:center">
         <h2>✅ Connected (#${connected.length + 1})</h2>
         <p>Return to your terminal — it will prompt for the next company or finish.</p>
       </body></html>`
    );
    const p = pending; pending = null;
    p.resolve({ code, realmId });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    // Loopback only: the callback listener must never be reachable from the LAN.
    server.listen(port, "127.0.0.1", resolve);
  });
  log(`Batch authorize listening on ${creds.redirectUri} (${environment}).`);

  try {
    let go = true;
    while (go) {
      const state = randomBytes(16).toString("hex");
      const authUrl =
        `${AUTHORIZE_URL}?client_id=${encodeURIComponent(creds.clientId)}` +
        `&response_type=code&scope=${encodeURIComponent(SCOPE)}` +
        `&redirect_uri=${encodeURIComponent(creds.redirectUri)}&state=${state}`;

      log(`\n[#${connected.length + 1}] Opening browser — pick the next company and click Allow.`);
      log("If it doesn't open, use this URL:");
      log("AUTHORIZE_URL>>> " + authUrl + " <<<");

      const { code, realmId } = await new Promise((resolve) => {
        pending = { state, resolve };
        openBrowser(authUrl);
      });

      const tokens = { ...(await exchangeCodeForTokens(code, environment)), realmId };
      const companyInfo = await getCompanyInfoWithTokens(tokens);

      // Reuse the existing slug if this realmId is already connected; else mint one.
      const existing = await listCompanies();
      const taken = new Set(existing.map((c) => c.slug).concat(connected.map((c) => c.slug)));
      const already = existing.find((c) => String(c.realmId) === String(realmId));
      const slug = already ? already.slug : deriveSlugFromRealm(realmId, taken);

      await persistAuthorization(slug, tokens, { replaceExisting: !!already });
      connected.push({
        slug,
        realmId,
        environment: tokens.environment,
        reused: !!already,
        company_name: companyInfo.CompanyName ?? null,
      });
      log(
        `   → "${slug}"${already ? " (already existed — refreshed)" : ""} · ` +
        `${companyInfo.CompanyName ?? `realm ${realmId}`} · ${tokens.environment}`
      );

      go = shouldContinue ? await shouldContinue(connected.slice()) : false;
    }
  } finally {
    server.close();
  }
  return connected;
}

const __test = {
  refreshTokensWithStorageForTest,
  refreshRecoveryPathFor,
  disconnectRecoveryPathFor,
  qboFetch,
  writeRetryDeadlineMs,
};

export {
  credentials,
  getValidTokens,
  saveTokens,
  persistAuthorization,
  refreshTokens,
  importRefreshToken,
  recoverStagedTokenImport,
  exchangeCodeForTokens,
  getCompanyInfoWithTokens,
  qboRequest,
  qboQuery,
  qboRequestBinary,
  qboUpload,
  getRealmId,
  runAuthorizationFlow,
  runBatchAuthorization,
  disconnectCompany,
  beginAuthorization,
  authorizationStatus,
  cancelAuthorization,
  deriveSlugFromRealm,
  listCompanies,
  assertRealmNotAlreadyAuthorized,
  sanitizeSlug,
  assertSlug,
  withRefreshLock,
  durableAtomicReplace,
  configureQboRuntime,
  __test,
  DEFAULT_COMPANY,
};
