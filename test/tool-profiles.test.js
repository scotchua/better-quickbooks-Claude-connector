import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOOL_PROFILE,
  KNOWN_TOOL_NAMES,
  TOOL_CAPABILITY_GROUPS,
  TOOL_PROFILE_NAMES,
  capabilitiesForProfile,
  parseToolProfile,
  shouldRegisterTool,
  toolProfileFromEnv,
} from "../src/tool-profiles.js";

describe("tool profile parsing", () => {
  it("uses the task-sized core profile by default", () => {
    expect(DEFAULT_TOOL_PROFILE).toBe("core");
    expect(parseToolProfile()).toBe("core");
    expect(parseToolProfile("  ")).toBe("core");
    expect(toolProfileFromEnv({})).toBe("core");
  });

  it("normalizes an explicit environment value", () => {
    expect(toolProfileFromEnv({ QBO_TOOL_PROFILE: "  ACCOUNTANT " })).toBe("accountant");
  });

  it("fails closed with a useful error for an invalid profile", () => {
    expect(() => parseToolProfile("power-user")).toThrow(/Invalid QBO_TOOL_PROFILE/);
    expect(() => parseToolProfile("power-user")).toThrow(/core, owner, bookkeeper, accountant, admin, developer, full/);
    expect(() => shouldRegisterTool("api_request", "power-user")).toThrow(/No tools were selected/);
  });
});

