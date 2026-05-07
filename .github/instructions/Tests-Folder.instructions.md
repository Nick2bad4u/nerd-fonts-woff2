---
name: Test-Guidelines
description: Rules for automated tests in test/
applyTo: "test/**"
---

# Test Guidelines (`test/`)

- Cover argument validation, exit codes, and safety gates.
- Keep tests deterministic and independent from network/auth state.
- Silence console noise unless output is part of the assertion.
- Add tests whenever changing CLI flags or default behavior.
