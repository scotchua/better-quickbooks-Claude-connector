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
//   3. A 0600 key file next to the project (the Linux default, or a previously
//      created legacy fallback on macOS/Windows).
// Set QBO_TOKEN_ENCRYPTION=off to keep legacy plaintext token files.

import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from "node:crypto";
import { link, open, readFile, unlink } from "node:fs/promises";
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

// A missing key is the ONLY condition that permits key creation. Treating an
// access error, a malformed value, or a decryption failure as "missing" rotates
// the key underneath every encrypted token file and makes those files
// unrecoverable. Keep the distinction explicit at each provider boundary.
const isMissingFile = (e) => e?.code === "ENOENT";
const errorText = (e) => `${e?.message || ""}\n${e?.stderr || ""}\n${e?.stdout || ""}`.toLowerCase();

async function fsyncParentDirectory(file, {
  openFile = open,
  platform = process.platform,
} = {}) {
  // Node cannot open a directory handle on Windows. The file itself is still
  // flushed before this point, so skip only the unsupported directory step.
  if (platform === "win32") return;
  const fh = await openFile(path.dirname(file), "r");
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

// Drop-in replacement for writeFile(..., { flag: "wx" }) used for newly
// generated key material. The key bytes must reach stable storage before the
// provider reports success; otherwise encrypted token files could outlive the
// only key capable of decrypting them after a power loss.
async function durableCreateFile(file, data, options = {}, {
  openFile = open,
  platform = process.platform,
  onCreated = () => {},
} = {}) {
  const fh = await openFile(file, options.flag || "w", options.mode);
  try {
    // Lets the exclusive publisher distinguish a pre-open failure from a
    // failure after this invocation actually created its unique temp.
    onCreated();
    await fh.writeFile(data, options.encoding ? { encoding: options.encoding } : undefined);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsyncParentDirectory(file, { openFile, platform });
}

// Publish complete key material without ever exposing a writable/partial
// canonical file. The unique sibling is written and fsynced first; hard-link
// creation then atomically installs the canonical name only if it is absent.
// `link` is supported by Node on both POSIX and Windows and, because the temp
// is adjacent, cannot cross filesystems. Unlike rename, it never replaces a
// malformed or concurrently-created canonical key.
async function durablePublishFileExclusive(file, data, options = {}, {
  write = durableCreateFile,
  linkFile = link,
  removeFile = unlink,
  tokenFactory = randomUUID,
  openFile = open,
  platform = process.platform,
} = {}) {
  const token = String(tokenFactory());
  if (!/^[A-Za-z0-9-]+$/.test(token)) {
    throw new Error("The key publication token must contain only letters, numbers, and hyphens.");
  }
  const temp = `${file}.${process.pid}.${token}.tmp`;
  let ownsTemp = false;
  let result;
  let operationError;
  try {
    try {
      await write(temp, data, { ...options, flag: "wx" }, {
        openFile,
        platform,
        onCreated: () => { ownsTemp = true; },
      });
      // Custom injected writers predating onCreated still retain the original
      // hook contract; a successful return proves they created the temp.
      ownsTemp = true;
    } catch (error) {
      // This EEXIST names the unique *temp*, not the canonical key. Never let a
      // temp collision masquerade as losing canonical publication, and never
      // unlink the colliding pathname unless onCreated proved we own it.
      if (error?.code === "EEXIST") {
        const collision = new Error(`Key publication temp ${temp} already exists; refusing to reuse or remove it.`, {
          cause: error,
        });
        collision.code = "EKEYTEMPCOLLISION";
        throw collision;
      }
      throw error;
    }

    try {
      await linkFile(temp, file);
      result = { created: true };
      await fsyncParentDirectory(file, { openFile, platform });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      result = { created: false };
    }
  } catch (error) {
    operationError = error;
  }

  let cleanupError;
  if (ownsTemp) {
    let removed = false;
    try {
      await removeFile(temp);
      removed = true;
    } catch (error) {
      if (error?.code !== "ENOENT") cleanupError = error;
    }
    if (removed) {
      try {
        // Persist removal of the now-redundant secret-bearing sibling. On
        // Windows fsyncParentDirectory intentionally performs no directory
        // open, matching the portability policy used elsewhere in this file.
        await fsyncParentDirectory(temp, { openFile, platform });
      } catch (error) {
        cleanupError = cleanupError
          ? new AggregateError([cleanupError, error], `Could not clean up key publication temp ${temp}.`)
          : error;
      }
    }
  }

  if (operationError && cleanupError) {
    throw new AggregateError(
      [operationError, cleanupError],
      `Key publication failed and its unique temp ${temp} could not be cleaned up safely.`
    );
  }
  if (operationError) throw operationError;
  if (cleanupError) throw cleanupError;
  return result;
}

function parseHexKey(value, source) {
  const hex = String(value ?? "").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`${source} exists but is not a 32-byte hex key; refusing to replace it.`);
  }
  return Buffer.from(hex, "hex");
}

