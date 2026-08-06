import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { summarizeResponse, auditFilePath, record, auditEnabled } from "../src/audit.js";

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
