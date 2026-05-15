---
name: "Test-Guidelines"
description: "Rules for tests in test/."
applyTo: "test/**"
---

# Test Guidelines

- Cover CLI validation, safety gates, exit codes, and summary output.
- Keep tests deterministic and independent from network/auth state.
- Prefer fixture-driven tests for filesystem scenarios.
- Silence console noise unless output is the assertion target.
- Add/adjust tests whenever changing flags, defaults, or conversion flow behavior.
