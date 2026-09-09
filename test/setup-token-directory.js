import { afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Vitest runs setup files for each test file; children inherit its directory.
const original = process.env.QBO_TOKENS_DIR;
const directory = await mkdtemp(path.join(tmpdir(), "qbo-test-tokens-"));
process.env.QBO_TOKENS_DIR = directory;

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
  if (original === undefined) delete process.env.QBO_TOKENS_DIR;
  else process.env.QBO_TOKENS_DIR = original;
});
