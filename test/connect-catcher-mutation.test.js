import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const offline = vi.hoisted(() => ({
  qbo: {
    credentials: vi.fn(),
    exchangeCodeForTokens: vi.fn(),
    persistAuthorization: vi.fn(),
    assertSlug: vi.fn(),
    getCompanyInfoWithTokens: vi.fn(),
    listCompanies: vi.fn(),
  },
  readline: { createInterface: vi.fn(), close: vi.fn(), answer: "" },
  browser: { spawn: vi.fn(), once: vi.fn(), unref: vi.fn() },
  randomBytes: vi.fn(),
}));

vi.mock("../src/qbo.js", () => offline.qbo);
vi.mock("node:readline", async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, default: { ...original.default, createInterface: offline.readline.createInterface } };
});
vi.mock("node:child_process", async (importOriginal) => ({ ...await importOriginal(), spawn: offline.browser.spawn }));
vi.mock("node:crypto", async (importOriginal) => ({ ...await importOriginal(), randomBytes: offline.randomBytes }));

import { connectViaCatcher } from "../src/connect-catcher.js";

const savedRedirect = process.env.QBO_CATCHER_REDIRECT_URI;
const savedExchangeRedirect = process.env.QBO_REDIRECT_URI;
const state = Buffer.alloc(16, 7).toString("base64url");
const reply = (fields = {}) => new URLSearchParams({
  code: "invented-code",
  realmId: "700123",
  state,
  ...fields,
}).toString();
const company = { slug: "cedar-ledger", realmId: "700123", environment: "production" };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.QBO_CATCHER_REDIRECT_URI = "https://catcher.example.test/return";
  offline.readline.answer = reply();
  offline.qbo.assertSlug.mockImplementation((slug) => slug);
  offline.qbo.listCompanies.mockResolvedValue([]);
  offline.qbo.credentials.mockReturnValue({ clientId: "invented-client" });
  offline.qbo.exchangeCodeForTokens.mockResolvedValue({ environment: "production" });
  offline.qbo.getCompanyInfoWithTokens.mockResolvedValue({
    CompanyName: "Cedar Ledger Company",
    LegalName: "Cedar Ledger LLC",
    CompanyAddr: { CountrySubDivisionCode: "OR" },
  });
  offline.qbo.persistAuthorization.mockResolvedValue();
  offline.readline.createInterface.mockImplementation(() => ({
    question: (_prompt, answer) => answer(offline.readline.answer),
    close: offline.readline.close,
  }));
  offline.browser.spawn.mockImplementation(() => ({ once: offline.browser.once, unref: offline.browser.unref }));
  offline.randomBytes.mockReturnValue(Buffer.alloc(16, 7));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  if (savedRedirect === undefined) delete process.env.QBO_CATCHER_REDIRECT_URI;
  else process.env.QBO_CATCHER_REDIRECT_URI = savedRedirect;
  if (savedExchangeRedirect === undefined) delete process.env.QBO_REDIRECT_URI;
  else process.env.QBO_REDIRECT_URI = savedExchangeRedirect;
  vi.restoreAllMocks();
});

describe("catcherRedirectUri through connectViaCatcher", () => {
  it("trims the hosted HTTPS redirect before authorization", async () => {
    process.env.QBO_CATCHER_REDIRECT_URI = "  https://catcher.example.test/return  ";
    await connectViaCatcher("cedar-ledger", "production", { openBrowserWindow: false });
    expect(process.env.QBO_REDIRECT_URI).toBe("https://catcher.example.test/return");
  });

  it("rejects a missing hosted redirect", async () => {
    delete process.env.QBO_CATCHER_REDIRECT_URI;
    await expect(connectViaCatcher("cedar-ledger", "production", { openBrowserWindow: false }))
      .rejects.toThrow(/QBO_CATCHER_REDIRECT_URI is not set/);
    expect(offline.qbo.credentials).not.toHaveBeenCalled();
  });

  it("rejects a non-HTTPS hosted redirect", async () => {
    process.env.QBO_CATCHER_REDIRECT_URI = "http://catcher.example.test/return";
    await expect(connectViaCatcher("cedar-ledger", "production", { openBrowserWindow: false }))
      .rejects.toThrow(/must be an https:\/\/ URL/);
    expect(offline.qbo.credentials).not.toHaveBeenCalled();
  });
});

describe("openBrowser through connectViaCatcher", () => {
  it("opens the authorization URL with the platform command and detaches the child", async () => {
    await connectViaCatcher("cedar-ledger", "production");
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32.exe" : "xdg-open";
    expect(offline.browser.spawn).toHaveBeenCalledWith(command, expect.any(Array), expect.objectContaining({ detached: true }));
    expect(offline.browser.unref).toHaveBeenCalledOnce();
  });

  it("does not launch a browser when requested", async () => {
    await connectViaCatcher("cedar-ledger", "production", { openBrowserWindow: false });
    expect(offline.browser.spawn).not.toHaveBeenCalled();
  });
});