async function readFileKey(keyFile, read = readFile) {
  try {
    return parseHexKey(await read(keyFile, "utf8"), `Token key file ${keyFile}`);
  } catch (e) {
    if (isMissingFile(e)) return null;
    if (/refusing to replace it/.test(e.message || "")) throw e;
    throw new Error(`Cannot read token key file ${keyFile}; refusing to create a replacement (${e.message}).`, { cause: e });
  }
}

// The canonical pathname appears atomically only after complete bytes are
// durable. If another process wins, read and validate its key instead of
// replacing it.
async function createFileKeyExclusive(keyFile, key, {
  read = readFile,
  write = durableCreateFile,
  publish = durablePublishFileExclusive,
  linkFile = link,
  removeFile = unlink,
  tokenFactory = randomUUID,
  openFile = open,
  platform = process.platform,
} = {}) {
  try {
    const publication = await publish(keyFile, key.toString("hex") + "\n", {
      encoding: "utf8", mode: 0o600, flag: "wx",
    }, {
      write, linkFile, removeFile, tokenFactory, openFile, platform,
    });
    if (publication.created) return { key, created: true };
  } catch (e) {
    if (e?.code !== "EEXIST") {
      throw new Error(`Cannot create token key file ${keyFile} (${e.message}).`, { cause: e });
    }
  }
  const winner = await readFileKey(keyFile, read);
  if (!winner) {
    throw new Error(`Token key file ${keyFile} appeared during creation but cannot be read; refusing to replace it.`);
  }
  return { key: winner, created: false };
}

async function keyFromEnv() {
  const hex = process.env.QBO_TOKEN_KEY;
  if (!hex) return null;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("QBO_TOKEN_KEY must be 64 hex characters (a 32-byte key).");
  }
  return Buffer.from(hex, "hex");
}

async function keyFromFile({
  keyFile = KEY_FILE,
  read = readFile,
  write = durableCreateFile,
  publish = durablePublishFileExclusive,
  linkFile = link,
  removeFile = unlink,
  tokenFactory = randomUUID,
  openFile = open,
  platform = process.platform,
  random = randomBytes,
  createIfMissing = true,
} = {}) {
  const existing = await readFileKey(keyFile, read);
  if (existing || !createIfMissing) return existing;
  const result = await createFileKeyExclusive(keyFile, random(32), {
    read,
    write,
    publish,
    linkFile,
    removeFile,
    tokenFactory,
    openFile,
    platform,
  });
  if (result.created) log("Created token encryption key file", keyFile);
  return result.key;
}

async function runSecurity(args, { stdin } = {}) {
  const p = execFileP("security", args);
  if (stdin !== undefined) {
    p.child.stdin.write(stdin);
    p.child.stdin.end();
  }
  const { stdout } = await p;
  return stdout;
}

function isMacKeyMissing(e) {
  const text = errorText(e);
  return Number(e?.code) === 44
    || text.includes("errsecitemnotfound")
    || text.includes("could not be found in the keychain")
    || text.includes("specified item could not be found");
}

function isMacKeyDuplicate(e) {
  const text = errorText(e);
  return Number(e?.code) === 45
    || text.includes("errsecduplicateitem")
    || text.includes("already exists")
    || text.includes("duplicate item");
}

