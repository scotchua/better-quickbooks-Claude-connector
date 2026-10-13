import { describe, expect, it } from "vitest";
import {
  KNOWN_TOOL_NAMES,
  capabilitiesForProfile,
  shouldRegisterTool,
  toolProfileFromEnv,
} from "../src/tool-profiles.js";

describe("toolProfileFromEnv", () => {
  it("uses the default profile for a missing environment object", () => {
    expect(toolProfileFromEnv(null)).toBe("core");
  });
});

describe("capabilitiesForProfile", () => {
  it("normalizes a configured profile before looking up its capabilities", () => {
    expect(capabilitiesForProfile("  OWNER ")).toContain("receivables");
  });
});

describe("shouldRegisterTool", () => {
  it("rejects empty and non-string tool names", () => {
    expect(shouldRegisterTool("", "core")).toBe(false);
    expect(shouldRegisterTool(null, "core")).toBe(false);
  });

  it("includes representative tools from each less common capability", () => {
    expect(shouldRegisterTool("get_estimates", "owner")).toBe(true);
    expect(shouldRegisterTool("create_sales_receipt", "owner")).toBe(true);
    expect(shouldRegisterTool("attach_file", "owner")).toBe(true);
    expect(shouldRegisterTool("create_time_activity", "bookkeeper")).toBe(true);
    expect(shouldRegisterTool("get_consolidated_profit_and_loss", "accountant")).toBe(true);
    expect(shouldRegisterTool("cancel_connection", "admin")).toBe(true);
    expect(shouldRegisterTool("execute_batch", "developer")).toBe(true);
  });

  it("includes permanent delete in the known tool catalog", () => {
    expect(KNOWN_TOOL_NAMES).toContain("delete_transaction");
  });
});
