# gh-runs-cleanup

[![latest GitHub release.](https://flat.badgen.net/github/release/Nick2bad4u/gh-runs-cleanup?color=cyan)](https://github.com/Nick2bad4u/gh-runs-cleanup/releases) [![GitHub stars.](https://flat.badgen.net/github/stars/Nick2bad4u/gh-runs-cleanup?color=yellow)](https://github.com/Nick2bad4u/gh-runs-cleanup/stargazers) [![GitHub forks.](https://flat.badgen.net/github/forks/Nick2bad4u/gh-runs-cleanup?color=green)](https://github.com/Nick2bad4u/gh-runs-cleanup/forks) [![GitHub open issues.](https://flat.badgen.net/github/open-issues/Nick2bad4u/gh-runs-cleanup?color=red)](https://github.com/Nick2bad4u/gh-runs-cleanup/issues)

`gh-runs-cleanup` is a GitHub CLI extension for safely cleaning up GitHub Actions workflow runs in bulk.

It is designed for repos that accumulate thousands of failed/cancelled runs and need controlled cleanup with clear filters and safety checks.

## Install

```bash
gh extension install Nick2bad4u/gh-runs-cleanup
```

Project site: <https://nick2bad4u.github.io/gh-runs-cleanup/>

## Requirements

- `gh` CLI installed and authenticated
- Node.js `>=22.18.0`

Extension installs run directly from the repository source; no local build step is required for end users.

## Usage

```bash
gh runs-cleanup --repo owner/repo --dry-run
gh runs-cleanup --repo owner/repo --status failure,cancelled --confirm
gh runs-cleanup --repo owner/repo --workflow CI --branch main --max-delete 100 --confirm
gh runs-cleanup --repo owner/repo --dry-run --json
gh runs-cleanup --before-days 30 --status failure --confirm
```

## Repository selection

- `--repo <owner/name>`: target repository.
- If `--repo` is omitted, the extension attempts to resolve the current repo via `gh repo view`.

## Filters

- `--status <value[,value...]>` (repeatable; default `failure,cancelled`)
- `--workflow <name|id>`
- `--exclude-workflow <name[,name...]>` (repeatable)
- `--branch <name>`
- `--exclude-branch <name[,name...]>` (repeatable)
- `--event <event>`
- `--user <login>`
- `--commit <sha>`
- `--created <date>`
- `--limit <n>` (default `200`)
- `--before-days <n>`: only include runs older than N days
- `--max-delete <n>`
- `--order <oldest|newest|none>`: order matched runs before deletion (`oldest` default)

## Execution flags

- `--dry-run`: preview matches without deleting
- `--confirm`: required to actually delete
- `--yes`: alias for `--confirm`
- `--all-statuses`: target all valid GitHub run statuses
- `--max-retries <n>`: retry failed delete calls (`2` default)
- `--retry-delay-ms <n>`: initial retry delay in ms (`200` default)
- `--fail-fast`: stop after first failed deletion
- `--max-failures <n>`: stop after `n` failed deletions
- `--verbose`: print matched run details
- `--quiet`: suppress most non-error text output
- `--json`: emit a machine-readable summary
- `--help`

## Exit codes

- `0`: success
- `1`: validation/auth/runtime error
- `2`: partial failure (some run deletions failed)

## Development

```bash
npm install
npm run typecheck
npm run build
npm run lint
npm test
```

## TypeScript and build output

- Source code lives in `src/`.
- The extension entrypoints (`gh-runs-cleanup`, `cleanup-workflow-runs.mjs`) execute `src/cli.ts` directly.
- Build output goes to `dist/` via `tsc` for CI validation and local compiled testing.
