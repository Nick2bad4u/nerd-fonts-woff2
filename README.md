# nerd-font-woff2

`nerd-font-woff2` is a TypeScript CLI project for building WOFF2 font assets from local TTF/OTF source files.

Primary use case: convert Nerd Fonts releases into a clean WOFF2 asset tree that can be published to GitHub Releases and consumed through jsDelivr.

## Current project scope

- Recursively scan one or more source directories for `.ttf` / `.otf` files.
- Build a deterministic conversion plan (dry-run by default).
- Convert files using an external WOFF2 converter command (for example `woff2_compress`).
- Generate an optional JSON asset index for downstream upload/publishing automation.

## Distribution strategy (npm vs URL)

Both approaches are valid, and this project is now set up for either:

- **Primary runtime delivery (recommended):** serve built WOFF2 files via GitHub Releases + jsDelivr URLs.
- **Optional package delivery:** publish this repo to npm so consumers can pin a version and access bundled assets.

For browser usage, URL delivery is usually simplest. npm is useful when teams want version pinning through package managers or local bundling workflows.

### Committed asset delivery (raw GitHub)

This repo is configured to keep generated fonts committed under `assets/woff2/**` so they can be consumed directly from git tags.

Raw URL pattern:

```text
https://raw.githubusercontent.com/Nick2bad4u/nerd-fonts-woff2/vX.Y.Z/assets/woff2/<family>/<file>.woff2
```

Use tagged versions (`vX.Y.Z`) for stable links.

## Requirements

- Node.js `>=22.18.0`
- A WOFF2 converter executable available locally (default command: `woff2_compress`)

## Install (local development)

```bash
npm install
```

## npm packaging status

- Package metadata includes `bin` entry `nerd-font-woff2`.
- `prepack` runs `npm run build` so published tarballs include compiled `dist/` output.
- Published files are restricted to runtime essentials (`dist/`, `assets/`, wrapper, README, LICENSE).
- Release workflow validates that committed assets exist in `assets/woff2` before creating a release.

> Note: the package is currently marked `"private": true` to prevent accidental publish during active development.
> When you're ready, set `"private": false`, run `npm pack` to verify contents, then publish.

## Usage

### Plan only (safe default)

```bash
node ./src/cli.ts --source-dir ./temp/nerd-fonts --dry-run
```

or via package command:

```bash
npx nerd-font-woff2 --source-dir ./temp/nerd-fonts --dry-run
```

### Convert files

```bash
node ./src/cli.ts --source-dir ./temp/nerd-fonts --convert --confirm
```

### Convert with JSON summary and index file

```bash
node ./src/cli.ts \
  --source-dir ./temp/nerd-fonts \
  --convert \
  --confirm \
  --index-file ./temp/font-index.json \
  --json
```

### Use manifest file

```bash
node ./src/cli.ts --manifest ./nerd-font-woff2.config.json --convert --confirm
```

Example manifest:

```json
{
  "sourceDirs": ["./temp/nerd-fonts"],
  "outDir": "./assets/woff2",
  "tempDir": "./temp/work",
  "converter": "woff2_compress",
  "converterArgs": [],
  "includeExts": ["ttf", "otf"],
  "indexFile": "./temp/font-index.json"
}
```

## CLI options

- `--source-dir <path[,path...]>` (repeatable)
- `--manifest <file>`
- `--out-dir <path>`
- `--temp-dir <path>`
- `--include-ext <ttf,otf>`
- `--max-files <n>`
- `--convert`
- `--dry-run`
- `--confirm` / `--yes`
- `--converter <cmd>`
- `--converter-arg <value>` (repeatable)
- `--fail-fast`
- `--index-file <path>`
- `--verbose`
- `--json`
- `--help`

## Exit codes

- `0`: success
- `1`: validation/runtime/dependency error
- `2`: partial conversion failure (one or more files failed)

## Planned next steps

- Add source acquisition commands for Nerd Fonts upstream archives/releases.
- Add publish commands for GitHub Release assets.
- Add jsDelivr-friendly manifest generation and versioned output layout.

## Development checks

```bash
npm run build
npm run typecheck
npm run lint
npm test
```
