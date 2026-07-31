import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
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
    const r = await setCompanyPolicy("temp", { read_only: false });
    expect(r.rules).toEqual({});
    expect(await policyFor("temp")).toEqual({});
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
