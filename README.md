# nerd-font-woff2

[![npm license.](https://flat.badgen.net/npm/license/nerd-fonts-woff2?color=purple)](https://github.com/Nick2bad4u/nerd-fonts-woff2/blob/main/LICENSE) [![npm total downloads.](https://flat.badgen.net/npm/dt/nerd-fonts-woff2?color=pink)](https://www.npmjs.com/package/nerd-fonts-woff2) [![latest GitHub release.](https://flat.badgen.net/github/release/Nick2bad4u/nerd-fonts-woff2?color=cyan)](https://github.com/Nick2bad4u/nerd-fonts-woff2/releases) [![GitHub stars.](https://flat.badgen.net/github/stars/Nick2bad4u/nerd-fonts-woff2?color=yellow)](https://github.com/Nick2bad4u/nerd-fonts-woff2/stargazers) [![GitHub forks.](https://flat.badgen.net/github/forks/Nick2bad4u/nerd-fonts-woff2?color=green)](https://github.com/Nick2bad4u/nerd-fonts-woff2/forks) [![GitHub open issues.](https://flat.badgen.net/github/open-issues/Nick2bad4u/nerd-fonts-woff2?color=red)](https://github.com/Nick2bad4u/nerd-fonts-woff2/issues) [![codecov.](https://flat.badgen.net/codecov/github/Nick2bad4u/nerd-fonts-woff2?color=blue)](https://codecov.io/gh/Nick2bad4u/nerd-fonts-woff2)

Ready-to-use **Nerd Fonts in WOFF2 format** — use them in any website or app via CDN link, or install them through npm.

No build step needed. No tools to install. Just copy a URL.

> Fonts are generated from [Nerd Fonts v3.4.0](https://github.com/ryanoasis/nerd-fonts/releases/tag/v3.4.0)
> and committed directly to this repository so they can be served from a stable CDN URL.

---

## Quick start — add a font to your website

Pick any font from the [available families](#available-font-families) below and add a `@font-face` rule to your CSS.

### jsDelivr CDN (recommended — global CDN, fast, always available)

```css
@font-face {
  font-family: "JetBrains Mono Nerd";
  src: url("https://cdn.jsdelivr.net/gh/Nick2bad4u/nerd-fonts-woff2@v1.0.0/fonts/woff2/JetBrainsMono/JetBrainsMonoNerdFont-Regular.woff2")
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
  src: url("https://raw.githubusercontent.com/Nick2bad4u/nerd-fonts-woff2/v1.0.0/fonts/woff2/JetBrainsMono/JetBrainsMonoNerdFont-Regular.woff2")
    format("woff2");
  font-display: swap;
}
```

> **Tip:** Always pin a version tag (`v1.0.0`) rather than using `main` so your fonts never change unexpectedly.

---

## URL pattern

All font files follow this pattern:

```text
https://cdn.jsdelivr.net/gh/Nick2bad4u/nerd-fonts-woff2@<version>/fonts/woff2/<Family>/<FileName>.woff2
```

| Part         | Example                         |
| ------------ | ------------------------------- |
| `<version>`  | `v1.0.0`                        |
| `<Family>`   | `JetBrainsMono`                 |
| `<FileName>` | `JetBrainsMonoNerdFont-Regular` |

Find available files by browsing the [`fonts/woff2/`](./fonts/woff2) folder in this repository, or see the full [asset index](./fonts/woff2/index.json).

You can also browse a searchable index page on GitHub Pages: [`/index.html`](./index.html)

---

## Install via npm

If you use a bundler (Webpack, Vite, etc.) or a Node.js project, you can install the fonts as an npm package:

```bash
npm install nerd-font-woff2
```

Then reference the files from `node_modules`:

```css
/* Vite / webpack — import the font file directly */
@font-face {
  font-family: "JetBrains Mono Nerd";
  src: url("nerd-font-woff2/fonts/woff2/JetBrainsMono/JetBrainsMonoNerdFont-Regular.woff2")
    format("woff2");
  font-display: swap;
}
```

Or read them in Node.js:

```js
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkgDir = join(require.resolve("nerd-font-woff2/package.json"), "..");
const fontBuffer = readFileSync(
  join(pkgDir, "fonts", "woff2", "JetBrainsMono", "JetBrainsMonoNerdFont-Regular.woff2")
);
```

---

## CLI usage

### Usage

```bash
npx nerd-font-woff2 --source-dir ./fonts/original [options]
```

### Execution flags

- `--convert` enable conversion mode (default is plan mode)
- `--confirm` / `--yes` required safety gate for non-dry-run conversion
- `--dry-run` plan only, no conversion writes
- `--concurrency <n>` max parallel conversions (default: `1`)
- `--timeout <ms>` per-file converter timeout (default: `60000` / `60s`)
- `--index-file <path>` output index file path (default: `<out-dir>/index.json`)
- `--verbose` more detailed progress output
- `--debug` debug output (implies `--verbose`)
- `--json` machine-readable summary output

### Examples

```bash
# Plan only (safe default)
npx nerd-font-woff2 --source-dir ./fonts/original

# Convert with explicit safety confirmation
npx nerd-font-woff2 --source-dir ./fonts/original --convert --confirm

# Faster conversion with custom concurrency and timeout
npx nerd-font-woff2 --source-dir ./fonts/original --convert --confirm --concurrency 4 --timeout 120000

# JSON summary and explicit index file
npx nerd-font-woff2 --source-dir ./fonts/original --convert --confirm --json --index-file ./fonts/woff2/index.json
```

---

## Available font families

All families from [Nerd Fonts v3.4.0](https://github.com/ryanoasis/nerd-fonts/releases/tag/v3.4.0) are included.
Browse the full list in the [`fonts/woff2/`](./fonts/woff2) directory.

Popular families:

| Family                | Folder name             |
| --------------------- | ----------------------- |
| 0xProto               | `0xProto`               |
| 3270                  | `3270`                  |
| Agave                 | `Agave`                 |
| AnonymousPro          | `AnonymousPro`          |
| Arimo                 | `Arimo`                 |
| AurulentSansMono      | `AurulentSansMono`      |
| BigBlueTerminal       | `BigBlueTerminal`       |
| BitstreamVeraSansMono | `BitstreamVeraSansMono` |
| CascadiaCode          | `CascadiaCode`          |
| CaskaydiaCove         | `CaskaydiaCove`         |
| CaskaydiaMono         | `CaskaydiaMono`         |
| CodeNewRoman          | `CodeNewRoman`          |
| ComicShannsMono       | `ComicShannsMono`       |
| CommitMono            | `CommitMono`            |
| Cousine               | `Cousine`               |
| D2Coding              | `D2Coding`              |
| DaddyTimeMono         | `DaddyTimeMono`         |
| DejaVuSansMono        | `DejaVuSansMono`        |
| DroidSansMono         | `DroidSansMono`         |
| EnvyCodeR             | `EnvyCodeR`             |
| FantasqueSansMono     | `FantasqueSansMono`     |
| FiraCode              | `FiraCode`              |
| FiraMono              | `FiraMono`              |
| GeistMono             | `GeistMono`             |
| Go-Mono               | `Go-Mono`               |
| Gohu                  | `Gohu`                  |
| GohuFont              | `GohuFont`              |
| Hack                  | `Hack`                  |
| Hasklig               | `Hasklig`               |
| HeavyData             | `HeavyData`             |
| Hermit                | `Hermit`                |
| iA-Writer             | `iA-Writer`             |
| IBMPlexMono           | `IBMPlexMono`           |
| Inconsolata           | `Inconsolata`           |
| InconsolataGo         | `InconsolataGo`         |
| InconsolataLGC        | `InconsolataLGC`        |
| IntelOneMono          | `IntelOneMono`          |
| Iosevka               | `Iosevka`               |
| IosevkaTerm           | `IosevkaTerm`           |
| IosevkaTermSlab       | `IosevkaTermSlab`       |
| JetBrainsMono         | `JetBrainsMono`         |
| Lekton                | `Lekton`                |
| LiberationMono        | `LiberationMono`        |
| Lilex                 | `Lilex`                 |
| MartianMono           | `MartianMono`           |
| Meslo                 | `Meslo`                 |
| Monofur               | `Monofur`               |
| Monoid                | `Monoid`                |
| Mononoki              | `Mononoki`              |
| MPlus                 | `MPlus`                 |
| NerdFontsSymbolsOnly  | `NerdFontsSymbolsOnly`  |
| Noto                  | `Noto`                  |
| OpenDyslexic          | `OpenDyslexic`          |
| Overpass              | `Overpass`              |
| ProFont               | `ProFont`               |
| ProggyClean           | `ProggyClean`           |
| Recursive             | `Recursive`             |
| RobotoMono            | `RobotoMono`            |
| ShareTechMono         | `ShareTechMono`         |
| SourceCodePro         | `SourceCodePro`         |
| SpaceMono             | `SpaceMono`             |
| Terminus              | `Terminus`              |
| Tinos                 | `Tinos`                 |
| Ubuntu                | `Ubuntu`                |
| UbuntuMono            | `UbuntuMono`            |
| UbuntuSans            | `UbuntuSans`            |
| VictorMono            | `VictorMono`            |
| ZedMono               | `ZedMono`               |

---

## What are Nerd Fonts?

[Nerd Fonts](https://www.nerdfonts.com/) patches developer-targeted fonts with a large number of glyphs (icons) from popular icon sets — including Devicons, Font Awesome, Material Design Icons, and many others.

They are widely used in terminal emulators, code editors, and shell prompts (Starship, Oh-My-Zsh, Powerlevel10k, etc.).

---

## Releases and versioning

Font assets are updated on each tagged release. Check the [Releases page](https://github.com/Nick2bad4u/nerd-fonts-woff2/releases) for the latest version and changelog.

Pin the version in your CDN URLs to avoid unexpected changes.

---

## License

Fonts are distributed under their respective upstream licenses (see each family's source in [Nerd Fonts](https://github.com/ryanoasis/nerd-fonts)).
This project's tooling and scripts are licensed under the [MIT License](./LICENSE).

---

## Links

- [Releases](https://github.com/Nick2bad4u/nerd-fonts-woff2/releases)
- [npm package](https://www.npmjs.com/package/nerd-fonts-woff2)
- [Asset index](./fonts/woff2/index.json)
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
      <td align="center" valign="top" width="25%"><a href="https://github.com/Nick2bad4u"><img src="https://avatars.githubusercontent.com/u/20943337?v=4?s=80" width="80px;" alt="Nick2bad4u"/><br /><sub><b>Nick2bad4u</b></sub></a><br /><a href="https://github.com/Nick2bad4u/eslint-plugin-typefest/issues?q=author%3ANick2bad4u" title="Bug reports">🐛</a> <a href="https://github.com/Nick2bad4u/eslint-plugin-typefest/commits?author=Nick2bad4u" title="Code">💻</a> <a href="https://github.com/Nick2bad4u/eslint-plugin-typefest/commits?author=Nick2bad4u" title="Documentation">📖</a> <a href="#ideas-Nick2bad4u" title="Ideas, Planning, & Feedback">🤔</a> <a href="#infra-Nick2bad4u" title="Infrastructure (Hosting, Build-Tools, etc)">🚇</a> <a href="#maintenance-Nick2bad4u" title="Maintenance">🚧</a> <a href="https://github.com/Nick2bad4u/eslint-plugin-typefest/pulls?q=is%3Apr+reviewed-by%3ANick2bad4u" title="Reviewed Pull Requests">👀</a> <a href="https://github.com/Nick2bad4u/eslint-plugin-typefest/commits?author=Nick2bad4u" title="Tests">⚠️</a> <a href="#tool-Nick2bad4u" title="Tools">🔧</a></td>
      <td align="center" valign="top" width="25%"><a href="https://snyk.io/"><img src="https://avatars.githubusercontent.com/u/19733683?v=4?s=80" width="80px;" alt="Snyk bot"/><br /><sub><b>Snyk bot</b></sub></a><br /><a href="#security-snyk-bot" title="Security">🛡️</a> <a href="#infra-snyk-bot" title="Infrastructure (Hosting, Build-Tools, etc)">🚇</a> <a href="#maintenance-snyk-bot" title="Maintenance">🚧</a> <a href="https://github.com/Nick2bad4u/eslint-plugin-typefest/pulls?q=is%3Apr+reviewed-by%3Asnyk-bot" title="Reviewed Pull Requests">👀</a></td>
      <td align="center" valign="top" width="25%"><a href="https://www.stepsecurity.io/"><img src="https://avatars.githubusercontent.com/u/89328645?v=4?s=80" width="80px;" alt="StepSecurity Bot"/><br /><sub><b>StepSecurity Bot</b></sub></a><br /><a href="#security-step-security-bot" title="Security">🛡️</a> <a href="#infra-step-security-bot" title="Infrastructure (Hosting, Build-Tools, etc)">🚇</a> <a href="#maintenance-step-security-bot" title="Maintenance">🚧</a></td>
      <td align="center" valign="top" width="25%"><a href="https://github.com/apps/dependabot"><img src="https://avatars.githubusercontent.com/in/29110?v=4?s=80" width="80px;" alt="dependabot[bot]"/><br /><sub><b>dependabot[bot]</b></sub></a><br /><a href="#infra-dependabot[bot]" title="Infrastructure (Hosting, Build-Tools, etc)">🚇</a> <a href="#security-dependabot[bot]" title="Security">🛡️</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="25%"><a href="https://github.com/apps/github-actions"><img src="https://avatars.githubusercontent.com/in/15368?v=4?s=80" width="80px;" alt="github-actions[bot]"/><br /><sub><b>github-actions[bot]</b></sub></a><br /><a href="https://github.com/Nick2bad4u/eslint-plugin-typefest/commits?author=github-actions[bot]" title="Code">💻</a> <a href="#infra-github-actions[bot]" title="Infrastructure (Hosting, Build-Tools, etc)">🚇</a></td>
    </tr>
  </tbody>
</table>

<!-- markdownlint-restore -->

<!-- prettier-ignore-end -->

<!-- ALL-CONTRIBUTORS-LIST:END -->
