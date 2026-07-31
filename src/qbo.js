// qbo.js — QuickBooks Online OAuth 2.0 handling + authenticated API client.
// All logs go to STDERR (console.error) because STDOUT is the MCP protocol channel.
//
// Multi-company: this connector can talk to any company that has an authorized
// tokens.<slug>.json file. The company is chosen PER CALL via the `company`
// option on qboRequest / qboQuery / getRealmId. QBO_COMPANY, if set, is only the
// fallback default used by the one-time `--connect` flow and by callers that
// pass no slug (backwards compatible with the legacy per-connector setup).

import http from "node:http";
import { exec } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, writeFile, readdir, rename, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { encryptionEnabled, encryptTokens, decryptTokens, isEncrypted } from "./secure-store.js";
import { record as auditRecord, summarizeResponse } from "./audit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";
const SCOPE = "com.intuit.quickbooks.accounting";
// Intuit sunset minor versions 1-74 on 2025-08-01; 75 is the supported baseline.
const MINOR_VERSION = process.env.QBO_MINOR_VERSION || "75";

// Network policy for every Intuit call: a hard timeout, plus retries with
// exponential backoff and jitter. 429 (throttled) is always retried because the
// request was rejected before processing; 5xx and network errors are retried
// only for idempotent requests, so a write is never blindly re-sent after the
// server may have applied it.
const TIMEOUT_MS = Number(process.env.QBO_TIMEOUT_MS) || 60_000;
const MAX_RETRIES = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function qboFetch(url, init = {}, { idempotent = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    const backoff = Math.min(1000 * 2 ** attempt, 8000) + Math.floor(Math.random() * 250);
    let res;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
      if (idempotent && attempt < MAX_RETRIES) { await sleep(backoff); continue; }
      throw timedOut ? new Error(`Request timed out after ${TIMEOUT_MS / 1000}s`) : e;
    }
    if (res.status === 429 && attempt < MAX_RETRIES) {
      const ra = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoff);
      continue;
    }
    if (res.status >= 500 && idempotent && attempt < MAX_RETRIES) {
      await sleep(backoff);
      continue;
    }
    return res;
  }
}

// Token files that exist on disk but are not real, selectable companies.
const NON_COMPANY_SLUGS = new Set(["sandbox-backup"]);

function log(...args) {
  console.error("[qbo]", ...args);
}

// Sanitize any user/env-supplied company slug to a safe filename fragment so it
// can never escape the project directory. Empty string → the legacy tokens.json.
function sanitizeSlug(s) {
  return String(s ?? "").trim().replace(/[^a-zA-Z0-9_-]/g, "");
}

// The --connect flow and no-arg callers fall back to this env-configured default.
const DEFAULT_COMPANY = sanitizeSlug(process.env.QBO_COMPANY || "");

function tokensPathFor(slug) {
  const clean = sanitizeSlug(slug);
  return path.join(ROOT, clean ? `tokens.${clean}.json` : "tokens.json");
}

// Credentials + redirect come from the environment (one Intuit app per
// connector). The API host, however, is derived per-company from each token
// file's stored `environment` (see apiBaseFor) — so a single connector can serve
// sandbox and production companies side by side, as long as they authorize under
// the same app credentials.
function credentials() {
  const {
    QBO_CLIENT_ID,
    QBO_CLIENT_SECRET,
    QBO_REDIRECT_URI = "http://localhost:3000/callback",
  } = process.env;

  if (!QBO_CLIENT_ID || !QBO_CLIENT_SECRET) {
    throw new Error(
      "Missing QBO_CLIENT_ID / QBO_CLIENT_SECRET. Fill them into your .env file (Step 7)."
    );
  }
  return {
    clientId: QBO_CLIENT_ID,
    clientSecret: QBO_CLIENT_SECRET,
    redirectUri: QBO_REDIRECT_URI,
  };
}

