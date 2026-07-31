import { describe, it, expect } from "vitest";
import { buildWhere } from "../src/entities.js";

const FIELDS = ["DocNumber", "TxnDate", "Balance", "Active", "CustomerRef"];

describe("buildWhere", () => {
  it("builds clauses with default and explicit operators", () => {
    expect(buildWhere([{ field: "TxnDate", value: "2026-07-01", operator: ">=" }], FIELDS))
      .toEqual(["TxnDate >= '2026-07-01'"]);
    expect(buildWhere([{ field: "DocNumber", value: "1042" }], FIELDS))
      .toEqual(["DocNumber = '1042'"]);
  });

  it("quotes strings and numbers, leaves booleans bare", () => {
    expect(buildWhere([{ field: "Balance", value: 0, operator: ">" }], FIELDS)).toEqual(["Balance > '0'"]);
    expect(buildWhere([{ field: "Active", value: false }], FIELDS)).toEqual(["Active = false"]);
  });

  it("supports IN with arrays", () => {
    expect(buildWhere([{ field: "CustomerRef", value: ["3", "7"], operator: "IN" }], FIELDS))
      .toEqual(["CustomerRef IN ('3', '7')"]);
  });

  it("rejects fields outside the allowlist (no field injection)", () => {
    expect(() => buildWhere([{ field: "Evil'--", value: "x" }], FIELDS)).toThrow(/not filterable/);
  });

  it("rejects unknown operators and array values without IN", () => {
    expect(() => buildWhere([{ field: "Balance", value: 1, operator: "!=" }], FIELDS)).toThrow(/Unsupported operator/);
    expect(() => buildWhere([{ field: "Balance", value: [1, 2] }], FIELDS)).toThrow(/IN operator/);
    expect(() => buildWhere([{ field: "Balance", value: [], operator: "IN" }], FIELDS)).toThrow(/at least one/);
  });

  it("escapes hostile values so they cannot break out of the literal", () => {
    const [clause] = buildWhere([{ field: "DocNumber", value: "x' OR TxnDate > '1900-01-01" }], FIELDS);
    expect(clause).toBe("DocNumber = 'x\\' OR TxnDate > \\'1900-01-01'");
  });
});
