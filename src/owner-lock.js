// Cross-process owner-aware directory lock.
//
// The lock pathname is a directory created with atomic mkdir. Its owner is a
// uniquely named marker inside that directory:
//
//   <lock>/owner-<random UUID>.json
//
// The marker name, rather than the mutable lock pathname, is the ownership
// capability. Release and dead-owner reclamation first unlink only that exact
// marker and attempt rmdir only when that unlink succeeded. Consequently, a
// delayed observer of an old owner cannot remove a newer owner's directory:
// its old marker pathname no longer exists, so it never calls rmdir.

import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_STALE_AFTER_MS = 5 * 60_000;
const OWNER_MARKER_RE = /^owner-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/i;
const RECLAIM_MARKER_RE = /^\.reclaim-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/i;
const MAX_MARKER_BYTES = 16 * 1024;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function positiveDuration(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new TypeError(`${name} must be a finite non-negative number.`);
  }
  return number;
}

function normalizedHostname(value) {
  return String(value ?? "").trim().toLowerCase();
}

function ownerMarkerName(token) {
  const normalized = String(token ?? "").toLowerCase();
  if (!OWNER_MARKER_RE.test(`owner-${normalized}.json`)) {
    throw new Error("The lock token factory must return a UUID.");
  }
  return `owner-${normalized}.json`;
}

function cleanupGuidance(lockPath, operationLabel) {
  return (
    `Refusing to clean it up automatically. Confirm that no ${operationLabel} operation is running, ` +
    `inspect the exact lock path ${lockPath}, and remove that path manually only after its owner is known to be gone.`
  );
}

function malformedLockError(lockPath, operationLabel, detail, cause) {
  return new Error(
    `Cannot safely use the ${operationLabel} lock ${lockPath}: ${detail}. ${cleanupGuidance(lockPath, operationLabel)}`,
    cause ? { cause } : undefined
  );
}

function sameDirectory(first, second) {
  // dev+ino is the stable identity on normal local filesystems, including the
  // filesystems supported by Node on Windows. birthtime is a fail-closed
  // fallback for unusual filesystems that report no useful inode.
  if (first?.ino || second?.ino) {
    return first?.dev === second?.dev && first?.ino === second?.ino;
  }
  return first?.dev === second?.dev && first?.birthtimeMs === second?.birthtimeMs;
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
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

async function fsyncDirectory(directoryPath, {
  platform = process.platform,
  openFile = open,
} = {}) {
  // Node cannot portably open directory handles on Windows. Marker files are
  // still fsynced there; POSIX additionally flushes the directory entries.
  if (platform === "win32") return;

  const handle = await openFile(directoryPath, "r");
  let operationError;
  try {
    await handle.sync();
  } catch (error) {
    operationError = error;
  }
  operationError = await closeHandle(handle, operationError, `Fsync of ${directoryPath}`);
  if (operationError) throw operationError;
}

async function writeDurableMarkerFile(file, record, state = null) {
  const handle = await open(file, "wx", 0o600);
  if (state) state.markerPath = file;
  let operationError;
  try {
    await handle.writeFile(JSON.stringify(record), { encoding: "utf8" });
    await handle.sync();
  } catch (error) {
    operationError = error;
  }
  operationError = await closeHandle(handle, operationError, `Writing ${file}`);
  if (operationError) throw operationError;
}

async function writeOwnerMarker(markerPath, owner, state) {
  // Build and fsync outside the shared lock directory. A process death before
  // publication therefore leaves that directory empty, which has a safe
  // age-based recovery path. The owner marker appears only through atomic
  // rename after its contents are complete and durable.
  const lockPath = path.dirname(markerPath);
  const initializingPath = path.join(path.dirname(lockPath), `.owner-lock-init-${owner.token}.tmp`);
  await writeDurableMarkerFile(initializingPath, owner, state);
  await rename(initializingPath, markerPath);
  state.markerPath = markerPath;
  state.insideLock = true;
}

async function removeMarkerThenDirectory(lockPath, markerPath, {
  operationLabel,
  platform,
  missingMarkerIsRace = false,
} = {}) {
  try {
    await unlink(markerPath);
  } catch (error) {
    if (error?.code === "ENOENT" && missingMarkerIsRace) return false;
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      throw malformedLockError(
        lockPath,
        operationLabel,
        "its unique owner marker disappeared or the lock pathname changed; a replacement path will not be removed",
        error
      );
    }
    throw malformedLockError(
      lockPath,
      operationLabel,
      `its unique owner marker could not be removed (${errorMessage(error)})`,
      error
    );
  }

  // This is intentionally conditional on the unique-marker unlink above.
  // ENOTEMPTY means somebody added a replacement marker/path; rmdir preserves
  // it, and we fail closed instead of inspecting and deleting it.
  try {
    await rmdir(lockPath);
  } catch (error) {
    if (error?.code === "ENOENT" && missingMarkerIsRace) return true;
    if (["ENOTEMPTY", "EEXIST"].includes(error?.code)) {
      throw malformedLockError(
        lockPath,
        operationLabel,
        "a replacement marker or path exists; only the former owner's unique marker was removed",
        error
      );
    }
    throw malformedLockError(
      lockPath,
      operationLabel,
      `the owner marker was removed but the lock directory could not be removed (${errorMessage(error)})`,
      error
    );
  }

  await fsyncDirectory(path.dirname(lockPath), { platform });
  return true;
}

