# Contributing

Fork away. This project is Apache-2.0, so you are free to fork it, modify it,
and use it commercially. One ask, not a requirement: **if you improve it, open
a pull request or an issue here** so every firm using the connector benefits.
Upstreamed fixes also mean you stop maintaining a private patch forever.

## Ground rules for pull requests

- `npm test` must pass (vitest; CI runs it on every PR).
- Never include real company data in code, tests, fixtures, or examples: no
  client names, realm IDs, tokens, or figures from live books. Use invented
  names and obviously fake realms (e.g. `9999999999123456`).
- Never commit secrets. `.env`, `tokens*.json`, `clients.json`, and
  `qbo-policy.json` are gitignored on purpose; keep them that way.
- Write-path changes (anything under a `create_`, `update_`, `delete_`,
  `void_`, `send_`, or `import_` tool, or `policy.js`) get extra scrutiny:
  these post to real accounting ledgers. Say in the PR how you tested against
  a sandbox company.
- Match the surrounding code style; keep tool descriptions in the same voice
  as the existing ones.

## Reporting problems

Open an issue with the tool name, the `intuit_tid` from the error message if
one is shown (Intuit support asks for it), and the smallest reproduction you
can manage with sandbox data.

## Security

If you find a vulnerability, especially anything touching token storage, the
OAuth flows, or the policy gate, open a private security advisory on GitHub
rather than a public issue.
