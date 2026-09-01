import { describe, it, expect, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, chmod, readFile, readdir, mkdir, rename, rm, stat, utimes } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { writeAmount, txnDates, checkWritePolicy, policyFor, setCompanyPolicy, __test } from "../src/policy.js";

const execFileP = promisify(execFile);
const POLICY_MODULE_URL = new URL("../src/policy.js", import.meta.url).href;

afterEach(() => {
  delete process.env.QBO_POLICY_FILE;
});

async function withPolicy(policy) {
  const dir = await mkdtemp(path.join(tmpdir(), "qbo-policy-"));
  const file = path.join(dir, "qbo-policy.json");
  await writeFile(file, JSON.stringify(policy));
  process.env.QBO_POLICY_FILE = file;
}

async function createPolicyOwnerLock(lockPath, {
  pid = process.pid,
  ownerHostname = hostname(),
  token = randomUUID(),
} = {}) {
  await mkdir(lockPath, { mode: 0o700 });
  const marker = path.join(lockPath, `owner-${token}.json`);
  await writeFile(marker, JSON.stringify({
    version: 1,
    pid,
    hostname: ownerHostname,
    token,
    created_at: new Date().toISOString(),
  }));
  return marker;
}

async function readPolicyLockOwner(lockPath) {
  const entries = await readdir(lockPath);
  expect(entries).toHaveLength(1);
  return JSON.parse(await readFile(path.join(lockPath, entries[0]), "utf8"));
}

describe("writeAmount", () => {
  it("uses the larger of the absolute header total and gross line amounts", () => {
    expect(writeAmount({ TotalAmt: 250 })).toBe(250);
    expect(writeAmount({ Line: [{ Amount: 100 }, { Amount: 50 }] })).toBe(150);
    expect(writeAmount({ TotalAmt: 1, Line: [{ Amount: 100 }, { Amount: -50 }] })).toBe(150);
    expect(writeAmount({ TotalAmt: -250, Line: [{ Amount: 100 }, { Amount: 50 }] })).toBe(250);
  });
  it("counts a journal by the larger absolute debit or credit side", () => {
    const body = { Line: [
      { Amount: -300, JournalEntryLineDetail: { PostingType: "Debit" } },
      { Amount: 200, JournalEntryLineDetail: { PostingType: "Debit" } },
      { Amount: 650, JournalEntryLineDetail: { PostingType: "Credit" } },
    ] };
    expect(writeAmount(body)).toBe(650);
  });
  it("sums independent batch-item magnitudes without cancellation", () => {
    const body = { BatchItemRequest: [
      { bId: "1", Purchase: { TotalAmt: -10 } },
      { bId: "2", RefundReceipt: { TotalAmt: 15 } },
    ] };
    expect(writeAmount(body)).toBe(25);
  });
  it("rejects non-finite or nonnumeric monetary fields even when another field looks safe", () => {
    expect(() => writeAmount({ TotalAmt: NaN })).toThrow(/finite number/);
    expect(() => writeAmount({ Amount: Infinity })).toThrow(/finite number/);
    expect(() => writeAmount({ TotalAmt: 1, Line: [{ Amount: "not-a-number" }] })).toThrow(/finite number/);
    expect(() => writeAmount({ Line: [{ Amount: "" }] })).toThrow(/finite number/);
  });
  it("is zero for bodies without money (voids, sends)", () => {
    expect(writeAmount({ Id: "145", SyncToken: "2" })).toBe(0);
    expect(writeAmount({ BatchItemRequest: [{ bId: "1", Customer: { DisplayName: "No money" } }] })).toBe(0);
    expect(writeAmount(null)).toBe(0);
  });
});

describe("txnDates", () => {
  it("collects dates from plain and batch bodies", () => {
    expect(txnDates({ TxnDate: "2026-07-01" })).toEqual(["2026-07-01"]);
    expect(txnDates({ BatchItemRequest: [{ Purchase: { TxnDate: "2026-07-02" } }] })).toEqual(["2026-07-02"]);
  });
});