// Environment used when authorizing a NEW company (no token file exists yet).
function connectEnvironment() {
  return (process.env.QBO_ENVIRONMENT || "sandbox").toLowerCase() === "production"
    ? "production"
    : "sandbox";
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

async function loadTokens(slug) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(tokensPathFor(slug), "utf8"));
  } catch {
    return null;
  }
  try {
    if (isEncrypted(parsed)) return await decryptTokens(parsed);
    // Legacy plaintext file: migrate to encrypted-at-rest on first touch.
    if (encryptionEnabled() && parsed?.access_token) {
      try {
        await saveTokens(slug, parsed);
      } catch (e) {
        log("Could not migrate token file to encrypted storage:", e.message);
      }
    }
    return parsed;
  } catch (e) {
    log(`Could not decrypt ${tokensPathFor(slug)}: ${e.message}`);
    return null;
  }
}

async function saveTokens(slug, tokens) {
  const p = tokensPathFor(slug);
  // Credentials are encrypted at rest (realmId/environment stay plaintext for
  // company discovery). Owner-only permissions, written atomically: a temp
  // file with 0600 perms is renamed over the target so concurrent readers
  // never see a torn file.
  const payload = encryptionEnabled() ? await encryptTokens(tokens) : tokens;
  const tmp = `${p}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
  await rename(tmp, p);
  log("Tokens saved to", p);
}

// Every authorized company is a tokens.<slug>.json file (excluding the legacy
// default tokens.json and known non-company backups). Returns, sorted by slug,
// [{ slug, realmId, environment }] — the source of truth for what this connector
// can reach right now.
async function listCompanies() {
  let files = [];
  try {
    files = await readdir(ROOT);
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    const m = /^tokens\.(.+)\.json$/.exec(f); // note: skips the legacy tokens.json
    if (!m) continue;
    const slug = m[1];
    if (NON_COMPANY_SLUGS.has(slug)) continue;
    try {
      const d = JSON.parse(await readFile(path.join(ROOT, f), "utf8"));
      out.push({ slug, realmId: d.realmId ?? null, environment: d.environment ?? null });
    } catch {
      /* unreadable token file — skip it */
    }
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

function openBrowser(url) {
  const platform = process.platform;
  const cmd =
    platform === "darwin"
      ? `open "${url}"`
      : platform === "win32"
      ? `start "" "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) {
      log("Could not auto-open your browser. Open this URL manually:\n", url);
    }
  });
}

// Full first-run authorization: open browser, catch the redirect on localhost:3000,
// exchange the code for tokens, save them to tokens.<DEFAULT_COMPANY>.json.
async function runAuthorizationFlow() {
  const creds = credentials();
  const environment = connectEnvironment();
  const slug = DEFAULT_COMPANY;
  const state = randomBytes(16).toString("hex");
  const redirect = new URL(creds.redirectUri);
  const port = Number(redirect.port) || 3000;

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
        }, { idempotent: true });
        const data = await tokenRes.json();
        if (!tokenRes.ok) {
          res.writeHead(500).end("Token exchange failed. Check the server console.");
          server.close();
          reject(new Error("Token exchange failed: " + JSON.stringify(data)));
          return;
        }

        const now = Date.now();
        const tokens = {
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          realmId,
          environment,
          expires_at: now + data.expires_in * 1000,
          refresh_expires_at: now + data.x_refresh_token_expires_in * 1000,
        };
        await saveTokens(slug, tokens);

        res.writeHead(200, { "Content-Type": "text/html" }).end(
          `<html><body style="font-family:sans-serif;padding:3rem;text-align:center">
             <h2>✅ QuickBooks connected</h2>
             <p>You can close this tab and return to Claude Desktop.</p>
           </body></html>`
        );
        server.close();
        log(`Connected to realmId ${realmId} (${environment})${slug ? ` as company "${slug}"` : ""}.`);
        resolve(tokens);
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

