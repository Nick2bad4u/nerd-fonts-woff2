# Contributing to gh-runs-cleanup

Thanks for helping improve this GitHub CLI extension.

## Local setup

```bash
npm install
npm run lint
npm test
```

## Development guidelines

- Keep behavior safe by default (`--confirm` required for destructive actions).
- Prefer explicit flags over implicit behavior.
- Keep output actionable and script-friendly.
- Add/adjust tests when changing argument parsing, filtering, or exit-code behavior.

## Pull requests

- Keep PRs focused and small.
- Include a short rationale in the PR description.
- Update README usage examples for any UX changes.
