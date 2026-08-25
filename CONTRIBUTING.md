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

Use the guided workflow for routine maintainer updates:

```bash
npm run fonts:update:guided
```

It saves the reviewed release identity to the ignored `temp/nerd-fonts-update/reviewed-plan.json` file, displays the plan fingerprint and checksum-manifest SHA-256, and requires the full fingerprint to be typed before it calls the hardened apply path. Enter without a fingerprint cancels without mutation.

To review now and apply later, use the saved-plan commands:

```bash
npm run -- fonts:update:review -- --ref v3.5.1 --verbose
npm run -- fonts:update:apply -- --confirm --verbose
```

Apply rejects an edited plan file and reacquires the upstream release identity while holding the lock. The saved file supplies convenience, not an integrity bypass. Use `--plan-file <repository-local-path>` only when maintaining more than one reviewed plan.

The underlying updater remains plan-only by default:

```bash
npm run fonts:update
```

The default command is read-only. It resolves the latest stable Nerd Fonts release, compares it with committed asset provenance, reports apply-prerequisite readiness, and fingerprints the exact release ID, tag commit, checksum manifest, asset IDs, sizes, and SHA-256 values.

After reviewing that plan, pin and apply the exact tag it reported:

```bash
npm run -- fonts:update -- --ref v3.5.1 --apply --confirm --plan-fingerprint <sha256-from-plan>
```

For timestamped stage bars, invoked child commands, command durations, and the existing archive/font counters, add `--verbose`:

```bash
npm run -- fonts:update -- --ref v3.5.1 --apply --confirm --plan-fingerprint <sha256-from-plan> --verbose
```

Updater stage diagnostics use stderr. In `--json` mode, child output is streamed to stderr and stdout remains exactly one parseable JSON document, including failures. During a normal interactive run, the conversion stage reports every exact relative font path at start and completion, `completed/total`, percentage, overall progress, active workers, process/module/read/convert/write/overhead/total timings, and output size. ANSI styling is automatic on interactive terminals; `--color` forces it, while `--no-color` or `NO_COLOR` disables it. Bars are persistent lines rather than cursor animation and therefore remain useful in CI logs and PowerShell transcripts.

`--concurrency` controls a fixed pool of isolated child processes, not a new process per font. Each process loads the native converter once and reports `worker #N reused; module cached` after its first job. Ordinary font errors leave the process available for later work. A timeout, IPC failure, or crash retires only that process and a subsequent job receives a replacement. The `worker` and `module` phases appear on a process's first result; `read`, quality-11 WOFF2 `convert`, `write` (including directory creation), IPC/runtime `overhead`, and end-to-end `total` are reported for every completed conversion. Queue wait appears when it reaches at least one millisecond.

The updater revalidates the reviewed fingerprint under an exclusive owner-checked lock, downloads every official `.tar.xz` family asset, validates it against the release's `SHA-256.txt` and GitHub digests, rejects unsafe archive/reparse paths, extracts into staging, converts into a separate staged WOFF2 tree, and verifies counts/signatures/index/provenance. It then promotes `fonts/original/**`, `fonts/woff2/**`, and `README.md` as one atomically journaled transaction. Pre-commit failures attempt every rollback operation; committed cleanup failures retain recovery state for the next apply.

Apply refuses uncommitted changes to the two generated trees or README unless `--allow-dirty` is explicit. Use `--force-rebuild` only to rebuild the currently installed ref; older refs never replace newer generated assets. An active lock is never broken. `--break-stale-lock` is limited to an old malformed lock after verifying no updater is running. The repository must be a local, non-UNC worktree, with canonical, staging, and backup paths on the same volume. `--convert` is retained only as a deprecated updater alias for `--apply`.

`fonts/woff2/source-metadata.json` is the committed provenance record. Generated index paths are repository-relative so the index remains valid across machines and checkout locations.

Useful plan options:

```bash
node ./scripts/update-nerd-fonts.mjs --json
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

Runs the parallel process-isolated converter using the bundled `ttf2woff2` package. Use the one-shot updater for release refreshes; it forces a clean staged conversion so changed and removed upstream files cannot leave stale output behind.

```bash
npm run -- fonts:convert -- --force --convert --confirm
```

For the same per-font reporting in a low-level conversion, add `--verbose`; `--color` and `--no-color` control ANSI styling. Always close or allow the command to finish normally so the coordinator can gracefully stop every pooled child process.

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

`fonts:local` is a compatibility alias for the safe `fonts:update` plan. Apply an update only with the explicit `--ref`, `--apply`, `--confirm`, and reviewed `--plan-fingerprint` shown above.

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
