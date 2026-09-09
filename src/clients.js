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

import { open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listCompanies, sanitizeSlug } from "./qbo.js";
import { normalizeName, resolveEnvPath } from "./util.js";
import { withOwnerDirectoryLock } from "./owner-lock.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLIENTS_LOCK_TIMEOUT_MS = 30_000;
const CLIENTS_LOCK_STALE_MS = 5 * 60_000;

export function clientsPath(env = process.env) {
  return resolveEnvPath(env.QBO_CLIENTS_FILE, path.join(ROOT, "clients.json"));
}

async function loadClientDocument(p) {
  try {
    const contents = await readFile(p, "utf8");
    const raw = contents.trim();
    if (!raw) return { clients: {}, contents, exists: true };
    const parsed = JSON.parse(raw);
    return { clients: parsed.clients ?? {}, contents, exists: true };
  } catch (e) {
    if (e.code === "ENOENT") return { clients: {}, contents: null, exists: false };
    throw new Error(
      `${p} is not valid JSON (${e.message}). Fix or move it; refusing to overwrite the roster.`
    );
  }
}

export async function loadClients() {
  return (await loadClientDocument(clientsPath())).clients;
}

async function closeHandle(handle, primaryError, description) {
  try {
    await handle.close();
    return primaryError;
  } catch (closeError) {
    if (!primaryError) return closeError;
    return new AggregateError(
      [primaryError, closeError],
      `${description} failed and its file handle could not be closed.`
    );
  }
}

async function fsyncParentDirectory(file, {
  openFile = open,
  platform = process.platform,
} = {}) {
  // Node cannot portably open directory handles on Windows. The file itself is
  // still flushed there; POSIX additionally flushes create/rename metadata.
  if (platform === "win32") return;
  const handle = await openFile(path.dirname(file), "r");
  let operationError;
  try {
    await handle.sync();
  } catch (error) {
    operationError = error;
  }
  operationError = await closeHandle(handle, operationError, `Fsync of ${path.dirname(file)}`);
  if (operationError) throw operationError;
}

async function durableAtomicReplace(file, contents, {
  openFile = open,
  move = rename,
  remove = unlink,
  platform = process.platform,
  token = randomUUID,
} = {}) {
  const tmp = `${file}.${process.pid}.${token()}.tmp`;
  let tempOwned = false;
  let moved = false;
  try {
    const handle = await openFile(tmp, "wx", 0o600);
    tempOwned = true;
    let operationError;
    try {
      await handle.writeFile(contents, { encoding: "utf8" });
      await handle.sync();
    } catch (error) {
      operationError = error;
    }
    operationError = await closeHandle(handle, operationError, `Writing ${tmp}`);
    if (operationError) throw operationError;

    // Persist the complete recovery temp before publication, then persist the
    // atomic rename. A crash can leave an unused complete temp, never a torn
    // canonical roster.
    await fsyncParentDirectory(tmp, { openFile, platform });
    await move(tmp, file);
    moved = true;
    await fsyncParentDirectory(file, { openFile, platform });
  } catch (primaryError) {
    if (tempOwned && !moved) {
      try {
        await remove(tmp);
      } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") {
          throw new AggregateError(
            [primaryError, cleanupError],
            `Client-roster replacement failed and its temporary file could not be removed (${cleanupError.message}).`
          );
        }
      }
    }
    throw primaryError;
  }
}

function clientsLockPath(p) {
  return `${p}.lock`;
}

async function withClientsLock(p, fn, options = {}) {
  return withOwnerDirectoryLock(clientsLockPath(p), "client-roster update", fn, {
    timeoutMs: CLIENTS_LOCK_TIMEOUT_MS,
    staleAfterMs: CLIENTS_LOCK_STALE_MS,
    ...options,
  });
}

async function saveClients(p, clients, previousContents) {
  // A backup is part of the recovery contract. Refuse to publish the new
  // roster if an existing generation cannot first be preserved durably.
  if (previousContents != null) {
    await durableAtomicReplace(`${p}.bak`, previousContents);
  }
  await durableAtomicReplace(p, JSON.stringify({ clients }, null, 2) + "\n");
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
// back with candidates so the caller can ask. Firm workflows rely on this
// invariant: never assume a client.
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
  const p = clientsPath();
  const savedEntry = await withClientsLock(p, async () => {
    const { clients, contents: previousContents } = await loadClientDocument(p);
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

    await saveClients(p, clients, previousContents);
    return clients[clean] ?? {};
  });

  // Do not hold the roster lock while scanning token identities. No current
  // path takes those operations in the reverse order, and keeping the critical
  // section file-local makes that lock ordering explicit for future changes.
  const authorized = (await listCompanies()).some((c) => c.slug === clean);
  return {
    slug: clean,
    entry: savedEntry,
    authorized,
    warning: authorized ? undefined
      : `No tokens.${clean}.json yet, so this client is labeled but not reachable. Authorize it with connect_company.`,
    clients_file: p,
  };
}

// Narrow durability/locking hooks for focused tests. Production callers use
// registerClient so the read-modify-write cannot escape the owner-aware lock.
export const __test = Object.freeze({
  clientsLockPath,
  durableAtomicReplace,
  fsyncParentDirectory,
  withClientsLock,
});
