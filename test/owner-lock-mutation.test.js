import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { withOwnerDirectoryLock, __test } from "../src/owner-lock.js";

let directory;
let lockPath;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "qbo-owner-lock-mutation-"));
  lockPath = path.join(directory, "operation.lock");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("positiveDuration", () => {
  it("accepts zero timeout and stale age for an uncontended lock", async () => {
    await expect(withOwnerDirectoryLock(lockPath, "Cedar Lantern books", async () => "entered", {
      timeoutMs: 0,
      staleAfterMs: 0,
    })).resolves.toBe("entered");
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("closeHandle", () => {
  it("preserves a directory sync failure when close succeeds", async () => {
    const failure = new Error("sync failed");
    const handle = {
      sync: vi.fn().mockRejectedValue(failure),
      close: vi.fn().mockResolvedValue(undefined),
    };

    await expect(__test.fsyncDirectory(lockPath, {
      platform: "linux",
      openFile: async () => handle,
    })).rejects.toBe(failure);
    expect(handle.sync).toHaveBeenCalledTimes(1);
    expect(handle.close).toHaveBeenCalledTimes(1);
  });
});

describe("parseLockMarker", () => {
  it("rejects a zero PID without entering the critical section", async () => {
    const token = "00000000-0000-4000-8000-000000000001";
    await mkdir(lockPath);
    const marker = path.join(lockPath, `owner-${token}.json`);
    await writeFile(marker, JSON.stringify({
      version: 1,
      pid: 0,
      hostname: "cedar-lantern.example",
      token,
      created_at: "2024-04-03T12:00:00.000Z",
    }));
    const callback = vi.fn();

    await expect(withOwnerDirectoryLock(lockPath, "Cedar Lantern books", callback, {
      localHostname: "cedar-lantern.example",
    }))
      .rejects.toThrow(/incomplete, inconsistent, or from an unsupported lock format/);
    expect(callback).not.toHaveBeenCalled();
    await expect(readFile(marker, "utf8")).resolves.toContain('"pid":0');
  });
});

describe("malformedLockError", () => {
  it("preserves the JSON parse error as the cause of an invalid marker", async () => {
    const token = "00000000-0000-4000-8000-000000000002";
    await mkdir(lockPath);
    const marker = path.join(lockPath, `owner-${token}.json`);
    await writeFile(marker, "not-json");

    const error = await withOwnerDirectoryLock(lockPath, "Cedar Lantern books", async () => "entered")
      .catch((failure) => failure);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/not valid JSON/);
    expect(error.cause).toBeInstanceOf(SyntaxError);
    await expect(readFile(marker, "utf8")).resolves.toBe("not-json");
  });
});

describe("reclaimOldEmptyDirectory", () => {
  it("retries acquisition immediately after reclaiming an old empty lock", async () => {
    await mkdir(lockPath);
    const old = new Date("2024-04-03T12:00:00.000Z");
    await utimes(lockPath, old, old);
    const wait = vi.fn();

    await expect(withOwnerDirectoryLock(lockPath, "Cedar Lantern books", async () => "entered", {
      staleAfterMs: 60_000,
      wait,
    })).resolves.toBe("entered");

    expect(wait).not.toHaveBeenCalled();
    await expect(readdir(directory)).resolves.toEqual([]);
  });
});
