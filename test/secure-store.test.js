import { describe, it, expect, beforeAll } from "vitest";

// Pin the key via env so the test never touches a platform secret store.
process.env.QBO_TOKEN_KEY = "a".repeat(64);

const { encryptTokens, decryptTokens, isEncrypted, encryptionEnabled } = await import("../src/secure-store.js");

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
