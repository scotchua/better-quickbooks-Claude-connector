import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const HEADING = "## Known limitations of the QuickBooks API";

describe("documentation", () => {
  it("keeps every known QuickBooks limitation tied to measured evidence", async () => {
    const readme = await readFile(path.join(ROOT, "README.md"), "utf8");
    const start = readme.indexOf(HEADING);
    const end = readme.indexOf("\n## ", start + HEADING.length);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const lines = readme.slice(start + HEADING.length, end)
      .split("\n")
      .filter((line) => line.startsWith("- "));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/\b(?:P\d+|20\d{2}-\d{2}-\d{2})\b/);
    }
  });
});