describe("ask and parsePasted through connectViaCatcher", () => {
  it("trims the pasted line and closes the prompt", async () => {
    offline.readline.answer = `  https://catcher.example.test/return?${reply()}  `;
    await connectViaCatcher("cedar-ledger", "production", { openBrowserWindow: false });
    expect(offline.readline.close).toHaveBeenCalledOnce();
    expect(offline.qbo.exchangeCodeForTokens).toHaveBeenCalledWith("invented-code", "production");
  });

  it("parses a full callback URL at the question-mark boundary", async () => {
    offline.readline.answer = `https://catcher.example.test/return?${reply()}`;
    await connectViaCatcher("cedar-ledger", "production", { openBrowserWindow: false });
    expect(offline.qbo.exchangeCodeForTokens).toHaveBeenCalledWith("invented-code", "production");
  });

  it("uses the first code when a query repeats it", async () => {
    offline.readline.answer = `${reply()}&code=second-invented-code`;
    await connectViaCatcher("cedar-ledger", "production", { openBrowserWindow: false });
    expect(offline.qbo.exchangeCodeForTokens).toHaveBeenCalledWith("invented-code", "production");
  });

  it("accepts a copied fragment with two leading question marks", async () => {
    offline.readline.answer = `??${reply()}`;
    await connectViaCatcher("cedar-ledger", "production", { openBrowserWindow: false });
    expect(offline.qbo.exchangeCodeForTokens).toHaveBeenCalledWith("invented-code", "production");
  });
});

describe("connectViaCatcher validation and persistence", () => {
  it("rejects an empty company slug", async () => {
    await expect(connectViaCatcher("", "production", { openBrowserWindow: false }))
      .rejects.toThrow(/Give a company slug/);
    expect(offline.qbo.listCompanies).not.toHaveBeenCalled();
  });

  it("rejects an empty paste", async () => {
    offline.readline.answer = "";
    await expect(connectViaCatcher("cedar-ledger", "production", { openBrowserWindow: false }))
      .rejects.toThrow(/Nothing pasted/);
    expect(offline.qbo.exchangeCodeForTokens).not.toHaveBeenCalled();
  });

  it("rejects an Intuit error before exchanging a code", async () => {
    offline.readline.answer = `${reply()}&error=access_denied`;
    await expect(connectViaCatcher("cedar-ledger", "production", { openBrowserWindow: false }))
      .rejects.toThrow(/Intuit returned an error: access_denied/);
    expect(offline.qbo.exchangeCodeForTokens).not.toHaveBeenCalled();
  });

  it("requires both a code and realm", async () => {
    offline.readline.answer = new URLSearchParams({ code: "invented-code", state }).toString();
    await expect(connectViaCatcher("cedar-ledger", "production", { openBrowserWindow: false }))
      .rejects.toThrow(/did not parse into a code and realmId/);
    expect(offline.qbo.exchangeCodeForTokens).not.toHaveBeenCalled();
  });

  it("rejects a mismatched state before exchanging a code", async () => {
    offline.readline.answer = reply({ state: "stale-state" });
    await expect(connectViaCatcher("cedar-ledger", "production", { openBrowserWindow: false }))
      .rejects.toThrow(/State did not match/);
    expect(offline.qbo.exchangeCodeForTokens).not.toHaveBeenCalled();
  });

  it("rejects a different returned realm before exchange on replacement", async () => {
    offline.qbo.listCompanies.mockResolvedValue([company]);
    offline.readline.answer = reply({ realmId: "700124" });
    await expect(connectViaCatcher("cedar-ledger", "production", { openBrowserWindow: false, replaceExisting: true }))
      .rejects.toThrow(/realm 700124/);
    expect(offline.qbo.exchangeCodeForTokens).not.toHaveBeenCalled();
  });

  it("rechecks a newly occupied slug before saving", async () => {
    offline.qbo.listCompanies.mockResolvedValueOnce([]).mockResolvedValueOnce([company]);
    await expect(connectViaCatcher("cedar-ledger", "production", { openBrowserWindow: false }))
      .rejects.toThrow(/replaceExisting: true/);
    expect(offline.qbo.persistAuthorization).not.toHaveBeenCalled();
  });

  it("persists tokens and returns only other slugs for the same realm", async () => {
    offline.qbo.listCompanies.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([
      company,
      { slug: "birch-books", realmId: "700123", environment: "production" },
      { slug: "maple-records", realmId: "800900", environment: "production" },
    ]);
    const result = await connectViaCatcher("cedar-ledger", "production", { openBrowserWindow: false });
    expect(offline.qbo.persistAuthorization).toHaveBeenCalledWith("cedar-ledger", expect.objectContaining({ realmId: "700123" }), { replaceExisting: false });
    expect(result.slug).toBe("cedar-ledger");
    expect(result.duplicate_slugs).toEqual(["birch-books"]);
    expect(result.company_name).toBe("Cedar Ledger Company");
  });
});
