import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile, readdir, writeFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

// Point the connector at a scratch directory so the roster and the token files
// it joins against are both fixtures.
let dir;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "qbo-clients-"));
  process.env.QBO_CLIENTS_FILE = path.join(dir, "clients.json");
  process.env.QBO_TOKEN_KEY = "d".repeat(64);
});

afterEach(async () => {
  delete process.env.QBO_CLIENTS_FILE;
  await rm(dir, { recursive: true, force: true });
});

// listCompanies reads tokens.<slug>.json from the project root, so fixtures go
// there and are cleaned up after. Plaintext is fine; only realmId and
// environment are read for the roster join.
const PROJECT_ROOT = path.join(import.meta.dirname, "..");
const fixtures = [];
async function authorize(slug, realmId, environment = "production") {
  const p = path.join(PROJECT_ROOT, `tokens.${slug}.json`);
  const tmp = `${p}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify({ realmId, environment, access_token: "x", refresh_token: "y", expires_at: 0, refresh_expires_at: 0 }));
  await rename(tmp, p);
  fixtures.push(p);
}
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((p) => rm(p, { force: true })));
});

describe("roster", () => {
  it("joins authorized companies to their labels and flags unlabeled ones", async () => {
    await authorize("zz-test-alpha", "1111");
    const { roster, registerClient } = await import("../src/clients.js");

    let r = await roster();
    const alpha = r.clients.find((c) => c.slug === "zz-test-alpha");
    expect(alpha).toMatchObject({ realmId: "1111", environment: "production", labeled: false });
    expect(r.unlabeled).toContain("zz-test-alpha");

    await registerClient("zz-test-alpha", { name: "Alpha Welding", aliases: ["Alpha"] });
    r = await roster();
    expect(r.clients.find((c) => c.slug === "zz-test-alpha")).toMatchObject({
      name: "Alpha Welding", labeled: true, aliases: ["Alpha"],
    });
    expect(r.unlabeled).not.toContain("zz-test-alpha");
  });

  it("reports labels that have no authorization, rather than hiding the drift", async () => {
    const { roster, registerClient } = await import("../src/clients.js");
    await registerClient("zz-test-ghost", { name: "Not Connected Co" });
    const r = await roster();
    expect(r.labeled_but_not_authorized).toContain("zz-test-ghost");
    expect(r.clients.map((c) => c.slug)).not.toContain("zz-test-ghost");
  });
});

describe("resolveClient", () => {
  it("matches slug, exact alias, and partial name", async () => {
    await authorize("zz-test-northwind", "2222");
    const { resolveClient, registerClient } = await import("../src/clients.js");
    await registerClient("zz-test-northwind", {
      name: "Northwind Supply Cooperative LLC",
      aliases: ["NSC", "Northwind Supply"],
    });

    expect((await resolveClient("zz-test-northwind")).match.slug).toBe("zz-test-northwind");
    expect((await resolveClient("nsc")).match.slug).toBe("zz-test-northwind");
    expect((await resolveClient("  Northwind   Supply ")).match.slug).toBe("zz-test-northwind");
    expect((await resolveClient("northwind supply cooperative llc")).match.slug).toBe("zz-test-northwind");
  });

  it("returns candidates instead of guessing when a term is ambiguous", async () => {
    await authorize("zz-test-one", "3333");
    await authorize("zz-test-two", "4444");
    const { resolveClient, registerClient } = await import("../src/clients.js");
    await registerClient("zz-test-one", { name: "Harbor Marine North" });
    await registerClient("zz-test-two", { name: "Harbor Marine South" });

    const r = await resolveClient("Harbor Marine");
    expect(r.match).toBeUndefined();
    expect(r.candidates.map((c) => c.slug).sort()).toEqual(["zz-test-one", "zz-test-two"]);
  });

  it("reports no match with the available clients rather than inventing one", async () => {
    const { resolveClient } = await import("../src/clients.js");
    const r = await resolveClient("Nonexistent Holdings");
    expect(r.match).toBeUndefined();
    expect(r.candidates).toEqual([]);
    expect(Array.isArray(r.all)).toBe(true);
  });

  it("rejects an empty term", async () => {
    const { resolveClient } = await import("../src/clients.js");
    await expect(resolveClient("   ")).rejects.toThrow(/client name/);
  });
});

describe("registerClient", () => {
  it("merges aliases and preserves untouched fields", async () => {
    const { registerClient, loadClients } = await import("../src/clients.js");
    await registerClient("zz-test-merge", { name: "Merge Co", engagement: "monthly bookkeeping", aliases: ["MC"] });
    await registerClient("zz-test-merge", { aliases: ["Merge"] });

    const entry = (await loadClients())["zz-test-merge"];
    expect(entry.aliases.sort()).toEqual(["MC", "Merge"]);
    expect(entry.engagement).toBe("monthly bookkeeping");
    expect(entry.name).toBe("Merge Co");
  });

  it("removes aliases on request and drops an entry when nothing is left", async () => {
    const { registerClient, loadClients } = await import("../src/clients.js");
    await registerClient("zz-test-drop", { aliases: ["Gone"] });
    await registerClient("zz-test-drop", { remove_aliases: ["gone"] });
    expect((await loadClients())["zz-test-drop"]).toBeUndefined();
  });

  it("warns when labeling a client that is not authorized", async () => {
    const { registerClient } = await import("../src/clients.js");
    const r = await registerClient("zz-test-unauth", { name: "Pending Co" });
    expect(r.authorized).toBe(false);
    expect(r.warning).toMatch(/connect_company/);
  });

  it("serializes concurrent registrations without losing entries or sharing a temp file", async () => {
    const { registerClient, loadClients } = await import("../src/clients.js");
    const count = 24;
    await Promise.all(Array.from({ length: count }, (_, index) =>
      registerClient(`zz-test-concurrent-${index}`, {
        name: `Concurrent Client ${index}`,
        aliases: [`CC-${index}`],
      })
    ));

    const clients = await loadClients();
    for (let index = 0; index < count; index++) {
      expect(clients[`zz-test-concurrent-${index}`]).toEqual({
        name: `Concurrent Client ${index}`,
        aliases: [`CC-${index}`],
      });
    }
    expect(JSON.parse(await readFile(process.env.QBO_CLIENTS_FILE, "utf8")).clients)
      .toEqual(clients);

    const leftovers = (await readdir(dir)).filter((name) =>
      name.endsWith(".tmp") || name.endsWith(".lock") || name.startsWith(".owner-lock-")
    );
    expect(leftovers).toEqual([]);
  });

  it("fsyncs a uniquely named temp and directory metadata on both sides of publication", async () => {
    const { __test } = await import("../src/clients.js");
    const events = [];
    const fileHandle = {
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
      return flags === "wx" ? fileHandle : directoryHandles.shift();
    });
    const move = vi.fn(async (from, to) => { events.push(`rename:${from}:${to}`); });
    const remove = vi.fn();
    const target = "/roster/clients.json";
    const tmp = `${target}.${process.pid}.unique.tmp`;

    await __test.durableAtomicReplace(target, "{}\n", {
      openFile,
      move,
      remove,
      platform: "linux",
      token: () => "unique",
    });

    expect(events).toEqual([
      `open:${tmp}:wx:384`,
      "write",
      "file-sync",
      "file-close",
      "open:/roster:r:",
      "directory-sync",
      "directory-close",
      `rename:${tmp}:${target}`,
      "open:/roster:r:",
      "directory-sync",
      "directory-close",
    ]);
    expect(remove).not.toHaveBeenCalled();
  });
});
