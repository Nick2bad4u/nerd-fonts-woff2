# Contributing to nerd-font-woff2

Thanks for helping improve this font conversion pipeline.

## Local setup

```bash
npm install
npm run lint
npm test
```

## Development guidelines

- Keep behavior safe by default (`--confirm` required for conversion execution).
- Prefer explicit flags over implicit behavior.
- Keep output deterministic and script-friendly (`--json` compatibility matters).
- Add/adjust tests when changing argument parsing, conversion flow, or exit codes.

## Pull requests

- Keep PRs focused and small.
- Include a short rationale in the PR description.
- Update README usage examples for any UX changes.
