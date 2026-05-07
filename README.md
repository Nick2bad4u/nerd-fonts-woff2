# nerd-font-woff2

`nerd-font-woff2` is a TypeScript CLI project for building WOFF2 font assets from local TTF/OTF source files.

Primary use case: download Nerd Fonts sources locally, convert them into a committed WOFF2 asset tree, and publish those committed assets for raw GitHub/jsDelivr consumption.

## Current project scope

- Recursively scan one or more source directories for `.ttf` / `.otf` files.
- Build a deterministic conversion plan (dry-run by default).
- Convert files using an external WOFF2 converter command (for example `woff2_compress`).
- Generate an optional JSON asset index for downstream upload/publishing automation.

## Distribution strategy (npm vs URL)

Both approaches are valid, and this project is now set up for either:

- **Primary runtime delivery (recommended):** serve committed WOFF2 files via raw GitHub + jsDelivr URLs.
- **Optional package delivery:** publish this repo to npm so consumers can pin a version and access bundled assets.

For browser usage, URL delivery is usually simplest. npm is useful when teams want version pinning through package managers or local bundling workflows.

### Committed asset delivery (raw GitHub)

This repo is configured to keep generated fonts committed under `fonts/woff2/**` so they can be consumed directly from tags.

Raw URL pattern:

```text
https://raw.githubusercontent.com/Nick2bad4u/nerd-fonts-woff2/vX.Y.Z/fonts/woff2/<family>/<file>.woff2
```

Use tagged versions (`vX.Y.Z`) for stable links.

## Requirements

- Node.js `>=22.18.0`
- A WOFF2 converter executable available locally (default command: `woff2_compress`)

## Install (local development)

```bash
npm install
```

## Local-only asset workflow (not CI)

Asset fetching/conversion is intentionally a **local** operation. The repository does not run bulk font downloads on CI.

### Directory layout

- Source fonts: `fonts/original/**` (`.ttf` / `.otf`)
- Converted output: `fonts/woff2/**` (`.woff2`)
- Generated index: `fonts/woff2/index.json`

### 1) Download all Nerd Fonts sources

```bash
npm run fonts:download
```

This performs a sparse clone of `ryanoasis/nerd-fonts` and copies `patched-fonts/**` into `fonts/original/**`.

Default source ref is pinned to `v3.4.0` for reproducibility. You can override it:

```bash
npm run fonts:download -- --ref v3.5.0
```

### 2) Build WOFF2 assets for all source families

```bash
npm run fonts:convert
```

By default, conversion uses `woff2_compress` from your PATH. Install Google WOFF2 tools locally before conversion, or pass a custom converter:

```bash
npm run fonts:convert -- --converter woff2_compress
```

### 3) Verify generated assets

```bash
npm run fonts:verify
```

### One-shot local pipeline

```bash
npm run fonts:local
```

### Preview conversion plan without writing files

```bash
npm run fonts:plan
```

## npm packaging status

- Package metadata includes `bin` entry `nerd-font-woff2`.
- `prepack` runs `npm run build` so published tarballs include compiled `dist/` output.
- Published files are restricted to runtime essentials (`dist/`, `assets/`, wrapper, README, LICENSE).
- Release workflow validates that committed assets exist before creating a release.

Run `npm pack` to verify package contents before publish.

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

## Using published files

### Raw GitHub

```css
@font-face {
  font-family: "JetBrains Mono Nerd";
  src: url("https://raw.githubusercontent.com/Nick2bad4u/nerd-fonts-woff2/v1.0.0/fonts/woff2/JetBrainsMono/JetBrainsMonoNerdFont-Regular.woff2") format("woff2");
  font-display: swap;
}
```

### jsDelivr (GitHub CDN)

```css
@font-face {
  font-family: "JetBrains Mono Nerd";
  src: url("https://cdn.jsdelivr.net/gh/Nick2bad4u/nerd-fonts-woff2@v1.0.0/fonts/woff2/JetBrainsMono/JetBrainsMonoNerdFont-Regular.woff2") format("woff2");
  font-display: swap;
}
```

### npm package asset reference

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

const fontPath = join(
  process.cwd(),
  "node_modules",
  "nerd-font-woff2",
  "fonts",
  "woff2",
  "JetBrainsMono",
  "JetBrainsMonoNerdFont-Regular.woff2"
);

const fontBuffer = readFileSync(fontPath);
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
  "sourceDirs": ["./fonts/original"],
  "outDir": "./fonts/woff2",
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

## Commit generated assets

```bash
git add fonts/woff2
git commit -m "Update generated WOFF2 assets"
```

## Development checks

```bash
npm run build
npm run typecheck
npm run lint
npm test
npm run test:coverage
```
