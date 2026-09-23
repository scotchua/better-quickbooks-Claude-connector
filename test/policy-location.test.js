// Decision 2: the policy file lives in policy/, not in the directory that holds
// the access tokens. The live file moved on 2026-09-23 and the old location is
// retired: never read, and a file found there blocks writes rather than being
// ignored, since ignoring it could leave an upgraded install with no rules.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { copyFile, cp, link, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  assertDefaultPolicyIsPlainFile,
  assertNoRetiredPolicyFile,
  defaultPolicyPath,
  KEEP_POLICY_BACKUPS,
  policyPath,
  POLICY_SUBDIRECTORY,
  prunePolicyBackups,
} from "../src/policy.js";

const execFileP = promisify(execFile);
let root;
let warnings;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "qbo-policy-location-")));
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

  it("treats a whitespace-only QBO_POLICY_FILE as unset, like the Python readers", async () => {
    await write(retired());
    expect(() => assertNoRetiredPolicyFile({ QBO_POLICY_FILE: "   " }, root)).toThrow(/Writes are blocked/);
    expect(policyPath({ QBO_POLICY_FILE: "   " })).toBe(defaultPolicyPath());
  });
});

describe("the default policy file itself", () => {
  it("must be a regular file, not a link to something else", async () => {
    const token = path.join(root, "tokens.acme.json");
    await write(token, '{"secret": true}\n');
    await mkdir(path.dirname(current()), { recursive: true });
    await symlink(token, current());
    expect(() => assertDefaultPolicyIsPlainFile({}, root)).toThrow(/symbolic link.*Writes are blocked/);
    const override = { QBO_POLICY_FILE: path.join(root, "elsewhere.json") };
    expect(() => assertDefaultPolicyIsPlainFile(override, root)).not.toThrow();
  });

  it("is fine when absent or a plain file", async () => {
    expect(() => assertDefaultPolicyIsPlainFile({}, root)).not.toThrow();
    await write(current());
    expect(() => assertDefaultPolicyIsPlainFile({}, root)).not.toThrow();
  });

  it("blocks when the retired location cannot be checked, not just when it exists", async () => {
    // A file in place of the directory makes lstat fail with ENOTDIR, which
    // existsSync would have read as absent.
    await write(path.join(root, "not-a-dir"));
    expect(() => assertNoRetiredPolicyFile({}, path.join(root, "not-a-dir")))
      .toThrow(/Cannot check .*Writes are blocked/);
  });
});

// The real write path, run against a copy of src/ so ROOT is a scratch folder
// and the live connector root is never touched.
describe("the write path itself", () => {
  const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
  const MODULES = path.join(SRC, "..", "node_modules");

  async function attempt(env, cwd = undefined) {
    await cp(SRC, path.join(root, "src"), { recursive: true });
    await symlink(MODULES, path.join(root, "node_modules"));
    await copyFile(path.join(SRC, "..", "package.json"), path.join(root, "package.json"));
    // The copy must resolve its own root to the scratch folder, or this test
    // would be writing to the live connector. Checked before any write.
    const script =
      `import { setCompanyPolicy, defaultPolicyPath } from ${JSON.stringify(pathToFileURL(path.join(root, "src", "policy.js")).href)};` +
      `if (defaultPolicyPath() !== ${JSON.stringify(current())}) { console.log('WRONG ROOT ' + defaultPolicyPath()); process.exit(0); }` +
      "try { await setCompanyPolicy('acme', { read_only: false }); console.log('WROTE'); }" +
      " catch (e) { console.log('REFUSED ' + e.message); }";
    const { stdout } = await execFileP(process.execPath, ["--input-type=module", "--eval", script],
      { env: { ...process.env, ...env }, cwd });
    return stdout;
  }

  it("still refuses when a relative QBO_POLICY_FILE names the default file from the connector root", async () => {
    // A relative override resolves against the working directory in all four
    // copies; from the connector root it names the default file, so it is checked.
    const rules = '{"defaults": {"read_only": true}}\n';
    await write(current(), rules);
    await write(retired(), rules);
    const out = await attempt({ QBO_POLICY_FILE: path.join("policy", "qbo-policy.json") }, root);
    expect(out).toMatch(/^REFUSED .*Writes are blocked/);
  });

  it.each([
    { name: "with no override", env: () => ({ QBO_POLICY_FILE: "" }) },
    { name: "with QBO_POLICY_FILE naming the default file", env: () => ({ QBO_POLICY_FILE: current() }) },
  ])("refuses a write while a retired file exists, $name", async ({ env }) => {
    const rules = '{"defaults": {"read_only": true}}\n';
    await write(current(), rules);
    await write(retired(), rules);
    const out = await attempt(env());
    expect(out).toMatch(/^REFUSED .*Writes are blocked/);
    expect(await readFile(current(), "utf8")).toBe(rules);
    expect((await readdir(path.dirname(current()))).filter((n) => n.includes(".bak-"))).toEqual([]);
  });

  it("refuses, and leaves the target alone, when the default file is a link to a token file", async () => {
    const token = path.join(root, "tokens.acme.json");
    await write(token, '{"secret": true}\n');
    await mkdir(path.dirname(current()), { recursive: true });
    await symlink(token, current());
    expect(await attempt({ QBO_POLICY_FILE: "" })).toMatch(/^REFUSED .*symbolic link/);
    expect(await readFile(token, "utf8")).toBe('{"secret": true}\n');
  });

  it("still refuses when QBO_POLICY_FILE reaches the default file through a symlink", async () => {
    const rules = '{"defaults": {"read_only": true}}\n';
    await write(current(), rules);
    await write(retired(), rules);
    const alias = path.join(root, "alias");
    await symlink(path.dirname(current()), alias);
    const out = await attempt({ QBO_POLICY_FILE: path.join(alias, "qbo-policy.json") });
    expect(out).toMatch(/^REFUSED .*Writes are blocked/);
    expect(await readFile(current(), "utf8")).toBe(rules);
  });

  it("writes once the retired file is gone", async () => {
    await write(current(), '{"defaults": {"read_only": true}}\n');
    expect(await attempt({ QBO_POLICY_FILE: "" })).toMatch(/^WROTE/);
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

  it("breaks equal modification times by name, never by directory order", async () => {
    await write(current());
    const when = new Date(Date.UTC(2026, 0, 1));
    for (const tag of ["b", "d", "a", "c"]) {
      const file = `${current()}.bak-${tag}`;
      await write(file);
      await utimes(file, when, when);
    }
    await prunePolicyBackups(current(), 2);
    expect((await names()).filter((n) => n.includes(".bak-"))).toEqual(["qbo-policy.json.bak-c", "qbo-policy.json.bak-d"]);
  });

  it("removes only the backup's own name, never a link target", async () => {
    await write(current());
    const outside = path.join(root, "protected.txt");
    const target = path.join(root, "target.txt");
    await write(outside, "keep me\n");
    await write(target, "keep me too\n");
    await link(outside, `${current()}.bak-hardlink`);
    await symlink(target, `${current()}.bak-symlink`);
    await prunePolicyBackups(current(), 0);
    expect(await readFile(outside, "utf8")).toBe("keep me\n");
    expect(await readFile(target, "utf8")).toBe("keep me too\n");
    // The hard-linked name goes (it is a regular backup file); the symlink is
    // not a regular file, so it is left alone entirely.
    expect((await names()).filter((n) => n.includes(".bak-"))).toEqual(["qbo-policy.json.bak-symlink"]);
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
