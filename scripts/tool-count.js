#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const child = spawn(process.execPath, [path.join(root, "src/index.js")], {
  cwd: root,
  env: { ...process.env, QBO_TOOL_PROFILE: "full" },
  stdio: ["pipe", "pipe", "inherit"],
});

let buffer = "";
let nextId = 1;
const pending = new Map();

child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message);
    }
  }
});

function call(method, params) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

try {
  await call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "tool-count", version: "1" },
  });
  const response = await call("tools/list", {});
  if (response.error) throw new Error(response.error.message);
  const names = response.result.tools.map((tool) => tool.name).sort();
  console.log(`${names.length} tools`);
  console.log(names.join("\n"));
} finally {
  child.kill();
}
