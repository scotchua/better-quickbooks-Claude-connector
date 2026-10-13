import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, open, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  __test as auditTest,
  currentToolName,
  currentToolSupportsRecovery,
  findWriteIntentByRequestId,
  recordWriteIntent,
  recoveryReplayMaxAgeMs,
  toolContext,
  writeRecoveryFilePath,
} from "../src/audit.js";

const originalAuditDir = process.env.QBO_AUDIT_DIR;
let directory;

async function useLedger() {
  directory = await mkdtemp(path.join(tmpdir(), "qbo-audit-mutation-"));
  process.env.QBO_AUDIT_DIR = directory;
}

afterEach(async () => {
  if (originalAuditDir === undefined) delete process.env.QBO_AUDIT_DIR;
  else process.env.QBO_AUDIT_DIR = originalAuditDir;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("currentToolName", () => {
  it("reads the current tool from its async context", () => {
    toolContext.run({ tool: "create_aster_invoice" }, () => {
      expect(currentToolName()).toBe("create_aster_invoice");
    });
  });
});

describe("currentToolSupportsRecovery", () => {
  it("blocks recovery only when its context explicitly opts out", () => {
    toolContext.run({ recoverySupported: false }, () => {
      expect(currentToolSupportsRecovery()).toBe(false);
    });
    toolContext.run({ recoverySupported: true }, () => {
      expect(currentToolSupportsRecovery()).toBe(true);
    });
  });
});

describe("writeRecoveryRequestLockPath", () => {
  it("uses a distinct lock for each request id", async () => {
    await useLedger();
    expect(auditTest.writeRecoveryRequestLockPath("aster-100"))
      .not.toBe(auditTest.writeRecoveryRequestLockPath("aster-101"));
  });
});

describe("withWriteRecoveryLock", () => {
  it("holds the shared ledger lock while its callback runs", async () => {
    await useLedger();
    const entries = await auditTest.withWriteRecoveryLock(() => readdir(directory));
    expect(entries).toContain(".write-recovery.lock");
  });
});

describe("recoveryReplayMaxAgeMs", () => {
  it("rejects a zero millisecond replay window", () => {
    expect(() => recoveryReplayMaxAgeMs("0")).toThrow(/positive whole number/);
  });
});

describe("appendRecoveryRecordUnlocked", () => {
  it("syncs the recovery ledger handle before closing it", async () => {
    await useLedger();
    let ledgerSyncs = 0;
    const openFile = async (target, flags, mode) => {
      const handle = await open(target, flags, mode);
      if (target !== writeRecoveryFilePath()) return handle;
      return {
        writeFile: (contents) => handle.writeFile(contents),
        sync: async () => { ledgerSyncs++; await handle.sync(); },
        close: () => handle.close(),
      };
    };
    await auditTest.appendRecoveryRecordUnlocked({
      kind: "api_write_intent",
      request_id: "aster-102",
      company: "Aster Books",
      amount: 34,
    }, { openFile });
    expect(ledgerSyncs).toBe(1);
  });
});

describe("fsyncRecoveryDirectoryChain", () => {
  it("syncs the containing directory on a non-Windows platform", async () => {
    await useLedger();
    const opened = [];
    await auditTest.fsyncRecoveryDirectoryChain(directory, undefined, {
      platform: "darwin",
      openFile: async (target) => {
        opened.push(target);
        return { sync: async () => {}, close: async () => {} };
      },
    });
    expect(opened).toEqual([path.resolve(directory)]);
  });
});

describe("findWriteIntentByRequestId", () => {
  it("returns the first durable intent after a matching replay", async () => {
    await useLedger();
    const envelope = {
      request_id: "aster-103",
      company: "Aster Books",
      realmId: "765432100",
      environment: "sandbox",
      method: "POST",
      path: "/invoice?requestid=aster-103",
      body_sha256: "c".repeat(64),
    };
    await recordWriteIntent({ ...envelope, tool: "create_invoice" });
    await recordWriteIntent({ ...envelope, tool: "replay_invoice" });
    const original = await findWriteIntentByRequestId(envelope.request_id);
    expect(original.tool).toBe("create_invoice");
  });
});
