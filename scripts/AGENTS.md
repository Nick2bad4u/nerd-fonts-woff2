---
name: "Scripts-Folder-Guidelines"
description: "Guidance for automation scripts under scripts/."
applyTo: "scripts/**"
---

# Scripts Guidelines

Scripts in `scripts/` support font download, conversion, verification, and maintenance.

- Keep scripts idempotent and safe for reruns.
- Prefer Node ESM (`.mjs`) and Node built-ins.
- Resolve paths explicitly from repo context.
- Use `temp/` for transient outputs; do not pollute repo root.
- When scripts mutate files, make changed targets explicit and deterministic.
- Keep diagnostics actionable and exit non-zero on failure.
