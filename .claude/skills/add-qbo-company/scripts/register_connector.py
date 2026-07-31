#!/usr/bin/env python3
"""Ensure the unified `qbo` connector is registered in the Claude Desktop config.

The unified model is one connector for every company: the company is picked at
runtime (select_company or a per-call `company` argument), so this entry never
carries a QBO_COMPANY. The script validates the existing config, backs it up,
adds or refreshes the single entry, and is idempotent.

Usage (unified, the default):
  register_connector.py --project-dir /path/to/qbo-mcp-server --node /path/to/node

Legacy per-company mode (deprecated; one qbo-<slug> connector per company):
  register_connector.py --slug 8315 --project-dir ... --node ...

Extra env pairs (rarely needed) are merged in with repeatable --env KEY=VALUE.
"""
import argparse
import json
import os
import platform
import shutil
import sys
from datetime import datetime


def config_path() -> str:
    home = os.path.expanduser("~")
    system = platform.system()
    if system == "Darwin":
        return os.path.join(home, "Library", "Application Support", "Claude",
                            "claude_desktop_config.json")
    if system == "Windows":
        appdata = os.environ.get("APPDATA", os.path.join(home, "AppData", "Roaming"))
        return os.path.join(appdata, "Claude", "claude_desktop_config.json")
    return os.path.join(home, ".config", "Claude", "claude_desktop_config.json")


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--project-dir", required=True)
    p.add_argument("--node", required=True)
    p.add_argument("--name", default="qbo", help="Connector name (unified mode; default 'qbo').")
    p.add_argument("--slug", default=None,
                   help="LEGACY: register a per-company qbo-<slug> connector instead.")
    p.add_argument("--env", action="append", default=[],
                   help="Extra env var as KEY=VALUE; repeatable.")
    p.add_argument("--config", default=None, help="Override config path (testing).")
    args = p.parse_args()

    index_js = os.path.join(os.path.abspath(args.project_dir), "src", "index.js")
    if not os.path.isfile(index_js):
        print(f"ERROR: {index_js} not found; is --project-dir correct?", file=sys.stderr)
        return 1
    if not os.path.isfile(args.node):
        print(f"ERROR: node not found at {args.node}", file=sys.stderr)
        return 1

    env = {}
    if args.slug:
        slug = args.slug.strip()
        server_key = f"qbo-{slug}"
        env["QBO_COMPANY"] = slug
        print("NOTE: per-company connectors are the legacy mode. The unified `qbo` "
              "connector (run without --slug) serves every company at once.")
    else:
        server_key = args.name.strip() or "qbo"

    for pair in args.env:
        if "=" not in pair:
            print(f"ERROR: --env '{pair}' must be KEY=VALUE", file=sys.stderr)
            return 1
        k, v = pair.split("=", 1)
        env[k.strip()] = v

    path = args.config or config_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)

    # Load existing config, tolerating a missing file but NOT a corrupt one;
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
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = f"{path}.bak-{stamp}"
        shutil.copy2(path, backup)
        print(f"Backed up existing config to {backup}")
    else:
        cfg = {}
        print("No existing Claude Desktop config found; creating a new one.")

    servers = cfg.setdefault("mcpServers", {})
    existed = server_key in servers
    entry = {"command": args.node, "args": [index_js]}
    if env:
        entry["env"] = env
    servers[server_key] = entry

    with open(path, "w") as f:
        json.dump(cfg, f, indent=2)
        f.write("\n")

    verb = "Updated" if existed else "Added"
    print(f"{verb} connector '{server_key}' in {path}")
    for k, v in env.items():
        shown = v if k not in ("QBO_CLIENT_SECRET",) else "<hidden>"
        print(f"  {k}={shown}")
    if not existed:
        print("Restart Claude Desktop once (full quit) to load the new connector.")
    else:
        print("No restart needed; the entry was refreshed in place.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
