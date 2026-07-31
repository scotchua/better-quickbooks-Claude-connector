#!/usr/bin/env python3
"""Show every authorized QBO company and how Claude Desktop reaches them.

The unified model registers ONE `qbo` connector that serves every
tokens.<slug>.json (token files keep realmId/environment as plaintext metadata
even when credentials are encrypted, so this scan works either way). Legacy
setups registered one qbo-<slug> connector per company; those are reported too.

Usage: list_companies.py --project-dir /path/to/qbo-mcp-server
"""
import argparse
import glob
import json
import os
import platform
import sys


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
    p.add_argument("--config", default=None)
    args = p.parse_args()

    proj = os.path.abspath(args.project_dir)
    index_js = os.path.join(proj, "src", "index.js")

    # Token files: tokens.<slug>.json (skip the legacy/default tokens.json).
    tokens = {}
    for fp in sorted(glob.glob(os.path.join(proj, "tokens.*.json"))):
        base = os.path.basename(fp)
        slug = base[len("tokens."):-len(".json")]
        if slug in ("sandbox-backup",):  # known non-company backup name
            continue
        try:
            with open(fp) as f:
                d = json.load(f)
            tokens[slug] = (d.get("realmId", "?"), d.get("environment", "?"))
        except Exception as e:
            tokens[slug] = (f"<unreadable: {e}>", "?")

    # Connectors: unified (points at this project's index.js, no QBO_COMPANY)
    # and legacy per-company (has QBO_COMPANY).
    path = args.config or config_path()
    unified = None
    legacy = set()
    if os.path.isfile(path):
        try:
            with open(path) as f:
                cfg = json.load(f)
            for key, entry in cfg.get("mcpServers", {}).items():
                argv = entry.get("args", [])
                if not any(str(a).endswith(os.path.join("src", "index.js")) for a in argv):
                    continue
                env = entry.get("env", {})
                if "QBO_COMPANY" in env:
                    legacy.add(env["QBO_COMPANY"])
                else:
                    unified = key
        except json.JSONDecodeError as e:
            print(f"WARNING: Claude Desktop config is not valid JSON ({e})", file=sys.stderr)

    print(f"unified connector: {'yes (' + unified + ')' if unified else 'NO'}")

    slugs = sorted(set(tokens) | legacy)
    if not slugs:
        print("No named companies found yet. Run the skill to add one.")
        if not unified:
            print("Then register the unified connector with register_connector.py.")
        return 0

    print(f"\n{'COMPANY':<14} {'AUTHORIZED':<11} {'ENV':<11} {'REALMID':<18} LEGACY-CONNECTOR")
    for slug in slugs:
        realm, envn = tokens.get(slug, ("-", "-"))
        authed = "yes" if slug in tokens else "NO"
        leg = "yes" if slug in legacy else "-"
        print(f"{slug:<14} {authed:<11} {envn:<11} {str(realm):<18} {leg}")

    # Nudges for the common half-configured states.
    if not unified:
        print("\n  ! No unified `qbo` connector registered. Run register_connector.py "
              "once, then restart Claude Desktop.")
    for slug in slugs:
        if slug in legacy and slug not in tokens:
            print(f"\n  ! {slug}: legacy connector exists but not authorized. Run "
                  f"`QBO_COMPANY={slug} npm run connect` or remove the entry.")
    if legacy and unified:
        print("\n  * Legacy qbo-<slug> connectors still exist. The unified connector "
              "covers them; consider removing the per-company entries.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