const securityQuote = (value) => `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

async function readMacKey(account, security = runSecurity) {
  try {
    const stdout = await security([
      "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w",
    ]);
    return parseHexKey(stdout, "macOS Keychain token key");
  } catch (e) {
    if (isMacKeyMissing(e)) return null;
    if (/refusing to replace it/.test(e.message || "")) throw e;
    throw new Error(`Cannot read the macOS Keychain token key; refusing to create a replacement (${e.message}).`, { cause: e });
  }
}

async function keyFromMacKeychain({
  account = os.userInfo().username,
  security = runSecurity,
  random = randomBytes,
} = {}) {
  const existing = await readMacKey(account, security);
  if (existing) return existing;

  const key = random(32);
  // Deliberately omit `-U`: updating an item after a racy or mistaken lookup
  // would rotate a live key. A concurrent creator produces a duplicate error;
  // in that case read and use the winner.
  const command =
    `add-generic-password -s ${securityQuote(KEYCHAIN_SERVICE)} ` +
    `-a ${securityQuote(account)} -w ${securityQuote(key.toString("hex"))}\n`;
  try {
    await security(["-i"], { stdin: command });
    log("Created token encryption key in the macOS Keychain.");
    return key;
  } catch (e) {
    if (!isMacKeyDuplicate(e)) {
      throw new Error(`Cannot create the macOS Keychain token key (${e.message}).`, { cause: e });
    }
    const winner = await readMacKey(account, security);
    if (!winner) {
      throw new Error("A macOS Keychain token key was created concurrently but cannot be read; refusing to replace it.");
    }
    return winner;
  }
}

async function runPowershell(command) {
  const { stdout } = await execFileP("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command", command,
  ]);
  return stdout.trim();
}

// Same, but the script arrives on stdin ("-Command -"), for the one command
// that carries key material: argv is visible in process listings, stdin is not.
async function runPowershellStdin(script) {
  const p = execFileP("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "-"]);
  p.child.stdin.write(script + "\n");
  p.child.stdin.end();
  const { stdout } = await p;
  return stdout.trim();
}

function validateBase64Blob(raw, source) {
  const blob = String(raw ?? "").trim();
  // A protected 64-character key is tiny. Bound the input before embedding it
  // in a PowerShell command so a corrupt file cannot become an enormous argv.
  if (!blob || blob.length > 16_384 || blob.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(blob)) {
    throw new Error(`${source} exists but is not valid Base64; refusing to replace it.`);
  }
  return blob;
}

async function readWindowsDpapiKey(dpapiFile, { read = readFile, powershell = runPowershell } = {}) {
  try {
    const raw = await read(dpapiFile, "utf8");
    const blob = validateBase64Blob(raw, `DPAPI token key file ${dpapiFile}`);
    let hex;
    try {
      hex = await powershell(
        "Add-Type -AssemblyName System.Security; " +
        `[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String('${blob}'), $null, 'CurrentUser'))`
      );
    } catch (e) {
      throw new Error(`Cannot decrypt DPAPI token key file ${dpapiFile}; refusing to replace it (${e.message}).`, { cause: e });
    }
    return parseHexKey(hex, `Decrypted DPAPI token key file ${dpapiFile}`);
  } catch (e) {
    if (isMissingFile(e)) return null;
    if (/refusing to replace it/.test(e.message || "")) throw e;
    throw new Error(`Cannot read DPAPI token key file ${dpapiFile}; refusing to create a replacement (${e.message}).`, { cause: e });
  }
}

async function keyFromWindowsDpapi({
  dpapiFile = DPAPI_FILE,
  read = readFile,
  write = durableCreateFile,
  publish = durablePublishFileExclusive,
  linkFile = link,
  removeFile = unlink,
  tokenFactory = randomUUID,
  openFile = open,
  platform = process.platform,
  powershell = runPowershell,
  powershellStdin = runPowershellStdin,
  random = randomBytes,
} = {}) {
  const existing = await readWindowsDpapiKey(dpapiFile, { read, powershell });
  if (existing) return existing;

  const key = random(32);
  const rawBlob = await powershellStdin(
    "Add-Type -AssemblyName System.Security; " +
    `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes('${key.toString("hex")}'), $null, 'CurrentUser'))`
  );
  const blob = validateBase64Blob(rawBlob, "New DPAPI-protected token key");
  let publication;
  try {
    publication = await publish(dpapiFile, blob + "\n", {
      encoding: "utf8", mode: 0o600, flag: "wx",
    }, {
      write, linkFile, removeFile, tokenFactory, openFile, platform,
    });
  } catch (e) {
    if (e?.code !== "EEXIST") {
      throw new Error(`Cannot create DPAPI token key file ${dpapiFile} (${e.message}).`, { cause: e });
    }
  }
  if (publication?.created) {
    log("Created DPAPI-protected token encryption key file", dpapiFile);
    return key;
  }
  const winner = await readWindowsDpapiKey(dpapiFile, { read, powershell });
  if (!winner) {
    throw new Error(`DPAPI token key file ${dpapiFile} appeared during creation but cannot be read; refusing to replace it.`);
  }
  return winner;
}

let cachedKey = null;
let keyInFlight = null;

async function loadKey() {
  const envKey = await keyFromEnv();
  if (envKey) return envKey;

  if (process.platform === "darwin") {
    const keychainKey = await readMacKey(os.userInfo().username);
    if (keychainKey) return keychainKey;
    // Older releases could fall back to .qbo-key when Keychain creation failed.
    // Prefer that existing key over creating a new Keychain item and silently
    // rotating away from it.
    const fallback = await keyFromFile({ createIfMissing: false });
    return fallback || keyFromMacKeychain();
  }
  if (process.platform === "win32") {
    const dpapiKey = await readWindowsDpapiKey(DPAPI_FILE);
    if (dpapiKey) return dpapiKey;
    // Same migration rule for a pre-existing plaintext fallback key file.
    const fallback = await keyFromFile({ createIfMissing: false });
    return fallback || keyFromWindowsDpapi();
  }
  return keyFromFile();
}

export async function getKey() {
  if (cachedKey) return cachedKey;
  if (!keyInFlight) {
    keyInFlight = loadKey()
      .then((key) => (cachedKey = key))
      .finally(() => { keyInFlight = null; });
  }
  return keyInFlight;
}

// Focused provider hooks for unit tests. They are deliberately dependency-
// injected so tests never touch the operator's real Keychain, DPAPI store, or
// project key file.
export const __test = {
  durableCreateFile,
  durablePublishFileExclusive,
  fsyncParentDirectory,
  keyFromFile,
  keyFromMacKeychain,
  keyFromWindowsDpapi,
  readMacKey,
  readWindowsDpapiKey,
};

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