async function refreshTokens(slug, existing) {
  // Intuit rotates the refresh token on every refresh, so a parallel caller or
  // another process may already have rotated it. Prefer the newest state on
  // disk: if a fresh access token is already there, use it; otherwise refresh
  // with the newest refresh token we can find.
  const onDisk = await loadTokens(slug);
  if (onDisk && onDisk.access_token !== existing.access_token &&
      Date.now() < (onDisk.expires_at ?? 0) - 60_000) {
    return onDisk;
  }
  const current = onDisk?.refresh_token ? onDisk : existing;

  const creds = credentials();
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: current.refresh_token,
  });
  const res = await qboFetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(creds),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  }, { idempotent: true });
  const data = await res.json();
  if (!res.ok) {
    const label = sanitizeSlug(slug) || "the default company";
    const reconnect = sanitizeSlug(slug)
      ? `\`QBO_COMPANY=${sanitizeSlug(slug)} npm run connect\``
      : "`npm run connect`";
    throw new Error(
      `Token refresh failed for ${label}: ${JSON.stringify(data)}. Re-authorize with ${reconnect}.`
    );
  }
  const now = Date.now();
  const tokens = {
    ...current,
    access_token: data.access_token,
    // Intuit rotates the refresh token; keep the new one if returned.
    refresh_token: data.refresh_token || current.refresh_token,
    expires_at: now + data.expires_in * 1000,
    refresh_expires_at: now + (data.x_refresh_token_expires_in
      ? data.x_refresh_token_expires_in * 1000
      : current.refresh_expires_at - now),
  };
  await saveTokens(slug, tokens);
  log(`Access token refreshed${sanitizeSlug(slug) ? ` for "${sanitizeSlug(slug)}"` : ""}.`);
  return tokens;
}

// In-flight refresh per company, so concurrent tool calls share one refresh
// instead of racing to rotate the same refresh token.
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
  const reconnect = sanitizeSlug(slug)
    ? `\`QBO_COMPANY=${sanitizeSlug(slug)} npm run connect\``
    : "`npm run connect`";

  let tokens = await loadTokens(slug);

  if (!tokens) {
    if (!allowInteractive) {
      throw new Error(
        `Not connected to QuickBooks for ${label}. Run ${reconnect} once to authorize.`
      );
    }
    return runAuthorizationFlow();
  }

  const now = Date.now();
  if (tokens.refresh_expires_at && now > tokens.refresh_expires_at) {
    if (!allowInteractive) {
      throw new Error(
        `Refresh token expired (100+ days) for ${label}. Re-authorize with ${reconnect}.`
      );
    }
    return runAuthorizationFlow();
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
async function qboRequest(pathAndQuery, { method = "GET", body, company } = {}) {
  const tokens = await getValidTokens(company ?? DEFAULT_COMPANY);
  const apiBase = apiBaseFor(tokens.environment);
  const sep = pathAndQuery.includes("?") ? "&" : "?";
  const url =
    `${apiBase}/v3/company/${tokens.realmId}${pathAndQuery}` +
    `${sep}minorversion=${MINOR_VERSION}`;

  const res = await qboFetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }, { idempotent: method === "GET" });

  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

  // intuit_tid is Intuit's per-request trace id; it goes into errors and the
  // audit log because Intuit support asks for it.
  const tid = res.headers.get("intuit_tid") || undefined;
  const fault = data?.Fault?.Error?.[0];
  const detail = fault
    ? `${fault.Message}${fault.Detail ? ": " + fault.Detail : ""}`
    : text;

  if (method !== "GET") {
    await auditRecord({
      kind: "api_write",
      method,
      path: pathAndQuery.split("?")[0],
      company: sanitizeSlug(company ?? DEFAULT_COMPANY) || "(default)",
      realmId: tokens.realmId,
      environment: tokens.environment,
      status: res.status,
      ok: res.ok,
      intuit_tid: tid,
      ...(res.ok ? summarizeResponse(data) : { error: String(detail).slice(0, 500) }),
    });
  }

  if (!res.ok) {
    throw new Error(
      `QBO API ${res.status} on ${method} ${pathAndQuery}: ${detail}${tid ? ` (intuit_tid: ${tid})` : ""}`
    );
  }
  return data;
}

