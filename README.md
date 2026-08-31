# nerd-fonts-woff2

[![npm license.](https://flat.badgen.net/npm/license/nerd-fonts-woff2?color=purple)](https://github.com/Nick2bad4u/nerd-fonts-woff2/blob/main/LICENSE) [![npm total downloads.](https://flat.badgen.net/npm/dt/nerd-fonts-woff2?color=pink)](https://www.npmjs.com/package/nerd-fonts-woff2) [![latest GitHub release.](https://flat.badgen.net/github/release/Nick2bad4u/nerd-fonts-woff2?color=cyan)](https://github.com/Nick2bad4u/nerd-fonts-woff2/releases) [![GitHub stars.](https://flat.badgen.net/github/stars/Nick2bad4u/nerd-fonts-woff2?color=yellow)](https://github.com/Nick2bad4u/nerd-fonts-woff2/stargazers) [![GitHub forks.](https://flat.badgen.net/github/forks/Nick2bad4u/nerd-fonts-woff2?color=green)](https://github.com/Nick2bad4u/nerd-fonts-woff2/forks) [![GitHub open issues.](https://flat.badgen.net/github/open-issues/Nick2bad4u/nerd-fonts-woff2?color=red)](https://github.com/Nick2bad4u/nerd-fonts-woff2/issues) [![codecov.](https://flat.badgen.net/codecov/github/Nick2bad4u/nerd-fonts-woff2?color=blue)](https://codecov.io/gh/Nick2bad4u/nerd-fonts-woff2)

Ready-to-use **Nerd Fonts in WOFF2 format** — use them in any website or app via CDN link, or install them through npm.

No build step needed. No tools to install. Just copy a URL.

> Fonts are generated from [Nerd Fonts v3.5.1](https://github.com/ryanoasis/nerd-fonts/releases/tag/v3.5.1)
> and published to the generated `main` branch as a rolling latest catalog.

---

## Quick start — add a font to your website

Pick any font from the [available families](#available-font-families) below and add a `@font-face` rule to your CSS.

### Rolling jsDelivr URL

```css
@font-face {
 font-family: "JetBrains Mono Nerd";
 src: url("https://cdn.jsdelivr.net/gh/Nick2bad4u/nerd-fonts-woff2@main/fonts/woff2/JetBrainsMono/JetBrainsMonoNerdFont-Regular.woff2")
  format("woff2");
 font-display: swap;
}
```

Then use it in your CSS:

```css
body {
 font-family: "JetBrains Mono Nerd", monospace;
}
```

### Raw GitHub URL

```css
@font-face {
 font-family: "JetBrains Mono Nerd";
 src: url("https://raw.githubusercontent.com/Nick2bad4u/nerd-fonts-woff2/main/fonts/woff2/JetBrainsMono/JetBrainsMonoNerdFont-Regular.woff2")
  format("woff2");
 font-display: swap;
}
```

`main` is intentionally mutable: it changes whenever a verified catalog is published. jsDelivr caches explicit branch URLs for approximately 12 hours, so a completed publication may not appear there immediately. Do not use `@latest`, an unversioned jsDelivr URL, or a code-release tag for fonts. `@latest` follows semver tags and may be cached for up to seven days.

The catalog is larger than jsDelivr's default 150 MB GitHub-package limit, so jsDelivr access is best-effort. Use the Raw GitHub `main` URL above as the supported fallback. See jsDelivr's [cache behavior](https://github.com/jsdelivr/jsdelivr#caching) and [package-size restriction](https://github.com/jsdelivr/jsdelivr#restrictions).

---

## URL pattern

All font files follow this pattern:

```text
https://cdn.jsdelivr.net/gh/Nick2bad4u/nerd-fonts-woff2@main/fonts/woff2/<Family>/<FileName>.woff2
```

| Part         | Example                         |
| ------------ | ------------------------------- |
| Branch       | `main`                          |
| `<Family>`   | `JetBrainsMono`                 |
| `<FileName>` | `JetBrainsMonoNerdFont-Regular` |

Find available files by browsing the [`fonts/woff2/`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2) folder on the generated distribution branch, or see the [rolling asset index](https://raw.githubusercontent.com/Nick2bad4u/nerd-fonts-woff2/main/fonts/woff2/index.json).

You can also browse the rolling searchable catalog on [GitHub Pages](https://nick2bad4u.github.io/nerd-fonts-woff2/). Pages is a best-effort surface for this multi-gigabyte snapshot; use the Raw GitHub index if GitHub declines to deploy it.

---

## Install via npm

The npm package ships the **CLI conversion tool only** — font files are not bundled.
To use fonts in a website or app, use the CDN URLs above (no install needed).

```bash
npm install nerd-fonts-woff2
# or globally
npm install -g nerd-fonts-woff2
```

Package size: **\~86 KB unpacked** (just the CLI binary + compiled JS).

> The fonts themselves are served from the rolling `main` distribution branch through Raw GitHub, with jsDelivr available on a best-effort basis.
> Bundling 7 GB of binary font files into npm would be impractical — use a CDN URL instead.

---

## Maintainer font update workflow

Repository development happens on the default `source` branch. `fonts/original/**` and `fonts/woff2/**` are generated and ignored there. The `main` branch is a generated, parentless distribution snapshot containing the exact `source` tree plus the verified WOFF2 catalog. Never create ordinary commits or pull requests against `main`.

For future catalog updates, the guided end-to-end command is:

```bash
npm run fonts:refresh:latest
```

It runs the reviewed upstream update, verifies the catalog, executes the repository gates, permits only the expected README/provenance source commit, displays a deterministic publication fingerprint before any push, pushes `source`, and invokes the resumable rolling publisher. It never publishes npm.

The low-level publisher plans by default. Apply only the exact reviewed fingerprint:

```bash
npm run fonts:publish:latest
npm run -- fonts:publish:latest -- --apply --confirm --plan-fingerprint <sha256>
npm run fonts:publish:resume
```

The publisher uploads conservative seed chunks under temporary `upload/font-catalog/...` branches, reconstructs the reviewed tree from bounded per-family Git database requests, and creates the exact reviewed parentless commit under an ownership-checked temporary final ref. It then installs that snapshot with `--force-with-lease`, verifies Raw GitHub metadata/index/font samples, and removes every temporary publication ref. The Git database writes are paced to avoid burst-rate failures, and the returned WOFF2 tree, distribution tree, commit, and ref must all match the reviewed plan before `main` can change. If `main` committed but verification or cleanup failed, the journal reports `committed: true` and `cleanupPending: true`; rerun `npm run fonts:publish:resume`. A lease conflict is never overwritten. Publishing requires a local, non-UNC worktree, authenticated GitHub CLI access with Contents write permission, and a temporary transaction directory on the same volume as the canonical catalog.

The one-time branch/history migration is also plan-first and fingerprint gated:

```bash
npm run repo:migrate:rolling-latest
npm run -- repo:migrate:rolling-latest -- --apply --confirm --plan-fingerprint <sha256>
```

The migration creates and verifies a local Git bundle under ignored `temp/repository-backups/` before changing remote refs or settings. Keep that bundle until the new `source` and `main` branches have been independently verified.

For machine-readable planning, invoke Node directly so stdout is exactly one JSON object:

```powershell
$stdoutFile = New-TemporaryFile
$stderrFile = New-TemporaryFile
& node .\scripts\publish-latest-fonts.mjs --json --no-color 1> $stdoutFile 2> $stderrFile
$nativeExitCode = $LASTEXITCODE

if ($nativeExitCode -ne 0) {
    $diagnostics = Get-Content -Raw $stderrFile
    throw "Rolling font publication failed with exit code $nativeExitCode.`n$diagnostics"
}

$plan = Get-Content -Raw $stdoutFile | ConvertFrom-Json -Depth 64
```

Capture `$LASTEXITCODE` before parsing JSON. Diagnostic progress and child output stay on stderr.

For the normal interactive workflow, run one command:

```bash
npm run fonts:update:guided
```

The guided workflow checks the live release and prerequisites, saves the complete reviewed identity under `temp/nerd-fonts-update/reviewed-plan.json`, prints the plan and checksum-manifest SHA-256 values, and asks you to type the complete plan fingerprint. Pressing Enter cancels safely. A matching fingerprint invokes the hardened updater with `--apply`, `--confirm`, and the saved fingerprint; apply still revalidates GitHub under the lock and enforces the dirty-tree, downgrade, checksum, transaction, and recovery safeguards.

For a review and apply split across terminals or maintenance windows:

```bash
npm run -- fonts:update:review -- --ref v3.5.1 --verbose
npm run -- fonts:update:apply -- --confirm --verbose
```

The apply command validates that the saved plan file was not edited and then revalidates the entire upstream identity. A saved fingerprint is never treated as permanent authorization. `--plan-file <repository-local-path>` can isolate multiple reviewed plans when needed.

If conversion stops after the reviewed sources were staged, resume only the missing, invalid, or failed outputs with:

```bash
npm run fonts:update:resume
```

Resume mode requires the saved reviewed plan and exact matching staged source metadata. It preserves valid staged WOFF2 files, checks their timestamp, complete header, `wOF2` signature, and declared file length, converts only the remainder, rebuilds the complete index, and runs the normal full-catalog verifier before promotion. It refuses to fall back to a full conversion when no reusable outputs are present. A normal apply intentionally clears staging; use the resume command first when retaining completed work matters.

The lower-level updater remains available for automation and troubleshooting. Check the latest stable Nerd Fonts release and produce a non-mutating update plan:

```bash
npm run fonts:update
```

The plan reports the current generated ref, target tag and commit, exact release/asset IDs and SHA-256 values, compressed download size, and a canonical plan fingerprint. Apply mode re-fetches that identity while holding the repository lock and refuses if any reviewed asset changed. After reviewing the generated command:

```bash
npm run -- fonts:update -- --ref v3.5.1 --apply --confirm --plan-fingerprint <sha256-from-plan>
```

Add `--verbose` to keep a durable stage bar, exact child commands, elapsed timings, and the downloader/converter counters visible during the long-running update:

```bash
npm run -- fonts:update -- --ref v3.5.1 --apply --confirm --plan-fingerprint <sha256-from-plan> --verbose
```

Updater stage diagnostics are written to stderr. In `--json` mode, child-process output is streamed to stderr and stdout is exactly one JSON document on both success and failure. During a normal interactive conversion, verbose mode prints the exact repository-relative font path at worker start and completion, a `completed/total` count, percentage, overall bar, active-worker count, detailed phase timings, and output size. ANSI colors are detected automatically for interactive terminals; use `--color` to force them, `--no-color` to disable them, or the standard `NO_COLOR` environment variable to disable automatic color. Progress uses persistent lines rather than cursor-control animation, which keeps PowerShell transcripts and CI logs readable.

Conversions run in a fixed pool of isolated child processes. The updater defaults to four workers and a 1,200-second per-font timeout. Each process loads the native `ttf2woff2` module once and then processes fonts sequentially; later jobs report `worker #N reused; module cached`. The first job reports process bootstrap as `worker`, native-module loading as `module`, then every completed job reports `read`, quality-11 WOFF2 `convert`, `write` (including output-directory creation), IPC/runtime `overhead`, and end-to-end `total`; a measurable internal queue wait is reported separately. An ordinary font error does not discard a healthy worker. A timeout, IPC failure, or process crash fails only the affected font, terminates that process, and creates a replacement for later work. Process isolation ensures a native crash or hard hang cannot take down the coordinator.

Only timeouts receive automatic retry passes. With the defaults, the updater retries timed-out fonts with two workers and a 1,800-second limit, then one worker and a 2,400-second limit. `--timeout-retries 0` disables these passes; the maximum is two. Ordinary conversion errors remain final immediately. Console failure details are capped, while every final failure is retained in `temp/nerd-fonts-update/<ref>/conversion-failures.json` for diagnosis and the next resume attempt.

The updater downloads the complete official `.tar.xz` release asset set, validates every archive against Nerd Fonts' `SHA-256.txt` and GitHub asset digests, rejects unsafe archive and repository paths, stages all source and WOFF2 output, verifies counts/signatures/index/provenance, and only then atomically promotes the assets and README as one journaled transaction. Recovery runs locally before GitHub is contacted. A same-ref apply is a no-op unless `--force-rebuild` is supplied; a newer installed ref supersedes an older request. Dirty changes under `README.md`, `fonts/original`, or `fonts/woff2` are refused unless `--allow-dirty` is explicit. `--convert` remains a deprecated updater alias for `--apply`.

For PowerShell automation, invoke Node directly, save the native exit code before parsing, and keep stderr separate:

```powershell
$stderrFile = Join-Path ([IO.Path]::GetTempPath()) "nerd-fonts-update.stderr.log"
$json = & node .\scripts\update-nerd-fonts.mjs --json --ref v3.5.1 2> $stderrFile
$nativeExitCode = $LASTEXITCODE
if ($nativeExitCode -ne 0) {
    throw "Nerd Fonts updater failed with exit code $nativeExitCode. See $stderrFile."
}
$plan = $json | ConvertFrom-Json -Depth 32
```

Updates require a local, non-UNC worktree; staging, transaction backups, and canonical trees must stay on the same volume. An active lock is never broken automatically. `--break-stale-lock` only permits recovery of an old malformed lock after confirming that no updater is running. A post-commit cleanup failure is reported as structured partial success with `committed: true` and is finished by the next apply. See [CONTRIBUTING.md](./CONTRIBUTING.md#local-asset-pipeline) for the low-level commands and recovery model.

---

## CLI usage

The CLI converts local TTF/OTF font files into WOFF2 format.

### Usage

```bash
npx nerd-fonts-woff2 --source-dir <path> [options]
# or if installed globally:
nerd-fonts-woff2 --source-dir <path> [options]
```

### Core options

| Flag                            | Description                                                  |
| ------------------------------- | ------------------------------------------------------------ |
| `--source-dir <path[,path...]>` | Source directory containing `.ttf`/`.otf` files (repeatable) |
| `--manifest <file>`             | JSON config file (optional alternative to CLI flags)         |
| `--out-dir <path>`              | Output directory for generated `.woff2` files                |
| `--temp-dir <path>`             | Temporary working directory                                  |
| `--include-ext <ttf,otf>`       | Input extensions to process (default: `ttf,otf`)             |
| `--max-files <n>`               | Limit number of files to process                             |

### Conversion options

| Flag                      | Description                                            |
| ------------------------- | ------------------------------------------------------ |
| `--convert`               | Run conversion pipeline (default mode is plan/dry-run) |
| `--dry-run`               | Plan only — do not call the external converter         |
| `--confirm`, `--yes`      | Required safety gate for non-dry-run conversion        |
| `--converter <cmd>`       | Converter executable (default: `woff2_compress`)       |
| `--converter-arg <value>` | Extra converter arguments (repeatable)                 |
| `--fail-fast`             | Stop on first conversion failure                       |
| `--concurrency <n>`       | Number of concurrent conversions (default: `1`)        |
| `--timeout <ms>`          | Per-file converter timeout in ms (default: `60000`)    |

### Output options

| Flag                  | Description                                              |
| --------------------- | -------------------------------------------------------- |
| `--index-file <path>` | Write asset index JSON (default: `<out-dir>/index.json`) |
| `--verbose`           | Print planned files and failures                         |
| `--debug`             | Enable debug output (implies `--verbose`)                |
| `--json`              | Emit machine-readable summary to stdout                  |
| `--help`              | Show help                                                |

### Examples

```bash
# Dry run — plan only, no files written (safe default)
npx nerd-fonts-woff2 --source-dir ./fonts/original --dry-run

# Convert with explicit safety confirmation
npx nerd-fonts-woff2 --source-dir ./fonts/original --convert --confirm

# Faster — 4 concurrent workers, 2 min timeout per file
npx nerd-fonts-woff2 --source-dir ./fonts/original --convert --confirm --concurrency 4 --timeout 120000

# Machine-readable JSON output + explicit index file path
npx nerd-fonts-woff2 --source-dir ./fonts/original --convert --confirm --json --index-file ./fonts/woff2/index.json

# Use a manifest config file instead of flags
npx nerd-fonts-woff2 --manifest ./nerd-fonts-woff2.config.json --convert --confirm --json

# Convert multiple source directories
npx nerd-fonts-woff2 --source-dir ./fonts/originals,./fonts/extras --convert --confirm
```

---

## Available font families

All families from [Nerd Fonts v3.5.1](https://github.com/ryanoasis/nerd-fonts/releases/tag/v3.5.1) are included.

Browse the full list in the [`fonts/woff2/`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2) directory on the generated `main` distribution branch, or search the [interactive browser](https://nick2bad4u.github.io/nerd-fonts-woff2/).

Popular families by `reserved font name` (see [Reserved Font Name mechanism](https://openfontlicense.org/webfonts-and-reserved-font-names/)).

For example, the `Monaspice Nerd Font` family is available as `Monaspace` in the URL path and file names:

![Font Name vs Reserved Font Name](assets/image.png)

| Family                                                                                                              | Preview Font                                                                            | Folder                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| [3270](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/3270.zip)                                   | [Preview Font](https://www.programmingfonts.org/#font3270)                              | [`3270`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/3270)                                   |
| [Agave](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/Agave.zip)                                 | [Preview Font](https://www.programmingfonts.org/#agave)                                 | [`Agave`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/Agave)                                 |
| [AnonymousPro](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/AnonymousPro.zip)                   | [Preview Font](https://www.programmingfonts.org/#anonymous-pro)                         | [`AnonymousPro`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/AnonymousPro)                   |
| [Arimo](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/Arimo.zip)                                 | [Preview Font](https://fonts.google.com/?query=arimo)                                   | [`Arimo`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/Arimo)                                 |
| [AurulentSansMono](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/AurulentSansMono.zip)           | [Preview Font](https://www.programmingfonts.org/#aurulent)                              | [`AurulentSansMono`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/AurulentSansMono)           |
| [BigBlueTerminal](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/BigBlueTerminal.zip)             | [Preview Font](https://www.programmingfonts.org/#bigblue-terminal)                      | [`BigBlueTerminal`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/BigBlueTerminal)             |
| [BitstreamVeraSansMono](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/BitstreamVeraSansMono.zip) | [Preview Font](https://www.programmingfonts.org/#bitstream-vera)                        | [`BitstreamVeraSansMono`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/BitstreamVeraSansMono) |
| [CascadiaCode](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/CascadiaCode.zip)                   | [Preview Font](https://www.programmingfonts.org/#cascadia-code)                         | [`CascadiaCode`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/CascadiaCode)                   |
| [CodeNewRoman](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/CodeNewRoman.zip)                   | [Preview Font](https://www.programmingfonts.org/#code-new-roman)                        | [`CodeNewRoman`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/CodeNewRoman)                   |
| [ComicShannsMono](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/ComicShannsMono.zip)             | [Preview Font](https://github.com/shannpersand/comic-shanns-mono)                       | [`ComicShannsMono`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/ComicShannsMono)             |
| [Cousine](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/Cousine.zip)                             | [Preview Font](https://www.programmingfonts.org/#cousine)                               | [`Cousine`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/Cousine)                             |
| [DaddyTimeMono](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/DaddyTimeMono.zip)                 | [Preview Font](https://www.programmingfonts.org/#daddytimemono)                         | [`DaddyTimeMono`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/DaddyTimeMono)                 |
| [DejaVuSansMono](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/DejaVuSansMono.zip)               | [Preview Font](https://www.programmingfonts.org/#dejavu)                                | [`DejaVuSansMono`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/DejaVuSansMono)               |
| [DroidSansMono](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/DroidSansMono.zip)                 | [Preview Font](https://www.programmingfonts.org/#droid-sans)                            | [`DroidSansMono`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/DroidSansMono)                 |
| [EnvyCodeR](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/EnvyCodeR.zip)                         | [Preview Font](https://www.programmingfonts.org/#envy-code-r)                           | [`EnvyCodeR`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/EnvyCodeR)                         |
| [FantasqueSansMono](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/FantasqueSansMono.zip)         | [Preview Font](https://www.programmingfonts.org/#fantasque-sans)                        | [`FantasqueSansMono`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/FantasqueSansMono)         |
| [FiraCode](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/FiraCode.zip)                           | [Preview Font](https://www.programmingfonts.org/#firacode)                              | [`FiraCode`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/FiraCode)                           |
| [FiraMono](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/FiraMono.zip)                           | [Preview Font](https://www.programmingfonts.org/#fira)                                  | [`FiraMono`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/FiraMono)                           |
| [Go-Mono](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/Go-Mono.zip)                             | [Preview Font](https://www.programmingfonts.org/#go-mono)                               | [`Go-Mono`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/Go-Mono)                             |
| [Gohu](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/Gohu.zip)                                   | [Preview Font](https://www.programmingfonts.org/#gohufont-14)                           | [`Gohu`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/Gohu)                                   |
| [Hack](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/Hack.zip)                                   | [Preview Font](https://www.programmingfonts.org/#hack)                                  | [`Hack`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/Hack)                                   |
| [Hasklig](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/Hasklig.zip)                             | [Preview Font](https://www.programmingfonts.org/#hasklig)                               | [`Hasklig`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/Hasklig)                             |
| [HeavyData](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/HeavyData.zip)                         | [Preview Font](https://github.com/soji-omori/HeavyData-font)                            | [`HeavyData`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/HeavyData)                         |
| [Hermit](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/Hermit.zip)                               | [Preview Font](https://www.programmingfonts.org/#hermit)                                | [`Hermit`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/Hermit)                               |
| [iA-Writer](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/iA-Writer.zip)                         | [Preview Font](https://www.programmingfonts.org/#ia-writer-mono)                        | [`iA-Writer`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/iA-Writer)                         |
| [IBMPlexMono](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/IBMPlexMono.zip)                     | [Preview Font](https://www.programmingfonts.org/#plex-mono)                             | [`IBMPlexMono`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/IBMPlexMono)                     |
| [Inconsolata](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/Inconsolata.zip)                     | [Preview Font](https://www.programmingfonts.org/#inconsolata)                           | [`Inconsolata`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/Inconsolata)                     |
| [InconsolataGo](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/InconsolataGo.zip)                 | [Preview Font](https://www.programmingfonts.org/#inconsolata-go)                        | [`InconsolataGo`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/InconsolataGo)                 |
| [InconsolataLGC](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/InconsolataLGC.zip)               | [Preview Font](https://www.programmingfonts.org/#inconsolata)                           | [`InconsolataLGC`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/InconsolataLGC)               |
| [Iosevka](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/Iosevka.zip)                             | [Preview Font](https://www.programmingfonts.org/#iosevka)                               | [`Iosevka`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/Iosevka)                             |
| [IosevkaTerm](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/IosevkaTerm.zip)                     | [Preview Font](https://www.programmingfonts.org/#iosevka)                               | [`IosevkaTerm`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/IosevkaTerm)                     |
| [JetBrainsMono](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/JetBrainsMono.zip)                 | [Preview Font](https://www.programmingfonts.org/#jetbrainsmono)                         | [`JetBrainsMono`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/JetBrainsMono)                 |
| [Lekton](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/Lekton.zip)                               | [Preview Font](https://www.programmingfonts.org/#lekton)                                | [`Lekton`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/Lekton)                               |
| [LiberationMono](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/LiberationMono.zip)               | [Preview Font](https://www.programmingfonts.org/#liberation)                            | [`LiberationMono`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/LiberationMono)               |
| [Lilex](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/Lilex.zip)                                 | [Preview Font](https://www.programmingfonts.org/#lilex)                                 | [`Lilex`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/Lilex)                                 |
| [Meslo](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/Meslo.zip)                                 | [Preview Font](https://www.programmingfonts.org/#meslo)                                 | [`Meslo`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/Meslo)                                 |
| [Monofur](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/Monofur.zip)                             | [Preview Font](https://www.programmingfonts.org/#monofur)                               | [`Monofur`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/Monofur)                             |
| [Monoid](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/Monoid.zip)                               | [Preview Font](https://www.programmingfonts.org/#monoid)                                | [`Monoid`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/Monoid)                               |
| [Mononoki](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/Mononoki.zip)                           | [Preview Font](https://www.programmingfonts.org/#mononoki)                              | [`Mononoki`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/Mononoki)                           |
| [MPlus](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/MPlus.zip)                                 | [Preview Font](https://www.programmingfonts.org/#mplus)                                 | [`MPlus`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/MPlus)                                 |
| [NerdFontsSymbolsOnly](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/NerdFontsSymbolsOnly.zip)   | [Preview Font](https://github.com/ryanoasis/nerd-fonts/wiki/Glyph-Sets-and-Code-Points) | [`NerdFontsSymbolsOnly`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/NerdFontsSymbolsOnly)   |
| [Noto](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/Noto.zip)                                   | [Preview Font](https://www.programmingfonts.org/#noto)                                  | [`Noto`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/Noto)                                   |
| [OpenDyslexic](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/OpenDyslexic.zip)                   | [Preview Font](https://www.programmingfonts.org/#opendyslexic)                          | [`OpenDyslexic`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/OpenDyslexic)                   |
| [Overpass](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/Overpass.zip)                           | [Preview Font](https://www.programmingfonts.org/#overpass)                              | [`Overpass`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/Overpass)                           |
| [ProFont](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/ProFont.zip)                             | [Preview Font](https://www.programmingfonts.org/#profont)                               | [`ProFont`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/ProFont)                             |
| [ProggyClean](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/ProggyClean.zip)                     | [Preview Font](https://www.programmingfonts.org/#proggy-clean)                          | [`ProggyClean`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/ProggyClean)                     |
| [RobotoMono](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/RobotoMono.zip)                       | [Preview Font](https://www.programmingfonts.org/#roboto)                                | [`RobotoMono`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/RobotoMono)                       |
| [ShareTechMono](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/ShareTechMono.zip)                 | [Preview Font](https://www.programmingfonts.org/#share-tech)                            | [`ShareTechMono`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/ShareTechMono)                 |
| [SourceCodePro](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/SourceCodePro.zip)                 | [Preview Font](https://www.programmingfonts.org/#source-code-pro)                       | [`SourceCodePro`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/SourceCodePro)                 |
| [SpaceMono](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/SpaceMono.zip)                         | [Preview Font](https://www.programmingfonts.org/#space)                                 | [`SpaceMono`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/SpaceMono)                         |
| [Terminus](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/Terminus.zip)                           | [Preview Font](https://www.programmingfonts.org/#terminus)                              | [`Terminus`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/Terminus)                           |
| [Tinos](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/Tinos.zip)                                 | [Preview Font](https://fonts.google.com/?query=tinos)                                   | [`Tinos`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/Tinos)                                 |
| [Ubuntu](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/Ubuntu.zip)                               | [Preview Font](https://fonts.google.com/?query=ubuntu)                                  | [`Ubuntu`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/Ubuntu)                               |
| [UbuntuMono](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/UbuntuMono.zip)                       | [Preview Font](https://www.programmingfonts.org/#ubuntu)                                | [`UbuntuMono`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/UbuntuMono)                       |
| [VictorMono](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/VictorMono.zip)                       | [Preview Font](https://www.programmingfonts.org/#victor-mono)                           | [`VictorMono`](https://github.com/Nick2bad4u/nerd-fonts-woff2/tree/main/fonts/woff2/VictorMono)                       |

## What are Nerd Fonts?

[Nerd Fonts](https://www.nerdfonts.com/) patches developer-targeted fonts with a large number of glyphs (icons) from popular icon sets — including Devicons, Font Awesome, Material Design Icons, and plenty of others.

They are widely used in terminal emulators, code editors, and shell prompts (Starship, Oh-My-Zsh, Powerlevel10k, etc.).

---

## Releases and versioning

GitHub Releases and npm versions describe the CLI/tooling on `source`; they do not freeze a font catalog. The only supported font generation is the current rolling `main` snapshot.

Exact historical tag URLs are not guaranteed. Content already cached by jsDelivr may remain available outside the repository owner's control, but consumers must not depend on it.

---

## License

Fonts are distributed under their respective upstream licenses (see each family's source in [Nerd Fonts](https://github.com/ryanoasis/nerd-fonts)).
This project's tooling and scripts are licensed under the [MIT License](./LICENSE).

---

## Links

- [Releases](https://github.com/Nick2bad4u/nerd-fonts-woff2/releases)
- [npm package](https://www.npmjs.com/package/nerd-fonts-woff2)
- [Rolling asset index](https://raw.githubusercontent.com/Nick2bad4u/nerd-fonts-woff2/main/fonts/woff2/index.json)
- [Nerd Fonts upstream](https://github.com/ryanoasis/nerd-fonts)
- [Contributing](./CONTRIBUTING.md)
- [Security](./SECURITY.md)
- [Developer guide](./CONTRIBUTING.md#in-depth-developer-documentation)

## Contributors ✨

<!-- ALL-CONTRIBUTORS-BADGE:START - Do not remove or modify this section -->

[![All Contributors.](https://img.shields.io/badge/all_contributors-5-orange.svg?style=flat-square)](#contributors-)

<!-- ALL-CONTRIBUTORS-BADGE:END -->

Thanks goes to these wonderful people ([emoji key](https://allcontributors.org/docs/en/emoji-key)):

<!-- ALL-CONTRIBUTORS-LIST:START - Do not remove or modify this section -->

<!-- prettier-ignore-start -->

<!-- markdownlint-disable -->

<table>
  <tbody>
    <tr>
      <td align="center" valign="top" width="25%"><a href="https://github.com/Nick2bad4u"><img src="https://avatars.githubusercontent.com/u/20943337?v=4?s=80" width="80px;" alt="Nick2bad4u"/><br /><sub><b>Nick2bad4u</b></sub></a><br /><a href="https://github.com/Nick2bad4u/nerd-fonts-woff2/issues?q=author%3ANick2bad4u" title="Bug reports">🐛</a> <a href="https://github.com/Nick2bad4u/nerd-fonts-woff2/commits?author=Nick2bad4u" title="Code">💻</a> <a href="https://github.com/Nick2bad4u/nerd-fonts-woff2/commits?author=Nick2bad4u" title="Documentation">📖</a> <a href="#ideas-Nick2bad4u" title="Ideas, Planning, & Feedback">🤔</a> <a href="#infra-Nick2bad4u" title="Infrastructure (Hosting, Build-Tools, etc)">🚇</a> <a href="#maintenance-Nick2bad4u" title="Maintenance">🚧</a> <a href="https://github.com/Nick2bad4u/nerd-fonts-woff2/pulls?q=is%3Apr+reviewed-by%3ANick2bad4u" title="Reviewed Pull Requests">👀</a> <a href="https://github.com/Nick2bad4u/nerd-fonts-woff2/commits?author=Nick2bad4u" title="Tests">⚠️</a> <a href="#tool-Nick2bad4u" title="Tools">🔧</a></td>
      <td align="center" valign="top" width="25%"><a href="https://snyk.io/"><img src="https://avatars.githubusercontent.com/u/19733683?v=4?s=80" width="80px;" alt="Snyk bot"/><br /><sub><b>Snyk bot</b></sub></a><br /><a href="#security-snyk-bot" title="Security">🛡️</a> <a href="#infra-snyk-bot" title="Infrastructure (Hosting, Build-Tools, etc)">🚇</a> <a href="#maintenance-snyk-bot" title="Maintenance">🚧</a> <a href="https://github.com/Nick2bad4u/nerd-fonts-woff2/pulls?q=is%3Apr+reviewed-by%3Asnyk-bot" title="Reviewed Pull Requests">👀</a></td>
      <td align="center" valign="top" width="25%"><a href="https://www.stepsecurity.io/"><img src="https://avatars.githubusercontent.com/u/89328645?v=4?s=80" width="80px;" alt="StepSecurity Bot"/><br /><sub><b>StepSecurity Bot</b></sub></a><br /><a href="#security-step-security-bot" title="Security">🛡️</a> <a href="#infra-step-security-bot" title="Infrastructure (Hosting, Build-Tools, etc)">🚇</a> <a href="#maintenance-step-security-bot" title="Maintenance">🚧</a></td>
      <td align="center" valign="top" width="25%"><a href="https://github.com/apps/dependabot"><img src="https://avatars.githubusercontent.com/in/29110?v=4?s=80" width="80px;" alt="dependabot[bot]"/><br /><sub><b>dependabot[bot]</b></sub></a><br /><a href="#infra-dependabot[bot]" title="Infrastructure (Hosting, Build-Tools, etc)">🚇</a> <a href="#security-dependabot[bot]" title="Security">🛡️</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="25%"><a href="https://github.com/apps/github-actions"><img src="https://avatars.githubusercontent.com/in/15368?v=4?s=80" width="80px;" alt="github-actions[bot]"/><br /><sub><b>github-actions[bot]</b></sub></a><br /><a href="https://github.com/Nick2bad4u/nerd-fonts-woff2/commits?author=github-actions[bot]" title="Code">💻</a> <a href="#infra-github-actions[bot]" title="Infrastructure (Hosting, Build-Tools, etc)">🚇</a></td>
    </tr>
  </tbody>
</table>

<!-- markdownlint-restore -->

<!-- prettier-ignore-end -->

<!-- ALL-CONTRIBUTORS-LIST:END -->
