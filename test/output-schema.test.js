import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { installOutputSchemaDialect, restampOutputSchema } from "../src/output-schema.js";

const DIALECT = "https://json-schema.org/draft/2020-12/schema";
const SDK_VERSION = JSON.parse(readFileSync(new URL(
  "../../../package.json", import.meta.resolve("@modelcontextprotocol/sdk/server/mcp.js")
), "utf8")).version;

describe("restampOutputSchema", () => {
  it("returns a re-stamped copy without mutating the source contract", () => {
    const schema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { count: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 10 } },
      required: ["count"],
      additionalProperties: false,
    };
    const before = JSON.stringify(schema);
    const result = restampOutputSchema(schema);
    expect(result).toEqual({ ...schema, $schema: DIALECT });
    expect(result).not.toBe(schema);
    expect(JSON.stringify(schema)).toBe(before);
    expect(restampOutputSchema(result)).toEqual(result);
  });

  it.each([
    ["array-form items", { items: [{ type: "string" }] }, "items"],
    ["boolean exclusiveMinimum", { exclusiveMinimum: true }, "exclusiveMinimum"],
    ["false exclusiveMinimum", { exclusiveMinimum: false }, "exclusiveMinimum"],
    ["boolean exclusiveMaximum", { exclusiveMaximum: true }, "exclusiveMaximum"],
    ["false exclusiveMaximum", { exclusiveMaximum: false }, "exclusiveMaximum"],
    ["dependencies", { dependencies: { a: ["b"] } }, "dependencies"],
    ["additionalItems", { additionalItems: false }, "additionalItems"],
    ["references with changed sibling semantics", { $ref: "#/definitions/value", type: "string" }, "$ref"],
  ])("rejects %s at the root and in nested schemas", (_name, schema, keyword) => {
    expect(() => restampOutputSchema(schema)).toThrow(keyword);
    expect(() => restampOutputSchema({ properties: { nested: schema } })).toThrow(keyword);
  });

  it.each([
    { items: { dependencies: {} } },
    { additionalProperties: { dependencies: {} } },
    { patternProperties: { "^x": { dependencies: {} } } },
    { definitions: { nested: { dependencies: {} } } },
    { $defs: { nested: { dependencies: {} } } },
    { anyOf: [{ dependencies: {} }] },
    { not: { dependencies: {} } },
    { if: { dependencies: {} } },
  ])("checks nested schema positions: %j", (schema) => {
    expect(() => restampOutputSchema(schema)).toThrow("dependencies");
  });

  it("does not interpret property names or literal data as schema keywords", () => {
    const schema = {
      properties: { dependencies: { type: "string" }, items: { type: "array", items: false } },
      default: { dependencies: {}, items: [] },
      examples: [{ exclusiveMinimum: true }],
      const: { items: [] },
    };
    expect(restampOutputSchema(schema)).toEqual({ ...schema, $schema: DIALECT });
  });

  it("checks and re-stamps nested dialect declarations", () => {
    expect(restampOutputSchema({ properties: { child: {
      $schema: "http://json-schema.org/draft-07/schema#", type: "string",
    } } }).properties.child.$schema).toBe(DIALECT);
    expect(() => restampOutputSchema({ $schema: "http://json-schema.org/draft-04/schema#" })).toThrow("unsupported source dialect");
  });
});

describe("installOutputSchemaDialect", () => {
  it.each([
    {},
    { server: {} },
    { server: { _requestHandlers: new Map() } },
    { server: { _requestHandlers: new Map([["tools/list", {}]]) } },
  ])("fails at startup with the SDK version when the seam is absent: %j", async (server) => {
    await expect(installOutputSchemaDialect(server, [])).rejects.toThrow(
      `@modelcontextprotocol/sdk ${SDK_VERSION}: expected server.server._requestHandlers Map with a tools/list function`
    );
  });

  it("preserves untyped tool bytes and stored Zod validation through the real SDK seam", async () => {
    const server = new McpServer({ name: "dialect-test", version: "1" });
    const outputSchema = z.object({ count: z.number() });
    const handler = async () => ({ content: [], structuredContent: { count: 1 } });
    const registered = server.registerTool("typed", { outputSchema }, handler);
    server.registerTool("untyped", { description: "Unchanged", inputSchema: { name: z.string() } }, handler);
    const request = { method: "tools/list" };
    const before = await server.server._requestHandlers.get("tools/list")(request, {});
    await installOutputSchemaDialect(server, ["typed"]);
    const after = await server.server._requestHandlers.get("tools/list")(request, {});
    expect(after.tools).toHaveLength(before.tools.length);
    expect(after.tools.filter((tool) => tool.outputSchema)).toHaveLength(1);
    expect(JSON.stringify(after.tools[1])).toBe(JSON.stringify(before.tools[1]));
    expect(after.tools[0]).toEqual({
      ...before.tools[0], outputSchema: { ...before.tools[0].outputSchema, $schema: DIALECT },
    });
    expect(registered.outputSchema).toBe(outputSchema);
    await expect(server.validateToolOutput(registered, await handler(), "typed")).resolves.toBeUndefined();
    await expect(server.validateToolOutput(registered, { content: [], structuredContent: { count: "1" } }, "typed"))
      .rejects.toThrow("Output validation error");
  });

  it("rejects incompatible generated schemas before installing the handler", async () => {
    const server = new McpServer({ name: "dialect-test", version: "1" });
    server.registerTool("tuple", { outputSchema: z.object({ value: z.tuple([z.string()]) }) }, async () => ({}));
    const original = server.server._requestHandlers.get("tools/list");
    await expect(installOutputSchemaDialect(server, ["tuple"])).rejects.toThrow("array-form items");
    expect(server.server._requestHandlers.get("tools/list")).toBe(original);
  });

  it.each([
    { tools: [{ name: "typed" }] },
    { tools: [{ name: "unexpected", outputSchema: {} }] },
    { tools: [{ name: "typed", outputSchema: {} }, { name: "extra", outputSchema: {} }] },
    {},
  ])("rejects missing contracts or a changed response shape at startup: %j", async (result) => {
    const server = { server: { _requestHandlers: new Map([["tools/list", async () => result]]) } };
    await expect(installOutputSchemaDialect(server, ["typed"])).rejects.toThrow(`@modelcontextprotocol/sdk ${SDK_VERSION}: expected`);
  });
});