// A policy file that cannot be read or parsed must BLOCK writes, not silently
// become "no restrictions". Failing open here would quietly unlock every
// read-only company, amount cap, and date floor in the file, with nothing
// anywhere reporting it.
describe("policy file failure modes", () => {
  async function withRawPolicyFile(contents) {
    const dir = await mkdtemp(path.join(tmpdir(), "qbo-policy-broken-"));
    const file = path.join(dir, "qbo-policy.json");
    await writeFile(file, contents);
    process.env.QBO_POLICY_FILE = file;
    return file;
  }

  it("blocks writes when the policy file is malformed JSON", async () => {
    await withRawPolicyFile('{"companies": {"acme": {"read_only": true},}');
    await expect(checkWritePolicy("acme", { TotalAmt: 1 })).rejects.toThrow(/not valid JSON/);
    // and the read path surfaces it too, rather than reporting "no rules"
    await expect(policyFor("acme")).rejects.toThrow(/not valid JSON/);
  });

  it("blocks writes when policy JSON is syntactically valid but semantically unsafe", async () => {
    await withRawPolicyFile(JSON.stringify({ companies: { acme: { max_write_amount: "abc" } } }));
    await expect(checkWritePolicy("acme", { TotalAmt: 1 })).rejects.toThrow(/nonnegative finite number/);

    await withRawPolicyFile(JSON.stringify({ companies: { acme: { max_write_amout: 100 } } }));
    await expect(checkWritePolicy("acme", { TotalAmt: 1 })).rejects.toThrow(/unknown rule/);

    await withRawPolicyFile(JSON.stringify({ defaults: { min_txn_date: "2026-02-30" } }));
    await expect(checkWritePolicy("acme", { TotalAmt: 1 })).rejects.toThrow(/real YYYY-MM-DD/);
  });

  // chmod does not model Windows ACL denial: Node accepts the call but the
  // file remains readable. Keep this as a real filesystem check on POSIX and
  // make the unsupported Windows branch explicit instead of silently passing.
  it.skipIf(process.platform === "win32")("blocks writes when the policy file cannot be read", async () => {
    const file = await withRawPolicyFile(JSON.stringify({ companies: { acme: { read_only: true } } }));
    await chmod(file, 0o000);
    try {
      // Root ignores the mode bits, so only assert when the chmod actually bites.
      const denied = await readFile(file, "utf8").then(() => false, () => true);
      if (denied) {
        await expect(checkWritePolicy("acme", { TotalAmt: 1 })).rejects.toThrow(/Writes are blocked/);
      }
    } finally {
      await chmod(file, 0o600);
    }
  });

  it("treats an empty file as no rules, matching setCompanyPolicy's own read", async () => {
    await withRawPolicyFile("   \n");
    await expect(checkWritePolicy("acme", { TotalAmt: 1e9 })).resolves.toBeUndefined();
  });

  it("still treats a MISSING file as no policy at all", async () => {
    process.env.QBO_POLICY_FILE = path.join(tmpdir(), "qbo-policy-does-not-exist-12345.json");
    await expect(checkWritePolicy("acme", { TotalAmt: 1e9 })).resolves.toBeUndefined();
  });

  it("stops serving a cached policy once the file goes bad", async () => {
    const file = await withRawPolicyFile(JSON.stringify({ companies: { acme: { max_write_amount: 100 } } }));
    await expect(checkWritePolicy("acme", { TotalAmt: 250 })).rejects.toThrow(/above the/);
    // Rewrite as garbage; mtime moves, so the cache must reload and then refuse.
    await writeFile(file, "{ not json");
    await expect(checkWritePolicy("acme", { TotalAmt: 1 })).rejects.toThrow(/not valid JSON/);
  });

  it("reloads an atomic replacement even when its mtime and size are unchanged", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "qbo-policy-same-mtime-"));
    const file = path.join(dir, "qbo-policy.json");
    const replacement = path.join(dir, "replacement.json");
    const fixed = new Date("2026-08-30T12:00:00.000Z");
    const oldPolicy = JSON.stringify({ companies: { acme: { max_write_amount: 100 } } });
    const newPolicy = JSON.stringify({ companies: { acme: { max_write_amount: 200 } } });
    expect(newPolicy.length).toBe(oldPolicy.length);

    await writeFile(file, oldPolicy);
    await utimes(file, fixed, fixed);
    process.env.QBO_POLICY_FILE = file;
    expect(await policyFor("acme")).toEqual({ max_write_amount: 100 });

    await writeFile(replacement, newPolicy);
    await utimes(replacement, fixed, fixed);
    await rename(replacement, file);
    expect((await stat(file)).mtimeMs).toBe(fixed.getTime());
    expect(await policyFor("acme")).toEqual({ max_write_amount: 200 });
  });
});

