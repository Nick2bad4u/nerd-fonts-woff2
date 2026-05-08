import { arrayJoin } from "ts-extras";

/**
 * Prints the CLI help text to stdout.
 */
export function printHelp(): void {
    process.stdout.write(`${renderHelpText()}\n`);
}

/**
 * Renders the full CLI help text.
 *
 * @returns A multi-line string containing all available options and examples.
 */
export function renderHelpText(): string {
    return arrayJoin(
        [
            "nerd-font-woff2",
            "",
            "Convert local TTF/OTF fonts into WOFF2 files with safe defaults.",
            "",
            "Usage:",
            "  nerd-font-woff2 --source-dir <path> [options]",
            "",
            "Core options:",
            "  --source-dir <path[,path...]>   Source directory containing .ttf/.otf files (repeatable)",
            "  --manifest <file>               JSON config file (optional)",
            "  --out-dir <path>                Output directory for generated .woff2 files",
            "  --temp-dir <path>               Temporary working directory",
            "  --include-ext <ttf,otf>         Input extensions (default: ttf,otf)",
            "  --max-files <n>                 Limit number of files to process",
            "",
            "Conversion options:",
            "  --convert                        Run conversion pipeline (default mode is plan)",
            "  --dry-run                        Plan only; do not execute external converter",
            "  --confirm, --yes                Required for non-dry-run conversion",
            "  --converter <cmd>               Converter executable (default: woff2_compress)",
            "  --converter-arg <value>         Extra converter args (repeatable)",
            "  --fail-fast                     Stop on first conversion failure",
            "  --concurrency <n>               Number of concurrent conversions (default: 1)",
            "  --timeout <ms>                  Per-file converter timeout in milliseconds (default: 60000 / 60s)",
            "",
            "Output options:",
            "  --index-file <path>             Write generated asset index JSON (default: <out-dir>/index.json)",
            "  --verbose                       Print planned files and failures",
            "  --debug                         Enable debug output (implies --verbose)",
            "  --json                          Emit machine-readable summary",
            "  --help                          Show this help",
            "",
            "Examples:",
            "  nerd-font-woff2 --source-dir ./temp/nerd-fonts --dry-run",
            "  nerd-font-woff2 --source-dir ./temp/nerd-fonts --convert --confirm",
            "  nerd-font-woff2 --source-dir ./temp/nerd-fonts --convert --confirm --concurrency 4",
            "  nerd-font-woff2 --source-dir ./temp/nerd-fonts --convert --confirm --timeout 30000",
            "  nerd-font-woff2 --manifest ./nerd-font-woff2.config.json --convert --confirm --json",
        ],
        "\n"
    );
}
