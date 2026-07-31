import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { summarizeResponse, auditFilePath, record, auditEnabled } from "../src/audit.js";

describe("summarizeResponse", () => {
  it("extracts the affected entity, id, doc number, and total", () => {
    expect(summarizeResponse({ Invoice: { Id: "145", DocNumber: "1042", TotalAmt: 500 }, time: "x" }))
      .toEqual({ entity: "Invoice", entityId: "145", docNumber: "1042", total: 500 });
  });
  it("summarizes batch responses by count", () => {
    expect(summarizeResponse({ BatchItemResponse: [{}, {}, {}] })).toEqual({ entity: "Batch", count: 3 });
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
