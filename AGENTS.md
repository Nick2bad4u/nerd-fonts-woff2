---
name: "Codex-Instructions-Nerd-Fonts-WOFF2"
description: "Repository-wide guidance for the nerd-fonts-woff2 CLI and asset pipeline."
applyTo: "**"
---

# Project Focus

This repository is a Node.js + TypeScript CLI that plans and converts font sources (`.ttf`/`.otf`) into WOFF2 assets.

## Priorities

- Keep conversion safety explicit: real writes require `--convert` and `--confirm` unless `--dry-run` is set.
- Preserve stable exit codes and machine-readable `--json` output.
- Prefer strict typing and clear validation over implicit behavior.
- Use Node built-ins first; add dependencies only when clearly justified.

## Quality Gates

Before finalizing changes, run:

1. `npm run build`
2. `npm run typecheck`
3. `npm run lint`
4. `npm test`

## Repo Layout

- Source: `src/`
- Scripts: `scripts/`
- Tests: `test/`
- Generated build output: `dist/`
- CLI wrapper: `nerd-fonts-woff2`
