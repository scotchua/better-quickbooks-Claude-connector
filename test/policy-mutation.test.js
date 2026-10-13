import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { __test, checkWritePolicy, policyFor, validatePolicy, writeAmount } from "../src/policy.js";

let directory;

afterEach(async () => {
  delete process.env.QBO_POLICY_FILE;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = null;
});

async function withPolicy(policy) {
  directory = await mkdtemp(path.join(tmpdir(), "qbo-policy-mutation-"));
  const file = path.join(directory, "policy.json");
  await writeFile(file, JSON.stringify(policy));
  process.env.QBO_POLICY_FILE = file;
}

describe("policyFileIdentity", () => {
  it("includes change time when other file metadata is identical", () => {
    const file = { dev: 1, ino: 2, size: 3, mtimeMs: 4, ctimeMs: 5 };
    expect(__test.policyFileIdentity({ ...file, ctimeMs: 6 })).not.toBe(__test.policyFileIdentity(file));
  });
});

describe("policyLockPath", () => {
  it("uses the policy file's .lock sibling", () => {
    const file = path.join(tmpdir(), "cedar-books-policy.json");
    expect(__test.policyLockPath(file)).toBe(`${file}.lock`);
  });
});

describe("withPolicyFileLock", () => {
  it("keeps an ownerless lock younger than the default stale threshold", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "qbo-policy-mutation-lock-"));
    const file = path.join(directory, "cedar-books-policy.json");
    const lock = __test.policyLockPath(file);
    await mkdir(lock);
    const recent = new Date(Date.now() - 60_000);
    await utimes(lock, recent, recent);
    let entered = false;
    await expect(__test.withPolicyFileLock(file, async () => { entered = true; }, { timeoutMs: 20 }))
      .rejects.toThrow(/Timed out/);
    expect(entered).toBe(false);
    expect((await stat(lock)).isDirectory()).toBe(true);
  });
});

describe("validatePolicy", () => {
  it("accepts a zero amount cap in a policy file", () => {
    const policy = { defaults: { max_write_amount: 0 } };
    expect(validatePolicy(policy)).toBe(policy);
  });
});

describe("policyFor", () => {
  it("keeps read only when sibling labels explicitly disagree", async () => {
    await withPolicy({ companies: {
      "cedar-books": { read_only: true },
      "pine-books": { read_only: false },
    } });
    const siblings = ["cedar-books", "pine-books"];
    expect(await policyFor("cedar-books", { siblings })).toMatchObject({ read_only: true });
    await expect(checkWritePolicy("pine-books", null, { siblings })).rejects.toThrow(/read-only/);
  });
});

describe("writeAmount", () => {
  it("adds an unclassified journal line to the larger posting side", () => {
    expect(writeAmount({ Line: [
      { Amount: 100, JournalEntryLineDetail: { PostingType: "Debit" } },
      { Amount: 20, JournalEntryLineDetail: {} },
    ] })).toBe(120);
  });
});

describe("checkWritePolicy", () => {
  it("allows a write exactly equal to its amount cap", async () => {
    await withPolicy({ companies: { "cedar-books": { max_write_amount: 125 } } });
    await expect(checkWritePolicy("cedar-books", { TotalAmt: 125 }, { siblings: ["cedar-books"] }))
      .resolves.toBeUndefined();
  });
});
