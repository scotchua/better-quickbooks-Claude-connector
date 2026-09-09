import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveEnvPath } from "./util.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export function tokensDir(env = process.env) {
  return resolveEnvPath(env.QBO_TOKENS_DIR, ROOT);
}
