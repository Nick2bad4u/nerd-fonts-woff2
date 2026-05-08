# Developer Guide — nerd-font-woff2

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

### Step 1 — Download Nerd Fonts sources

```bash
npm run fonts:download
```

Check whether upstream Nerd Fonts has a newer tag than your local downloaded source metadata:

```bash
npm run fonts:check-upstream
```

Optional flags for scripting:

```bash
npm run fonts:check-upstream -- --json
npm run fonts:check-upstream -- --fail-on-update
```

Performs a sparse checkout of `ryanoasis/nerd-fonts` and copies `patched-fonts/**` into `fonts/original/**`.
Default ref is pinned to `v3.4.0` for reproducibility. Override with:

```bash
npm run fonts:download -- --ref v3.5.0
```

### Step 2 — Convert to WOFF2

```bash
npm run fonts:convert
```

Runs the fast in-process bulk converter (`scripts/bulk-convert-fonts.mjs`) using the bundled `ttf2woff2` npm package — **no system tools required**.

Converts all `.ttf` / `.otf` files in `fonts/original/**` and writes `.woff2` output to the mirrored path under `fonts/woff2/**`. Skips already up-to-date files (based on mtime). Use `--force` to re-convert everything.

```bash
npm run fonts:convert -- --force
```

Preview without writing files:

```bash
npm run fonts:convert:dry-run
```

### Step 3 — Verify generated assets

```bash
npm run fonts:verify
```

Checks that every expected output file exists and has a valid WOFF2 magic signature (`wOF2`).

### One-shot local pipeline

```bash
npm run fonts:local
```

Runs: `fonts:setup` → `fonts:download` → `fonts:convert` → `fonts:verify`.

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
npx nerd-font-woff2 --source-dir ./fonts/original --dry-run
```

### Convert files

```bash
npx nerd-font-woff2 --source-dir ./fonts/original --convert --confirm
```

### Convert with JSON summary and index file

```bash
npx nerd-font-woff2 \
  --source-dir ./fonts/original \
  --convert \
  --confirm \
  --index-file ./fonts/woff2/index.json \
  --json
```

### Use a manifest file

```bash
npx nerd-font-woff2 --manifest ./nerd-font-woff2.config.json --convert --confirm
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

| Flag                      | Description                                   |
| ------------------------- | --------------------------------------------- |
| `--source-dir <path>`     | Source directory (repeatable)                 |
| `--manifest <file>`       | Load options from a JSON manifest             |
| `--out-dir <path>`        | Output directory for `.woff2` files           |
| `--temp-dir <path>`       | Scratch directory for staging                 |
| `--include-ext <ttf,otf>` | File extensions to include                    |
| `--max-files <n>`         | Limit files processed                         |
| `--convert`               | Enable conversion (off by default)            |
| `--dry-run`               | Plan without writing files                    |
| `--confirm` / `--yes`     | Skip confirmation prompt                      |
| `--converter <cmd>`       | Converter command (default: `woff2_compress`) |
| `--converter-arg <value>` | Converter argument (repeatable)               |
| `--fail-fast`             | Stop on first failure                         |
| `--concurrency <n>`       | Parallel conversions (default: `1`)           |
| `--timeout <ms>`          | Per-file timeout (default: `60000`)           |
| `--index-file <path>`     | Write JSON asset index                        |
| `--verbose`               | Verbose output                                |
| `--debug`                 | Debug output (implies verbose)                |
| `--json`                  | Machine-readable JSON output                  |
| `--help`                  | Show help                                     |

Default behavior notes:

- `--index-file` defaults to `<out-dir>/index.json`
- index writing only occurs in non-dry-run `--convert` mode (safe plan mode stays write-free)
- `--timeout` defaults to `60000` ms (`60s`)
- `--concurrency` defaults to `1` for deterministic/safe CLI execution

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

End-to-end local refresh pipeline (install → checks → source update check → download → convert → verify):

```bash
npm run final
```

---

## GitHub Pages font browser

A static searchable font browser is available at repository root `index.html`.
It reads `fonts/woff2/index.json` and renders family/file links for easy discovery.

- Default file path: `./index.html`
- Data source: `./fonts/woff2/index.json`
- CDN links are generated for `jsDelivr` and are version-editable in the UI.

If using GitHub Pages with branch deployment, keep publishing from `main` and include root files (or configure Pages to a folder that contains this `index.html` plus `fonts/woff2`).

---

## Commit generated assets

After converting, commit the generated output:

```bash
git add fonts/woff2
git commit -m "Update generated WOFF2 assets"
```

---

## npm packaging

- `bin` entry: `nerd-font-woff2`
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
