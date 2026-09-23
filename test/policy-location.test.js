// Decision 2: the policy file lives in policy/, not in the directory that holds
// the access tokens. The live file moved on 2026-09-23 and the old location is
// retired: never read, and a file found there blocks writes rather than being
// ignored, since ignoring it could leave an upgraded install with no rules.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertNoRetiredPolicyFile,
  defaultPolicyPath,
  KEEP_POLICY_BACKUPS,
  policyPath,
  POLICY_SUBDIRECTORY,
  prunePolicyBackups,
} from "../src/policy.js";

let root;
let warnings;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "qbo-policy-location-"));
  warnings = [];
  vi.spyOn(console, "error").mockImplementation((...args) => warnings.push(args.join(" ")));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

const current = () => path.join(root, POLICY_SUBDIRECTORY, "qbo-policy.json");
const retired = () => path.join(root, "qbo-policy.json");

async function write(file, text = "{}\n") {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, "utf8");
}

describe("where the policy file is looked for", () => {
  it.each([
    { name: "with no file at all", files: [] },
    { name: "with the file in policy/", files: [current] },
    { name: "even with a file in the old location", files: [retired] },
  ])("is always policy/ $name", async ({ files }) => {
    for (const file of files) await write(file());
    expect(defaultPolicyPath(root)).toBe(current());
    expect(warnings).toEqual([]);
  });

  it("uses QBO_POLICY_FILE as given", () => {
    const override = path.join(root, "elsewhere.json");
    expect(policyPath({ QBO_POLICY_FILE: override })).toBe(override);
  });
});

describe("a policy file in the retired location", () => {
  it("blocks writes, whether or not policy/ has one", async () => {
    await write(retired());
    expect(() => assertNoRetiredPolicyFile({}, root)).toThrow(/old location.*Writes are blocked/);
    await write(current());
    expect(() => assertNoRetiredPolicyFile({}, root)).toThrow(/Writes are blocked/);
  });

  it("is fine when absent, and irrelevant under QBO_POLICY_FILE", async () => {
    expect(() => assertNoRetiredPolicyFile({}, root)).not.toThrow();
    await write(retired());
    const override = { QBO_POLICY_FILE: path.join(root, "elsewhere.json") };
    expect(() => assertNoRetiredPolicyFile(override, root)).not.toThrow();
  });
});

describe("pruning policy backups", () => {
  async function backups(count) {
    const made = [];
    for (let i = 0; i < count; i++) {
      const file = `${current()}.bak-${String(i).padStart(3, "0")}`;
      await write(file);
      const when = new Date(Date.UTC(2026, 0, 1) + i * 60_000);
      await utimes(file, when, when);
      made.push(file);
    }
    return made;
  }
  const names = async () => (await readdir(path.dirname(current()))).sort();

  it("keeps the newest by modification time and deletes the rest", async () => {
    await write(current());
    const made = await backups(KEEP_POLICY_BACKUPS + 5);
    await prunePolicyBackups(current());
    const left = (await names()).filter((n) => n.includes(".bak-"));
    expect(left).toEqual(made.slice(5).map((f) => path.basename(f)));
  });

  it("leaves other files and subdirectories alone", async () => {
    await write(current());
    await backups(KEEP_POLICY_BACKUPS + 2);
    await write(path.join(path.dirname(current()), "old-backups", "qbo-policy.json.bak-archived"));
    await write(path.join(path.dirname(current()), "notes.txt"));
    await prunePolicyBackups(current());
    const left = await names();
    expect(left).toContain("old-backups");
    expect(left).toContain("notes.txt");
    expect(left).toContain("qbo-policy.json");
    expect(await readdir(path.join(path.dirname(current()), "old-backups"))).toEqual(["qbo-policy.json.bak-archived"]);
  });

  it("does nothing at or under the limit, and never throws", async () => {
    await write(current());
    await backups(3);
    await prunePolicyBackups(current());
    expect((await names()).filter((n) => n.includes(".bak-"))).toHaveLength(3);
    await prunePolicyBackups(path.join(root, "missing-dir", "qbo-policy.json"));
    expect(warnings.join("\n")).toMatch(/could not prune/);
  });
});
