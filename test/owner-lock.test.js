import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { tmpdir } from "node:os";
import { withOwnerDirectoryLock, __test } from "../src/owner-lock.js";

const DEAD_PID = 2_147_483_647;
let tokenCounter = 0;

function token() {
  tokenCounter += 1;
  return `00000000-0000-4000-8000-${tokenCounter.toString(16).padStart(12, "0")}`;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function createOwnedLock(lockPath, {
  pid = DEAD_PID,
  ownerHostname = hostname(),
  ownerToken = token(),
  markerPrefix = "owner-",
  createdAt = new Date().toISOString(),
} = {}) {
  await mkdir(lockPath, { mode: 0o700 });
  const marker = path.join(lockPath, `${markerPrefix}${ownerToken}.json`);
  await writeFile(marker, JSON.stringify({
    version: 1,
    pid,
    hostname: ownerHostname,
    token: ownerToken,
    created_at: createdAt,
  }));
  return marker;
}

async function markerAt(lockPath) {
  const entries = await readdir(lockPath);
  expect(entries).toHaveLength(1);
  const markerPath = path.join(lockPath, entries[0]);
  return { markerPath, owner: JSON.parse(await readFile(markerPath, "utf8")) };
}

describe("withOwnerDirectoryLock", () => {
  let directory;
  let lockPath;

  beforeEach(async () => {
    tokenCounter = 0;
    directory = await mkdtemp(path.join(tmpdir(), "qbo-owner-lock-"));
    lockPath = path.join(directory, "operation.lock");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("serializes overlapping owners and exposes a complete unique marker before entry", async () => {
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const order = [];

    const first = withOwnerDirectoryLock(lockPath, "test operation", async () => {
      order.push("first-enter");
      const { owner } = await markerAt(lockPath);
      expect(owner).toMatchObject({ version: 1, pid: process.pid, hostname: hostname() });
      expect(owner.token).toMatch(/^[0-9a-f-]{36}$/);
      firstEntered.resolve();
      await releaseFirst.promise;
      order.push("first-exit");
      return "first-result";
    });

    await firstEntered.promise;
    const second = withOwnerDirectoryLock(lockPath, "test operation", async () => {
      order.push("second-enter");
      const { owner } = await markerAt(lockPath);
      expect(owner.pid).toBe(process.pid);
      order.push("second-exit");
      return "second-result";
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(order).toEqual(["first-enter"]);
    releaseFirst.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual(["first-result", "second-result"]);
    expect(order).toEqual(["first-enter", "first-exit", "second-enter", "second-exit"]);
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("releases after an operation error and preserves the original error", async () => {
    const failure = new Error("critical section failed");
    await expect(withOwnerDirectoryLock(lockPath, "test operation", async () => {
      throw failure;
    })).rejects.toBe(failure);
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("combines operation and release failures while preserving a replacement path", async () => {
    let replacement;
    const thrown = await withOwnerDirectoryLock(lockPath, "test operation", async () => {
      replacement = path.join(lockPath, "replacement-owner");
      await mkdir(replacement);
      throw new Error("operation exploded");
    }).catch((error) => error);

    expect(thrown).toBeInstanceOf(AggregateError);
    expect(thrown.errors).toHaveLength(2);
    expect(thrown.errors[0].message).toBe("operation exploded");
    expect(thrown.errors[1].message).toMatch(/replacement marker or path exists/i);
    await expect(stat(replacement)).resolves.toBeTruthy();
  });

  it("never steals a live local owner, even when its marker is old", async () => {
    const marker = await createOwnedLock(lockPath, { pid: process.pid });
    const old = new Date(Date.now() - 86_400_000);
    await utimes(marker, old, old);
    let clock = 0;
    const isProcessAlive = vi.fn(() => true);
    let entered = false;

    await expect(withOwnerDirectoryLock(lockPath, "test operation", async () => {
      entered = true;
    }, {
      timeoutMs: 20,
      staleAfterMs: 0,
      now: () => clock,
      wait: async (ms) => { clock += ms; },
      isProcessAlive,
    })).rejects.toThrow(/Timed out.*held by process/is);

    expect(entered).toBe(false);
    expect(isProcessAlive).toHaveBeenCalledWith(process.pid);
    await expect(stat(marker)).resolves.toBeTruthy();
  });

  it("never checks or steals an owner recorded on another host", async () => {
    const marker = await createOwnedLock(lockPath, {
      pid: DEAD_PID,
      ownerHostname: "another-host.example",
    });
    let clock = 0;
    const isProcessAlive = vi.fn(() => false);

    await expect(withOwnerDirectoryLock(lockPath, "test operation", async () => "not-entered", {
      timeoutMs: 20,
      now: () => clock,
      wait: async (ms) => { clock += ms; },
      localHostname: "this-host.example",
      isProcessAlive,
    })).rejects.toThrow(/Timed out.*another-host\.example/is);

    expect(isProcessAlive).not.toHaveBeenCalled();
    await expect(stat(marker)).resolves.toBeTruthy();
  });

  it.each([
    ["lock-path stat", "inspectPath", lstat],
    ["lock-directory read", "readLockDirectory", readdir],
    ["owner-marker open", "openMarkerFile", open],
  ])("retries a transient Windows EPERM from %s without treating it as ownership evidence", async (
    _source,
    hookName,
    realOperation
  ) => {
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const sawTransient = deferred();
    const order = [];
    const first = withOwnerDirectoryLock(lockPath, "first operation", async () => {
      order.push("first-enter");
      firstEntered.resolve();
      await releaseFirst.promise;
      order.push("first-exit");
      return "first-result";
    });
    await firstEntered.promise;

    let attempts = 0;
    const inspectionHook = vi.fn(async (...args) => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error("marker is delete-pending");
        error.code = "EPERM";
        sawTransient.resolve();
        throw error;
      }
      return open(...args);
    });
    const second = withOwnerDirectoryLock(lockPath, "second operation", async () => {
      order.push("second-enter");
      order.push("second-exit");
      return "second-result";
    }, {
      platform: "win32",
      timeoutMs: 2_000,
      [hookName]: inspectionHook,
    });

    await sawTransient.promise;
    try {
      expect(order).toEqual(["first-enter"]);
      expect(await readdir(lockPath)).toHaveLength(1);
    } finally {
      releaseFirst.resolve();
    }
    await expect(Promise.all([first, second])).resolves.toEqual(["first-result", "second-result"]);

    expect(order).toEqual(["first-enter", "first-exit", "second-enter", "second-exit"]);
    expect(inspectionHook).toHaveBeenCalled();
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when a Windows owner marker remains unreadable through the deadline", async () => {
    const marker = await createOwnedLock(lockPath, { pid: process.pid });
    let clock = 0;
    let entered = false;
    const openMarkerFile = vi.fn(async () => {
      const error = new Error("persistent marker denial");
      error.code = "EPERM";
      throw error;
    });

    await expect(withOwnerDirectoryLock(lockPath, "test operation", async () => {
      entered = true;
    }, {
      platform: "win32",
      timeoutMs: 20,
      now: () => clock,
      wait: async (ms) => { clock += ms; },
      openMarkerFile,
    })).rejects.toThrow(/remained unreadable on Windows.*EPERM.*Refusing.*manually/is);

    expect(entered).toBe(false);
    expect(openMarkerFile).toHaveBeenCalledTimes(2);
    await expect(stat(marker)).resolves.toBeTruthy();
  });

  it("does not reinterpret owner-marker permission errors as transient off Windows", async () => {
    const marker = await createOwnedLock(lockPath, { pid: process.pid });
    const wait = vi.fn();
    const openMarkerFile = vi.fn(async () => {
      const error = new Error("permission denied");
      error.code = "EPERM";
      throw error;
    });

    await expect(withOwnerDirectoryLock(lockPath, "test operation", async () => "not-entered", {
      platform: "linux",
      wait,
      openMarkerFile,
    })).rejects.toThrow(/lock marker .* cannot be read.*permission denied.*Refusing/is);

    expect(wait).not.toHaveBeenCalled();
    await expect(stat(marker)).resolves.toBeTruthy();
  });

  it("reclaims a dead local owner without waiting for an age threshold", async () => {
    const abandonedMarker = await createOwnedLock(lockPath);
    await expect(withOwnerDirectoryLock(lockPath, "test operation", async () => {
      const { markerPath, owner } = await markerAt(lockPath);
      expect(markerPath).not.toBe(abandonedMarker);
      expect(owner.pid).toBe(process.pid);
      return "recovered";
    }, {
      staleAfterMs: Number.MAX_SAFE_INTEGER,
      isProcessAlive: (pid) => pid !== DEAD_PID,
    })).resolves.toBe("recovered");
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not let a delayed dead-owner reclaimer remove a newer owner", async () => {
    const oldMarker = await createOwnedLock(lockPath);
    const aObserved = deferred();
    const bObserved = deferred();
    const resumeB = deferred();
    const cEntered = deferred();
    const releaseC = deferred();
    const entered = [];

    const ownerA = withOwnerDirectoryLock(lockPath, "race A", async () => {
      entered.push("A");
      return "A complete";
    }, {
      isProcessAlive: async (pid) => {
        if (pid === DEAD_PID) {
          aObserved.resolve();
          await bObserved.promise;
          return false;
        }
        return true;
      },
    });
    await aObserved.promise;

    let bClock = 0;
    let bEntered = false;
    const ownerB = withOwnerDirectoryLock(lockPath, "race B", async () => {
      bEntered = true;
    }, {
      timeoutMs: 200,
      now: () => bClock,
      wait: async (ms) => { bClock += ms; },
      isProcessAlive: async (pid) => {
        if (pid === DEAD_PID) {
          bObserved.resolve();
          await resumeB.promise;
          return false;
        }
        return true;
      },
    });
    await bObserved.promise;

    // A removes the exact old marker, acquires, enters, and releases. B still
    // holds an observation of that old UUID and remains paused.
    await expect(ownerA).resolves.toBe("A complete");
    await expect(stat(oldMarker)).rejects.toMatchObject({ code: "ENOENT" });

    const ownerC = withOwnerDirectoryLock(lockPath, "race C", async () => {
      entered.push("C");
      cEntered.resolve();
      await releaseC.promise;
      return "C complete";
    });
    await cEntered.promise;
    const cMarkerBefore = (await readdir(lockPath))[0];

    // B's unlink of the old unique marker returns ENOENT. The crucial rule is
    // that B must not call rmdir after that, so C's directory stays intact.
    resumeB.resolve();
    await expect(ownerB).rejects.toThrow(/Timed out.*process/is);
    expect(bEntered).toBe(false);
    expect((await readdir(lockPath))[0]).toBe(cMarkerBefore);
    expect(entered).toEqual(["A", "C"]);

    releaseC.resolve();
    await expect(ownerC).resolves.toBe("C complete");
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reclaims only an old ownerless directory", async () => {
    await mkdir(lockPath);
    let clock = Date.now();
    await expect(withOwnerDirectoryLock(lockPath, "test operation", async () => "not-entered", {
      timeoutMs: 20,
      staleAfterMs: 60_000,
      now: () => clock,
      wait: async (ms) => { clock += ms; },
    })).rejects.toThrow(/Timed out.*ownerless directory/is);
    await expect(stat(lockPath)).resolves.toBeTruthy();

    const old = new Date(Date.now() - 120_000);
    await utimes(lockPath, old, old);
    await expect(withOwnerDirectoryLock(lockPath, "test operation", async () => "recovered", {
      staleAfterMs: 60_000,
    })).resolves.toBe("recovered");
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers a crash before owner-marker publication from the old empty directory", async () => {
    await mkdir(lockPath);
    const initializationTemp = path.join(directory, `.owner-lock-init-${token()}.tmp`);
    await writeFile(initializationTemp, "partial but outside the shared lock");
    const old = new Date(Date.now() - 120_000);
    await utimes(lockPath, old, old);

    await expect(withOwnerDirectoryLock(lockPath, "test operation", async () => "entered", {
      staleAfterMs: 60_000,
    })).resolves.toBe("entered");
    // The incomplete sibling is inert: it neither blocks nor gets mistaken
    // for an owner. Manual/orphan cleanup can remove it independently.
    await expect(stat(initializationTemp)).resolves.toBeTruthy();
  });

  it("never removes a replacement empty directory after pre-publication failure", async () => {
    // Model a delayed cleanup from owner A after its original empty directory
    // was reclaimed and owner C created a new directory at the shared path.
    await mkdir(lockPath);
    await expect(__test.cleanupFailedAcquisition(lockPath, {
      markerPath: null,
      insideLock: false,
      preserveDirectory: false,
    }, {
      operationLabel: "delayed acquisition",
      platform: process.platform,
    })).resolves.toBe(false);
    expect((await stat(lockPath)).isDirectory()).toBe(true);
    expect(await readdir(lockPath)).toEqual([]);
  });

  it("recovers a dead process's fully published empty-directory reclaim claim", async () => {
    const deadClaim = await createOwnedLock(lockPath, {
      pid: DEAD_PID,
      markerPrefix: ".reclaim-",
    });

    await expect(withOwnerDirectoryLock(lockPath, "test operation", async () => "recovered", {
      isProcessAlive: (pid) => pid !== DEAD_PID,
    })).resolves.toBe("recovered");
    await expect(stat(deadClaim)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never removes a new owner after an injected post-isolation failure", async () => {
    await mkdir(lockPath);
    const old = new Date(Date.now() - 120_000);
    await utimes(lockPath, old, old);
    const replacementToken = token();

    const thrown = await withOwnerDirectoryLock(lockPath, "test operation", async () => "not-entered", {
      staleAfterMs: 60_000,
      afterEmptyLockIsolated: async ({ lockPath: sharedPath }) => {
        // The old directory has been atomically moved away, so model a new
        // process acquiring the shared pathname before cleanup fails.
        await createOwnedLock(sharedPath, {
          pid: process.pid,
          ownerToken: replacementToken,
        });
        throw new Error("injected failure after quarantine fsync");
      },
    }).catch((error) => error);

    expect(thrown.message).toMatch(/isolated at .*\.owner-lock-reclaim-.*injected failure/is);
    const { owner } = await markerAt(lockPath);
    expect(owner.token).toBe(replacementToken);
    const quarantines = (await readdir(directory)).filter((name) => name.startsWith(".owner-lock-reclaim-"));
    expect(quarantines).toHaveLength(1);
  });

  it("fails closed on legacy files and malformed owner markers with cleanup guidance", async () => {
    await writeFile(lockPath, JSON.stringify({ pid: DEAD_PID }));
    await expect(withOwnerDirectoryLock(lockPath, "test operation", async () => "not-entered"))
      .rejects.toThrow(/legacy or malformed file.*Refusing.*manually/is);
    expect((await lstat(lockPath)).isFile()).toBe(true);

    await unlink(lockPath);
    await mkdir(lockPath);
    const badMarker = path.join(lockPath, `owner-${token()}.json`);
    await writeFile(badMarker, "not-json");
    await expect(withOwnerDirectoryLock(lockPath, "test operation", async () => "not-entered"))
      .rejects.toThrow(/not valid JSON.*Refusing.*manually/is);
    await expect(stat(badMarker)).resolves.toBeTruthy();
  });

  it("refuses to remove the directory after its own marker is swapped", async () => {
    const replacementToken = token();
    const replacementName = `owner-${replacementToken}.json`;

    await expect(withOwnerDirectoryLock(lockPath, "test operation", async () => {
      const [ownMarker] = await readdir(lockPath);
      await unlink(path.join(lockPath, ownMarker));
      await writeFile(path.join(lockPath, replacementName), JSON.stringify({
        version: 1,
        pid: process.pid,
        hostname: "replacement-host",
        token: replacementToken,
        created_at: new Date().toISOString(),
      }));
    })).rejects.toThrow(/unique owner marker disappeared.*replacement path will not be removed/is);

    expect(await readdir(lockPath)).toEqual([replacementName]);
  });

  it("recovers a real lock owner killed while inside its critical section", async () => {
    const moduleUrl = new URL("../src/owner-lock.js", import.meta.url).href;
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { withOwnerDirectoryLock } from ${JSON.stringify(moduleUrl)};
      await withOwnerDirectoryLock(${JSON.stringify(lockPath)}, "child operation", async () => {
        process.stdout.write("LOCKED\\n");
        await new Promise(() => {});
      });
    `], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const acquired = new Promise((resolve) => {
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (stdout.includes("LOCKED\n")) resolve();
      });
    });
    const closed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });

    try {
      await Promise.race([
        acquired,
        new Promise((_, reject) => setTimeout(
          () => reject(new Error(`child did not acquire lock: ${stderr}`)),
          5_000
        )),
      ]);
      const killedOwner = (await markerAt(lockPath)).owner;
      expect(killedOwner.pid).toBe(child.pid);

      child.kill();
      const exit = await closed;
      expect(exit.signal || exit.code !== 0).toBeTruthy();
      await expect(withOwnerDirectoryLock(lockPath, "parent operation", async () => "recovered"))
        .resolves.toBe("recovered");
      await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  }, 15_000);

  it("skips directory fsync on Windows while retaining the portable API", async () => {
    const openFile = vi.fn(() => {
      throw new Error("directory open must not be attempted");
    });
    await expect(__test.fsyncDirectory(lockPath, { platform: "win32", openFile }))
      .resolves.toBeUndefined();
    expect(openFile).not.toHaveBeenCalled();
  });
});
