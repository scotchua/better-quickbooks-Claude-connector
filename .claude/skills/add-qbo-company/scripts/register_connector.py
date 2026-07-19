#!/usr/bin/env python3
"""Register (or update) a qbo-<slug> connector in the Claude Desktop config.

This is the error-prone part of adding a company — hand-editing JSON risks a
trailing comma or a wrong path that silently breaks *every* connector. This
script does it safely: it validates the existing file, backs it up, adds one
connector entry, and is idempotent (re-running just refreshes the entry).

Usage:
  register_connector.py --slug 8315 --project-dir /path/to/qbo-mcp-server \
      --node /path/to/node [--env KEY=VALUE ...]

The QBO_COMPANY env var is always set to <slug>; extra --env pairs (e.g. for a
production company's own keys) are merged in.
"""
import argparse
import json
import os
import shutil
import sys
from datetime import datetime


def config_path() -> str:
    # macOS location. (Linux/Windows differ, but this server targets a Mac.)
    return os.path.expanduser(
        "~/Library/Application Support/Claude/claude_desktop_config.json"
    )


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--slug", required=True)
    p.add_argument("--project-dir", required=True)
    p.add_argument("--node", required=True)
    p.add_argument("--env", action="append", default=[],
                   help="Extra env var as KEY=VALUE; repeatable.")
    p.add_argument("--config", default=None, help="Override config path (testing).")
    args = p.parse_args()

    slug = args.slug.strip()
    server_key = f"qbo-{slug}"
    index_js = os.path.join(os.path.abspath(args.project_dir), "src", "index.js")

    if not os.path.isfile(index_js):
        print(f"ERROR: {index_js} not found — is --project-dir correct?", file=sys.stderr)
        return 1
    if not os.path.isfile(args.node):
        print(f"ERROR: node not found at {args.node}", file=sys.stderr)
        return 1

    env = {"QBO_COMPANY": slug}
    for pair in args.env:
        if "=" not in pair:
            print(f"ERROR: --env '{pair}' must be KEY=VALUE", file=sys.stderr)
            return 1
        k, v = pair.split("=", 1)
        env[k.strip()] = v

    path = args.config or config_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)

    # Load existing config, tolerating a missing file but NOT a corrupt one —
    # overwriting invalid JSON blindly could clobber other connectors.
    if os.path.isfile(path):
        with open(path) as f:
            raw = f.read().strip()
        try:
            cfg = json.loads(raw) if raw else {}
        except json.JSONDecodeError as e:
            print(f"ERROR: existing config is not valid JSON ({e}). Fix or move it "
                  f"before running this script:\n  {path}", file=sys.stderr)
            return 1
        # Back up before we touch a real file.
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = f"{path}.bak-{stamp}"
        shutil.copy2(path, backup)
        print(f"Backed up existing config → {backup}")
    else:
        cfg = {}
        print("No existing Claude Desktop config found; creating a new one.")

    servers = cfg.setdefault("mcpServers", {})
    existed = server_key in servers
    servers[server_key] = {"command": args.node, "args": [index_js], "env": env}

    with open(path, "w") as f:
        json.dump(cfg, f, indent=2)
        f.write("\n")

    verb = "Updated" if existed else "Added"
    print(f"{verb} connector '{server_key}' in {path}")
    print(f"  QBO_COMPANY={slug}")
    for k, v in env.items():
        if k != "QBO_COMPANY":
            shown = v if k not in ("QBO_CLIENT_SECRET",) else "<hidden>"
            print(f"  {k}={shown}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
