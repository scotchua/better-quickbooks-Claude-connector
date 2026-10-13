# Mutation test sweep, October 2026

Scope: tests only. No file under `src/`, no policy file, no package file and no existing test expectation changed. Each module was swept by Codex with hand-selected single-change mutants (comparison flips, AND/OR swaps, return replacements, statement removal, arithmetic changes). The per-module reports were produced by Codex and are summarized here; the kill rates are Codex's measurements, not re-measured in full. Claude re-ran the full suite and spot-checked five new tests (see Verification).

## Totals

- Modules swept: 22. Twenty produced new tests. Two (`doctor.js`, `output-schema.js`) produced nothing.
- Mutants generated: 888 across the 20 measured modules.
- Killed by the existing tests: 492 (55.4%).
- Killed with the new tests: 868 (97.7%).
- Survivors left: 20. Each is classified below as equivalent or untestable offline.
- Defects found in production code: none.
- New test cases added: about 184 (counted from added `it(` and `test(` lines), in 15 new files and 5 existing files extended by additions only.

## Per module

| Module | Mutants | Killed before | Killed after |
| --- | ---: | ---: | ---: |
| `allocate.js` | 35 | 29 (82.9%) | 32 (91.4%) |
| `audit.js` | 32 | 22 (68.8%) | 31 (96.9%) |
| `clients.js` | 37 | 29 (78.4%) | 37 (100%) |
| `compact.js` | 132 | 19 (14.4%) | 132 (100%) |
| `company-registry.js` | 31 | 26 (83.9%) | 31 (100%) |
| `connect-catcher.js` | 32 | 8 (25%) | 32 (100%) |
| `connect-playground.js` | 33 | 8 (24.2%) | 32 (97.0%) |
| `csv.js` | 32 | 27 (84.4%) | 31 (96.9%) |
| `entities.js` | 46 | 14 (30.4%) | 46 (100%) |
| `index.js` | 25 | 11 (44.0%) | 24 (96.0%) |
| `lines.js` | 39 | 2 (5.1%) | 39 (100%) |
| `links.js` | 50 | 37 (74%) | 50 (100%) |
| `owner-lock.js` | 28 | 23 (82.1%) | 28 (100%) |
| `policy.js` | 44 | 36 (81.8%) | 43 (97.7%) |
| `qbo.js` | 12 | 3 (25%) | 12 (100%) |
| `reconcile.js` | 44 | 32 (72.7%) | 44 (100%) |
| `reports.js` | 69 | 52 (75.4%) | 67 (97.1%) |
| `secure-store.js` | 74 | 50 (67.6%) | 66 (89.2%) |
| `tool-profiles.js` | 35 | 22 (62.9%) | 34 (97.1%) |
| `util.js` | 58 | 42 (72.4%) | 57 (98.3%) |
| `doctor.js` | 0 | not measured | not measured |
| `output-schema.js` | 0 | not measured | not measured |

## Caveats

- The samples are selected mutants, not exhaustive mutation searches. `qbo.js` covers 12 mutants only; `compact.js` and `lines.js` carry the largest gains because their prior coverage was thin.
- Codex worked offline without `node_modules` in several sweeps. `allocate.js` and `tool-profiles.js` and similar reports note that the full `npm test` could not run in that environment and that a local harness stood in. The suite has since been run in full (see Verification).
- `doctor.js` and `output-schema.js` were stopped before any mutant was generated because the modules could not be imported without installed dependencies. They need a rerun with dependencies installed.

## Survivors left

Equivalent (no observable behavior change):
- `allocate.js`: invoice-overpay, invoice-total and bill-overpay boundaries (three mutants). Operands are rounded to cents, so the compared difference cannot equal the 0.005 threshold.
- `csv.js`: `prepareJournalDirectory` return value (private, both callers ignore it).
- `index.js`: M05, the optional `newDate` operator (schema-validated input).
- `policy.js`: M41, `max_write_amount` `< 0` versus `<= 0` (zero is already excluded by the outer condition).
- `reports.js`: M047 and M052 in `flagGlRows` (date and integer guards are redundant for real values).
- `secure-store.js`: M26 (suppresses a log message only) and M53 (empty blob also fails the Base64 regex).
- `tool-profiles.js`: S10 (one-character tool name takes a different path but the same result).
- `util.js`: M049, `expandHome` `slice(2)` versus `slice(1)`.

Untestable offline (no injection hook reaches the code):
- `audit.js`: M11, `prepareRecoveryDirectory` fsync call. A durability coverage gap.
- `secure-store.js`: M36, M37 (`runSecurity` stdin), M48 (`runPowershell`), M49, M50 (`runPowershellStdin`), M63 (macOS key provider branch in `loadKey`). Each would invoke a real platform executable.
- `connect-playground.js`: one survivor, `makePrompter.trim`, which is private and redundant with `cleanRealmId` and `cleanRefreshToken`.

## Defects found

None. Every module report states that no mutant exposed behavior that contradicts the intended design, and no expected-failure tests were added.
