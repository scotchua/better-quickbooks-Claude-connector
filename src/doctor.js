#!/usr/bin/env node
// Local, read-only installation diagnostics. Never prints credential values or
// token contents and never contacts Intuit; use the health_check MCP tool for a
// live connection test.

import { access, readFile, readdir, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { policyPath, validatePolicy } from "./policy.js";
import { auditDir as resolveAuditDir } from "./audit.js";
import { toolProfileFromEnv } from "./tool-profiles.js";
import { duplicateRealms } from "./company-registry.js";
import { resolveEnvPath } from "./util.js";
import { tokensDir } from "./token-directory.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = path.join(ROOT, ".env");
const results = [];

const add = (status, check, detail, next_step) =>
  results.push({ status, check, detail, ...(next_step ? { next_step } : {}) });

let fileEnv = {};
try {
  const raw = await readFile(ENV_FILE, "utf8");
  fileEnv = dotenv.parse(raw);
  const mode = (await stat(ENV_FILE)).mode & 0o777;
  if (mode & 0o077) {
    add("warn", ".env permissions", `File mode is ${mode.toString(8)}; other local users may be able to read it.`, `Run chmod 600 "${ENV_FILE}".`);
  } else {
    add("ok", ".env", "Configuration file exists and is private.");
  }
} catch (e) {
  add("error", ".env", e.code === "ENOENT" ? "Configuration file is missing." : `Cannot read configuration (${e.message}).`, "Copy .env.example to .env and add the Intuit credentials.");
}

const env = { ...fileEnv, ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== "")) };
// Registry diagnostics read process.env just like the runtime.
dotenv.populate(process.env, env, { override: true });

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor >= 22) add("ok", "Node.js", `Version ${process.versions.node}.`);
else add("error", "Node.js", `Version ${process.versions.node}; this connector requires Node 22 or newer.`, "Install Node.js 22+ and rerun npm install.");

const credentialPairs = [
  ["production", "QBO_CLIENT_ID", "QBO_CLIENT_SECRET"],
  ["sandbox", "QBO_CLIENT_ID_SANDBOX", "QBO_CLIENT_SECRET_SANDBOX"],
];
let completeCredentialPairs = 0;
for (const [label, idName, secretName] of credentialPairs) {
  const hasId = Boolean(env[idName]);
  const hasSecret = Boolean(env[secretName]);
  if (hasId && hasSecret) {
    completeCredentialPairs++;
    add("ok", `${label} credentials`, `${idName} and ${secretName} are set.`);
  } else if (hasId || hasSecret) {
    add("error", `${label} credentials`, `Only one half of the credential pair is set.`, `Set both ${idName} and ${secretName}, or remove both.`);
  } else {
    add("info", `${label} credentials`, "Not configured.");
  }
}
if (!completeCredentialPairs) add("error", "Intuit credentials", "No complete production or sandbox credential pair is configured.");

try {
  const profile = toolProfileFromEnv(env);
  add("ok", "Tool profile", `${profile} profile selected.`);
} catch (e) {
  add("error", "Tool profile", e.message);
}

const filesBase = env.QBO_FILES_DIR ? resolveEnvPath(env.QBO_FILES_DIR) : null;
if (!filesBase) {
  add("error", "QBO_FILES_DIR", "No local-files fence is configured. Imports, reconciliation, reports, and downloads will be refused.", "Set QBO_FILES_DIR to the root of the firm's client-file tree.");
} else {
  try {
    const info = await stat(filesBase);
    if (!info.isDirectory()) throw new Error("the path is not a directory");
    await access(filesBase, fsConstants.R_OK | fsConstants.W_OK);
    add("ok", "QBO_FILES_DIR", `${filesBase} exists and is readable/writable.`);
  } catch (e) {
    add("error", "QBO_FILES_DIR", `${filesBase} is unusable (${e.message}).`);
  }
}

const tokenDirectory = tokensDir(env);
add("info", "QBO_TOKENS_DIR", `Using ${tokenDirectory}.`);
add("info", "QBO_CLIENTS_FILE", `Using ${resolveEnvPath(env.QBO_CLIENTS_FILE, path.join(ROOT, "clients.json"))}.`);

