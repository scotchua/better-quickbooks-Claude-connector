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
// The pasted refresh token is read with terminal echo muted, never logged, and
// immediately exchanged; only the returned live token is stored.

import readline from "node:readline";
import { spawn } from "node:child_process";
import {
  credentials,
  importRefreshToken,
  recoverStagedTokenImport,
  assertSlug,
  getCompanyInfoWithTokens,
  listCompanies,
} from "./qbo.js";

const PLAYGROUND_URL = "https://developer.intuit.com/app/developer/playground";
export const PLAYGROUND_REDIRECT = "https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl";

const log = (...a) => console.error("[qbo-playground]", ...a);

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

// Keep this validation local to the playground entry point so neither
// authorization flow has to depend on the other's browser/prompt machinery.
// It runs before prompting and again before the refresh exchange and final
// save, so replacement authority stays bound to one realm and environment.
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
      `${existing.environment}, but the playground supplied realm ${realmId} in ${environment}. Refusing to overwrite it; ` +
      `use a new slug for a different company.`
    );
  }
}

/**
 * Authorize one company by importing playground-minted tokens.
 * @param {string} slug   Company slug; becomes tokens.<slug>.json.
 * @param {string} environment "production" (default) or "sandbox".
 * @param {object} opts   { openBrowserWindow = true, replaceExisting = false }
 */
export async function connectViaPlayground(
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

  // Refuse before credential checks, browser launch, and secret input. This
  // makes accidental replacement the default-impossible path.
  const existing = (await listCompanies()).find((c) => c.slug === clean);
  assertSafeExistingSlug(existing, { slug: clean, environment: env, replaceExisting });
  credentials(env); // fail early if .env lacks the app keys for this environment

  const validateFreshTokens = (expectedRealm) => async (tokens) => {
    if (String(tokens.environment ?? "").toLowerCase() !== env) {
      throw new Error(`The staged authorization is ${tokens.environment ?? "an unknown environment"}, not ${env}.`);
    }
    if (expectedRealm != null && String(tokens.realmId) !== String(expectedRealm)) {
      throw new Error(`The refreshed authorization returned realm ${tokens.realmId}, not the supplied realm ${expectedRealm}.`);
    }
    const companyInfo = await getCompanyInfoWithTokens(tokens);
    const latest = (await listCompanies()).find((c) => c.slug === clean);
    assertSafeExistingSlug(latest, {
      slug: clean,
      environment: tokens.environment ?? env,
      realmId: tokens.realmId,
      replaceExisting,
    });
    return companyInfo;
  };

  const finish = async ({ tokens, validation: companyInfo }, recovered = false) => {
    const twins = (await listCompanies()).filter(
      (c) => c.realmId === String(tokens.realmId) && c.slug !== clean
    );
    return {
      slug: clean,
      realmId: String(tokens.realmId),
      environment: tokens.environment ?? env,
      company_name: companyInfo.CompanyName ?? null,
      legal_name: companyInfo.LegalName ?? null,
      address_state: companyInfo.CompanyAddr?.CountrySubDivisionCode ?? null,
      duplicate_slugs: twins.length ? twins.map((c) => c.slug) : undefined,
      rotation_note: recovered
        ? "Recovered the encrypted credential staged by an interrupted Playground import, verified it, and promoted it atomically."
        : "The pasted credential was immediately exchanged, staged encrypted, verified, and promoted. Every successful Intuit token response is stored; the refresh-token value may rotate periodically. Do not retain or reuse the pasted value.",
      verify: "Confirm company_name is the client you intended before any report runs.",
    };
  };

  // A prior run may have received newer token state and then stopped
  // during CompanyInfo verification. Resume that encrypted candidate before
  // opening a browser or asking the operator to mint another credential.
  const recovered = await recoverStagedTokenImport(clean, {
    validate: validateFreshTokens(existing?.realmId),
    replaceExisting,
  });
  if (recovered) return finish(recovered, true);

  if (existing) {
    log(`Note: "${clean}" is already authorized (realm ${existing.realmId}, ${existing.environment}).`);
    log("Replacement was explicitly authorized; the pasted realm must match before anything is refreshed.");
  }

  log(`Authorizing "${clean}" as ${env} via the Intuit OAuth Playground.`);
  log("");
  log("One-time app setup (skip if done before): on developer.intuit.com, open");
  log(`your app's Keys & OAuth page for the ${env.toUpperCase()} environment and add`);
  log("this Redirect URI exactly:");
  log(`  ${PLAYGROUND_REDIRECT}`);
  log("");
  log("In the playground that is opening:");
  log("  1. Pick THIS app (the one whose keys are in this project's .env) and");
  log(`     the ${env} environment. A mismatched app makes the paste fail`);
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

  // Bind replacement authority to the existing realm/environment and re-read
  // immediately before the refreshable credential is exchanged.
  assertSafeExistingSlug(existing, {
    slug: clean,
    environment: env,
    realmId,
    replaceExisting,
  });
  const current = (await listCompanies()).find((c) => c.slug === clean);
  assertSafeExistingSlug(current, {
    slug: clean,
    environment: env,
    realmId,
    replaceExisting,
  });

  // Refresh immediately: proves the token belongs to this app, retrieves an
  // access token and real expiries, and gives Intuit its rotation opportunity.
  // qbo.js holds one cross-process lock across exchange, encrypted durable
  // staging, CompanyInfo verification, and canonical promotion.
  //
  // force: true is load-bearing. Without it, re-authorizing a slug that still
  // has a fresh access token on disk short-circuits and reports success for a
  // paste that was never exchanged, and a slug with any token file would
  // refresh using the ON-DISK token instead of the pasted one. Either way the
  // import would validate nothing and import nothing.
  let imported;
  try {
    imported = await importRefreshToken(
      clean,
      { refresh_token, realmId: String(realmId), environment: env },
      { validate: validateFreshTokens(realmId), replaceExisting }
    );
  } catch (e) {
    if (e?.refreshOutcomeQuarantined === true) {
      throw new Error(e.message, { cause: e });
    }
    throw new Error(
      `${e.message}\nMost common cause: the playground was run against a different app than the one in this project's .env, ` +
      "or the sandbox/production environment does not match. If the error says an encrypted credential was staged, " +
      "fix the verification problem and rerun this same command before minting another token. Otherwise re-mint in " +
      "the playground with the right app and try again."
    );
  }
  return finish(imported);
}
