import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { summarizeResponse, auditFilePath, record, auditEnabled, findWriteByRequestId } from "../src/audit.js";

describe("summarizeResponse", () => {
  it("extracts the affected entity, id, doc number, and total", () => {
    expect(summarizeResponse({ Invoice: { Id: "145", DocNumber: "1042", TotalAmt: 500 }, time: "x" }))
      .toEqual({ entity: "Invoice", entityId: "145", docNumber: "1042", total: 500 });
  });
  it("summarizes batch responses by count", () => {
    expect(summarizeResponse({ BatchItemResponse: [{}, {}, {}] })).toEqual({
      entity: "Batch",
      count: 3,
      items: [
        { bId: undefined, ok: true, entity: null, entityId: null },
        { bId: undefined, ok: true, entity: null, entityId: null },
        { bId: undefined, ok: true, entity: null, entityId: null },
      ],
    });
  });

  // A count alone cannot answer "what did Claude actually change" when a batch
  // half-succeeds, which is exactly when someone goes looking.
  it("records per-item outcomes for a partially failed batch", () => {
    const summary = summarizeResponse({
      BatchItemResponse: [
        { bId: "bid0", Purchase: { Id: "101", TotalAmt: 25 } },
        { bId: "bid1", Fault: { Error: [{ Message: "Invalid account reference" }] } },
      ],
    });
    expect(summary.entity).toBe("Batch");
    expect(summary.count).toBe(2);
    expect(summary.items).toEqual([
      { bId: "bid0", ok: true, entity: "Purchase", entityId: "101" },
      { bId: "bid1", ok: false, error: "Invalid account reference" },
    ]);
  });
  it("returns empty for unrecognized bodies", () => {
    expect(summarizeResponse({ time: "x" })).toEqual({});
    expect(summarizeResponse(null)).toEqual({});
  });
});

describe("audit file", () => {
  it("names one file per month", () => {
    const p = auditFilePath(new Date("2026-07-31T12:00:00Z"));
    expect(path.basename(p)).toBe("audit-2026-07.jsonl");
  });

  it("appends JSONL records with timestamps", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "qbo-audit-"));
    process.env.QBO_AUDIT_DIR = dir;
    try {
      expect(auditEnabled()).toBe(true);
      await record({ kind: "api_write", method: "POST", path: "/invoice", ok: true });
      await record({ kind: "api_write", method: "POST", path: "/bill", ok: false });
      const lines = (await readFile(auditFilePath(), "utf8")).trim().split("\n");
      expect(lines).toHaveLength(2);
      const first = JSON.parse(lines[0]);
      expect(first.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(first.path).toBe("/invoice");
      expect(JSON.parse(lines[1]).ok).toBe(false);
    } finally {
      delete process.env.QBO_AUDIT_DIR;
    }
  });

  it("never throws even when the directory is unwritable", async () => {
    // A "directory" nested under a regular file fails fast with ENOTDIR.
    const dir = await mkdtemp(path.join(tmpdir(), "qbo-audit-bad-"));
    const blocker = path.join(dir, "file");
    await writeFile(blocker, "x");
    process.env.QBO_AUDIT_DIR = path.join(blocker, "nested");
    try {
      await expect(record({ kind: "api_write" })).resolves.toBeUndefined();
    } finally {
      delete process.env.QBO_AUDIT_DIR;
    }
  });
});

// QBO_AUDIT=strict is for deployments where an unrecorded write is itself the
// incident. It cannot make the write conditional — the API has already
// answered by then — so the contract is "raise loudly", not "roll back".
describe("audit modes", () => {
  const origMode = process.env.QBO_AUDIT;
  const origDir = process.env.QBO_AUDIT_DIR;
  afterEach(() => {
    if (origMode === undefined) delete process.env.QBO_AUDIT; else process.env.QBO_AUDIT = origMode;
    if (origDir === undefined) delete process.env.QBO_AUDIT_DIR; else process.env.QBO_AUDIT_DIR = origDir;
  });

  it("writes nothing at all when off", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "qbo-audit-off-"));
    process.env.QBO_AUDIT_DIR = dir;
    process.env.QBO_AUDIT = "off";
    await record({ kind: "api_write", tool: "create_invoice" });
    await expect(readdir(dir)).resolves.toEqual([]);
  });

  it("records the tool name and body fingerprint when on", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "qbo-audit-on-"));
    process.env.QBO_AUDIT_DIR = dir;
    process.env.QBO_AUDIT = "on";
    await record({ kind: "api_write", tool: "create_invoice", body_sha256: "abc123", request_id: "req-1" });
    const files = await readdir(dir);
    const line = JSON.parse((await readFile(path.join(dir, files[0]), "utf8")).trim());
    expect(line).toMatchObject({ tool: "create_invoice", body_sha256: "abc123", request_id: "req-1" });
    expect(line.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("swallows a write failure when on, but raises it when strict", async () => {
    // An unwritable directory: mkdir under a regular file always fails.
    const dir = await mkdtemp(path.join(tmpdir(), "qbo-audit-bad-"));
    const asFile = path.join(dir, "not-a-dir");
    await writeFile(asFile, "x");
    process.env.QBO_AUDIT_DIR = path.join(asFile, "nested");

    process.env.QBO_AUDIT = "on";
    await expect(record({ kind: "api_write" })).resolves.toBeUndefined();

    process.env.QBO_AUDIT = "strict";
    await expect(record({ kind: "api_write" })).rejects.toThrow(/ALREADY BEEN SENT/);
  });
});

