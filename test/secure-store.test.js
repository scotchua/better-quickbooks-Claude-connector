import { describe, it, expect, vi } from "vitest";
import { mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Pin the key via env so the test never touches a platform secret store.
process.env.QBO_TOKEN_KEY = "a".repeat(64);

const { encryptTokens, decryptTokens, isEncrypted, encryptionEnabled, __test } = await import("../src/secure-store.js");

const fsError = (code, message = code) => Object.assign(new Error(message), { code });

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qbo-secure-store-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const sample = {
  access_token: "at-secret",
  refresh_token: "rt-secret",
  realmId: "9341453",
  environment: "sandbox",
  expires_at: 1900000000000,
  refresh_expires_at: 1990000000000,
};

describe("secure token store", () => {
  it("is enabled by default", () => {
    expect(encryptionEnabled()).toBe(true);
  });

  it("round-trips tokens through AES-256-GCM", async () => {
    const enc = await encryptTokens(sample);
    expect(isEncrypted(enc)).toBe(true);
    const dec = await decryptTokens(enc);
    expect(dec).toEqual(sample);
  });

  it("keeps realmId and environment as plaintext metadata only", async () => {
    const enc = await encryptTokens(sample);
    expect(enc.realmId).toBe("9341453");
    expect(enc.environment).toBe("sandbox");
    const raw = JSON.stringify(enc);
    expect(raw).not.toContain("at-secret");
    expect(raw).not.toContain("rt-secret");
    expect(enc.access_token).toBeUndefined();
    expect(enc.refresh_token).toBeUndefined();
  });

  it("rejects tampered ciphertext (GCM auth)", async () => {
    const enc = await encryptTokens(sample);
    const data = Buffer.from(enc.enc.data, "base64");
    data[0] ^= 0xff;
    enc.enc.data = data.toString("base64");
    await expect(decryptTokens(enc)).rejects.toThrow();
  });

  it("treats legacy plaintext files as not encrypted", () => {
    expect(isEncrypted(sample)).toBe(false);
    expect(isEncrypted(null)).toBe(false);
  });
});

describe("key provider fail-closed behavior", () => {
  it("creates a missing file key exclusively and gives concurrent callers the same key", async () => {
    await withTempDir(async (dir) => {
      const keyFile = path.join(dir, "key");
      let byte = 1;
      const random = () => Buffer.alloc(32, byte++);
      const [a, b] = await Promise.all([
        __test.keyFromFile({ keyFile, random }),
        __test.keyFromFile({ keyFile, random }),
      ]);
      expect(a).toEqual(b);
      expect((await readFile(keyFile, "utf8")).trim()).toBe(a.toString("hex"));
    });
  });

  it("never exposes a partial canonical key and makes a concurrent creator use one complete winner", async () => {
    await withTempDir(async (dir) => {
      const keyFile = path.join(dir, "key");
      const slowKey = Buffer.alloc(32, 0x11);
      const fastKey = Buffer.alloc(32, 0x22);
      let signalPartial;
      const partialWritten = new Promise((resolve) => { signalPartial = resolve; });
      let allowCompletion;
      const canComplete = new Promise((resolve) => { allowCompletion = resolve; });
      const slowWrite = async (temp, data, options, { onCreated } = {}) => {
        const handle = await open(temp, options.flag, options.mode);
        try {
          onCreated?.();
          const bytes = Buffer.from(data, options.encoding || "utf8");
          const midpoint = Math.max(1, Math.floor(bytes.length / 2));
          await handle.writeFile(bytes.subarray(0, midpoint));
          signalPartial(temp);
          await canComplete;
          await handle.writeFile(bytes.subarray(midpoint));
          await handle.sync();
        } finally {
          await handle.close();
        }
      };

      const slow = __test.keyFromFile({
        keyFile,
        random: () => slowKey,
        write: slowWrite,
        tokenFactory: () => "slow-creator",
      });
      const slowTemp = await partialWritten;
      try {
        await expect(readFile(keyFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        expect((await readFile(slowTemp, "utf8")).length).toBeGreaterThan(0);
        expect((await readFile(slowTemp, "utf8")).length).toBeLessThan(65);

        // Because the slow process exposed only its unique temp, this complete
        // creator can safely win canonical publication.
        const fast = await __test.keyFromFile({
          keyFile,
          random: () => fastKey,
          tokenFactory: () => "fast-creator",
        });
        expect(fast).toEqual(fastKey);
      } finally {
        allowCompletion();
      }

      expect(await slow).toEqual(fastKey);
      expect((await readFile(keyFile, "utf8")).trim()).toBe(fastKey.toString("hex"));
      expect(await readdir(dir)).toEqual(["key"]);
    });
  });

  it("does not confuse a unique-temp collision with a canonical publication winner", async () => {
    await withTempDir(async (dir) => {
      const keyFile = path.join(dir, "key");
      const token = "fixed-token";
      const temp = `${keyFile}.${process.pid}.${token}.tmp`;
      await writeFile(temp, "belongs to another creator");

      await expect(__test.keyFromFile({
        keyFile,
        random: () => Buffer.alloc(32, 0x31),
        tokenFactory: () => token,
      })).rejects.toThrow(/publication temp.*already exists.*refusing to reuse or remove/i);
      await expect(readFile(keyFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(temp, "utf8")).toBe("belongs to another creator");
    });
  });

  it("fails closed on an unsupported hard link and removes only its owned temp", async () => {
    await withTempDir(async (dir) => {
      const keyFile = path.join(dir, "key");
      const linkFile = vi.fn(async () => { throw fsError("ENOTSUP", "hard links unsupported"); });

      await expect(__test.keyFromFile({
        keyFile,
        random: () => Buffer.alloc(32, 0x35),
        tokenFactory: () => "unsupported-link",
        linkFile,
      })).rejects.toThrow(/cannot create token key.*hard links unsupported/i);
      await expect(readFile(keyFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(dir)).toEqual([]);
      expect(linkFile).toHaveBeenCalledOnce();
    });
  });

  it("never overwrites a malformed canonical key that appears during publication", async () => {
    await withTempDir(async (dir) => {
      const keyFile = path.join(dir, "key");
      const linkFile = async (_temp, canonical) => {
        await writeFile(canonical, "not-a-key\n");
        throw fsError("EEXIST", "canonical appeared");
      };

      await expect(__test.keyFromFile({
        keyFile,
        random: () => Buffer.alloc(32, 0x41),
        tokenFactory: () => "malformed-winner",
        linkFile,
      })).rejects.toThrow(/exists but is not a 32-byte hex key.*refusing/i);
      expect(await readFile(keyFile, "utf8")).toBe("not-a-key\n");
      expect(await readdir(dir)).toEqual(["key"]);
    });
  });

  it("does not replace a malformed file key", async () => {
    await withTempDir(async (dir) => {
      const keyFile = path.join(dir, "key");
      await writeFile(keyFile, "not-a-key\n");
      await expect(__test.keyFromFile({ keyFile })).rejects.toThrow(/exists but is not a 32-byte hex key.*refusing/i);
      expect(await readFile(keyFile, "utf8")).toBe("not-a-key\n");
    });
  });

  it("does not create a file key after a read/access error", async () => {
    const write = vi.fn();
    const read = vi.fn(async () => { throw fsError("EACCES", "permission denied"); });
    await expect(__test.keyFromFile({ keyFile: "/unreadable/key", read, write }))
      .rejects.toThrow(/cannot read.*refusing to create a replacement/i);
    expect(write).not.toHaveBeenCalled();
  });

  it("creates a Keychain key only after a confirmed item-not-found result", async () => {
    const key = Buffer.alloc(32, 0x31);
    const calls = [];
    const security = vi.fn(async (args, options = {}) => {
      calls.push({ args, options });
      if (args[0] === "find-generic-password") {
        throw Object.assign(new Error("The specified item could not be found in the keychain."), { code: 44 });
      }
      return "";
    });
    expect(await __test.keyFromMacKeychain({ account: "tester", security, random: () => key })).toEqual(key);
    expect(calls).toHaveLength(2);
    expect(calls[1].options.stdin).toContain("add-generic-password");
    expect(calls[1].options.stdin).not.toContain(" -U");
  });

  it("does not replace a malformed or temporarily inaccessible Keychain item", async () => {
    const malformedSecurity = vi.fn(async () => "not-a-key\n");
    await expect(__test.keyFromMacKeychain({ account: "tester", security: malformedSecurity }))
      .rejects.toThrow(/exists but is not a 32-byte hex key.*refusing/i);
    expect(malformedSecurity).toHaveBeenCalledTimes(1);

    const deniedSecurity = vi.fn(async () => { throw fsError("EACCES", "User interaction is not allowed"); });
    await expect(__test.keyFromMacKeychain({ account: "tester", security: deniedSecurity }))
      .rejects.toThrow(/cannot read the macOS Keychain.*refusing/i);
    expect(deniedSecurity).toHaveBeenCalledTimes(1);
  });

  it("uses a concurrently-created Keychain item instead of updating it", async () => {
    const winner = Buffer.alloc(32, 0x42);
    let finds = 0;
    const security = vi.fn(async (args) => {
      if (args[0] === "find-generic-password") {
        finds++;
        if (finds === 1) throw Object.assign(new Error("item not found"), { code: 44 });
        return winner.toString("hex") + "\n";
      }
      throw Object.assign(new Error("The specified item already exists in the keychain."), { code: 45 });
    });
    const result = await __test.keyFromMacKeychain({
      account: "tester",
      security,
      random: () => Buffer.alloc(32, 0x43),
    });
    expect(result).toEqual(winner);
    expect(finds).toBe(2);
  });

  it("creates a DPAPI key only when its file is confirmed missing", async () => {
    await withTempDir(async (dir) => {
      const dpapiFile = path.join(dir, "key.dpapi");
      const key = Buffer.alloc(32, 0x51);
      const protectedBlob = Buffer.from("protected-key").toString("base64");
      const powershell = vi.fn();
      const powershellStdin = vi.fn(async () => protectedBlob);
      expect(await __test.keyFromWindowsDpapi({
        dpapiFile,
        powershell,
        powershellStdin,
        random: () => key,
      })).toEqual(key);
      expect((await readFile(dpapiFile, "utf8")).trim()).toBe(protectedBlob);
      expect(powershell).not.toHaveBeenCalled();
    });
  });

  it("does not replace a malformed DPAPI file", async () => {
    await withTempDir(async (dir) => {
      const dpapiFile = path.join(dir, "key.dpapi");
      await writeFile(dpapiFile, "not base64!\n");
      const write = vi.fn();
      const powershell = vi.fn();
      await expect(__test.keyFromWindowsDpapi({ dpapiFile, write, powershell }))
        .rejects.toThrow(/not valid Base64.*refusing/i);
      expect(write).not.toHaveBeenCalled();
      expect(powershell).not.toHaveBeenCalled();
      expect(await readFile(dpapiFile, "utf8")).toBe("not base64!\n");
    });
  });

  it("does not replace a DPAPI key after access or decryption errors", async () => {
    const write = vi.fn();
    const deniedRead = vi.fn(async () => { throw fsError("EACCES", "permission denied"); });
    await expect(__test.keyFromWindowsDpapi({ dpapiFile: "key.dpapi", read: deniedRead, write }))
      .rejects.toThrow(/cannot read DPAPI.*refusing to create a replacement/i);
    expect(write).not.toHaveBeenCalled();

    const blob = Buffer.from("protected-key").toString("base64") + "\n";
    const read = vi.fn(async () => blob);
    const powershell = vi.fn(async () => { throw new Error("CryptographicException"); });
    await expect(__test.keyFromWindowsDpapi({ dpapiFile: "key.dpapi", read, write, powershell }))
      .rejects.toThrow(/cannot decrypt DPAPI.*refusing to replace it/i);
    expect(write).not.toHaveBeenCalled();
  });

  it("does not replace a DPAPI blob that decrypts to malformed key material", async () => {
    const blob = Buffer.from("protected-key").toString("base64") + "\n";
    const read = vi.fn(async () => blob);
    const write = vi.fn();
    const powershell = vi.fn(async () => "short-key");
    await expect(__test.keyFromWindowsDpapi({ dpapiFile: "key.dpapi", read, write, powershell }))
      .rejects.toThrow(/decrypted DPAPI.*not a 32-byte hex key.*refusing/i);
    expect(write).not.toHaveBeenCalled();
  });
});

describe("durable key-file creation", () => {
  it("still publishes and cleans its temp without directory handles on Windows", async () => {
    const events = [];
    const openFile = vi.fn();
    const result = await __test.durablePublishFileExclusive(
      "C:\\keys\\master.key",
      "secret\n",
      { encoding: "utf8", mode: 0o600, flag: "wx" },
      {
        platform: "win32",
        tokenFactory: () => "windows-publish",
        openFile,
        write: vi.fn(async (temp, _data, _options, { onCreated }) => {
          onCreated();
          events.push(`write:${temp}`);
        }),
        linkFile: vi.fn(async (temp, canonical) => { events.push(`link:${temp}:${canonical}`); }),
        removeFile: vi.fn(async (temp) => { events.push(`unlink:${temp}`); }),
      }
    );

    const temp = `C:\\keys\\master.key.${process.pid}.windows-publish.tmp`;
    expect(result).toEqual({ created: true });
    expect(events).toEqual([
      `write:${temp}`,
      `link:${temp}:C:\\keys\\master.key`,
      `unlink:${temp}`,
    ]);
    expect(openFile).not.toHaveBeenCalled();
  });

  it("syncs file data before syncing its parent directory on POSIX", async () => {
    const events = [];
    const fileHandle = {
      writeFile: vi.fn(async () => { events.push("write"); }),
      sync: vi.fn(async () => { events.push("file-sync"); }),
      close: vi.fn(async () => { events.push("file-close"); }),
    };
    const directoryHandle = {
      sync: vi.fn(async () => { events.push("directory-sync"); }),
      close: vi.fn(async () => { events.push("directory-close"); }),
    };
    const openFile = vi.fn(async (target, flags, mode) => {
      events.push(`open:${target}:${flags}:${mode ?? ""}`);
      return flags === "wx" ? fileHandle : directoryHandle;
    });

    await __test.durableCreateFile(
      "/keys/master.key",
      "secret\n",
      { encoding: "utf8", mode: 0o600, flag: "wx" },
      { openFile, platform: "linux" }
    );

    expect(events).toEqual([
      "open:/keys/master.key:wx:384",
      "write",
      "file-sync",
      "file-close",
      "open:/keys:r:",
      "directory-sync",
      "directory-close",
    ]);
  });

  it("fails closed when the parent directory cannot be synced", async () => {
    const fileHandle = {
      writeFile: vi.fn(async () => {}),
      sync: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const directoryHandle = {
      sync: vi.fn(async () => { throw fsError("EIO", "directory flush failed"); }),
      close: vi.fn(async () => {}),
    };
    const openFile = vi.fn()
      .mockResolvedValueOnce(fileHandle)
      .mockResolvedValueOnce(directoryHandle);

    await expect(__test.durableCreateFile(
      "/keys/master.key",
      "secret\n",
      { encoding: "utf8", mode: 0o600, flag: "wx" },
      { openFile, platform: "linux" }
    )).rejects.toThrow(/directory flush failed/);
    expect(directoryHandle.close).toHaveBeenCalledOnce();
  });

  it("still syncs the file but skips unsupported directory handles on Windows", async () => {
    const fileHandle = {
      writeFile: vi.fn(async () => {}),
      sync: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const openFile = vi.fn(async () => fileHandle);

    await __test.durableCreateFile(
      "C:\\keys\\master.key",
      "secret\n",
      { encoding: "utf8", mode: 0o600, flag: "wx" },
      { openFile, platform: "win32" }
    );
    expect(fileHandle.sync).toHaveBeenCalledOnce();
    expect(openFile).toHaveBeenCalledOnce();
  });
});
