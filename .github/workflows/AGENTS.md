---
name: "Workflows-Guidelines"
description: "Rules for CI workflows in this repository."
applyTo: ".github/workflows/*.yml"
---

# GitHub Actions Guidelines

- Keep workflows minimal, deterministic, and tied to this repo's actual gates.
- Use least-privilege `permissions` and avoid unnecessary write scopes.
- Ensure CI validates `build`, `typecheck`, `lint`, and `test`.
- Avoid adding unrelated security/scanning workflows unless explicitly requested.
- Prefer fast, observable failures with clear job and step names.
