# Contributing to nerd-fonts-woff2

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

## In-depth developer documentation

For developers who want in-depth guides see below for detailed documentation on the build pipeline, CLI tool, and release process.

## Developer Guide — nerd-fonts-woff2

This document covers the build pipeline, conversion tooling, CLI, and release process for maintainers and contributors.

For end-user font usage, see [README.md](./README.md).

---

## Requirements

- Node.js `>=22.18.0`
- npm `>=10`

## Install dependencies

```bash
npm install
```

---

## Local asset pipeline

Asset fetching and conversion are intentionally **local-only** operations. CI does not run bulk font downloads.

### Directory layout

| Path                     | Contents                                             |
| ------------------------ | ---------------------------------------------------- |
| `fonts/original/**`      | Downloaded `.ttf` / `.otf` source files (gitignored) |
| `fonts/woff2/**`         | Generated `.woff2` output files (committed)          |
| `fonts/woff2/index.json` | Generated asset index                                |
| `temp/`                  | Scratch space used during conversion (gitignored)    |

### Recommended — plan and apply a complete upstream update

```bash
npm run fonts:update
```

The default command is read-only. It resolves the latest stable Nerd Fonts release, compares it with committed asset provenance, checks the required tools, and reports the exact release archive count and download size.

After reviewing that plan, pin and apply the exact tag it reported:

```bash
npm run -- fonts:update -- --ref v3.5.1 --convert --confirm
```

The updater downloads every official `.tar.xz` family asset, validates it against the release's `SHA-256.txt`, rejects unsafe archive paths, extracts into staging, converts into a separate staged WOFF2 tree, verifies counts/signatures/index/provenance, and only then replaces `fonts/original/**` and `fonts/woff2/**`. A failed download, extraction, conversion, or verification leaves the current asset trees in place.

`fonts/woff2/source-metadata.json` is the committed provenance record. Generated index paths are repository-relative so the index remains valid across machines and checkout locations.

Useful plan options:

```bash
npm run -- fonts:update -- --json
npm run -- fonts:update -- --ref v3.5.1 --dry-run
```

### Low-level source download

Use this only when debugging the update pipeline. It requires an explicit release and confirmation because it replaces its destination:

```bash
npm run -- fonts:download -- --ref v3.5.1 --dry-run
npm run -- fonts:download -- --ref v3.5.1 --confirm
```

Custom downloader destinations are restricted to children of `temp/`; this prevents a mistyped debugging path from replacing repository source or configuration directories.

Unlike the old sparse-checkout process, this consumes the complete official release asset set, including families whose binaries are not stored under the upstream repository's `patched-fonts/` tree.

### Low-level WOFF2 conversion

```bash
npm run fonts:convert
```

This is now a non-mutating plan. Real writes require the repository's standard conversion gates:

```bash
npm run -- fonts:convert -- --convert --confirm
```

Runs the parallel in-process converter using the bundled `ttf2woff2` package. Use the one-shot updater for release refreshes; it forces a clean staged conversion so changed and removed upstream files cannot leave stale output behind.

```bash
npm run -- fonts:convert -- --force --convert --confirm
```

Preview without writing files:

```bash
npm run fonts:convert:dry-run
```

### Verify generated assets

```bash
npm run fonts:verify
```

Checks both directions of the source/output mapping, rejects stale outputs, validates every WOFF2 magic signature, checks portable index paths and byte sizes, and validates release provenance when present.

### One-shot local pipeline

```bash
npm run fonts:local
```

`fonts:local` is a compatibility alias for the safe `fonts:update` plan. Apply an update only with the explicit `--ref`, `--convert`, and `--confirm` flags shown above.

### Converter readiness check

```bash
npm run fonts:setup
```

Verifies `ttf2woff2` is installed and runs a live smoke-test conversion.

---

## CLI tool usage

The CLI (`dist/src/cli.js`) provides fine-grained control for single-directory or manifest-driven workflows.

### Plan only (safe default)

```bash
npx nerd-fonts-woff2 --source-dir ./fonts/original --dry-run
```

### Convert files

```bash
npx nerd-fonts-woff2 --source-dir ./fonts/original --convert --confirm
```

### Convert with JSON summary and index file

```bash
npx nerd-fonts-woff2 \
  --source-dir ./fonts/original \
  --convert \
  --confirm \
  --index-file ./fonts/woff2/index.json \
  --json
```

### Use a manifest file

```bash
npx nerd-fonts-woff2 --manifest ./nerd-fonts-woff2.config.json --convert --confirm
```

Example manifest:

```json
{
 "sourceDirs": ["./fonts/original"],
 "outDir": "./fonts/woff2",
 "tempDir": "./temp/work",
 "converter": "node",
 "converterArgs": ["./scripts/node-woff2-compress.mjs"],
 "includeExts": ["ttf", "otf"],
 "indexFile": "./fonts/woff2/index.json"
}
```

### CLI options reference

| Flag                      | Description                         |
| ------------------------- | ----------------------------------- |
| `--source-dir <path>`     | Source directory (repeatable)       |
| `--manifest <file>`       | Load options from a JSON manifest   |
| `--out-dir <path>`        | Output directory for `.woff2` files |
| `--temp-dir <path>`       | Scratch directory for staging       |
| `--include-ext <ttf,otf>` | File extensions to include          |
| `--max-files <n>`         | Limit files processed               |
| `--convert`               | Enable conversion (off by default)  |
| `--dry-run`               | Plan without writing files          |
| `--confirm` / `--yes`     | Skip confirmation prompt            |
| `--converter <cmd>`       | Converter command (default: `node`) |
| `--converter-arg <value>` | Converter argument (repeatable)     |
| `--fail-fast`             | Stop on first failure               |
| `--index-file <path>`     | Write JSON asset index              |
| `--verbose`               | Verbose output                      |
| `--json`                  | Machine-readable JSON output        |
| `--help`                  | Show help                           |

### Exit codes

| Code | Meaning                                               |
| ---- | ----------------------------------------------------- |
| `0`  | Success                                               |
| `1`  | Validation / runtime / dependency error               |
| `2`  | Partial conversion failure (one or more files failed) |

---

## Development checks

Run all checks before opening a PR:

```bash
npm run build
npm run typecheck
npm run lint
npm test
npm run test:coverage
```

Or run them all together:

```bash
npm run lint:all
```

---

## Commit generated assets

After converting, commit the generated output:

```bash
git add fonts/woff2
git commit -m "Update generated WOFF2 assets"
```

---

## npm packaging

- `bin` entry: `nerd-fonts-woff2`
- `prepack` runs `npm run build` so published tarballs include compiled `dist/` output
- Published files are restricted to runtime essentials (`dist/`, `fonts/woff2/`, wrapper, README, LICENSE)
- Release workflow validates that committed assets exist before creating a GitHub release

Preview package contents before publish:

```bash
npm pack
```

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution guidelines, coding standards, and pull request process.

## Security

See [SECURITY.md](./SECURITY.md) for the vulnerability reporting policy.
