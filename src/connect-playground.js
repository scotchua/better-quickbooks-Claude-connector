// connect-playground.js — authorize a company by importing tokens minted in
// Intuit's OAuth 2.0 Playground.
//
// Why this exists alongside the catcher: Intuit rejects localhost redirect
// URIs for production apps, so SOMETHING hosted has to catch the callback.
// The catcher (connect-catcher.js) is a static page the firm hosts; this path
// removes all non-Intuit hosting by letting Intuit's own hosted playground
// catch the redirect and mint the tokens. The operator pastes the refresh
// token and realm id back here; the script immediately performs a refresh,
// which both validates the paste and hands Intuit the chance to rotate it,
// then stores the result encrypted like every other authorization.
//
// One-time setup in the Intuit app (per environment, Keys & OAuth page):
//   Redirect URIs -> add exactly:
//   https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl
//
// The pasted refresh token is read with terminal echo muted and never logged.
// It may remain valid for up to ~a day until Intuit rotates it on our first
// refresh cycle, which the completion message says out loud.

import readline from "node:readline";
import { exec } from "node:child_process";
import {
  credentials,
  refreshTokens,
  sanitizeSlug,
  qboRequest,
  listCompanies,
} from "./qbo.js";

const PLAYGROUND_URL = "https://developer.intuit.com/app/developer/playground";
export const PLAYGROUND_REDIRECT = "https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl";

const log = (...a) => console.error("[qbo-playground]", ...a);

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? `open "${url}"`
    : process.platform === "win32" ? `start "" "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, (err) => { if (err) log("Could not auto-open the browser; use the URL above."); });
}

// One readline interface serves every prompt, and answers are drained from a
// line queue: input that arrives before its question is asked (a two-line
// paste, a pipe delivering everything in one chunk) waits in the queue
// instead of being discarded between rl.question() calls. Hidden prompts echo
// * so a long-lived credential never sits in scrollback, and a closed stdin
// becomes a clean error instead of a hang.
function makePrompter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: process.stdin.isTTY === true });
  let muted = false;
  const write = rl._writeToOutput?.bind(rl);
  if (write) {
    rl._writeToOutput = (s) => { if (muted) rl.output.write("*"); else write(s); };
  }
  const queue = [];
  const waiters = [];
  let ended = false;
  rl.on("line", (line) => {
    const w = waiters.shift();
    if (w) w(line);
    else queue.push(line);
  });
  rl.on("close", () => {
    ended = true;
    while (waiters.length) waiters.shift()(null);
  });
  const nextLine = () => new Promise((resolve) => {
    if (queue.length) return resolve(queue.shift());
    if (ended) return resolve(null);
    waiters.push(resolve);
  });
  const askQ = async (question, { hidden = false } = {}) => {
    process.stderr.write(question);
    muted = hidden;
    const line = await nextLine();
    muted = false;
    if (hidden) process.stderr.write("\n");
    if (line == null) throw new Error("Input ended before the value was pasted; nothing was saved.");
    return line.trim();
  };
  return {
    ask: (q) => askQ(q),
    askHidden: (q) => askQ(q, { hidden: true }),
    close: () => rl.close(),
  };
}

// The playground labels values; people paste labels, quotes, and whitespace
// along with them. Pull the value out rather than failing on decoration.
export function cleanRealmId(pasted) {
  const m = String(pasted ?? "").match(/\d{5,}/);
  return m ? m[0] : null;
}

export function cleanRefreshToken(pasted) {
  const s = String(pasted ?? "").trim().replace(/^["']|["']$/g, "").replace(/^Refresh\s*Token\s*:?\s*/i, "").trim();
  if (!/^[A-Za-z0-9._~+/=-]{20,512}$/.test(s)) return null;
  return s;
}

/**
 * Authorize one company by importing playground-minted tokens.
 * @param {string} slug   Company slug; becomes tokens.<slug>.json.
 * @param {string} environment "production" (default) or "sandbox".
 * @param {object} opts   { openBrowserWindow = true }
 */
export async function connectViaPlayground(slug, environment = "production", { openBrowserWindow = true } = {}) {
  const clean = sanitizeSlug(slug);
  if (!clean) throw new Error("Give a company slug of letters, numbers, or hyphens.");
  credentials(environment); // fail early if .env lacks the app keys for this environment

  const existing = (await listCompanies()).find((c) => c.slug === clean);
  if (existing) {
    log(`Note: "${clean}" is already authorized (realm ${existing.realmId}, ${existing.environment}).`);
    log("Completing this will replace that authorization.");
  }

  log(`Authorizing "${clean}" as ${environment} via the Intuit OAuth Playground.`);
  log("");
  log("One-time app setup (skip if done before): on developer.intuit.com, open");
  log(`your app's Keys & OAuth page for the ${environment.toUpperCase()} environment and add`);
  log("this Redirect URI exactly:");
  log(`  ${PLAYGROUND_REDIRECT}`);
  log("");
  log("In the playground that is opening:");
  log("  1. Pick THIS app (the one whose keys are in this project's .env) and");
  log(`     the ${environment} environment. A mismatched app makes the paste fail`);
  log("     with invalid_grant.");
  log("  2. Scope: com.intuit.quickbooks.accounting. Get authorization code;");
  log("     sign into the CLIENT'S company and click Allow.");
  log("  3. Click Get tokens. Copy the Realm ID and the Refresh Token.");
  log("");
  log("PLAYGROUND_URL>>> " + PLAYGROUND_URL + " <<<");
  if (openBrowserWindow) openBrowser(PLAYGROUND_URL);

  const prompter = makePrompter();
  let realmId, refresh_token;
  try {
    const realmRaw = await prompter.ask("\nPaste the Realm ID: ");
    realmId = cleanRealmId(realmRaw);
    if (!realmId) throw new Error("That did not contain a realm id (a 5+ digit number). Nothing was saved.");

    const tokenRaw = await prompter.askHidden("Paste the Refresh Token (input hidden): ");
    refresh_token = cleanRefreshToken(tokenRaw);
    if (!refresh_token) {
      throw new Error("That did not look like a refresh token. Copy the Refresh Token field's value exactly; nothing was saved.");
    }
  } finally {
    prompter.close();
  }

  // Refresh immediately: proves the token belongs to this app, retrieves an
  // access token and real expiries, gives Intuit its rotation opportunity,
  // and persists the result encrypted (refreshTokens saves on success).
  //
  // force: true is load-bearing. Without it, re-authorizing a slug that still
  // has a fresh access token on disk short-circuits and reports success for a
  // paste that was never exchanged, and a slug with any token file would
  // refresh using the ON-DISK token instead of the pasted one. Either way the
  // import would validate nothing and import nothing.
  let tokens;
  try {
    tokens = await refreshTokens(clean, { refresh_token, realmId: String(realmId), environment },
                                { force: true });
  } catch (e) {
    throw new Error(
      `${e.message}\nMost common cause: the playground was run against a different app than the one in this project's .env, ` +
      "or the sandbox/production environment does not match. Re-mint in the playground with the right app and try again."
    );
  }

  // Confirm which file actually landed; a wrong-company authorization must
  // never pass silently (same contract as the catcher flow).
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
    environment: tokens.environment ?? environment,
    company_name: companyName,
    legal_name: legalName,
    address_state: addressState,
    duplicate_slugs: twins.length ? twins.map((c) => c.slug) : undefined,
    warning,
    rotation_note: "The pasted refresh token may stay valid up to ~24h until Intuit rotates it on refresh; the live copy is stored encrypted here and rotates automatically from now on.",
    verify: "Confirm company_name is the client you intended before any report runs.",
  };
}
