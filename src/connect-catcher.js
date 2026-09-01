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
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { parse as parseQuery } from "node:querystring";
import { credentials, exchangeCodeForTokens, persistAuthorization, assertSlug, getCompanyInfoWithTokens, listCompanies } from "./qbo.js";

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
  const [command, args] = process.platform === "darwin"
    ? ["open", [url]]
    : process.platform === "win32"
      ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
      : ["xdg-open", [url]];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.once("error", () => log("Could not auto-open the browser; use the URL above."));
  child.unref();
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

// Reusing a slug is an overwrite, not a convenience default. Check once before
// any browser work, then again with the returned realm immediately before the
// token file can be replaced. The second check also closes the ordinary race
// where a different process connects this slug while the operator is in Intuit.
export function assertSafeExistingSlug(existing, {
  slug,
  environment,
  realmId,
  replaceExisting = false,
} = {}) {
  if (!existing) return;
  const existingEnvironment = String(existing.environment ?? "").toLowerCase();
  const requestedEnvironment = String(environment ?? "").toLowerCase();
  const identity = `realm ${existing.realmId ?? "unknown"}, ${existing.environment ?? "unknown environment"}`;

  if (replaceExisting !== true) {
    throw new Error(
      `Company slug "${slug}" is already authorized (${identity}). Refusing to replace it without explicit ` +
      `replaceExisting: true. Use a new slug if this is a different company or authorization.`
    );
  }
  if (!existingEnvironment || existingEnvironment !== requestedEnvironment) {
    throw new Error(
      `Company slug "${slug}" is already authorized as ${identity}, but this flow is for ` +
      `${environment ?? "an unknown environment"}. Refusing to overwrite it. Use a new slug for a different environment.`
    );
  }
  if (realmId != null && String(existing.realmId ?? "") !== String(realmId)) {
    throw new Error(
      `Company slug "${slug}" is already authorized to realm ${existing.realmId ?? "unknown"} in ` +
      `${existing.environment}, but Intuit returned realm ${realmId} in ${environment}. Refusing to overwrite it; ` +
      `use a new slug for a different company.`
    );
  }
}

/**
 * Authorize one production company through the hosted catcher.
 * @param {string} slug   Company slug; becomes tokens.<slug>.json.
 * @param {string} environment "production" (default) or "sandbox".
 * @param {object} opts { openBrowserWindow = true, replaceExisting = false }
 */
export async function connectViaCatcher(
  slug,
  environment = "production",
  { openBrowserWindow = true, replaceExisting = false } = {}
) {
  const clean = assertSlug(slug);
  if (!clean) throw new Error("Give a company slug of letters, numbers, or hyphens.");
  const env = String(environment).toLowerCase();
  if (env !== "production" && env !== "sandbox") {
    throw new Error(`environment must be "production" or "sandbox", got "${environment}".`);
  }

  // This is intentionally the first I/O in the flow: an existing slug without
  // explicit replacement authority must fail before configuration checks,
  // browser launch, or asking the operator to paste anything.
  const existing = (await listCompanies()).find((c) => c.slug === clean);
  assertSafeExistingSlug(existing, { slug: clean, environment: env, replaceExisting });

  const redirectUri = catcherRedirectUri();
  // credentials() and exchangeCodeForTokens both read QBO_REDIRECT_URI, and
  // Intuit requires the exchange's redirect_uri to match the authorize
  // request's byte for byte. Setting it here keeps the two in step without
  // asking the operator to edit .env for a one-off.
  process.env.QBO_REDIRECT_URI = redirectUri;

  // Fail before opening a browser. Without this, missing keys produce an
  // authorize URL carrying an empty client_id, so the operator is sent to an
  // Intuit error page and asked to paste something they can never get.
  const creds = credentials(env);

  if (existing) {
    log(`Note: "${clean}" is already authorized (realm ${existing.realmId}, ${existing.environment}).`);
    log("Replacement was explicitly authorized; the returned realm must match before anything is saved.");
  }

  const state = randomBytes(16).toString("base64url");
  const authUrl =
    `${AUTHORIZE_URL}?client_id=${encodeURIComponent(creds.clientId)}` +
    `&response_type=code&scope=${encodeURIComponent(SCOPE)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;

  log(`Authorizing "${clean}" as ${env}.`);
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

  // Bind replacement permission to the same company/environment the slug
  // already names. Re-read to catch a slug created or changed during OAuth.
  assertSafeExistingSlug(existing, {
    slug: clean,
    environment: env,
    realmId,
    replaceExisting,
  });

  const tokens = { ...(await exchangeCodeForTokens(code, env)), realmId: String(realmId) };
  const companyInfo = await getCompanyInfoWithTokens(tokens);
  // The exchange does not persist anything. Re-read after that network round
  // trip so the final identity check sits immediately in front of saveTokens.
  const current = (await listCompanies()).find((c) => c.slug === clean);
  assertSafeExistingSlug(current, {
    slug: clean,
    environment: tokens.environment ?? env,
    realmId: tokens.realmId,
    replaceExisting,
  });
  // The canonical commit rechecks slug replacement and realm uniqueness while
  // holding slug-then-realm cross-process locks; this earlier network flow does
  // not rely on a check-then-save window.
  await persistAuthorization(clean, tokens, { replaceExisting });

  const twins = (await listCompanies()).filter((c) => c.realmId === String(realmId) && c.slug !== clean);

  return {
    slug: clean,
    realmId: String(realmId),
    environment: env,
    company_name: companyInfo.CompanyName ?? null,
    legal_name: companyInfo.LegalName ?? null,
    address_state: companyInfo.CompanyAddr?.CountrySubDivisionCode ?? null,
    duplicate_slugs: twins.length ? twins.map((c) => c.slug) : undefined,
    verify: "Confirm company_name is the client you intended before any report runs.",
  };
}