describe("policy file durability", () => {
  it("fsyncs a newly created backup before reporting it durable", async () => {
    const events = [];
    const fileHandle = {
      writeFile: vi.fn(async () => { events.push("write"); }),
      sync: vi.fn(async () => { events.push("file-sync"); }),
      close: vi.fn(async () => { events.push("file-close"); }),
    };
    const directoryHandle = {
      sync: vi.fn(async () => { events.push("directory-sync"); }),
      close: vi.fn(async () => { events.push("directory-close"); }),
    };
    const openFile = vi.fn(async (target, flags, mode) => {
      events.push(`open:${target}:${flags}:${mode ?? ""}`);
      return flags === "wx" ? fileHandle : directoryHandle;
    });

    await __test.durableCreateFile(
      "/policies/qbo-policy.json.bak",
      "{}\n",
      {},
      { openFile, platform: "linux" }
    );

    expect(events).toEqual([
      "open:/policies/qbo-policy.json.bak:wx:384",
      "write",
      "file-sync",
      "file-close",
      "open:/policies:r:",
      "directory-sync",
      "directory-close",
    ]);
  });

  it("syncs temp data and directory metadata on both sides of rename", async () => {
    const events = [];
    const tempHandle = {
      writeFile: vi.fn(async () => { events.push("write"); }),
      sync: vi.fn(async () => { events.push("file-sync"); }),
      close: vi.fn(async () => { events.push("file-close"); }),
    };
    const directoryHandle = () => ({
      sync: vi.fn(async () => { events.push("directory-sync"); }),
      close: vi.fn(async () => { events.push("directory-close"); }),
    });
    const directoryHandles = [directoryHandle(), directoryHandle()];
    const openFile = vi.fn(async (target, flags, mode) => {
      events.push(`open:${target}:${flags}:${mode ?? ""}`);
      return flags === "wx" ? tempHandle : directoryHandles.shift();
    });
    const move = vi.fn(async (from, to) => { events.push(`rename:${from}:${to}`); });
    const remove = vi.fn();

    await __test.durableAtomicReplace(
      "/policies/qbo-policy.json",
      "/policies/qbo-policy.tmp",
      "{}\n",
      { openFile, move, remove, platform: "linux" }
    );

    expect(events).toEqual([
      "open:/policies/qbo-policy.tmp:wx:384",
      "write",
      "file-sync",
      "file-close",
      "open:/policies:r:",
      "directory-sync",
      "directory-close",
      "rename:/policies/qbo-policy.tmp:/policies/qbo-policy.json",
      "open:/policies:r:",
      "directory-sync",
      "directory-close",
    ]);
    expect(remove).not.toHaveBeenCalled();
  });

  it("fails closed and removes its owned temp file if metadata cannot be synced", async () => {
    const tempHandle = {
      writeFile: vi.fn(async () => {}),
      sync: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const directoryHandle = {
      sync: vi.fn(async () => { throw Object.assign(new Error("directory flush failed"), { code: "EIO" }); }),
      close: vi.fn(async () => {}),
    };
    const openFile = vi.fn()
      .mockResolvedValueOnce(tempHandle)
      .mockResolvedValueOnce(directoryHandle);
    const move = vi.fn();
    const remove = vi.fn(async () => {});

    await expect(__test.durableAtomicReplace(
      "/policies/qbo-policy.json",
      "/policies/qbo-policy.tmp",
      "{}\n",
      { openFile, move, remove, platform: "linux" }
    )).rejects.toThrow(/directory flush failed/);
    expect(move).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith("/policies/qbo-policy.tmp");
    expect(directoryHandle.close).toHaveBeenCalledOnce();
  });
});

describe("checkWritePolicy", () => {
  it("does nothing when no policy file exists", async () => {
    process.env.QBO_POLICY_FILE = "/nonexistent/qbo-policy.json";
    await expect(checkWritePolicy("acme", { TotalAmt: 1e9 })).resolves.toBeUndefined();
  });

  it("blocks writes to read-only companies, including body-less gate checks", async () => {
    await withPolicy({ companies: { acme: { read_only: true } } });
    await expect(checkWritePolicy("acme", null)).rejects.toThrow(/read-only/);
    await expect(checkWritePolicy("other", { TotalAmt: 5 })).resolves.toBeUndefined();
  });

  it("enforces max_write_amount from defaults with per-company override", async () => {
    await withPolicy({ defaults: { max_write_amount: 100 }, companies: { big: { max_write_amount: 10000 } } });
    await expect(checkWritePolicy("acme", { TotalAmt: 250 })).rejects.toThrow(/above the/);
    await expect(checkWritePolicy("big", { TotalAmt: 250 })).resolves.toBeUndefined();
  });

  it("fails closed when a capped write contains a non-finite monetary field", async () => {
    await withPolicy({ defaults: { max_write_amount: 100 } });
    await expect(checkWritePolicy("acme", {
      TotalAmt: 1,
      Line: [{ Amount: "NaN" }],
    })).rejects.toThrow(/monetary field.*finite number/);
  });

  it("enforces the min_txn_date floor", async () => {
    await withPolicy({ defaults: { min_txn_date: "2026-01-01" } });
    await expect(checkWritePolicy("acme", { TxnDate: "2025-12-31", TotalAmt: 1 })).rejects.toThrow(/floor/);
    await expect(checkWritePolicy("acme", { TxnDate: "2026-01-01", TotalAmt: 1 })).resolves.toBeUndefined();
  });

  it("enforces a rule the moment setCompanyPolicy writes it (no stale cache)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "qbo-policy-write-"));
    process.env.QBO_POLICY_FILE = path.join(dir, "qbo-policy.json");

    await setCompanyPolicy("acme", { read_only: true });
    await expect(checkWritePolicy("acme", { TotalAmt: 1 })).rejects.toThrow(/read-only/);

    // Lifting it must take effect immediately, not after the cache TTL.
    await setCompanyPolicy("acme", { read_only: false });
    await expect(checkWritePolicy("acme", { TotalAmt: 1 })).resolves.toBeUndefined();
  });

  it("leaves other companies' rules intact when writing one", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "qbo-policy-merge-"));
    process.env.QBO_POLICY_FILE = path.join(dir, "qbo-policy.json");

    await setCompanyPolicy("locked", { read_only: true });
    await setCompanyPolicy("capped", { max_write_amount: 5000 });
    await setCompanyPolicy("capped", { min_txn_date: "2026-01-01" });

    expect(await policyFor("locked")).toEqual({ read_only: true });
    expect(await policyFor("capped")).toEqual({ max_write_amount: 5000, min_txn_date: "2026-01-01" });
  });

  it("serializes concurrent policy updates so neither company is lost", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "qbo-policy-concurrent-"));
    process.env.QBO_POLICY_FILE = path.join(dir, "qbo-policy.json");

    await Promise.all([
      setCompanyPolicy("alpha", { read_only: true }),
      setCompanyPolicy("beta", { max_write_amount: 2500 }),
      setCompanyPolicy("gamma", { min_txn_date: "2026-01-01" }),
    ]);

    expect(await policyFor("alpha")).toEqual({ read_only: true });
    expect(await policyFor("beta")).toEqual({ max_write_amount: 2500 });
    expect(await policyFor("gamma")).toEqual({ min_txn_date: "2026-01-01" });
  });

  it("serializes updates from separate Node processes so no company rule is lost", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "qbo-policy-cross-process-"));
    const file = path.join(dir, "qbo-policy.json");
    const updates = [
      ["alpha", { read_only: true }],
      ["beta", { max_write_amount: 2500 }],
      ["gamma", { min_txn_date: "2026-01-01" }],
      ["delta", { read_only: false }],
      ["epsilon", { max_write_amount: 9000 }],
      ["zeta", { min_txn_date: "2025-07-01" }],
    ];
    const script =
      `import { setCompanyPolicy } from ${JSON.stringify(POLICY_MODULE_URL)};` +
      `await setCompanyPolicy(process.env.TEST_POLICY_SLUG, JSON.parse(process.env.TEST_POLICY_PATCH));`;

    await Promise.all(updates.map(([slug, patch]) => execFileP(
      process.execPath,
      ["--input-type=module", "--eval", script],
      {
        env: {
          ...process.env,
          QBO_POLICY_FILE: file,
          TEST_POLICY_SLUG: slug,
          TEST_POLICY_PATCH: JSON.stringify(patch),
        },
      }
    )));

    const saved = JSON.parse(await readFile(file, "utf8"));
    for (const [slug, patch] of updates) expect(saved.companies[slug], slug).toEqual(patch);
    await expect(stat(__test.policyLockPath(file))).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);

  it("drops a company entry when its last rule is cleared", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "qbo-policy-clear-"));
    process.env.QBO_POLICY_FILE = path.join(dir, "qbo-policy.json");

    await setCompanyPolicy("temp", { read_only: true });
    // null means "inherit the default", which is what empties the entry.
    const r = await setCompanyPolicy("temp", { read_only: null });
    expect(r.rules).toEqual({});
    expect(await policyFor("temp")).toEqual({});
  });

  it("stores read_only:false so a deny-by-default company can be reopened", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "qbo-policy-reopen-"));
    const file = path.join(dir, "qbo-policy.json");
    await writeFile(file, JSON.stringify({ defaults: { read_only: true }, companies: {} }));
    process.env.QBO_POLICY_FILE = file;

    // Deny-by-default: a company nobody has configured is closed.
    await expect(checkWritePolicy("fresh", null)).rejects.toThrow(/read-only/);

    // Explicitly allowing must survive the write, not be deleted back into the
    // default. Deleting it here is what made default-deny a one-way door.
    const r = await setCompanyPolicy("fresh", { read_only: false });
    expect(r.rules).toEqual({ read_only: false });
    expect(await policyFor("fresh")).toMatchObject({ read_only: false });
    await expect(checkWritePolicy("fresh", { TotalAmt: 1 })).resolves.toBeUndefined();

    // And inheriting again re-closes it.
    await setCompanyPolicy("fresh", { read_only: null });
    await expect(checkWritePolicy("fresh", null)).rejects.toThrow(/read-only/);
  });

  it("rejects a malformed date rather than writing it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "qbo-policy-bad-"));
    process.env.QBO_POLICY_FILE = path.join(dir, "qbo-policy.json");
    await expect(setCompanyPolicy("acme", { min_txn_date: "01/01/2026" })).rejects.toThrow(/YYYY-MM-DD/);
  });

  it("merges defaults with company overrides", async () => {
    await withPolicy({ defaults: { read_only: true }, companies: { open: { read_only: false } } });
    expect(await policyFor("open")).toMatchObject({ read_only: false });
    await expect(checkWritePolicy("open", { TotalAmt: 1 })).resolves.toBeUndefined();
    await expect(checkWritePolicy("locked", null)).rejects.toThrow(/read-only/);
  });
});

