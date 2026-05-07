# Copilot Instructions for gh-runs-cleanup

This repository is a GitHub CLI extension focused on safe cleanup of workflow runs.

## Core principles

- Safety first: destructive actions must stay opt-in (`--confirm` / `--yes`).
- Keep CLI output deterministic and script-friendly.
- Prefer strict typing and explicit validation.
- Minimize runtime dependencies; prefer Node built-ins.

## Quality checks

Before finalizing changes, run:

1. `npm run build`
2. `npm run typecheck`
3. `npm run lint`
4. `npm test`

## Architecture

- Source: `src/`
- Tests: `test/`
- Build output: `dist/`
- Extension entrypoints: `gh-runs-cleanup`, `cleanup-workflow-runs.mjs`

## Behavioral expectations

- Maintain stable exit codes.
- Keep `--json` output machine-readable and backward compatible.
- Include precise error messages and categories for failures.