try {
  const names = await readdir(tokenDirectory);
  const tokenNames = names.filter((name) => /^tokens(?:\.[A-Za-z0-9_-]+)?\.json$/.test(name));
  if (!tokenNames.length) {
    add("warn", "Company authorizations", "No token files were found.", "Connect a sandbox with connect_company/admin profile, or run the documented production Playground flow.");
  } else {
    const loose = [];
    const invalid = [];
    for (const name of tokenNames) {
      const tokenPath = path.join(tokenDirectory, name);
      const mode = (await stat(tokenPath)).mode & 0o777;
      if (mode & 0o077) loose.push(name);
      try {
        const parsed = JSON.parse(await readFile(tokenPath, "utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("root is not an object");
        if (!parsed.realmId) throw new Error("realmId is missing");
        if (!["sandbox", "production"].includes(String(parsed.environment || "").toLowerCase())) {
          throw new Error("environment is not sandbox or production");
        }
        if (parsed.enc) {
          if (parsed.enc.v !== 1 || parsed.enc.alg !== "aes-256-gcm" ||
              !parsed.enc.iv || !parsed.enc.tag || !parsed.enc.data) {
            throw new Error("encrypted token envelope is incomplete or unsupported");
          }
        } else if (!parsed.access_token || !parsed.refresh_token) {
          throw new Error("neither a valid encrypted envelope nor a complete legacy token bundle");
        }
      } catch (e) {
        invalid.push(`${name} (${e.message})`);
      }
    }
    if (invalid.length) {
      add("error", "Company authorizations", `Invalid token file(s): ${invalid.join("; ")}.`, "Repair the file or move it to backups/; the connector fails closed rather than hiding it.");
    } else {
      add(loose.length ? "warn" : "ok", "Company authorizations", `${tokenNames.length} token file(s) found${loose.length ? `; permissions are too broad on: ${loose.join(", ")}` : " and structurally valid with private permissions"}.`, loose.length ? "Use chmod 600 on the named token files." : undefined);
    }
  }
} catch (e) {
  add("error", "Company authorizations", `Cannot inspect token files (${e.message}).`);
}

// Recovery sidecars contain encrypted authorization state and deliberately do
// not look like company token files. Report only counts (never realm ids or
// slug-bearing filenames) so diagnostics cannot leak client identifiers.
try {
  const names = await readdir(tokenDirectory);
  const refreshRecoveryCount = names.filter((name) => /^\.qbo-refresh-recovery-[A-Za-z0-9_-]+\.json$/.test(name)).length;
  const disconnectRecoveryCount = names.filter((name) => /^\.qbo-disconnect-recovery-[A-Za-z0-9_-]+\.json$/.test(name)).length;
  const playgroundStageCount = names.filter((name) => /^\.qbo-token-stage-[A-Za-z0-9_-]+\.json$/.test(name)).length;
  if (!refreshRecoveryCount && !disconnectRecoveryCount && !playgroundStageCount) {
    add("ok", "OAuth recovery state", "No interrupted token operation is pending.");
  } else {
    add(
      "warn",
      "OAuth recovery state",
      `${refreshRecoveryCount} refresh, ${disconnectRecoveryCount} disconnect, and ${playgroundStageCount} Playground recovery record(s) are pending.`,
      "Run the corresponding connector command again to recover locally; it will fail closed rather than replay an uncertain token."
    );
  }
} catch (e) {
  add("error", "OAuth recovery state", `Cannot inspect recovery sidecars (${e.message}).`);
}

// One realm reachable under two slugs is a defect worth naming without a
// write: write guardrails now resolve by realm and merge the strictest rule, so
// the books stay protected, but provenance and audit records still cannot say
// which label a posting used.
try {
  const dupes = await duplicateRealms();
  if (!dupes.length) {
    add("ok", "Company identity", "Every authorized company addresses a distinct QuickBooks realm.");
  } else {
    for (const dupe of dupes) {
      const displaySlug = (slug) => slug || "(default)";
      // Prefer the named multi-company identity as the one to retain. The
      // legacy default remains supported, but it is harder to address and
      // easier to overlook in policy/audit workflows.
      const ordered = [...dupe.slugs].sort((a, b) => {
        if (!a && b) return 1;
        if (a && !b) return -1;
        return a.localeCompare(b);
      });
      const duplicateFiles = ordered.slice(1).map((slug) =>
        slug ? `tokens.${slug}.json` : "tokens.json"
      );
      add("error", "Company identity",
        `Realm ${dupe.realmId} is authorized under ${dupe.slugs.length} identities: ${ordered.map(displaySlug).join(", ")}.`,
        `Do not run disconnect while aliases share a realm: revocation may invalidate the identity you intend to keep. ` +
        `If these are confirmed copies of one authorization and ${displaySlug(ordered[0])} passes a health check, move ` +
        `${duplicateFiles.join(", ")} into backups/ (a reversible local de-alias). If they are not known copies, review ` +
        `the Intuit app connection and reauthorize exactly one slug.`);
    }
  }
} catch (e) {
  add("error", "Company identity", `Cannot check for duplicate realms (${e.message}).`);
}

const configuredPolicyPath = policyPath(env);
try {
  const raw = (await readFile(configuredPolicyPath, "utf8")).trim();
  validatePolicy(raw ? JSON.parse(raw) : {}, configuredPolicyPath);
  add("ok", "Write policy", `${configuredPolicyPath} is valid.`);
} catch (e) {
  if (e.code === "ENOENT") {
    add("warn", "Write policy", `No policy file is active at ${configuredPolicyPath}; only the global safety gates apply.`);
  } else {
    add("error", "Write policy", `${configuredPolicyPath} is invalid (${e.message}).`);
  }
}

const auditDir = resolveAuditDir(env);
try {
  const info = await stat(auditDir);
  if (!info.isDirectory()) throw new Error("path exists but is not a directory");
  await access(auditDir, fsConstants.W_OK);
  add("ok", "Audit journal", `${auditDir} is writable.`);
} catch (e) {
  if (e.code === "ENOENT") {
    try {
      await access(path.dirname(auditDir), fsConstants.W_OK);
      add("ok", "Audit journal", `${auditDir} can be created on the first audited operation.`);
    } catch (parentError) {
      add("error", "Audit journal", `Cannot create ${auditDir} (${parentError.message}).`);
    }
  } else {
    add("error", "Audit journal", `${auditDir} is not usable (${e.message}).`);
  }
}

{
  const desktopConfig = process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json")
    : process.platform === "win32"
      ? path.join(env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json")
      : path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "Claude", "claude_desktop_config.json");
  try {
    const config = JSON.parse(await readFile(desktopConfig, "utf8"));
    const configured = JSON.stringify(config).includes(ROOT);
    add(configured ? "ok" : "warn", "Claude Desktop config", configured ? "The connector path appears in Claude Desktop configuration." : "Claude Desktop configuration exists but does not reference this connector.");
  } catch (e) {
    add("info", "Claude Desktop config", e.code === "ENOENT" ? "No Claude Desktop config was found; this is fine when using Claude Code or another MCP host." : `Could not validate it (${e.message}).`);
  }
}

const summary = {
  ok: results.filter((r) => r.status === "ok").length,
  warnings: results.filter((r) => r.status === "warn").length,
  errors: results.filter((r) => r.status === "error").length,
  info: results.filter((r) => r.status === "info").length,
};

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify({ summary, results }, null, 2)}\n`);
} else {
  const icon = { ok: "OK", warn: "WARN", error: "ERROR", info: "INFO" };
  for (const row of results) {
    process.stdout.write(`[${icon[row.status]}] ${row.check}: ${row.detail}\n`);
    if (row.next_step) process.stdout.write(`       Next: ${row.next_step}\n`);
  }
  process.stdout.write(`\n${summary.errors} error(s), ${summary.warnings} warning(s), ${summary.ok} check(s) OK. No network calls were made.\n`);
}

process.exitCode = summary.errors ? 1 : 0;
