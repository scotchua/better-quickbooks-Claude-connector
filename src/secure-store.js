// secure-store.js: encryption at rest for OAuth token files.
//
// Token files keep two plaintext identifiers (realmId, environment) so company
// discovery stays cheap, while every credential (access token, refresh token,
// expiries) lives inside an AES-256-GCM blob. The 32-byte master key comes
// from, in order:
//   1. QBO_TOKEN_KEY env var (64 hex chars): for tests/CI or externally
//      managed keys.
//   2. The platform secret store, reached without native dependencies:
//      macOS Keychain via the `security` CLI, Windows DPAPI via PowerShell.
//   3. A 0600 key file next to the project (fallback, and the Linux default).
// Set QBO_TOKEN_ENCRYPTION=off to keep legacy plaintext token files.

import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const KEYCHAIN_SERVICE = "qbo-mcp-server";
const KEY_FILE = path.join(ROOT, ".qbo-key");
const DPAPI_FILE = path.join(ROOT, ".qbo-key.dpapi");

function log(...args) {
  console.error("[qbo-secure]", ...args);
}

export function encryptionEnabled() {
  return (process.env.QBO_TOKEN_ENCRYPTION || "on").toLowerCase() !== "off";
}

// ---- key providers ----------------------------------------------------------

async function keyFromEnv() {
  const hex = process.env.QBO_TOKEN_KEY;
  if (!hex) return null;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("QBO_TOKEN_KEY must be 64 hex characters (a 32-byte key).");
  }
  return Buffer.from(hex, "hex");
}

async function keyFromFile() {
  try {
    const hex = (await readFile(KEY_FILE, "utf8")).trim();
    if (/^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, "hex");
  } catch { /* not created yet */ }
  const key = randomBytes(32);
  const tmp = `${KEY_FILE}.${process.pid}.tmp`;
  await writeFile(tmp, key.toString("hex") + "\n", { encoding: "utf8", mode: 0o600 });
  await rename(tmp, KEY_FILE);
  log("Created token encryption key file", KEY_FILE);
  return key;
}

async function keyFromMacKeychain() {
  const account = os.userInfo().username;
  try {
    const { stdout } = await execFileP("security", [
      "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w",
    ]);
    const hex = stdout.trim();
    if (/^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, "hex");
    throw new Error("keychain item is not a 32-byte hex key");
  } catch {
    const key = randomBytes(32);
    await execFileP("security", [
      "add-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account,
      "-w", key.toString("hex"), "-U",
    ]);
    log("Created token encryption key in the macOS Keychain.");
    return key;
  }
}

async function runPowershell(command) {
  const { stdout } = await execFileP("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command", command,
  ]);
  return stdout.trim();
}

async function keyFromWindowsDpapi() {
  try {
    const blob = (await readFile(DPAPI_FILE, "utf8")).trim();
    const hex = await runPowershell(
      "Add-Type -AssemblyName System.Security; " +
      `[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String('${blob}'), $null, 'CurrentUser'))`
    );
    if (/^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, "hex");
    throw new Error("DPAPI blob did not decode to a 32-byte hex key");
  } catch {
    const key = randomBytes(32);
    const blob = await runPowershell(
      "Add-Type -AssemblyName System.Security; " +
      `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes('${key.toString("hex")}'), $null, 'CurrentUser'))`
    );
    const tmp = `${DPAPI_FILE}.${process.pid}.tmp`;
    await writeFile(tmp, blob + "\n", { encoding: "utf8", mode: 0o600 });
    await rename(tmp, DPAPI_FILE);
    log("Created DPAPI-protected token encryption key file", DPAPI_FILE);
    return key;
  }
}

let cachedKey = null;

export async function getKey() {
  if (cachedKey) return cachedKey;
  const envKey = await keyFromEnv();
  if (envKey) return (cachedKey = envKey);
  try {
    if (process.platform === "darwin") return (cachedKey = await keyFromMacKeychain());
    if (process.platform === "win32") return (cachedKey = await keyFromWindowsDpapi());
  } catch (e) {
    log(`Platform secret store unavailable (${e.message}); falling back to a 0600 key file.`);
  }
  return (cachedKey = await keyFromFile());
}

// ---- encrypt / decrypt ------------------------------------------------------

// Fields kept in plaintext so company discovery can read them without the key.
const PLAINTEXT_META = ["realmId", "environment"];

export async function encryptTokens(tokens) {
  const key = await getKey();
  const secrets = { ...tokens };
  const out = {};
  for (const f of PLAINTEXT_META) {
    if (tokens[f] !== undefined) { out[f] = tokens[f]; delete secrets[f]; }
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(secrets), "utf8"), cipher.final()]);
  out.enc = {
    v: 1,
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
  return out;
}

export function isEncrypted(fileJson) {
  return !!fileJson?.enc?.data;
}

export async function decryptTokens(fileJson) {
  const key = await getKey();
  const { iv, tag, data, alg } = fileJson.enc;
  if (alg !== "aes-256-gcm") throw new Error(`Unsupported token encryption algorithm: ${alg}`);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  const plain = Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]);
  const secrets = JSON.parse(plain.toString("utf8"));
  const out = { ...secrets };
  for (const f of PLAINTEXT_META) if (fileJson[f] !== undefined) out[f] = fileJson[f];
  return out;
}
