---
name: Source-Guidelines
description: Rules for TypeScript source in src/
applyTo: "src/**"
---

# Source Guidelines (`src/`)

- Keep CLI behavior safe and explicit.
- Validate user input before external calls.
- Prefer typed helper functions over large monolithic logic blocks.
- Preserve stable output shape for `--json` mode.
- Use Node built-ins unless an external package is clearly justified.
