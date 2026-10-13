import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const scan = vi.hoisted(() => ({ directory: null }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readdir: async (directory, ...args) => directory === scan.directory
      ? ["tokens.vanished.json"] : actual.readdir(directory, ...args),
    readFile: async (file, ...args) => path.dirname(file) === scan.directory
      ? Promise.reject(Object.assign(new Error("vanished"), { code: "ENOENT" }))
      : actual.readFile(file, ...args),
  };
});

import { listAuthorizedCompanies, realmSiblingSlugs } from "../src/company-registry.js";

const originalDirectory = process.env.QBO_TOKENS_DIR;
const directories = [];

afterEach(async () => {
  scan.directory = null;
  process.env.QBO_TOKENS_DIR = originalDirectory;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tokenDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "qbo-registry-mutation-"));
  directories.push(directory);
  process.env.QBO_TOKENS_DIR = directory;
  return directory;
}

describe("scanAuthorizationFiles", () => {
  it("returns an empty company list when the token directory is absent", async () => {
    process.env.QBO_TOKENS_DIR = path.join(await tokenDirectory(), "absent");
    expect(await listAuthorizedCompanies()).toEqual([]);
  });

  it("rejects an invalid company slug instead of hiding the token", async () => {
    const directory = await tokenDirectory();
    await writeFile(path.join(directory, "tokens.bad.name.json"), JSON.stringify({ realmId: "7421" }));
    await expect(listAuthorizedCompanies()).rejects.toThrow(/invalid company slug/);
  });

  it("rejects corrupt token JSON instead of hiding the company", async () => {
    const directory = await tokenDirectory();
    await writeFile(path.join(directory, "tokens.cedar.json"), "{broken-json");
    await expect(listAuthorizedCompanies()).rejects.toThrow(/cannot be read as valid JSON/);
  });

  it("ignores a token that vanishes between directory listing and reading", async () => {
    scan.directory = path.join(await tokenDirectory(), "simulated");
    process.env.QBO_TOKENS_DIR = scan.directory;
    expect(await listAuthorizedCompanies()).toEqual([]);
  });
});

describe("realmSiblingSlugs", () => {
  it("normalizes a null slug to the legacy default identity", async () => {
    const companies = [
      { slug: "", realmId: "7421", environment: "sandbox" },
      { slug: "cedar", realmId: "7421", environment: "sandbox" },
    ];
    expect(await realmSiblingSlugs(null, companies)).toEqual(["", "cedar"]);
  });
});