describe("curated tool profiles", () => {
  it("keeps common owner workflows small and hides specialist/admin tools", () => {
    expect(shouldRegisterTool("get_profit_and_loss", "owner")).toBe(true);
    expect(shouldRegisterTool("create_invoice", "owner")).toBe(true);
    expect(shouldRegisterTool("create_bill_payment", "owner")).toBe(true);
    expect(shouldRegisterTool("create_journal_entry", "owner")).toBe(false);
    expect(shouldRegisterTool("connect_company", "owner")).toBe(false);
  });

  it("keeps the bookkeeper profile free of raw and permanent-delete tools", () => {
    expect(shouldRegisterTool("reconcile_bank_csv", "bookkeeper")).toBe(true);
    expect(shouldRegisterTool("find_duplicate_transactions", "bookkeeper")).toBe(true);
    for (const name of ["query", "api_get", "api_request", "execute_batch", "delete_transaction"]) {
      expect(shouldRegisterTool(name, "bookkeeper"), name).toBe(false);
    }
  });

  it("defaults to the task-sized firm core", () => {
    expect(shouldRegisterTool("create_journal_entry")).toBe(true);
    expect(shouldRegisterTool("get_consolidated_balance_sheet")).toBe(true);
    expect(shouldRegisterTool("create_invoice")).toBe(true);
    expect(shouldRegisterTool("create_bill_payment")).toBe(true);
    expect(shouldRegisterTool("preview_bank_csv_import")).toBe(true);
    expect(shouldRegisterTool("import_transactions_from_csv")).toBe(true);
    expect(shouldRegisterTool("api_request")).toBe(false);
    expect(shouldRegisterTool("connect_company")).toBe(false);
    expect(shouldRegisterTool("register_client")).toBe(true);
    // Naming a client is everyday work; editing that company's write
    // guardrails is not. The default profile must not be able to lift a
    // read_only flag, which it could while both lived in one capability.
    expect(shouldRegisterTool("set_company_policy")).toBe(false);
    const defaultNames = KNOWN_TOOL_NAMES.filter((name) => shouldRegisterTool(name));
    expect(defaultNames.length).toBeLessThanOrEqual(61);
  });

  it("carries the read-only tools the close-review prompts require", () => {
    // registerWorkflowPrompt hides any prompt whose tools are absent, so a
    // gap here silently drops month-end-data-pack, close-readiness-review,
    // and collections-review from the default profile.
    for (const name of [
      "get_aged_receivables_detail",
      "get_aged_payables_detail",
      "get_recurring_transactions",
      "get_general_ledger",
      "get_changes_since",
      "get_trial_balance",
      "get_cash_flow",
      "get_overdue_invoices",
      "get_transaction_links",
      "resolve_client",
      "get_preferences",
    ]) {
      expect(shouldRegisterTool(name), name).toBe(true);
    }
  });

  it("never lets a narrower profile administer policy that a broader one cannot", () => {
    expect(shouldRegisterTool("set_company_policy", "core")).toBe(false);
    expect(shouldRegisterTool("set_company_policy", "owner")).toBe(false);
    expect(shouldRegisterTool("set_company_policy", "bookkeeper")).toBe(false);
    expect(shouldRegisterTool("set_company_policy", "accountant")).toBe(true);
    expect(shouldRegisterTool("set_company_policy", "admin")).toBe(true);
    // register_client is label-only (clients.json), so the everyday profiles
    // keep it and the broader ones do not lose it.
    for (const profile of ["core", "bookkeeper", "accountant", "admin"]) {
      expect(shouldRegisterTool("register_client", profile), profile).toBe(true);
    }
  });

  it("adds journal and multi-company work for accountants without exposing raw API access", () => {
    expect(shouldRegisterTool("create_journal_entry", "accountant")).toBe(true);
    expect(shouldRegisterTool("get_consolidated_balance_sheet", "accountant")).toBe(true);
    expect(shouldRegisterTool("api_get", "accountant")).toBe(false);
    expect(shouldRegisterTool("delete_transaction", "accountant")).toBe(false);
  });

  it("keeps admin focused on connection and policy management", () => {
    expect(shouldRegisterTool("connect_company", "admin")).toBe(true);
    expect(shouldRegisterTool("set_company_policy", "admin")).toBe(true);
    expect(shouldRegisterTool("health_check", "admin")).toBe(true);
    expect(shouldRegisterTool("create_invoice", "admin")).toBe(false);
  });

  it("gives developers raw access but still reserves permanent delete for full", () => {
    for (const name of TOOL_CAPABILITY_GROUPS.raw_api) {
      expect(shouldRegisterTool(name, "developer"), name).toBe(true);
    }
    expect(shouldRegisterTool("create_journal_entry", "developer")).toBe(true);
    expect(shouldRegisterTool("delete_transaction", "developer")).toBe(false);
  });

  it("hides newly introduced, unclassified tools from every curated profile", () => {
    for (const profile of TOOL_PROFILE_NAMES.filter((name) => name !== "full")) {
      expect(shouldRegisterTool("future_unsafe_escape_hatch", profile), profile).toBe(false);
    }
  });
});

describe("full compatibility profile", () => {
  it("registers every known tool, including raw API and permanent delete", () => {
    expect(KNOWN_TOOL_NAMES.length).toBeGreaterThan(100);
    expect(KNOWN_TOOL_NAMES.every((name) => shouldRegisterTool(name, "full"))).toBe(true);
    expect(shouldRegisterTool("delete_transaction", "full")).toBe(true);
    expect(shouldRegisterTool("api_request", "full")).toBe(true);
  });

  it("also preserves future tools until they are assigned to a curated profile", () => {
    expect(shouldRegisterTool("future_tool", "full")).toBe(true);
  });

  it("exposes the capability composition for host and documentation use", () => {
    expect(capabilitiesForProfile("developer")).toContain("raw_api");
    expect(capabilitiesForProfile("bookkeeper")).not.toContain("raw_api");
    expect(capabilitiesForProfile("full")).toContain("permanent_delete");
    expect(capabilitiesForProfile("accountant")).toContain("client_labels");
    expect(capabilitiesForProfile("accountant")).toContain("policy_administration");
    expect(capabilitiesForProfile("core")).toContain("client_labels");
    expect(capabilitiesForProfile("core")).not.toContain("policy_administration");
    expect(capabilitiesForProfile("accountant")).not.toContain("authorization");
  });
});