// The lookup that makes replaying an Intuit requestid safe. Without it, a
// reused id with a changed body returns the original transaction and discards
// the new one, with an HTTP 200 and no hint that anything was dropped.
describe("findWriteByRequestId", () => {
  const origDir = process.env.QBO_AUDIT_DIR;
  const origMode = process.env.QBO_AUDIT;
  afterEach(() => {
    if (origDir === undefined) delete process.env.QBO_AUDIT_DIR; else process.env.QBO_AUDIT_DIR = origDir;
    if (origMode === undefined) delete process.env.QBO_AUDIT; else process.env.QBO_AUDIT = origMode;
  });

  const seed = async (records, when = new Date()) => {
    const dir = await mkdtemp(path.join(tmpdir(), "qbo-reqid-"));
    process.env.QBO_AUDIT_DIR = dir;
    delete process.env.QBO_AUDIT;
    const month = when.toISOString().slice(0, 7);
    await writeFile(path.join(dir, `audit-${month}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    return dir;
  };

  it("finds the record for a request id and returns its body hash", async () => {
    await seed([
      { ts: "2026-08-06T01:00:00Z", kind: "api_write", request_id: "aaa", body_sha256: "1111", method: "POST", path: "/invoice" },
      { ts: "2026-08-06T02:00:00Z", kind: "api_write", request_id: "bbb", body_sha256: "2222", method: "POST", path: "/bill" },
    ]);
    const hit = await findWriteByRequestId("bbb");
    expect(hit).toMatchObject({ request_id: "bbb", body_sha256: "2222", path: "/bill" });
  });

  it("returns null for an unknown id and for no id", async () => {
    await seed([{ ts: "x", request_id: "aaa", body_sha256: "1111" }]);
    expect(await findWriteByRequestId("zzz")).toBeNull();
    expect(await findWriteByRequestId(undefined)).toBeNull();
  });

  it("returns the most recent record when an id appears more than once", async () => {
    await seed([
      { ts: "2026-08-06T01:00:00Z", request_id: "aaa", body_sha256: "first" },
      { ts: "2026-08-06T03:00:00Z", request_id: "aaa", body_sha256: "latest" },
    ]);
    expect((await findWriteByRequestId("aaa")).body_sha256).toBe("latest");
  });

  it("skips corrupt lines rather than failing the write that depends on it", async () => {
    await seed([{ ts: "x", request_id: "aaa", body_sha256: "1111" }]);
    const dir = process.env.QBO_AUDIT_DIR;
    const month = new Date().toISOString().slice(0, 7);
    const file = path.join(dir, `audit-${month}.jsonl`);
    await writeFile(file, (await readFile(file, "utf8")) + '{"request_id":"aaa" TRUNCATED\n');
    expect((await findWriteByRequestId("aaa")).body_sha256).toBe("1111");
  });

  it("finds an id written last month, so a replay near a boundary still matches", async () => {
    const now = new Date();
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15);
    const dir = await mkdtemp(path.join(tmpdir(), "qbo-reqid-prev-"));
    process.env.QBO_AUDIT_DIR = dir;
    delete process.env.QBO_AUDIT;
    await writeFile(
      path.join(dir, `audit-${lastMonth.toISOString().slice(0, 7)}.jsonl`),
      JSON.stringify({ ts: "old", request_id: "ccc", body_sha256: "3333" }) + "\n"
    );
    expect((await findWriteByRequestId("ccc", now)).body_sha256).toBe("3333");
  });

  // With auditing off there is no prior hash to compare against, so the guard
  // has nothing to work with and must not pretend otherwise.
  it("returns null when auditing is off", async () => {
    await seed([{ ts: "x", request_id: "aaa", body_sha256: "1111" }]);
    process.env.QBO_AUDIT = "off";
    expect(await findWriteByRequestId("aaa")).toBeNull();
  });
});
