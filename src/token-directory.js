import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export function tokensDir() {
  return process.env.QBO_TOKENS_DIR || ROOT;
}
