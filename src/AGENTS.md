---
name: "Source-Guidelines"
description: "Rules for TypeScript source in src/."
applyTo: "src/**"
---

# Source Guidelines

- Treat `src/cli.ts` as the canonical runtime entry for planning and conversion behavior.
- Preserve CLI contract stability: flags, exit codes, and `--json` output shape.
- Validate user input before filesystem/process operations.
- Prefer async Node APIs (`node:fs/promises`, child-process wrappers) and explicit error handling.
- Keep helpers small and typed; avoid `any` and unsafe assertions.
- If behavior changes, update help text/tests in the same patch.
