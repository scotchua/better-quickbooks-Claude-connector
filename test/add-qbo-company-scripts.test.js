import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = path.join(ROOT, ".claude", "skills", "add-qbo-company", "scripts");

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

    const out = execFileSync("python3", [path.join(SCRIPTS, "list_companies.py"), "--project-dir", dir, "--config", config], { encoding: "utf8" });
    expect(out).toContain("alpha");
    expect(out).toContain("sandbox-backup");
    expect(out).not.toContain("hidden");
  });

  it.each(["../", "a/b", "a.b", " two", "UPPER", "", "--foo", "a_b", "a--b"])(
    "rejects malformed legacy connector slug %j",
    (slug) => {
      const dir = project();
      const config = path.join(dir, "config.json");
      const result = spawnSync("python3", [
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
    const result = spawnSync("python3", [
      path.join(SCRIPTS, "register_connector.py"), "--project-dir", dir,
      "--node", process.execPath, "--config", config, "--slug=acme-123",
    ], { encoding: "utf8" });
    expect(result.status).toBe(0);
  });
});