describe("cross-process policy lock", () => {
  it("does not steal an old lock from an owner process that is still alive", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "qbo-policy-live-lock-"));
    const file = path.join(dir, "qbo-policy.json");
    const lock = __test.policyLockPath(file);
    const token = randomUUID();
    const marker = await createPolicyOwnerLock(lock, { token });
    const old = new Date(Date.now() - 86_400_000);
    await utimes(marker, old, old);
    let entered = false;
    try {
      await expect(__test.withPolicyFileLock(file, async () => { entered = true; }, { timeoutMs: 20 }))
        .rejects.toThrow(/Timed out.*held by process/);
      expect(entered).toBe(false);
      expect(await readPolicyLockOwner(lock)).toMatchObject({ token });
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  });

  it("reclaims a lock whose recorded owner process is dead", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "qbo-policy-dead-lock-"));
    const file = path.join(dir, "qbo-policy.json");
    const lock = __test.policyLockPath(file);
    const deadToken = randomUUID();
    await createPolicyOwnerLock(lock, {
      pid: 2_147_483_647,
      token: deadToken,
    });

    const result = await __test.withPolicyFileLock(file, async () => {
      const active = await readPolicyLockOwner(lock);
      expect(active.pid).toBe(process.pid);
      expect(active.token).not.toBe(deadToken);
      return "recovered";
    });
    expect(result).toBe("recovered");
    await expect(stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reclaims an old ownerless lock directory but not a fresh one", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "qbo-policy-ownerless-lock-"));
    const file = path.join(dir, "qbo-policy.json");
    const lock = __test.policyLockPath(file);
    await mkdir(lock);

    await expect(__test.withPolicyFileLock(file, async () => "should-not-run", {
      timeoutMs: 20,
      staleAfterMs: 60_000,
    })).rejects.toThrow(/Timed out/);

    const old = new Date(Date.now() - 120_000);
    await utimes(lock, old, old);
    await expect(__test.withPolicyFileLock(file, async () => "recovered", {
      staleAfterMs: 60_000,
    })).resolves.toBe("recovered");
    await expect(stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed on a legacy file lock even when it is old", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "qbo-policy-legacy-lock-"));
    const file = path.join(dir, "qbo-policy.json");
    const lock = __test.policyLockPath(file);
    await writeFile(lock, "partial-owner-record");
    const old = new Date(Date.now() - 120_000);
    await utimes(lock, old, old);

    await expect(__test.withPolicyFileLock(file, async () => "should-not-run", {
      staleAfterMs: 1,
    })).rejects.toThrow(/legacy or malformed file.*Refusing.*manually/is);
    expect(await readFile(lock, "utf8")).toBe("partial-owner-record");
  });

  it("fails closed on a persistent lock-inspection error instead of spinning", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "qbo-policy-bad-lock-"));
    const file = path.join(dir, "qbo-policy.json");
    const lock = __test.policyLockPath(file);
    await mkdir(lock);
    await writeFile(path.join(lock, "unexpected-entry"), "do not remove");
    let entered = false;

    await expect(__test.withPolicyFileLock(file, async () => { entered = true; }, { timeoutMs: 20 }))
      .rejects.toThrow(/unexpected path.*Refusing.*manually/is);
    expect(entered).toBe(false);
  });

  it("fails closed when owner liveness itself cannot be verified", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "qbo-policy-owner-check-"));
    const file = path.join(dir, "qbo-policy.json");
    const lock = __test.policyLockPath(file);
    const token = randomUUID();
    await createPolicyOwnerLock(lock, {
      pid: 999_999,
      token,
    });
    const inspectionError = Object.assign(new Error("process table unavailable"), { code: "EIO" });
    try {
      await expect(__test.withPolicyFileLock(file, async () => {}, {
        isProcessAlive: () => { throw inspectionError; },
      })).rejects.toThrow(/local owner process.*cannot be checked.*Refusing/is);
      expect(await readPolicyLockOwner(lock)).toMatchObject({ token });
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  });
});
