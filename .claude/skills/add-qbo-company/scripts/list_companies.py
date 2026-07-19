#!/usr/bin/env python3
"""Show every QBO company this server knows about and whether it's wired into
Claude Desktop — a fast sanity check before/after adding one.

Cross-references three things that must line up for a company to actually work:
  1. tokens.<slug>.json on disk (the authorization)
  2. its realmId + environment
  3. a matching qbo-<slug> connector in the Claude Desktop config

Usage: list_companies.py --project-dir /path/to/qbo-mcp-server
"""
import argparse
import glob
import json
import os
import sys


def config_path() -> str:
    return os.path.expanduser(
        "~/Library/Application Support/Claude/claude_desktop_config.json"
    )


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--project-dir", required=True)
    p.add_argument("--config", default=None)
    args = p.parse_args()

    proj = os.path.abspath(args.project_dir)

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

    # Registered connectors.
    path = args.config or config_path()
    registered = set()
    if os.path.isfile(path):
        try:
            with open(path) as f:
                cfg = json.load(f)
            for key, entry in cfg.get("mcpServers", {}).items():
                env = entry.get("env", {})
                if "QBO_COMPANY" in env:
                    registered.add(env["QBO_COMPANY"])
        except json.JSONDecodeError as e:
            print(f"WARNING: Claude Desktop config is not valid JSON ({e})", file=sys.stderr)

    slugs = sorted(set(tokens) | registered)
    if not slugs:
        print("No named companies found yet. Run the skill to add one.")
        return 0

    print(f"{'COMPANY':<14} {'AUTHORIZED':<11} {'REGISTERED':<11} {'ENV':<11} REALMID")
    for slug in slugs:
        realm, envn = tokens.get(slug, ("—", "—"))
        authed = "yes" if slug in tokens else "NO"
        reg = "yes" if slug in registered else "NO"
        print(f"{slug:<14} {authed:<11} {reg:<11} {envn:<11} {realm}")

    # Gentle nudges for the two half-configured states.
    for slug in slugs:
        if slug in tokens and slug not in registered:
            print(f"\n  ! {slug}: authorized but no connector — run register_connector.py.")
        if slug in registered and slug not in tokens:
            print(f"\n  ! {slug}: connector exists but not authorized — run "
                  f"`QBO_COMPANY={slug} npm run connect`.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
