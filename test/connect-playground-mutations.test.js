import { beforeEach, describe, expect, it, vi } from "vitest";

const qbo = vi.hoisted(() => ({
  credentials: vi.fn(() => ({ clientId: "invented-client" })),
  importRefreshToken: vi.fn(),
  recoverStagedTokenImport: vi.fn(async () => null),
  assertSlug: vi.fn((slug) => String(slug)),
  getCompanyInfoWithTokens: vi.fn(async () => ({ CompanyName: "Cedar Lantern LLC", LegalName: "Cedar Lantern Holdings LLC", CompanyAddr: { CountrySubDivisionCode: "OR" } })),
  listCompanies: vi.fn(async () => []),
}));
const io = vi.hoisted(() => ({ lines: [], interfaces: [], spawn: vi.fn() }));

vi.mock("../src/qbo.js", () => qbo);
vi.mock("node:child_process", () => ({ spawn: io.spawn }));
vi.mock("node:readline", () => ({
  default: {
    createInterface: vi.fn(() => {
      const listeners = new Map();
      const rl = {
        on: (event, listener) => { listeners.set(event, listener); },
        emit: (event, ...args) => listeners.get(event)?.(...args),
        close: vi.fn(() => listeners.get("close")?.()),
        output: { write: vi.fn() },
        _writeToOutput: vi.fn(),
      };
      io.interfaces.push(rl);
      queueMicrotask(() => {
        for (const line of io.lines) rl.emit("line", line);
        rl.emit("close");
      });
      return rl;
    }),
  },
}));

import {
  assertSafeExistingSlug,
  cleanRealmId,
  cleanRefreshToken,
  connectViaPlayground,
} from "../src/connect-playground.js";

const existing = { slug: "cedar-lantern", realmId: "2468013579", environment: "production" };
const token = "InventedRefreshToken1234567890";
const tokens = { realmId: existing.realmId, environment: "production" };

