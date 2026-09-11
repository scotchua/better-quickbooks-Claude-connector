import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("policy artifact ignore rules", () => {
  it("ignores local policy artifacts without ignoring tracked files", () => {
    const artifacts = [
      "qbo-policy.json",
      "qbo-policy.json.bak-20260910-123456",
      "qbo-policy.json.lock",
      "qbo-policy.json.mutation.lock",
      "qbo-policy.json.probe.lock",
      "qbo-policy.json.probe-journal.json",
      "qbo-policy.json.future-artifact",
      "qbo-policy.write.tmp",
    ];
    const ignored = execFileSync("git", ["check-ignore", "--no-index", "--stdin", "-z"], {
      cwd: ROOT,
      input: artifacts.join("\0") + "\0",
      encoding: "utf8",
    });
    expect(ignored.split("\0").filter(Boolean)).toEqual(artifacts);

    const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });
    expect(tracked).not.toBe("");
    // Without --no-index, check-ignore skips tracked files and this guard is vacuous.
    const result = spawnSync("git", ["check-ignore", "--no-index", "--stdin", "-z"], {
      cwd: ROOT,
      input: tracked,
      encoding: "utf8",
    });
    expect(result.error).toBeUndefined();
    expect(result.stdout.split("\0").filter(Boolean)).toEqual([]);
    expect(result.status, result.stderr).toBe(1);
  });
});
