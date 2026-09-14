// Decision 2: the policy file moves out of the directory that holds the access
// tokens. Four repositories read it and they cannot change in the same instant,
// so both locations are accepted during the move. These pin which one wins, and
// pin that a policy written while neither exists lands in the new place rather
// than recreating the old one.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultPolicyPath, POLICY_SUBDIRECTORY } from "../src/policy.js";

let root;
let warnings;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "qbo-policy-location-"));
  warnings = [];
  vi.spyOn(console, "error").mockImplementation((line) => warnings.push(String(line)));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

const moved = () => path.join(root, POLICY_SUBDIRECTORY, "qbo-policy.json");
const beside = () => path.join(root, "qbo-policy.json");

async function write(file) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "{}\n", "utf8");
}

describe("where the policy file is looked for", () => {
  it("uses the new location when it is there", async () => {
    await write(moved());
    expect(defaultPolicyPath(root)).toBe(moved());
  });

  it("uses the old location when it is the only one, and says so", async () => {
    await write(beside());
    expect(defaultPolicyPath(root)).toBe(beside());
    expect(warnings.join("\n")).toMatch(/still sits in the directory that holds the access tokens/);
  });

  it("prefers the new one when both exist, and says which it ignored", async () => {
    await write(moved());
    await write(beside());
    expect(defaultPolicyPath(root)).toBe(moved());
    expect(warnings.join("\n")).toMatch(/two policy files exist/);
  });

  it("points at the new location when there is no policy file at all", () => {
    // This is the path a policy WRITE creates. Returning the old one here
    // would recreate the file beside the credentials after somebody moved it.
    expect(defaultPolicyPath(root)).toBe(moved());
    expect(warnings).toEqual([]);
  });
});
