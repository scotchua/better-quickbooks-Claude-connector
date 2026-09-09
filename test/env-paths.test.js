import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { auditDir } from "../src/audit.js";
import { clientsPath } from "../src/clients.js";
import { loadPolicy, policyPath } from "../src/policy.js";
import { tokensDir } from "../src/token-directory.js";
import { resolveEnvPath, resolveUserPath } from "../src/util.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const paths = [
  ["QBO_TOKENS_DIR", tokensDir, ROOT, "QBO_TOKENS_DIR"],
  ["QBO_AUDIT_DIR", auditDir, path.join(ROOT, "audit-log"), "Audit journal"],
  ["QBO_POLICY_FILE", policyPath, path.join(ROOT, "qbo-policy.json"), "Write policy"],
  ["QBO_CLIENTS_FILE", clientsPath, path.join(ROOT, "clients.json"), "QBO_CLIENTS_FILE"],
];
let directory;
let defaultExportPath;

beforeAll(async () => {
  directory = await realpath(await mkdtemp(path.join(tmpdir(), "qbo-env-paths-")));
  // Register the real server's tools without opening a stdio transport.
  const connect = vi.spyOn(McpServer.prototype, "connect").mockResolvedValue();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    ({ defaultExportPath } = await import("../src/index.js"));
  } finally {
    connect.mockRestore();
    log.mockRestore();
  }
});

afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

