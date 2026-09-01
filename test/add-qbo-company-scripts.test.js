import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = path.join(ROOT, ".claude", "skills", "add-qbo-company", "scripts");
const PYTHON = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");

function project() {
  const dir = mkdtempSync(path.join(tmpdir(), "qbo-company-scripts-"));
  mkdirSync(path.join(dir, "src"));
  writeFileSync(path.join(dir, "src", "index.js"), "");
  return dir;
}

describe("add-qbo-company helper scripts", () => {
  it("reports every root token file, including sandbox-backup, without recursing", () => {
    const dir = project();
    for (const slug of ["alpha", "sandbox-backup"]) {
      writeFileSync(path.join(dir, `tokens.${slug}.json`), JSON.stringify({ realmId: slug, environment: "sandbox" }));
    }
    mkdirSync(path.join(dir, "backups"));
    writeFileSync(path.join(dir, "backups", "tokens.hidden.json"), "{}");
    const config = path.join(dir, "config.json");
    writeFileSync(config, "{}");

    const out = execFileSync(PYTHON, [path.join(SCRIPTS, "list_companies.py"), "--project-dir", dir, "--config", config], { encoding: "utf8" });
    expect(out).toContain("alpha");
    expect(out).toContain("sandbox-backup");
    expect(out).not.toContain("hidden");
  });

  it.each(["../", "a/b", "a.b", " two", "UPPER", "", "--foo", "a_b", "a--b"])(
    "rejects malformed legacy connector slug %j",
    (slug) => {
      const dir = project();
      const config = path.join(dir, "config.json");
      const result = spawnSync(PYTHON, [
        path.join(SCRIPTS, "register_connector.py"), "--project-dir", dir,
        "--node", process.execPath, "--config", config, `--slug=${slug}`,
      ], { encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("--slug must use only lowercase");
    }
  );

  it("accepts the documented lowercase slug grammar", () => {
    const dir = project();
    const config = path.join(dir, "config.json");
    const result = spawnSync(PYTHON, [
      path.join(SCRIPTS, "register_connector.py"), "--project-dir", dir,
      "--node", process.execPath, "--config", config, "--slug=acme-123",
    ], { encoding: "utf8" });
    expect(result.status).toBe(0);
  });

  it("stores requested env values but redacts every credential-shaped key from output", () => {
    const dir = project();
    const config = path.join(dir, "config.json");
    const entries = {
      QBO_CLIENT_SECRET_SANDBOX: "sandbox-secret-material",
      QBO_TOKEN_KEY: "token-key-material",
      DATABASE_PASSWORD: "database-password-material",
      OPENAI_API_KEY: "api-key-material",
      QBO_TOOL_PROFILE: "accountant",
    };
    const envArgs = Object.entries(entries).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
    const result = spawnSync(PYTHON, [
      path.join(SCRIPTS, "register_connector.py"), "--project-dir", dir,
      "--node", process.execPath, "--config", config, ...envArgs,
    ], { encoding: "utf8" });

    expect(result.status).toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    for (const [key, value] of Object.entries(entries)) {
      if (key === "QBO_TOOL_PROFILE") continue;
      expect(output).toContain(`${key}=<hidden>`);
      expect(output).not.toContain(value);
    }
    expect(output).toContain("QBO_TOOL_PROFILE=accountant");
    expect(JSON.parse(readFileSync(config, "utf8")).mcpServers.qbo.env).toEqual(entries);
  });

  it("does not reflect a malformed --env argument that may contain a secret", () => {
    const dir = project();
    const config = path.join(dir, "config.json");
    const secret = "pasted-secret-token-material";
    const result = spawnSync(PYTHON, [
      path.join(SCRIPTS, "register_connector.py"), "--project-dir", dir,
      "--node", process.execPath, "--config", config, "--env", secret,
    ], { encoding: "utf8" });

    expect(result.status).toBe(1);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toContain("--env argument must be KEY=VALUE");
    expect(output).not.toContain(secret);
  });

  it("rejects an invalid or empty env key without reflecting its key or value", () => {
    for (const rawKey of ["", "INVALID-SECRET-NAME"]) {
      const dir = project();
      const config = path.join(dir, "config.json");
      const secret = `pasted-private-value-${rawKey || "empty"}`;
      const result = spawnSync(PYTHON, [
        path.join(SCRIPTS, "register_connector.py"), "--project-dir", dir,
        "--node", process.execPath, "--config", config, "--env", `${rawKey}=${secret}`,
      ], { encoding: "utf8" });

      expect(result.status).toBe(1);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(output).toContain("--env key is invalid");
      if (rawKey) expect(output).not.toContain(rawKey);
      expect(output).not.toContain(secret);
    }
  });

  it("makes the rewritten config and its backup owner-only on POSIX", () => {
    if (process.platform === "win32") return;
    const dir = project();
    const config = path.join(dir, "config.json");
    writeFileSync(config, JSON.stringify({ mcpServers: { existing: { command: "node" } } }), { mode: 0o644 });
    chmodSync(config, 0o644);

    const result = spawnSync(PYTHON, [
      path.join(SCRIPTS, "register_connector.py"), "--project-dir", dir,
      "--node", process.execPath, "--config", config,
    ], { encoding: "utf8" });

    expect(result.status).toBe(0);
    const backup = readdirSync(dir).find((name) => name.startsWith("config.json.bak-"));
    expect(backup).toBeTruthy();
    expect(statSync(config).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(dir, backup)).mode & 0o777).toBe(0o600);
  });

  it("documents platform-specific commands and each authorization flow's real marker", () => {
    const skill = readFileSync(path.join(ROOT, ".claude", "skills", "add-qbo-company", "SKILL.md"), "utf8");
    expect(skill).toContain("Windows PowerShell");
    expect(skill).toContain("PLAYGROUND_URL>>>");
    expect(skill).toContain("AUTHORIZE_URL>>>");
    expect(skill).toMatch(/Paste the line from the catcher page/i);
    expect(skill).toMatch(/Only the sandbox localhost and batch flows use port 3000/i);
  });
});
