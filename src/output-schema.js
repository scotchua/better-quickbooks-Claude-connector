import { readFileSync } from "node:fs";

const DIALECT = "https://json-schema.org/draft/2020-12/schema";
const SDK_VERSION = JSON.parse(readFileSync(new URL(
  "../../../package.json", import.meta.resolve("@modelcontextprotocol/sdk/server/mcp.js")
), "utf8")).version;

// Only re-label constructs whose semantics we have checked in both dialects.
// References and new keywords need review before extending this allowlist.
const PORTABLE_KEYWORDS = new Set([
  "$schema", "type", "properties", "patternProperties", "additionalProperties",
  "propertyNames", "items", "required", "enum", "const", "allOf", "anyOf",
  "oneOf", "not", "if", "then", "else", "definitions", "$defs",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minLength", "maxLength", "pattern", "minItems", "maxItems", "uniqueItems",
  "minProperties", "maxProperties", "title", "description", "default", "examples",
  "readOnly", "writeOnly", "$comment",
]);
const SCHEMA_MAPS = new Set(["properties", "patternProperties", "definitions", "$defs"]);
const SCHEMA_ARRAYS = new Set(["allOf", "anyOf", "oneOf"]);
const SCHEMA_VALUES = new Set(["additionalProperties", "propertyNames", "items", "not", "if", "then", "else"]);

export function restampOutputSchema(schema) {
  function visit(value, location) {
    if (typeof value === "boolean") return value;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Non-portable outputSchema at ${location}: expected a schema object or boolean`);
    }
    const result = { ...value };
    for (const [key, child] of Object.entries(value)) {
      const at = `${location}/${key}`;
      if (!PORTABLE_KEYWORDS.has(key)) {
        throw new Error(`Non-portable outputSchema at ${at}: keyword requires dialect review`);
      }
      if (key === "items" && Array.isArray(child)) {
        throw new Error(`Non-portable outputSchema at ${at}: array-form items requires prefixItems`);
      }
      if ((key === "exclusiveMinimum" || key === "exclusiveMaximum") && typeof child === "boolean") {
        throw new Error(`Non-portable outputSchema at ${at}: boolean exclusive bounds are unsupported`);
      }
      if (key === "$schema") {
        if (child !== "http://json-schema.org/draft-07/schema#" && child !== DIALECT) {
          throw new Error(`Non-portable outputSchema at ${at}: unsupported source dialect ${child}`);
        }
        result[key] = DIALECT;
      } else if (SCHEMA_MAPS.has(key)) {
        result[key] = Object.fromEntries(Object.entries(child).map(([name, nested]) =>
          [name, visit(nested, `${at}/${name}`)]));
      } else if (SCHEMA_ARRAYS.has(key)) {
        result[key] = child.map((nested, index) => visit(nested, `${at}/${index}`));
      } else if (SCHEMA_VALUES.has(key)) {
        result[key] = visit(child, at);
      }
    }
    return result;
  }
  const result = visit(schema, "#");
  if (typeof result === "boolean") {
    throw new Error("Non-portable outputSchema at #: MCP requires an object schema");
  }
  return { ...result, $schema: DIALECT };
}

export async function installOutputSchemaDialect(server, expectedNames) {
  const handlers = server.server?._requestHandlers;
  const original = handlers instanceof Map ? handlers.get("tools/list") : undefined;
  const expected = new Set(expectedNames);
  const fail = (message) => new Error(`@modelcontextprotocol/sdk ${SDK_VERSION}: ${message}`);
  if (typeof original !== "function") {
    throw fail('expected server.server._requestHandlers Map with a tools/list function');
  }
  const wrapped = async (...args) => {
    const result = await original(...args);
    if (!Array.isArray(result?.tools)) throw fail("expected tools/list to return a tools array");
    const declared = result.tools.filter((tool) => Object.hasOwn(tool, "outputSchema"));
    if (declared.length !== expected.size ||
        new Set(declared.map((tool) => tool.name)).size !== expected.size ||
        declared.some((tool) => !expected.has(tool.name))) {
      throw fail(`expected outputSchema contracts for ${expected.size} tools: ${[...expected].join(", ")}`);
    }
    return {
      ...result,
      tools: result.tools.map((tool) => Object.hasOwn(tool, "outputSchema")
        ? { ...tool, outputSchema: restampOutputSchema(tool.outputSchema) }
        : tool),
    };
  };
  // Preflight before connecting: incompatible schemas must fail at startup.
  await wrapped({ method: "tools/list" }, {});
  handlers.set("tools/list", wrapped);
}