function doctor() {
  const result = spawnSync(process.execPath, [path.join(ROOT, "src", "doctor.js"), "--json"], {
    cwd: directory,
    env: process.env,
    encoding: "utf8",
    timeout: 5_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).not.toBeNull();
  return JSON.parse(result.stdout).results;
}

describe("filesystem environment paths", () => {
  it.each(paths)("preserves the base-commit default for unset %s", (name, resolve, expected) => {
    vi.stubEnv(name, undefined);
    expect(resolve()).toBe(expected);
  });

  it.each(paths)("preserves the base-commit default for empty %s", (name, resolve, expected) => {
    vi.stubEnv(name, "");
    expect(resolve()).toBe(expected);
  });

  it.each(paths)("leaves an absolute %s unchanged", (name, resolve) => {
    const absolute = path.join(directory, "configured");
    vi.stubEnv(name, absolute);
    expect(resolve()).toBe(absolute);
  });

  it.each(paths)("expands a home-relative %s", (name, resolve) => {
    vi.stubEnv(name, "~/configured");
    expect(resolve()).toBe(path.join(homedir(), "configured"));
  });

  it.each(paths)("makes a relative %s absolute", (name, resolve) => {
    vi.stubEnv(name, "configured");
    expect(resolve()).toBe(path.join(process.cwd(), "configured"));
  });

  it.each([undefined, ""])("preserves both QBO_FILES_DIR defaults for %s", async (value) => {
    vi.stubEnv("QBO_FILES_DIR", value);
    const outside = path.join(directory, "unfenced.csv");
    expect(await resolveUserPath(outside)).toBe(outside);
    await expect(resolveUserPath(outside, { requireBase: true })).rejects.toThrow(/QBO_FILES_DIR is not set/);
    expect(defaultExportPath("acme", "report.csv")).toBe(path.join(ROOT, "exports", "acme", "report.csv"));
  });

  it.each(["absolute", "home", "relative"])("uses the same %s QBO_FILES_DIR for the fence and default exports", async (kind) => {
    const raw = kind === "absolute" ? path.join(directory, "files") : kind === "home" ? "~/files" : "files";
    const expected = kind === "absolute" ? raw : path.join(kind === "home" ? homedir() : process.cwd(), "files");
    vi.stubEnv("QBO_FILES_DIR", raw);
    const file = path.join(expected, "exports", "acme", "report.csv");
    expect(defaultExportPath("acme", "report.csv")).toBe(file);
    expect(await resolveUserPath(file, { requireBase: true })).toBe(file);
    await expect(resolveUserPath(path.join(expected, "..", "outside.csv"))).rejects.toThrow(/outside QBO_FILES_DIR/);
  });

  it.each(["~", "~/configured", "~\\configured"])("expands %s through the shared resolver", (value) => {
    expect(resolveEnvPath(value, ROOT)).toBe(value === "~" ? homedir() : path.join(homedir(), "configured"));
  });
});

describe("doctor/runtime path parity", () => {
  it.each(["unset", "empty", "absolute", "home", "relative"])("reports runtime paths for every variable with %s values", async (kind) => {
    vi.stubEnv("HOME", directory);
    vi.stubEnv("USERPROFILE", directory);
    const configured = path.join(directory, "configured");
    await mkdir(configured, { recursive: true });
    const value = kind === "unset" ? undefined : kind === "empty" ? "" : kind === "absolute" ? configured : kind === "home" ? "~/configured" : "configured";
    for (const [name] of paths) vi.stubEnv(name, value);
    vi.stubEnv("QBO_FILES_DIR", value);
    // Match the child's unrelated cwd to prove repository-based defaults are
    // independent of cwd, while relative overrides use the launch directory.
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(directory);
    try {
      const results = doctor();
      for (const [, resolve, , check] of paths) {
        const detail = results.find((row) => row.check === check).detail;
        const reportedPath = detail.startsWith("Using ")
          ? detail.slice("Using ".length, -1)
          : detail.startsWith("No policy file is active at ")
            ? detail.slice("No policy file is active at ".length).split(";")[0]
            : detail.split(/ (?:is |can be created )/)[0];
        expect(reportedPath, check).toBe(resolve());
      }
      const files = results.find((row) => row.check === "QBO_FILES_DIR");
      if (value) {
        const exported = defaultExportPath("acme", "report.csv");
        const runtimeBase = path.dirname(path.dirname(path.dirname(exported)));
        expect(files.detail).toBe(`${runtimeBase} exists and is readable/writable.`);
        expect(await resolveUserPath(exported, { requireBase: true })).toBe(exported);
        await expect(resolveUserPath(path.join(runtimeBase, "..", "outside.csv"))).rejects.toThrow(/outside QBO_FILES_DIR/);
      } else {
        expect(files.detail).toMatch(/No local-files fence is configured/);
        await expect(resolveUserPath("report.csv", { requireBase: true })).rejects.toThrow(/QBO_FILES_DIR is not set/);
        expect(defaultExportPath("acme", "report.csv")).toBe(path.join(ROOT, "exports", "acme", "report.csv"));
      }
    } finally {
      cwd.mockRestore();
    }
  });
});

describe("expanded policy and file fence regressions", () => {
  it("loads a real policy fixture from a ~/ path instead of returning null", async () => {
    vi.stubEnv("HOME", directory);
    vi.stubEnv("USERPROFILE", directory);
    const fixture = await readFile(path.join(ROOT, "qbo-policy.example.json"), "utf8");
    await writeFile(path.join(directory, "policy.json"), fixture);
    vi.stubEnv("QBO_POLICY_FILE", "~/policy.json");
    expect(await loadPolicy()).toEqual(JSON.parse(fixture));
    expect(doctor().find((row) => row.check === "Write policy")).toMatchObject({
      status: "ok",
      detail: `${policyPath()} is valid.`,
    });
  });

  it("still returns null for ENOENT at an expanded policy path", async () => {
    vi.stubEnv("HOME", directory);
    vi.stubEnv("USERPROFILE", directory);
    vi.stubEnv("QBO_POLICY_FILE", "~/missing-policy.json");
    expect(await loadPolicy()).toBeNull();
  });

  it("refuses outside paths and credential-shaped basenames with an expanded base", async () => {
    vi.stubEnv("QBO_FILES_DIR", "~/files");
    for (const file of ["~/outside.csv", "~/files-evil/report.csv", "~/files/../outside.csv"]) {
      await expect(resolveUserPath(file)).rejects.toThrow(/outside QBO_FILES_DIR/);
    }
    for (const name of [".env", ".env.local", "tokens.acme.json", ".qbo-key", "id_rsa", "id_ed25519", "private.pem", ".npmrc", ".netrc"]) {
      await expect(resolveUserPath(`~/files/${name}`)).rejects.toThrow(/credential-shaped/);
    }
  });
});
