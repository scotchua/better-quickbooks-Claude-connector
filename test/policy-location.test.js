// Decision 2: the policy file moves out of the directory that holds the access
// tokens. Four repositories read it and they cannot change in the same instant,
// so both locations are accepted during the move. These pin which one wins, and
// pin that a policy written while neither exists lands in the new place rather
// than recreating the old one.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertPolicyFilesAgree, defaultPolicyPath, policyPath, POLICY_SUBDIRECTORY } from "../src/policy.js";

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

const moved = () => path.join(root, POLICY_SUBDIRECTORY, "qbo-policy.json");
const beside = () => path.join(root, "qbo-policy.json");

async function write(file, text = "{}\n") {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, "utf8");
}

describe("where the policy file is looked for", () => {
  it.each([
    { name: "uses the new location when it is there", files: [moved], want: moved, warning: null },
    {
      name: "uses the old location when it is the only one, and says so",
      files: [beside],
      want: beside,
      warning: /still sits in the directory that holds the access tokens/,
    },
    {
      name: "prefers the new one when both exist, and says to delete the old one",
      files: [moved, beside],
      want: moved,
      warning: /two policy files exist/,
    },
    // No file at all is the path a policy WRITE creates. Returning the old one
    // here would recreate the file beside the credentials after somebody moved it.
    { name: "points at the new location when there is no policy file at all", files: [], want: moved, warning: null },
  ])("$name", async ({ files, want, warning }) => {
    for (const file of files) await write(file());
    expect(defaultPolicyPath(root)).toBe(want());
    if (warning) expect(warnings.join("\n")).toMatch(warning);
    else expect(warnings).toEqual([]);
  });

  it("does not probe or warn about the default when QBO_POLICY_FILE wins", async () => {
    await write(beside());
    const override = path.join(root, "elsewhere.json");
    expect(policyPath({ QBO_POLICY_FILE: override })).toBe(override);
    expect(warnings).toEqual([]);
  });
});

describe("two policy files at once", () => {
  const strict = JSON.stringify({ defaults: { read_only: true } });

  it("allows writes while the two files agree", async () => {
    await write(moved(), strict + "\n");
    await write(beside(), strict);
    await expect(assertPolicyFilesAgree({}, root)).resolves.toBeUndefined();
  });

  // Codex review 20260923T005126Z-760af6, finding 1: an empty copy appearing in
  // policy/ must not quietly replace the stricter file still in force.
  it("blocks writes when a new-location copy disagrees with the old file", async () => {
    await write(moved(), "{}\n");
    await write(beside(), strict);
    await expect(assertPolicyFilesAgree({}, root)).rejects.toThrow(/disagree.*Writes are blocked/);
  });

  it("has nothing to compare with one file, or with an override", async () => {
    await write(beside(), strict);
    await expect(assertPolicyFilesAgree({}, root)).resolves.toBeUndefined();
    await write(moved(), "{}\n");
    const override = { QBO_POLICY_FILE: path.join(root, "elsewhere.json") };
    await expect(assertPolicyFilesAgree(override, root)).resolves.toBeUndefined();
  });
});
