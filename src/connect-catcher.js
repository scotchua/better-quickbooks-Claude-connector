// connect-catcher.js — authorize a PRODUCTION QuickBooks company.
//
// Why this exists alongside the localhost flow: Intuit does not accept
// http://localhost as a redirect URI for production apps. Only HTTPS is
// allowed there, so connect_company and runAuthorizationFlow — which both
// catch the callback on localhost:3000 — can only ever serve sandbox files.
// Every real client has to come back through an HTTPS redirect.
//
// So this flow uses a static catcher page that YOU host: Intuit redirects
// there, the page shows the query string, and the operator pastes that one
// line back here. No inbound port, no tunnel, and the pasted line is useless
// to anyone else: the authorization code is single-use, expires in minutes,
// and is worthless without this app's client secret.
//
// There is no default page, deliberately. Set QBO_CATCHER_REDIRECT_URI to a
// page you control (docs/oauth-catcher/ has one ready to deploy, and its
// README covers hosting). If you would rather host nothing at all, use
// `npm run connect:playground -- <slug>` instead: it mints tokens in Intuit's
// own OAuth 2.0 Playground, so every hop stays on Intuit-operated pages.
//
// The result is written straight to tokens.<slug>.json, so a production
// company is authorized in one step with no import from anywhere else.

import readline from "node:readline";
import { exec } from "node:child_process";
import { randomBytes } from "node:crypto";
import { parse as parseQuery } from "node:querystring";
import { credentials, exchangeCodeForTokens, saveTokens, sanitizeSlug, qboRequest, listCompanies } from "./qbo.js";

const AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
const SCOPE = "com.intuit.quickbooks.accounting";


const log = (...a) => console.error("[qbo-catcher]", ...a);

function catcherRedirectUri() {
  const uri = (process.env.QBO_CATCHER_REDIRECT_URI || "").trim();
  if (!uri) {
    throw new Error(
      "QBO_CATCHER_REDIRECT_URI is not set, and this flow ships no default page.\n" +
      "  Either: host the page in docs/oauth-catcher/ (see its README), register that\n" +
      "  HTTPS URL as a Redirect URI on your Intuit app, and set the variable in .env;\n" +
      "  Or:     run `npm run connect:playground -- <slug>` instead, which needs nothing\n" +
      "          hosted (tokens are minted in Intuit's own OAuth 2.0 Playground)."
    );
  }
  if (!uri.startsWith("https://")) {
    throw new Error(
      `QBO_CATCHER_REDIRECT_URI must be an https:// URL (got "${uri}"). Intuit rejects ` +
      "anything else as a production redirect."
    );
  }
  return uri;
}

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? `open "${url}"`
    : process.platform === "win32" ? `start "" "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, (err) => { if (err) log("Could not auto-open the browser; use the URL above."); });
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

// The catcher shows a full URL or a bare query string; accept either, and
// tolerate a leading "?" so a copied fragment works too.
function parsePasted(pasted) {
  let qs = pasted;
  const q = pasted.indexOf("?");
  if (q >= 0) qs = pasted.slice(q + 1);
  if (qs.startsWith("?")) qs = qs.slice(1);
  const p = parseQuery(qs);
  const one = (v) => (Array.isArray(v) ? v[0] : v);
  return {
    code: one(p.code),
    realmId: one(p.realmId),
    state: one(p.state),
    error: one(p.error),
  };
}

/**
 * Authorize one production company through the hosted catcher.
 * @param {string} slug   Company slug; becomes tokens.<slug>.json.
 * @param {string} environment "production" (default) or "sandbox".
 */
export async function connectViaCatcher(slug, environment = "production", { openBrowserWindow = true } = {}) {
  const clean = sanitizeSlug(slug);
  if (!clean) throw new Error("Give a company slug of letters, numbers, or hyphens.");

  const redirectUri = catcherRedirectUri();
  // credentials() and exchangeCodeForTokens both read QBO_REDIRECT_URI, and
  // Intuit requires the exchange's redirect_uri to match the authorize
  // request's byte for byte. Setting it here keeps the two in step without
  // asking the operator to edit .env for a one-off.
  process.env.QBO_REDIRECT_URI = redirectUri;

  // Fail before opening a browser. Without this, missing keys produce an
  // authorize URL carrying an empty client_id, so the operator is sent to an
  // Intuit error page and asked to paste something they can never get.
  credentials(environment);

  const existing = (await listCompanies()).find((c) => c.slug === clean);
  if (existing) {
    log(`Note: "${clean}" is already authorized (realm ${existing.realmId}, ${existing.environment}).`);
    log("Completing this will replace that authorization.");
  }

  const state = randomBytes(16).toString("base64url");
  const authUrl =
    `${AUTHORIZE_URL}?client_id=${encodeURIComponent(process.env.QBO_CLIENT_ID || "")}` +
    `&response_type=code&scope=${encodeURIComponent(SCOPE)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;

  log(`Authorizing "${clean}" as ${environment}.`);
  log(openBrowserWindow
    ? "Opening Intuit. Log in, pick the company, and click Allow."
    : "Open this URL yourself (browser launch suppressed by --no-browser):");
  log("AUTHORIZE_URL>>> " + authUrl + " <<<");
  log(`Redirecting to: ${redirectUri}`);
  log("If Intuit answers \"the redirect_uri query parameter value is invalid\", that URL is");
  log("not registered on this app. Add it under Keys & OAuth -> Redirect URIs, exactly.");
  if (openBrowserWindow) openBrowser(authUrl);

  const pasted = await ask("\nPaste the line from the catcher page here: ");
  if (!pasted) throw new Error("Nothing pasted; no changes made.");

  const { code, realmId, state: got, error } = parsePasted(pasted);
  if (error) throw new Error(`Intuit returned an error: ${error}`);
  if (!code || !realmId) {
    throw new Error(
      "That did not parse into a code and realmId. Copy the whole line from the " +
      "catcher page (its copy button gets this right) and run this again."
    );
  }
  if (got !== state) {
    throw new Error(
      "State did not match what was sent — either a stale paste from an earlier " +
      "attempt, or tampering. Nothing was saved; run this again."
    );
  }

  const tokens = { ...(await exchangeCodeForTokens(code, environment)), realmId: String(realmId) };
  await saveTokens(clean, tokens);

  // Confirm which file actually landed. An authorization that succeeds against
  // the wrong company is the worst outcome, because everything downstream looks
  // healthy while pointing at the wrong books.
  let companyName = null, legalName = null, addressState = null, warning;
  try {
    const info = await qboRequest(`/companyinfo/${realmId}`, { company: clean });
    companyName = info.CompanyInfo?.CompanyName ?? null;
    legalName = info.CompanyInfo?.LegalName ?? null;
    addressState = info.CompanyInfo?.CompanyAddr?.CountrySubDivisionCode ?? null;
  } catch (e) {
    warning = `Authorized, but reading the company name failed: ${e.message}`;
  }

  const twins = (await listCompanies()).filter((c) => c.realmId === String(realmId) && c.slug !== clean);

  return {
    slug: clean,
    realmId: String(realmId),
    environment,
    company_name: companyName,
    legal_name: legalName,
    address_state: addressState,
    duplicate_slugs: twins.length ? twins.map((c) => c.slug) : undefined,
    warning,
    verify: "Confirm company_name is the client you intended before any report runs.",
  };
}
