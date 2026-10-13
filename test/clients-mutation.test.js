import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

let directory;
let priorClientsFile;
let priorTokensDir;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "qbo-client-mutation-"));
  priorClientsFile = process.env.QBO_CLIENTS_FILE;
  priorTokensDir = process.env.QBO_TOKENS_DIR;
  process.env.QBO_CLIENTS_FILE = path.join(directory, "clients.json");
  process.env.QBO_TOKENS_DIR = directory;
});

afterEach(async () => {
  if (priorClientsFile === undefined) delete process.env.QBO_CLIENTS_FILE;
  else process.env.QBO_CLIENTS_FILE = priorClientsFile;
  if (priorTokensDir === undefined) delete process.env.QBO_TOKENS_DIR;
  else process.env.QBO_TOKENS_DIR = priorTokensDir;
  await rm(directory, { recursive: true, force: true });
});

describe("closeHandle", () => {
  it("preserves both write and close failures", async () => {
    const { __test } = await import("../src/clients.js");
    const handle = {
      writeFile: vi.fn(async () => { throw new Error("write failed"); }),
      sync: vi.fn(),
      close: vi.fn(async () => { throw new Error("close failed"); }),
    };
    let caught;
    try {
      await __test.durableAtomicReplace("/roster/clients.json", "{}", {
        openFile: vi.fn(async () => handle),
        remove: vi.fn(),
        platform: "win32",
        token: () => "both-errors",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect(caught.errors.map((error) => error.message)).toEqual(["write failed", "close failed"]);
  });
});

describe("durableAtomicReplace", () => {
  it("removes an owned temp when file sync fails", async () => {
    const { __test } = await import("../src/clients.js");
    const remove = vi.fn();
    const move = vi.fn();
    const target = "/roster/clients.json";
    await expect(__test.durableAtomicReplace(target, "{}", {
      openFile: vi.fn(async () => ({
        writeFile: vi.fn(),
        sync: vi.fn(async () => { throw new Error("sync failed"); }),
        close: vi.fn(),
      })),
      move,
      remove,
      platform: "win32",
      token: () => "sync-failure",
    })).rejects.toThrow(/sync failed/);
    expect(remove.mock.calls).toEqual([[`${target}.${process.pid}.sync-failure.tmp`]]);
    expect(move).not.toHaveBeenCalled();
  });

  it("retains the published roster when its directory sync fails", async () => {
    const { __test } = await import("../src/clients.js");
    const remove = vi.fn();
    const move = vi.fn();
    let opened = 0;
    await expect(__test.durableAtomicReplace("/roster/clients.json", "{}", {
      openFile: vi.fn(async () => {
        opened++;
        return {
          writeFile: vi.fn(),
          sync: vi.fn(async () => {
            if (opened === 3) throw new Error("directory sync failed");
          }),
          close: vi.fn(),
        };
      }),
      move,
      remove,
      platform: "linux",
      token: () => "published",
    })).rejects.toThrow(/directory sync failed/);
    expect(move).toHaveBeenCalledOnce();
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("saveClients", () => {
  it("writes a newline after the roster document", async () => {
    const { registerClient } = await import("../src/clients.js");
    await registerClient("zz-test-newline", { name: "Invented Cedar Works" });
    expect((await readFile(process.env.QBO_CLIENTS_FILE, "utf8")).endsWith("\n")).toBe(true);
  });
});

describe("registerClient", () => {
  it("stores a company name supplied without a display name", async () => {
    const { registerClient, loadClients } = await import("../src/clients.js");
    await registerClient("zz-test-company-name", { company_name: "Invented Juniper Ledger LLC" });
    expect((await loadClients())["zz-test-company-name"].company_name).toBe("Invented Juniper Ledger LLC");
  });

  it("stores a data folder supplied without other labels", async () => {
    const { registerClient, loadClients } = await import("../src/clients.js");
    await registerClient("zz-test-folder", { data_folder: path.join(directory, "invented-spruce") });
    expect((await loadClients())["zz-test-folder"].data_folder).toBe(path.join(directory, "invented-spruce"));
  });

  it("stores service lines supplied without other labels", async () => {
    const { registerClient, loadClients } = await import("../src/clients.js");
    await registerClient("zz-test-services", { service_lines: ["invented bookkeeping", "invented tax"] });
    expect((await loadClients())["zz-test-services"].service_lines).toEqual(["invented bookkeeping", "invented tax"]);
  });

  it("omits the authorization warning for an authorized company", async () => {
    const { registerClient } = await import("../src/clients.js");
    await writeFile(path.join(directory, "tokens.zz-test-authorized.json"), JSON.stringify({
      realmId: "987654",
      environment: "production",
      access_token: "invented-access",
      refresh_token: "invented-refresh",
      expires_at: 0,
      refresh_expires_at: 0,
    }));
    const result = await registerClient("zz-test-authorized", { name: "Invented Maple Company" });
    expect(result.authorized).toBe(true);
    expect(result.warning).toBeUndefined();
  });
});
