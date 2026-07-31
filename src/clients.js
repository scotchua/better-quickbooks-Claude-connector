// clients.js: the connector's client roster.
//
// Authorization is the truth for "is this client reachable": a company exists
// here because there is a tokens.<slug>.json for it. This file adds only the
// human layer that QuickBooks and the filesystem cannot supply: what the firm
// calls the client, what people type instead of the slug, what kind of
// engagement it is, and where its working folder lives.
//
// Keeping those separate matters. If this file became the list of clients, it
// would drift from the authorizations and every downstream skill would trust a
// roster that no longer matches reality. So list_clients reports drift in both
// directions rather than hiding it: authorized-but-unlabeled, and
// labeled-but-not-authorized.
//
// Stored as clients.json next to the token files (gitignored, since client
// names are not repo content). QBO_CLIENTS_FILE overrides the path.

import { readFile, writeFile, rename, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listCompanies, sanitizeSlug } from "./qbo.js";
import { normalizeName } from "./util.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export function clientsPath() {
  return process.env.QBO_CLIENTS_FILE || path.join(ROOT, "clients.json");
}

export async function loadClients() {
  try {
    const raw = (await readFile(clientsPath(), "utf8")).trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed.clients ?? {};
  } catch (e) {
    if (e.code === "ENOENT") return {};
    throw new Error(
      `${clientsPath()} is not valid JSON (${e.message}). Fix or move it; refusing to overwrite the roster.`
    );
  }
}

async function saveClients(clients) {
  const p = clientsPath();
  try { await copyFile(p, `${p}.bak`); } catch { /* nothing to back up yet */ }
  const tmp = `${p}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ clients }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await rename(tmp, p);
}

// Every searchable label for one entry, normalized for tolerant comparison.
function labelsFor(slug, entry) {
  return [slug, entry?.name, entry?.company_name, ...(entry?.aliases || [])]
    .filter(Boolean)
    .map(normalizeName);
}

// The roster: authorized companies joined to their metadata, plus drift.
export async function roster() {
  const [companies, clients] = await Promise.all([listCompanies(), loadClients()]);
  const rows = companies.map((c) => {
    const meta = clients[c.slug] || {};
    return {
      slug: c.slug,
      name: meta.name ?? meta.company_name ?? null,
      realmId: c.realmId,
      environment: c.environment,
      aliases: meta.aliases?.length ? meta.aliases : undefined,
      engagement: meta.engagement ?? undefined,
      service_lines: meta.service_lines?.length ? meta.service_lines : undefined,
      data_folder: meta.data_folder ?? undefined,
      labeled: Object.keys(meta).length > 0,
    };
  });
  const authorized = new Set(companies.map((c) => c.slug));
  return {
    clients: rows,
    unlabeled: rows.filter((r) => !r.labeled).map((r) => r.slug),
    labeled_but_not_authorized: Object.keys(clients).filter((s) => !authorized.has(s)),
  };
}

// Resolve what a person typed to a slug. Never guesses: an ambiguous term comes
// back with candidates so the caller can ask, which is the same contract the
// MHPE skills hold about never assuming a client.
export async function resolveClient(term) {
  const wanted = normalizeName(term);
  if (!wanted) throw new Error("Give a client name, alias, or slug to resolve.");
  const { clients: rows } = await roster();
  const metadata = await loadClients();

  const exactSlug = rows.find((r) => r.slug === sanitizeSlug(term));
  if (exactSlug) return { match: exactSlug, how: "slug" };

  const exact = rows.filter((r) => labelsFor(r.slug, metadata[r.slug]).includes(wanted));
  if (exact.length === 1) return { match: exact[0], how: "exact name or alias" };
  if (exact.length > 1) return { candidates: exact, how: "ambiguous exact match" };

  const partial = rows.filter((r) =>
    labelsFor(r.slug, metadata[r.slug]).some((l) => l.includes(wanted) || wanted.includes(l))
  );
  if (partial.length === 1) return { match: partial[0], how: "partial name or alias" };
  if (partial.length > 1) return { candidates: partial, how: "ambiguous partial match" };
  return { candidates: [], how: "no match", all: rows.map((r) => ({ slug: r.slug, name: r.name })) };
}

// Add or update one client's labels. Only touches the keys provided, so a
// later call adding an alias cannot wipe the engagement type.
export async function registerClient(slug, patch = {}) {
  const clean = sanitizeSlug(slug);
  if (!clean) throw new Error("slug must contain at least one letter, number, or hyphen.");
  const clients = await loadClients();
  const entry = { ...(clients[clean] || {}) };

  if (patch.name !== undefined) entry.name = patch.name || undefined;
  if (patch.company_name !== undefined) entry.company_name = patch.company_name || undefined;
  if (patch.engagement !== undefined) entry.engagement = patch.engagement || undefined;
  if (patch.data_folder !== undefined) entry.data_folder = patch.data_folder || undefined;
  if (patch.service_lines !== undefined) {
    entry.service_lines = patch.service_lines?.length ? [...new Set(patch.service_lines)] : undefined;
  }
  if (patch.aliases !== undefined) {
    // Merge rather than replace: aliases accumulate as people type new short
    // forms, and losing one silently reintroduces the guessing problem.
    const merged = new Set([...(entry.aliases || []), ...(patch.aliases || [])].filter(Boolean));
    entry.aliases = merged.size ? [...merged] : undefined;
  }
  if (patch.remove_aliases?.length) {
    const drop = new Set(patch.remove_aliases.map(normalizeName));
    const kept = (entry.aliases || []).filter((a) => !drop.has(normalizeName(a)));
    entry.aliases = kept.length ? kept : undefined;
  }

  for (const k of Object.keys(entry)) if (entry[k] === undefined) delete entry[k];
  if (Object.keys(entry).length === 0) delete clients[clean];
  else clients[clean] = entry;

  await saveClients(clients);
  const authorized = (await listCompanies()).some((c) => c.slug === clean);
  return {
    slug: clean,
    entry: clients[clean] ?? {},
    authorized,
    warning: authorized ? undefined
      : `No tokens.${clean}.json yet, so this client is labeled but not reachable. Authorize it with connect_company.`,
    clients_file: clientsPath(),
  };
}
