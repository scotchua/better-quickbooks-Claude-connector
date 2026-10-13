import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertBalanced, expandHome, guessContentType, isAmbiguousHttpStatus,
  isRealCalendarDate, readResponseBuffer, resolveUserPath, todayISO,
  validateRawQboPath,
} from "../src/util.js";

describe("todayISO", () => {
  it("returns a complete ISO calendar date", () => {
    expect(todayISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("isAmbiguousHttpStatus", () => {
  it("includes timeout and the first server error without including ordinary failures", () => {
    expect(isAmbiguousHttpStatus(408)).toBe(true);
    expect(isAmbiguousHttpStatus(500)).toBe(true);
    expect(isAmbiguousHttpStatus(409)).toBe(false);
  });
});

describe("guessContentType", () => {
  it("maps a CSV export to text/csv", () => {
    expect(guessContentType("Sable Finch ledger.csv")).toBe("text/csv");
  });
});

describe("readResponseBuffer", () => {
  it("accepts a declared length exactly at the cap", async () => {
    const response = { headers: new Headers({ "content-length": "5" }), body: null };
    expect(await readResponseBuffer(response, { maxBytes: 5 })).toEqual(Buffer.alloc(0));
  });

  it("returns an empty Buffer when there is no body", async () => {
    const result = await readResponseBuffer({ body: null }, { maxBytes: 1 });
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.length).toBe(0);
  });

  it("accepts a zero-byte stream chunk", async () => {
    const reader = {
      read: vi.fn().mockResolvedValueOnce({ done: false, value: new Uint8Array(0) })
        .mockResolvedValueOnce({ done: true }),
      releaseLock: vi.fn(),
    };
    const result = await readResponseBuffer({ body: { getReader: () => reader } }, { maxBytes: 1 });
    expect(result).toEqual(Buffer.alloc(0));
  });

  it("releases the stream reader after a successful read", async () => {
    const reader = {
      read: vi.fn().mockResolvedValueOnce({ done: true }),
      releaseLock: vi.fn(),
    };
    await readResponseBuffer({ body: { getReader: () => reader } }, { maxBytes: 1 });
    expect(reader.releaseLock).toHaveBeenCalledOnce();
  });
});

describe("assertBalanced", () => {
  const line = (posting_type, amount) => ({ posting_type, amount });

  it("accepts an imbalance exactly at the half-cent tolerance", () => {
    expect(assertBalanced([line("Debit", 0.005), line("Credit", 0)]))
      .toEqual({ debit: 0.005, credit: 0 });
  });

  it("rejects an imbalance just above the half-cent tolerance", () => {
    expect(() => assertBalanced([line("Debit", 1.0055), line("Credit", 1)]))
      .toThrow(/not balanced/);
  });
});

describe("isRealCalendarDate", () => {
  it("accepts the first day of January", () => {
    expect(isRealCalendarDate("2028-01-01")).toBe(true);
  });
});

describe("validateRawQboPath", () => {
  it("preserves percent characters in query values", () => {
    expect(validateRawQboPath("/query?query=Orion%ZZ"))
      .toBe("/query?query=Orion%ZZ");
  });
});

describe("resolveUserPath", () => {
  it("fences a missing file beneath a symlink to an outside directory", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "qbo-util-mutation-")));
    const inside = path.join(root, "inside");
    const outside = path.join(root, "outside");
    const previous = process.env.QBO_FILES_DIR;
    try {
      await mkdir(inside);
      await mkdir(outside);
      await symlink(outside, path.join(inside, "escape"), process.platform === "win32" ? "junction" : "dir");
      process.env.QBO_FILES_DIR = inside;
      await expect(resolveUserPath(path.join(inside, "escape", "new.csv"), { purpose: "write" }))
        .rejects.toThrow(/outside QBO_FILES_DIR/);
    } finally {
      if (previous === undefined) delete process.env.QBO_FILES_DIR;
      else process.env.QBO_FILES_DIR = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
});