async function qboQuery(sql, { company } = {}) {
  const data = await qboRequest(`/query?query=${encodeURIComponent(sql)}`, { company });
  return data.QueryResponse || {};
}

// Multipart upload to /v3/company/{realmId}/upload (the Attachable file endpoint).
// `formData` is a FormData with the file_metadata_0N / file_content_0N parts;
// fetch sets the multipart boundary header itself.
async function qboUpload(formData, { company } = {}) {
  const tokens = await getValidTokens(company ?? DEFAULT_COMPANY);
  const apiBase = apiBaseFor(tokens.environment);
  const url = `${apiBase}/v3/company/${tokens.realmId}/upload?minorversion=${MINOR_VERSION}`;
  const res = await qboFetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: "application/json" },
    body: formData,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  const tid = res.headers.get("intuit_tid") || undefined;
  await auditRecord({
    kind: "api_write",
    method: "POST",
    path: "/upload",
    company: sanitizeSlug(company ?? DEFAULT_COMPANY) || "(default)",
    realmId: tokens.realmId,
    environment: tokens.environment,
    status: res.status,
    ok: res.ok,
    intuit_tid: tid,
  });
  if (!res.ok) {
    const fault = data?.Fault?.Error?.[0];
    const detail = fault ? `${fault.Message}${fault.Detail ? ": " + fault.Detail : ""}` : text;
    throw new Error(`QBO upload ${res.status}: ${detail}${tid ? ` (intuit_tid: ${tid})` : ""}`);
  }
  return data;
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
  const tokens = await loadTokens(slug);
  if (!tokens?.refresh_token) {
    throw new Error(`No stored tokens for ${label}; nothing to disconnect.`);
  }
  const creds = credentials();
  const res = await qboFetch(REVOKE_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(creds),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ token: tokens.refresh_token }),
  }, { idempotent: true });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token revocation failed for ${label} (HTTP ${res.status}): ${text}`);
  }
  await unlink(tokensPathFor(slug));
  await auditRecord({ kind: "disconnect", company: sanitizeSlug(slug) || "(default)", realmId: tokens.realmId ?? null });
  log(`Revoked Intuit access and removed the token file for ${label}.`);
  return { slug: sanitizeSlug(slug), realmId: tokens.realmId ?? null };
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
  const creds = credentials();
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
  }, { idempotent: true });
  const data = await res.json();
  if (!res.ok) throw new Error("Token exchange failed: " + JSON.stringify(data));
  const now = Date.now();
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    environment,
    expires_at: now + data.expires_in * 1000,
    refresh_expires_at: now + data.x_refresh_token_expires_in * 1000,
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
  const creds = credentials();
  const environment = connectEnvironment();
  const redirect = new URL(creds.redirectUri);
  const port = Number(redirect.port) || 3000;

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

      // Reuse the existing slug if this realmId is already connected; else mint one.
      const existing = await listCompanies();
      const taken = new Set(existing.map((c) => c.slug).concat(connected.map((c) => c.slug)));
      const already = existing.find((c) => String(c.realmId) === String(realmId));
      const slug = already ? already.slug : deriveSlugFromRealm(realmId, taken);

      await saveTokens(slug, tokens);
      connected.push({ slug, realmId, environment: tokens.environment, reused: !!already });
      log(`   → "${slug}"${already ? " (already existed — refreshed)" : ""} · realm ${realmId} · ${tokens.environment}`);

      go = shouldContinue ? await shouldContinue(connected.slice()) : false;
    }
  } finally {
    server.close();
  }
  return connected;
}

export {
  credentials,
  getValidTokens,
  qboRequest,
  qboQuery,
  qboUpload,
  getRealmId,
  runAuthorizationFlow,
  runBatchAuthorization,
  disconnectCompany,
  deriveSlugFromRealm,
  listCompanies,
  sanitizeSlug,
  DEFAULT_COMPANY,
};