beforeEach(() => {
  vi.clearAllMocks();
  io.lines = [];
  io.interfaces = [];
  io.spawn.mockImplementation(() => ({ once: vi.fn(), unref: vi.fn() }));
  qbo.listCompanies.mockResolvedValue([]);
  qbo.recoverStagedTokenImport.mockResolvedValue(null);
  qbo.importRefreshToken.mockImplementation(async (_slug, _input, options) => ({
    tokens,
    validation: await options.validate(tokens),
  }));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("cleanRealmId", () => {
  it("requires at least five consecutive digits", () => {
    expect(cleanRealmId("Realm ID: 1234")).toBeNull();
    expect(cleanRealmId("Realm ID: 12345")).toBe("12345");
  });
});

describe("cleanRefreshToken", () => {
  it("enforces both token length boundaries", () => {
    expect(cleanRefreshToken("A".repeat(20))).toBe("A".repeat(20));
    expect(cleanRefreshToken("A".repeat(512))).toBe("A".repeat(512));
    expect(cleanRefreshToken("A".repeat(513))).toBeNull();
  });
});

describe("assertSafeExistingSlug", () => {
  it("refuses an existing company before any credentials or prompt", async () => {
    qbo.listCompanies.mockResolvedValue([existing]);
    await expect(connectViaPlayground(existing.slug, "production", { openBrowserWindow: false }))
      .rejects.toThrow(/replaceExisting: true/);
    expect(qbo.credentials).not.toHaveBeenCalled();
    expect(io.interfaces).toHaveLength(0);
  });

  it("accepts a new company without replacement authority", () => {
    expect(() => assertSafeExistingSlug(null, { slug: "new-invented-company" })).not.toThrow();
  });

  it("requires authority when the company already exists", () => {
    expect(() => assertSafeExistingSlug(existing, {
      slug: existing.slug,
      environment: "production",
      realmId: existing.realmId,
    })).toThrow(/replaceExisting: true/);
  });
});

describe("openBrowser", () => {
  it("detaches an opened browser and honors the browser option", async () => {
    await expect(connectViaPlayground("cedar-lantern")).rejects.toThrow(/Input ended/);
    expect(io.spawn).toHaveBeenCalledTimes(1);
    expect(io.spawn.mock.results[0].value.unref).toHaveBeenCalledTimes(1);
    await expect(connectViaPlayground("cedar-lantern", "production", { openBrowserWindow: false }))
      .rejects.toThrow(/Input ended/);
    expect(io.spawn).toHaveBeenCalledTimes(1);
  });
});

describe("makePrompter", () => {
  it("reports closed input when the second pasted value is missing", async () => {
    io.lines = [existing.realmId];
    await expect(connectViaPlayground(existing.slug, "production", { openBrowserWindow: false }))
      .rejects.toThrow(/Input ended before the value was pasted/);
  });
});

describe("validateFreshTokens and finish", () => {
  it("validates recovered credentials and reports the verified company and duplicate slug", async () => {
    const twin = { slug: "maple-studio", realmId: existing.realmId, environment: "production" };
    qbo.listCompanies.mockResolvedValue([existing, twin]);
    qbo.recoverStagedTokenImport.mockImplementation(async (_slug, options) => ({
      tokens,
      validation: await options.validate(tokens),
    }));
    const result = await connectViaPlayground(existing.slug, "production", { replaceExisting: true, openBrowserWindow: false });
    expect(result).toMatchObject({
      slug: existing.slug,
      realmId: existing.realmId,
      environment: "production",
      company_name: "Cedar Lantern LLC",
      legal_name: "Cedar Lantern Holdings LLC",
      address_state: "OR",
      duplicate_slugs: [twin.slug],
    });
    expect(result.rotation_note).toMatch(/Recovered the encrypted credential/);
    expect(qbo.getCompanyInfoWithTokens).toHaveBeenCalledWith(tokens);
    expect(qbo.importRefreshToken).not.toHaveBeenCalled();
  });
});

describe("connectViaPlayground", () => {
  it("rejects an unsupported environment before prompting", async () => {
    await expect(connectViaPlayground("cedar-lantern", "staging", { openBrowserWindow: false }))
      .rejects.toThrow(/environment must be/);
    expect(io.interfaces).toHaveLength(0);
  });

  it("checks credentials before asking for a token", async () => {
    await expect(connectViaPlayground("cedar-lantern", "production", { openBrowserWindow: false }))
      .rejects.toThrow(/Input ended/);
    expect(qbo.credentials).toHaveBeenCalledWith("production");
  });

  it("passes the pasted realm, token, and replacement authority to import", async () => {
    io.lines = ["Realm ID: 2468013579", `Refresh Token: ${token}`];
    qbo.listCompanies.mockResolvedValue([existing]);
    const result = await connectViaPlayground(existing.slug, "production", { replaceExisting: true, openBrowserWindow: false });
    expect(qbo.importRefreshToken).toHaveBeenCalledWith(
      existing.slug,
      { refresh_token: token, realmId: existing.realmId, environment: "production" },
      expect.objectContaining({ replaceExisting: true, validate: expect.any(Function) })
    );
    expect(result.company_name).toBe("Cedar Lantern LLC");
  });

  it("rechecks a slug created while the operator was pasting", async () => {
    io.lines = [existing.realmId, token];
    qbo.listCompanies.mockResolvedValueOnce([]).mockResolvedValueOnce([existing]);
    await expect(connectViaPlayground(existing.slug, "production", { openBrowserWindow: false }))
      .rejects.toThrow(/replaceExisting: true/);
    expect(qbo.importRefreshToken).not.toHaveBeenCalled();
  });

  it("preserves a quarantined refresh error without suggesting another mint", async () => {
    io.lines = [existing.realmId, token];
    const cause = Object.assign(new Error("Encrypted candidate is quarantined"), { refreshOutcomeQuarantined: true });
    qbo.importRefreshToken.mockRejectedValue(cause);
    await expect(connectViaPlayground(existing.slug, "production", { openBrowserWindow: false }))
      .rejects.toMatchObject({ message: cause.message, cause });
  });
});
