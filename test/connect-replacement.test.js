import { beforeEach, describe, expect, it, vi } from "vitest";

const qbo = vi.hoisted(() => ({
  credentials: vi.fn(() => ({ clientId: "test-client", redirectUri: "https://example.test/callback" })),
  exchangeCodeForTokens: vi.fn(),
  persistAuthorization: vi.fn(),
  assertSlug: vi.fn((slug) => String(slug)),
  getCompanyInfoWithTokens: vi.fn(),
  listCompanies: vi.fn(),
  refreshTokens: vi.fn(),
  importRefreshToken: vi.fn(),
  recoverStagedTokenImport: vi.fn(async () => null),
}));

vi.mock("../src/qbo.js", () => qbo);

import {
  assertSafeExistingSlug as assertCatcherReplacement,
  connectViaCatcher,
} from "../src/connect-catcher.js";
import {
  assertSafeExistingSlug as assertPlaygroundReplacement,
  connectViaPlayground,
} from "../src/connect-playground.js";

const existing = { slug: "acme", realmId: "123456789", environment: "production" };
const validators = [
  ["catcher", assertCatcherReplacement],
  ["playground", assertPlaygroundReplacement],
];

beforeEach(() => {
  vi.clearAllMocks();
  qbo.listCompanies.mockResolvedValue([existing]);
});

describe.each(validators)("%s existing-slug validation", (_label, validate) => {
  it("leaves new slugs and exact authorized replacements alone", () => {
    expect(() => validate(null, {
      slug: "new-company",
      environment: "production",
    })).not.toThrow();
    expect(() => validate(existing, {
      slug: "acme",
      environment: "production",
      realmId: "123456789",
      replaceExisting: true,
    })).not.toThrow();
  });

  it("requires explicit replacement authority", () => {
    expect(() => validate(existing, {
      slug: "acme",
      environment: "production",
    })).toThrow(/replaceExisting: true.*new slug/i);
  });

  it("refuses an environment or realm mismatch even when replacement was authorized", () => {
    expect(() => validate(existing, {
      slug: "acme",
      environment: "sandbox",
      replaceExisting: true,
    })).toThrow(/new slug.*environment/i);
    expect(() => validate(existing, {
      slug: "acme",
      environment: "production",
      realmId: "987654321",
      replaceExisting: true,
    })).toThrow(/realm 987654321.*new slug/i);
  });
});

describe("authorization entry points", () => {
  it("catcher refuses an existing slug before credentials, browser, prompt, exchange, or save", async () => {
    await expect(connectViaCatcher("acme", "production", { openBrowserWindow: false }))
      .rejects.toThrow(/replaceExisting: true/);
    expect(qbo.credentials).not.toHaveBeenCalled();
    expect(qbo.exchangeCodeForTokens).not.toHaveBeenCalled();
    expect(qbo.persistAuthorization).not.toHaveBeenCalled();
  });

  it("playground refuses an existing slug before credentials, browser, prompt, or refresh", async () => {
    await expect(connectViaPlayground("acme", "production", { openBrowserWindow: false }))
      .rejects.toThrow(/replaceExisting: true/);
    expect(qbo.credentials).not.toHaveBeenCalled();
    expect(qbo.importRefreshToken).not.toHaveBeenCalled();
    expect(qbo.recoverStagedTokenImport).not.toHaveBeenCalled();
  });
});
