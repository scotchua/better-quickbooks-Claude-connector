import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
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
  await writeFile(p, JSON.stringify({ realmId, environment, access_token: "x", refresh_token: "y", expires_at: 0, refresh_expires_at: 0 }));
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
    await authorize("zz-test-psa", "2222");
    const { resolveClient, registerClient } = await import("../src/clients.js");
    await registerClient("zz-test-psa", {
      name: "Power Systems and Supplies of Alaska LLC",
      aliases: ["PSSA", "Power Systems"],
    });

    expect((await resolveClient("zz-test-psa")).match.slug).toBe("zz-test-psa");
    expect((await resolveClient("pssa")).match.slug).toBe("zz-test-psa");
    expect((await resolveClient("  Power   Systems ")).match.slug).toBe("zz-test-psa");
    expect((await resolveClient("power systems and supplies of alaska llc")).match.slug).toBe("zz-test-psa");
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
});