async function cleanupFailedAcquisition(lockPath, markerState, {
  operationLabel,
  platform,
} = {}) {
  if (markerState.preserveDirectory) {
    if (markerState.markerPath) {
      try {
        await unlink(markerState.markerPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    return false;
  }

  if (markerState.insideLock) {
    // We created this cryptographically unique pathname. If it disappeared,
    // do not touch the directory: ownership may have changed in the meantime.
    return removeMarkerThenDirectory(lockPath, markerState.markerPath, {
      operationLabel,
      platform,
      missingMarkerIsRace: false,
    });
  }

  if (markerState.markerPath) {
    try {
      await unlink(markerState.markerPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  // mkdir succeeded but no unique marker was ever published. We cannot prove
  // that the pathname is still our directory: another process may already
  // have age-reclaimed it and created a new, still-empty directory at the same
  // name. Never rmdir a shared pathname without first removing our unique
  // marker. Leave this one ownerless for the normal age/quarantine recovery.
  return false;
}

async function tryAcquire(lockPath, owner, {
  operationLabel,
  platform,
} = {}) {
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw new Error(`Cannot create the ${operationLabel} lock directory ${lockPath} (${errorMessage(error)}).`, {
      cause: error,
    });
  }

  const markerPath = path.join(lockPath, ownerMarkerName(owner.token));
  const markerState = { markerPath: null, insideLock: false, preserveDirectory: false };
  try {
    const createdDirectoryStat = await lstat(lockPath);
    // open("wx") makes even a UUID collision fail rather than overwrite.
    await writeOwnerMarker(markerPath, owner, markerState);
    const currentDirectoryStat = await lstat(lockPath);
    if (!currentDirectoryStat.isDirectory() || !sameDirectory(createdDirectoryStat, currentDirectoryStat)) {
      markerState.preserveDirectory = true;
      throw malformedLockError(
        lockPath,
        operationLabel,
        "the newly created lock directory was replaced during owner-marker publication"
      );
    }
    const entries = await readdir(lockPath);
    if (entries.length !== 1 || entries[0] !== path.basename(markerPath)) {
      throw malformedLockError(
        lockPath,
        operationLabel,
        "an unexpected replacement marker or path appeared during owner-marker publication"
      );
    }
    await fsyncDirectory(lockPath, { platform });
    await fsyncDirectory(path.dirname(lockPath), { platform });
    return true;
  } catch (acquisitionError) {
    let cleanupError;
    try {
      await cleanupFailedAcquisition(lockPath, markerState, {
        operationLabel,
        platform,
      });
    } catch (error) {
      cleanupError = error;
    }
    if (cleanupError) {
      throw new AggregateError(
        [acquisitionError, cleanupError],
        `Could not initialize the ${operationLabel} lock and could not safely clean up its directory.`
      );
    }
    throw acquisitionError;
  }
}

function parseLockMarker(raw, token, markerName, lockPath, operationLabel) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw malformedLockError(
      lockPath,
      operationLabel,
      `lock marker ${markerName} is not valid JSON`,
      error
    );
  }
  const pid = Number(parsed?.pid);
  const markerToken = String(parsed?.token ?? "").toLowerCase();
  const ownerHostname = String(parsed?.hostname ?? "").trim();
  const createdAt = String(parsed?.created_at ?? "");
  if (parsed?.version !== 1 || !Number.isInteger(pid) || pid <= 0 ||
      !ownerHostname || markerToken !== token.toLowerCase() ||
      !Number.isFinite(Date.parse(createdAt))) {
    throw malformedLockError(
      lockPath,
      operationLabel,
      `lock marker ${markerName} is incomplete, inconsistent, or from an unsupported lock format`
    );
  }
  return {
    version: 1,
    pid,
    hostname: ownerHostname,
    token: markerToken,
    created_at: createdAt,
  };
}

async function inspectLock(lockPath, operationLabel, {
  platform = process.platform,
  openMarkerFile = open,
} = {}) {
  let directoryStat;
  try {
    directoryStat = await lstat(lockPath);
  } catch (error) {
    if (error?.code === "ENOENT") return { kind: "missing" };
    throw malformedLockError(
      lockPath,
      operationLabel,
      `the lock pathname cannot be inspected (${errorMessage(error)})`,
      error
    );
  }

  // Old implementations used a file at this pathname. Automatically unlinking
  // a legacy/malformed file would reintroduce the pathname TOCTOU this module
  // exists to avoid, so migration fails closed with manual guidance.
  if (!directoryStat.isDirectory()) {
    throw malformedLockError(
      lockPath,
      operationLabel,
      "the pathname is a legacy or malformed file/symlink rather than an owner-lock directory"
    );
  }

  let entries;
  try {
    entries = await readdir(lockPath, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { kind: "missing" };
    throw malformedLockError(
      lockPath,
      operationLabel,
      `the lock directory cannot be read (${errorMessage(error)})`,
      error
    );
  }
  if (entries.length === 0) return { kind: "empty", stat: directoryStat };
  if (entries.length !== 1) {
    throw malformedLockError(
      lockPath,
      operationLabel,
      `the lock directory contains ${entries.length} entries instead of one unique owner marker`
    );
  }

  const entry = entries[0];
  const ownerMatch = OWNER_MARKER_RE.exec(entry.name);
  const reclaimMatch = RECLAIM_MARKER_RE.exec(entry.name);
  const match = ownerMatch ?? reclaimMatch;
  if (!entry.isFile() || !match) {
    throw malformedLockError(
      lockPath,
      operationLabel,
      `the lock directory contains unexpected path ${JSON.stringify(entry.name)}`
    );
  }
  const token = match[1].toLowerCase();
  const markerPath = path.join(lockPath, entry.name);
  let markerStat;
  let handle;
  try {
    markerStat = await lstat(markerPath);
    if (!markerStat.isFile() || markerStat.size > MAX_MARKER_BYTES) {
      throw malformedLockError(
        lockPath,
        operationLabel,
        `lock marker ${entry.name} is not a small regular file`
      );
    }
    handle = await openMarkerFile(markerPath, "r");
    const openedStat = await handle.stat();
    if (!sameDirectory(markerStat, openedStat)) {
      throw malformedLockError(
        lockPath,
        operationLabel,
        `lock marker ${entry.name} changed while it was being inspected`
      );
    }
    const raw = await handle.readFile("utf8");
    const owner = parseLockMarker(raw, token, entry.name, lockPath, operationLabel);
    return {
      kind: ownerMatch ? "owned" : "reclaiming",
      stat: directoryStat,
      markerPath,
      markerName: entry.name,
      owner,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { kind: "changed" };
    // Windows can report EPERM when an owner has unlinked its marker but the
    // directory entry is still in the filesystem's delete-pending state. This
    // observation is never authoritative: the caller may wait and inspect the
    // complete lock again, but must not reclaim or remove anything because of
    // it. A persistent EPERM is bounded by the normal acquisition deadline and
    // ultimately fails closed with manual-cleanup guidance.
    if (platform === "win32" && error?.code === "EPERM") {
      return {
        kind: "transient",
        markerName: entry.name,
        cause: error,
      };
    }
    if (error?.message?.startsWith(`Cannot safely use the ${operationLabel} lock`)) throw error;
    throw malformedLockError(
      lockPath,
      operationLabel,
      `lock marker ${entry.name} cannot be read (${errorMessage(error)})`,
      error
    );
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch (error) {
        throw malformedLockError(
          lockPath,
          operationLabel,
          `lock marker ${entry.name} could not be closed after inspection (${errorMessage(error)})`,
          error
        );
      }
    }
  }
}

async function reclaimDeadOwner(lockPath, observed, {
  operationLabel,
  platform,
} = {}) {
  // A later process that observed this owner may arrive after another
  // reclaimer removed it and a new owner acquired the pathname. The old marker
  // has a different UUID, so ENOENT returns false WITHOUT calling rmdir.
  return removeMarkerThenDirectory(lockPath, observed.markerPath, {
    operationLabel,
    platform,
    missingMarkerIsRace: true,
  });
}

async function removeUniqueClaim(claimPath) {
  try {
    await unlink(claimPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function reclaimOldEmptyDirectory(lockPath, observed, {
  operationLabel,
  platform,
  tokenFactory,
  localHostname,
  now,
  afterEmptyLockIsolated,
} = {}) {
  // Empty lock directories can result from a crash between mkdir and owner
  // marker publication. Publish a complete owner-aware reclaim claim before
  // moving the directory. If this process dies, another local process can
  // verify the claim PID is dead and reclaim its exact unique marker.
  const claimToken = String(tokenFactory()).toLowerCase();
  ownerMarkerName(claimToken); // reuse the strict UUID validator
  const claimName = `.reclaim-${claimToken}.json`;
  const claimPath = path.join(lockPath, claimName);
  const parent = path.dirname(lockPath);
  const claimTemp = path.join(parent, `.owner-lock-reclaim-init-${claimToken}.tmp`);
  const claimOwner = {
    version: 1,
    pid: process.pid,
    hostname: String(localHostname),
    token: claimToken,
    created_at: new Date(Number(now)).toISOString(),
  };
  let claimPublished = false;
  try {
    await writeDurableMarkerFile(claimTemp, claimOwner);
    await rename(claimTemp, claimPath);
    claimPublished = true;
    await fsyncDirectory(lockPath, { platform });
  } catch (error) {
    let cleanupError;
    try {
      if (claimPublished) {
        await removeMarkerThenDirectory(lockPath, claimPath, {
          operationLabel,
          platform,
          missingMarkerIsRace: true,
        });
      } else {
        await unlink(claimTemp).catch((cleanup) => {
          if (cleanup?.code !== "ENOENT") throw cleanup;
        });
      }
    } catch (cleanup) {
      cleanupError = cleanup;
    }
    if (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Could not publish the ${operationLabel} empty-directory reclaim claim and could not safely clean it up.`
      );
    }
    if (["ENOENT", "EEXIST"].includes(error?.code)) return false;
    throw malformedLockError(
      lockPath,
      operationLabel,
      `the old empty directory could not be claimed safely (${errorMessage(error)})`,
      error
    );
  }

  let currentStat;
  try {
    currentStat = await lstat(lockPath);
  } catch (error) {
    await removeUniqueClaim(claimPath).catch(() => {});
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (!currentStat.isDirectory() || !sameDirectory(observed.stat, currentStat)) {
    // The unique claim may have landed in a replacement directory. Remove only
    // that claim; never rmdir a directory different from the one observed.
    await removeUniqueClaim(claimPath);
    return false;
  }

  let entries;
  try {
    entries = await readdir(lockPath);
  } catch (error) {
    await removeUniqueClaim(claimPath).catch(() => {});
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (entries.length !== 1 || entries[0] !== claimName) {
    // Another reclaimer or an unexpected path won the race. Remove only our
    // claim and let a fresh observation decide what remains.
    await removeUniqueClaim(claimPath);
    return false;
  }
  // Do not rmdir the shared lock pathname. Move the directory, while our claim
  // pins its identity, into a unique sibling container first. A new owner can
  // then acquire lockPath without any delayed rmdir being able to touch it.
  const quarantineContainer = path.join(parent, `.owner-lock-reclaim-${claimToken}`);
  const quarantinedLock = path.join(quarantineContainer, "lock");
  let containerCreated = false;
  try {
    await mkdir(quarantineContainer, { mode: 0o700 });
    containerCreated = true;
    await rename(lockPath, quarantinedLock);
    await fsyncDirectory(parent, { platform });
  } catch (error) {
    // Remove only our unique claim from the original path. If the directory
    // moved or changed, ENOENT leaves the replacement untouched.
    await removeMarkerThenDirectory(lockPath, claimPath, {
      operationLabel,
      platform,
      missingMarkerIsRace: true,
    }).catch(() => {});
    if (containerCreated) await rmdir(quarantineContainer).catch(() => {});
    if (["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error?.code)) return false;
    throw malformedLockError(
      lockPath,
      operationLabel,
      `the old empty directory could not be isolated safely (${errorMessage(error)})`,
      error
    );
  }

  const quarantinedClaim = path.join(quarantinedLock, claimName);
  try {
    await afterEmptyLockIsolated({ lockPath, quarantineContainer, quarantinedLock });
    if (!(await removeUniqueClaim(quarantinedClaim))) {
      throw new Error("the unique empty-directory claim disappeared after isolation");
    }
    await rmdir(quarantinedLock);
    await rmdir(quarantineContainer);
    await fsyncDirectory(parent, { platform });
  } catch (error) {
    // Any competing/replacement path remains isolated under the unique
    // quarantine container. It is never removed recursively or by pathname.
    throw malformedLockError(
      lockPath,
      operationLabel,
      `the old empty directory was isolated at ${quarantineContainer}, but a replacement path prevented safe cleanup (${errorMessage(error)})`,
      error
    );
  }
  return true;
}

function timeoutError(lockPath, operationLabel, timeoutMs, observed) {
  let heldBy = "an owner whose identity could not be verified";
  if (["owned", "reclaiming"].includes(observed?.kind)) {
    heldBy = `process ${observed.owner.pid} on ${observed.owner.hostname}`;
  } else if (observed?.kind === "empty") {
    heldBy = "a newly created ownerless directory";
  }
  return new Error(
    `Timed out after ${timeoutMs}ms waiting for the ${operationLabel} lock ${lockPath}, held by ${heldBy}. ` +
    cleanupGuidance(lockPath, operationLabel)
  );
}

/**
 * Run `fn` while exclusively owning a cross-process directory lock.
 *
 * `now`, `wait`, `localHostname`, and `isProcessAlive` are injectable so the
 * timeout/liveness policy is deterministic in focused tests. `platform`,
 * `tokenFactory`, and `openMarkerFile` are narrow portability/test hooks;
 * production callers should normally omit the entire options object.
 * `afterEmptyLockIsolated` exists only for deterministic failure injection
 * around the quarantine boundary.
 */
export async function withOwnerDirectoryLock(lockPath, operationLabel, fn, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  now = Date.now,
  wait = sleep,
  localHostname = hostname(),
  isProcessAlive = processIsAlive,
  platform = process.platform,
  tokenFactory = randomUUID,
  openMarkerFile = open,
  afterEmptyLockIsolated = async () => {},
} = {}) {
  if (typeof fn !== "function") throw new TypeError("Lock callback must be a function.");
  if (typeof now !== "function" || typeof wait !== "function" ||
      typeof isProcessAlive !== "function" || typeof tokenFactory !== "function" ||
      typeof openMarkerFile !== "function" ||
      typeof afterEmptyLockIsolated !== "function") {
    throw new TypeError("Lock timing, liveness, token, and marker-file hooks must be functions.");
  }
  const label = String(operationLabel ?? "operation").trim() || "operation";
  const timeout = positiveDuration(timeoutMs, "timeoutMs");
  const staleAfter = positiveDuration(staleAfterMs, "staleAfterMs");
  const startedAt = Number(now());
  if (!Number.isFinite(startedAt)) throw new TypeError("now() must return a finite millisecond timestamp.");
  const localHost = String(localHostname ?? "").trim();
  if (!localHost) throw new TypeError("localHostname must be a non-empty string.");
  const deadline = startedAt + timeout;
  const token = String(tokenFactory()).toLowerCase();
  ownerMarkerName(token); // validate before creating any filesystem state
  const owner = {
    version: 1,
    pid: process.pid,
    hostname: localHost,
    token,
    created_at: new Date(startedAt).toISOString(),
  };

  let lastObserved;
  for (;;) {
    if (await tryAcquire(lockPath, owner, { operationLabel: label, platform })) break;

    const observed = await inspectLock(lockPath, label, { platform, openMarkerFile });
    lastObserved = observed;
    if (["missing", "changed"].includes(observed.kind)) continue;
    if (observed.kind === "transient") {
      const currentTime = Number(now());
      if (!Number.isFinite(currentTime)) throw new TypeError("now() must return a finite millisecond timestamp.");
      if (currentTime >= deadline) {
        throw malformedLockError(
          lockPath,
          label,
          `lock marker ${observed.markerName} remained unreadable on Windows until the ${timeout}ms wait deadline ` +
            `(${observed.cause?.code ?? "error"}: ${errorMessage(observed.cause)})`,
          observed.cause
        );
      }
      await wait(Math.max(1, Math.min(50, deadline - currentTime)));
      continue;
    }

    let reclaimed = false;
    if (observed.kind === "empty") {
      const observedAt = Number(now());
      if (!Number.isFinite(observedAt)) throw new TypeError("now() must return a finite millisecond timestamp.");
      if (observedAt - observed.stat.mtimeMs >= staleAfter) {
        reclaimed = await reclaimOldEmptyDirectory(lockPath, observed, {
          operationLabel: label,
          platform,
          tokenFactory,
          localHostname: localHost,
          now: observedAt,
          afterEmptyLockIsolated,
        });
      }
    } else {
      const remoteOwner = normalizedHostname(observed.owner.hostname) !== normalizedHostname(localHost);
      if (!remoteOwner) {
        let alive;
        try {
          alive = await isProcessAlive(observed.owner.pid);
        } catch (error) {
          throw malformedLockError(
            lockPath,
            label,
            `the local owner process ${observed.owner.pid} cannot be checked (${errorMessage(error)})`,
            error
          );
        }
        if (!alive) {
          reclaimed = await reclaimDeadOwner(lockPath, observed, {
            operationLabel: label,
            platform,
          });
        }
      }
    }
    if (reclaimed) continue;

    const currentTime = Number(now());
    if (!Number.isFinite(currentTime)) throw new TypeError("now() must return a finite millisecond timestamp.");
    if (currentTime >= deadline) throw timeoutError(lockPath, label, timeout, lastObserved);
    await wait(Math.max(1, Math.min(50, deadline - currentTime)));
  }

  let result;
  let operationError;
  try {
    result = await fn();
  } catch (error) {
    operationError = error;
  }

  let releaseError;
  try {
    await removeMarkerThenDirectory(lockPath, path.join(lockPath, ownerMarkerName(owner.token)), {
      operationLabel: label,
      platform,
      missingMarkerIsRace: false,
    });
  } catch (error) {
    releaseError = error;
  }

  if (operationError && releaseError) {
    throw new AggregateError(
      [operationError, releaseError],
      `The ${label} operation failed (${errorMessage(operationError)}) and its lock could not be released (${errorMessage(releaseError)}).`
    );
  }
  if (operationError) throw operationError;
  if (releaseError) throw releaseError;
  return result;
}

// Narrowly exposed for focused portability assertions. Production integration
// needs only withOwnerDirectoryLock.
export const __test = Object.freeze({
  fsyncDirectory,
  ownerMarkerName,
  cleanupFailedAcquisition,
});
