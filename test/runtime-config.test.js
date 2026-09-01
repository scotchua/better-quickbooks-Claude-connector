import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function startWith(overrides) {
  return spawnSync(process.execPath, ["src/index.js"], {
    cwd: ROOT,
    env: { ...process.env, ...overrides },
    encoding: "utf8",
    timeout: 5_000,
  });
}

describe("bounded runtime configuration", () => {
  it.each([
    ["QBO_REPORT_MAX_INLINE_CHARS", "Infinity", "positive safe integer"],
    ["QBO_REPORT_MAX_INLINE_CHARS", "-1", "positive safe integer"],
    ["QBO_PDF_MAX_INLINE_BYTES", "1.5", "positive safe integer"],
    ["QBO_PDF_MAX_INLINE_BYTES", "Infinity", "positive safe integer"],
    ["QBO_RESPONSE_MAX_BYTES", "1.5", "positive safe integer"],
    ["QBO_RESPONSE_MAX_BYTES", "Infinity", "positive safe integer"],
    ["QBO_RECOVERY_REPLAY_MAX_AGE_MS", "Infinity", "positive whole number"],
  ])("fails startup for invalid %s=%s", (name, value, expected) => {
    const result = startWith({ [name]: value });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(new RegExp(`${name} must be a ${expected}`));
  });

  it.each([
    ["QBO_DISABLE_WRITES", "treu"],
    ["QBO_DISABLE_WRITES", "1"],
    ["QBO_DISABLE_DELETES", "treu"],
    ["QBO_DISABLE_DELETES", "1"],
  ])("fails closed for invalid %s=%s", (name, value) => {
    const result = startWith({ [name]: value });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(new RegExp(`${name} must be true or false`));
  });
});
