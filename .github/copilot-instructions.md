# Copilot Instructions for nerd-font-woff2

This repository provides a CLI pipeline for building WOFF2 assets from Nerd Fonts and other TTF/OTF font sources.

## Core principles

- Safety first: execution that writes/changes files should remain explicit (`--convert` + `--confirm`).
- Keep CLI output deterministic and script-friendly.
- Prefer strict typing and explicit input validation.
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
- Entrypoint wrapper: `nerd-font-woff2`

## Behavioral expectations

- Maintain stable exit codes.
- Keep `--json` output machine-readable and backward compatible.
- Include precise error messages and categories for failures.
