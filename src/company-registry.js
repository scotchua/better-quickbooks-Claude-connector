// company-registry.js: the single scan that answers "which companies are
// authorized, and which QuickBooks realm does each one address".
//
// This lives on its own because two layers need it and they must not disagree.
// qbo.js needs it to resolve a call target; policy.js needs it to resolve write
// guardrails by REALM rather than by slug. Having policy.js import qbo.js would
// be circular (qbo.js already imports policy.js), and having each keep its own
// copy of the scan would let them drift apart silently, which is the worst of
// the three options for a safety control.
//
// Only realmId and environment are read, and both are stored in plaintext
// precisely so this scan needs no encryption key and no network call.

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// Retaining a token file without exposing it as a company is a matter of WHERE
// it lives, not what it is called: this scan does not recurse, so anything
// parked in backups/ is kept and ignored.
const LEGACY_HIDDEN_SLUG = "sandbox-backup";
let warnedLegacyBackup = false;

function log(...args) {
  console.error("[qbo]", ...args);
}

async function scanAuthorizationFiles({ includeDefault = false } = {}) {
  let files = [];
  try {
    files = await readdir(ROOT);
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    const m = /^tokens\.(.+)\.json$/.exec(f);
    const isDefault = f === "tokens.json";
    if (!m && !(includeDefault && isDefault)) continue;
    const slug = isDefault ? "" : m[1];
    if (slug === LEGACY_HIDDEN_SLUG && !warnedLegacyBackup) {
      warnedLegacyBackup = true;
      log(`tokens.${LEGACY_HIDDEN_SLUG}.json is no longer hidden by name. Move it to ` +
          `backups/ to keep it out of the company list, or rename it if it is a real company.`);
    }
    if (!isDefault && !/^[A-Za-z0-9_-]+$/.test(slug)) {
      throw new Error(`Token filename ${f} contains an invalid company slug. Move it to backups/ or rename it explicitly.`);
    }
    try {
      const d = JSON.parse(await readFile(path.join(ROOT, f), "utf8"));
      out.push({ slug, realmId: d.realmId ?? null, environment: d.environment ?? null });
    } catch (e) {
      // Another process may disconnect or atomically replace a company after
      // readdir. A file that genuinely vanished is not corrupt and will be
      // discovered on the next call if it reappears.
      if (e.code === "ENOENT") continue;
      throw new Error(
        `Token file ${f} exists but cannot be read as valid JSON (${e.message}). ` +
        `It is not being hidden as a disconnected company; repair or move it to backups/.`
      );
    }
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * Every named company exposed to users as
 * [{ slug, realmId, environment }], sorted by slug.
 *
 * The legacy default tokens.json deliberately stays out of the user-facing
 * roster because it has no slug that a multi-company caller can select.
 */
export async function listAuthorizedCompanies() {
  return scanAuthorizationFiles();
}

/**
 * Every persisted OAuth identity, including the legacy default tokens.json as
 * slug "". Authorization uniqueness checks use this broader view: hiding the
 * default from the company picker must not let the same realm be authorized a
 * second time under a named slug.
 */
export async function listAuthorizationIdentities() {
  return scanAuthorizationFiles({ includeDefault: true });
}

/**
 * Every slug that addresses the SAME books as `slug`, including itself.
 *
 * A realm is the set of books; a slug is a local nickname in a filename. Write
 * guardrails protect books, so this is the set a policy decision must consider.
 * Returns [slug] unchanged when the slug is unknown or has no recorded realm.
 * The legacy default ("") participates when it shares a realm with a named
 * authorization; otherwise a stricter policy on either alias could be bypassed.
 */
export async function realmSiblingSlugs(slug, companies = null) {
  const clean = String(slug ?? "");
  const list = companies ?? await listAuthorizationIdentities();
  const self = list.find((c) => c.slug === clean);
  if (!self || self.realmId == null) return [clean];
  const siblings = list
    .filter((c) => String(c.realmId) === String(self.realmId))
    .map((c) => c.slug);
  return siblings.length ? siblings : [clean];
}

/**
 * Realms addressed by more than one slug, as [{ realmId, slugs, environments }].
 * A duplicate is an operational defect: provenance, audit, and guardrails all
 * key off identity, and two names for one set of books make each ambiguous.
 */
export async function duplicateRealms(companies = null) {
  const list = companies ?? await listAuthorizationIdentities();
  const byRealm = new Map();
  for (const c of list) {
    if (c.realmId == null) continue;
    const key = String(c.realmId);
    if (!byRealm.has(key)) byRealm.set(key, []);
    byRealm.get(key).push(c);
  }
  return [...byRealm.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([realmId, rows]) => ({
      realmId,
      slugs: rows.map((r) => r.slug),
      environments: [...new Set(rows.map((r) => r.environment))],
    }));
}
