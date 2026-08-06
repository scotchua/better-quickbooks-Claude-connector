import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile, chmod, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeAmount, txnDates, checkWritePolicy, policyFor, setCompanyPolicy } from "../src/policy.js";

afterEach(() => {
  delete process.env.QBO_POLICY_FILE;
});

async function withPolicy(policy) {
  const dir = await mkdtemp(path.join(tmpdir(), "qbo-policy-"));
  const file = path.join(dir, "qbo-policy.json");
  await writeFile(file, JSON.stringify(policy));
  process.env.QBO_POLICY_FILE = file;
}

describe("writeAmount", () => {
  it("prefers TotalAmt, then sums Line amounts", () => {
    expect(writeAmount({ TotalAmt: 250 })).toBe(250);
    expect(writeAmount({ Line: [{ Amount: 100 }, { Amount: 50 }] })).toBe(150);
  });
  it("counts journal entries by debits only", () => {
    const body = { Line: [
      { Amount: 500, JournalEntryLineDetail: { PostingType: "Debit" } },
      { Amount: 500, JournalEntryLineDetail: { PostingType: "Credit" } },
    ] };
    expect(writeAmount(body)).toBe(500);
  });
  it("sums batch items", () => {
    const body = { BatchItemRequest: [
      { bId: "1", Purchase: { Line: [{ Amount: 10 }] } },
      { bId: "2", Purchase: { Line: [{ Amount: 15 }] } },
    ] };
    expect(writeAmount(body)).toBe(25);
  });
  it("is zero for bodies without money (voids, sends)", () => {
    expect(writeAmount({ Id: "145", SyncToken: "2" })).toBe(0);
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

  it("blocks writes when the policy file cannot be read", async () => {
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
