export function renderHelpText(): string {
    return [
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
        "",
        "Output options:",
        "  --index-file <path>             Write generated asset index JSON",
        "  --verbose                       Print planned files and failures",
        "  --json                          Emit machine-readable summary",
        "  --help                          Show this help",
        "",
        "Examples:",
        "  nerd-font-woff2 --source-dir ./temp/nerd-fonts --dry-run",
        "  nerd-font-woff2 --source-dir ./temp/nerd-fonts --convert --confirm",
        "  nerd-font-woff2 --manifest ./nerd-font-woff2.config.json --convert --confirm --json",
    ].join("\n");
}

export function printHelp(): void {
    console.log(renderHelpText());
}
