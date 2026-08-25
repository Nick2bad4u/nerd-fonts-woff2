# Developer Guide — nerd-fonts-woff2

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

For a guided plan, review, and apply sequence:

```bash
npm run fonts:update:guided
```

The command saves a complete ignored review file under `temp/nerd-fonts-update/`, prints both relevant SHA-256 values, and requires the exact plan fingerprint to be typed before applying. It then delegates to the same locked, fingerprint-revalidating updater used by the low-level command.

For noninteractive or delayed maintenance, split the workflow:

```bash
npm run -- fonts:update:review -- --ref v3.5.1 --verbose
npm run -- fonts:update:apply -- --confirm --verbose
```

The second command validates the saved plan, obtains its target and fingerprint, and revalidates current GitHub metadata before downloading. `--plan-file` accepts only repository-local paths. The default plan file is ignored by Git.

The low-level updater remains read-only by default:

```bash
npm run fonts:update
```

This is read-only by default. It resolves the latest stable release, checks local provenance and prerequisite readiness, fingerprints the release ID, resolved commit, checksum manifest, and selected asset metadata/digests, and prints the exact reviewed apply command. The lower-level tag check remains available for automation:

```bash
npm run fonts:check-upstream
```

Optional flags for scripting:

```bash
npm run -- fonts:check-upstream -- --json
npm run -- fonts:check-upstream -- --fail-on-update
```

Apply only after reviewing the plan:

```bash
npm run -- fonts:update -- --ref v3.5.1 --apply --confirm --plan-fingerprint <sha256-from-plan>
```

Add `--verbose` for timestamped stage bars, exact child commands, timings, and archive/font counters:

```bash
npm run -- fonts:update -- --ref v3.5.1 --apply --confirm --plan-fingerprint <sha256-from-plan> --verbose
```

Updater stage diagnostics are emitted on stderr. In `--json` mode, child-process output is streamed to stderr and stdout is exactly one machine-readable JSON document on success or failure. During a normal interactive run, the converter reports every exact relative font path at start and completion, `completed/total`, percentage, overall progress, active workers, process/module/read/convert/write/overhead/total timings, and output size. ANSI styling is automatic for interactive terminals; `--color` forces it, while `--no-color` or `NO_COLOR` disables it. Progress uses persistent lines rather than cursor control so logs remain readable when redirected or captured by CI.

The converter uses a fixed process-backed worker pool. Pool processes load the native module once, handle jobs sequentially, and are reused after both successful conversions and ordinary font errors. The coordinator validates every IPC message and retires a process after timeout, IPC failure, malformed result, or crash; later jobs create replacements up to `--concurrency`. A clean shutdown asks idle children to exit, then force-terminates any child that does not respond. The first result from a process includes bootstrap and module-load timings; reused processes report cached initialization. `read`, quality-11 WOFF2 `convert`, `write` (including directory creation), IPC/runtime `overhead`, and end-to-end `total` identify where each font spent time.

The updater consumes the complete official `.tar.xz` release asset set rather than the incomplete upstream `patched-fonts/` checkout. Under the exclusive lock it performs offline recovery first, re-reads canonical metadata and Git status, revalidates the reviewed artifact fingerprint, checks disk/prerequisite capabilities, and only then downloads. It verifies `SHA-256.txt` plus GitHub digests, extracts and converts into staging, verifies source/output/index/provenance consistency, and atomically promotes both trees with README in one journal. Pre-commit failures restore the prior state; post-commit cleanup failures retain a committed journal and report `committed: true` for the next apply to finish.

Apply refuses dirty generated paths by default. `--allow-dirty`, `--force-rebuild`, and `--break-stale-lock` are deliberate recovery/override controls, not routine flags. The update worktree must be local and non-UNC, and all rename targets must stay on one volume. The updater's `--convert` spelling is deprecated; it remains an alias for `--apply` while the low-level converter continues to use `--convert`.

For scripts, invoke `node ./scripts/update-nerd-fonts.mjs --json`, save `$LASTEXITCODE` before `ConvertFrom-Json`, and capture stderr separately. JSON failures use stable category exit codes and preserve child command, exit, signal, phase, and nested rollback errors.

For downloader debugging only:

```bash
npm run -- fonts:download -- --ref v3.5.1 --dry-run
npm run -- fonts:download -- --ref v3.5.1 --confirm
```

Non-default downloader destinations must be children of `temp/`.

### Low-level WOFF2 conversion

```bash
npm run fonts:convert
```

The default is a non-mutating plan. Real writes require both gates:

```bash
npm run -- fonts:convert -- --convert --confirm
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

Checks missing and stale files, WOFF2 signatures, portable index paths and sizes, and release provenance when present.

### One-shot local pipeline

```bash
npm run fonts:local
```

`fonts:local` is a compatibility alias for the safe `fonts:update` plan.

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
