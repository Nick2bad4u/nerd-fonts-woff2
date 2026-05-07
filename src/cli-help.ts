import type { Styler } from "./cli-types.js";

type HelpOption = {
    arg?: string;
    description: string;
    flag: string;
};

type HelpSection = {
    options?: HelpOption[];
    title: string;
};

const HELP_SECTIONS: HelpSection[] = [
    {
        options: [
            {
                arg: "<owner/name>",
                description:
                    "Target repository (optional if run inside a repo)",
                flag: "--repo",
            },
            {
                arg: "<owner/name[,..]>",
                description: "Multiple target repositories (repeatable)",
                flag: "--repos",
            },
            {
                description: "Target all repositories for an owner/login",
                flag: "--all-repos",
            },
            {
                arg: "<login>",
                description:
                    "Owner/login used with --all-repos (default: authenticated user)",
                flag: "--owner",
            },
        ],
        title: "Target repository",
    },
    {
        options: [
            {
                arg: "<value[,value...]>",
                description:
                    "Run statuses to target (repeatable; default: failure,cancelled)",
                flag: "--status",
            },
            {
                description: "Target all valid statuses",
                flag: "--all-statuses",
            },
            {
                arg: "<name|id>",
                description: "Filter by workflow name or id",
                flag: "--workflow",
            },
            {
                arg: "<name[,name...]>",
                description: "Exclude matching workflow names (repeatable)",
                flag: "--exclude-workflow",
            },
            {
                arg: "<name>",
                description: "Filter by branch",
                flag: "--branch",
            },
            {
                arg: "<name[,name...]>",
                description: "Exclude matching branch names (repeatable)",
                flag: "--exclude-branch",
            },
            {
                arg: "<event>",
                description: "Filter by triggering event",
                flag: "--event",
            },
            {
                arg: "<login>",
                description: "Filter by actor",
                flag: "--user",
            },
            {
                arg: "<sha>",
                description: "Filter by commit SHA",
                flag: "--commit",
            },
            {
                arg: "<date>",
                description: "GitHub created-date filter (same as gh run list)",
                flag: "--created",
            },
            {
                arg: "<n>",
                description: "Only delete runs older than N days",
                flag: "--before-days",
            },
            {
                arg: "<n>",
                description: "Max runs to fetch per status (default: 500)",
                flag: "--limit",
            },
            {
                arg: "<n>",
                description: "Safety cap on number of deletions",
                flag: "--max-delete",
            },
            {
                arg: "<oldest|newest|none>",
                description: "Processing order (default: oldest)",
                flag: "--order",
            },
        ],
        title: "Filters",
    },
    {
        options: [
            {
                description: "Show what would be deleted without deleting",
                flag: "--dry-run",
            },
            {
                description: "Required to perform deletion",
                flag: "--confirm",
            },
            {
                description: "Alias for --confirm",
                flag: "--yes",
            },
            {
                arg: "<n>",
                description: "Delete retry attempts (default: 2)",
                flag: "--max-retries",
            },
            {
                arg: "<n>",
                description: "Initial retry delay in ms (default: 200)",
                flag: "--retry-delay-ms",
            },
            {
                description: "Stop deleting after first failed run",
                flag: "--fail-fast",
            },
            {
                arg: "<n>",
                description: "Stop after N failed deletions",
                flag: "--max-failures",
            },
            {
                description: "Show per-run details",
                flag: "--verbose",
            },
            {
                description: "Show expanded summaries (tables, grouped counts)",
                flag: "--summary",
            },
            {
                description: "Reduce non-error output in text mode",
                flag: "--quiet",
            },
        ],
        title: "Execution",
    },
    {
        options: [
            {
                description: "Emit structured JSON output",
                flag: "--json",
            },
            {
                arg: "<auto|always|never>",
                description: "Color mode for text output (default: auto)",
                flag: "--color",
            },
            {
                description: "Alias for --color never",
                flag: "--no-color",
            },
            {
                arg: "<auto|always|never>",
                description: "Unicode table borders/symbols (default: auto)",
                flag: "--unicode",
            },
            {
                description: "Alias for --unicode never",
                flag: "--no-unicode",
            },
            {
                description: "Disable progress bars in interactive terminals",
                flag: "--no-progress",
            },
            {
                description:
                    "CI-friendly output (disables interactive formatting)",
                flag: "--ci",
            },
        ],
        title: "Output",
    },
    {
        options: [
            {
                description: "Show this help",
                flag: "--help",
            },
        ],
        title: "Help",
    },
];

const HELP_NOTES = [
    "--workflow uses compatibility mode, so progress may update less frequently.",
];

const HELP_EXAMPLES = [
    "gh runs-cleanup --repo owner/repo --confirm",
    "gh runs-cleanup --repos owner/repo,owner/other-repo --dry-run",
    "gh runs-cleanup --all-repos --owner my-user --status failure --confirm",
    "gh runs-cleanup --repo owner/repo --status failure,cancelled --limit 500 --confirm",
    'gh runs-cleanup --repo owner/repo --workflow "CI" --branch main --dry-run',
    "gh runs-cleanup --repo owner/repo --json --dry-run",
    "gh runs-cleanup --before-days 30 --status failure --confirm",
];

function styleToken(token: string, styler: Styler): string {
    if (token.startsWith("--")) return styler.flag(token);
    if (token.startsWith("<") && token.endsWith(">")) return styler.arg(token);
    return token;
}

function styleCommandExample(command: string, styler?: Styler): string {
    if (!styler) {
        return command;
    }

    return command
        .split(/(\s+)/u)
        .map((token) => styleToken(token, styler))
        .join("");
}

export function buildHelpText(styler?: Styler): string {
    const heading = (text: string): string =>
        styler ? styler.info(text) : text;
    const flag = (text: string): string => (styler ? styler.flag(text) : text);
    const arg = (text: string): string => (styler ? styler.arg(text) : text);
    const title = (text: string): string =>
        styler ? styler.heading(text) : text;

    const optionLabelWidths = HELP_SECTIONS.flatMap((section) =>
        (section.options ?? []).map((option) => {
            const argSuffix = option.arg ? ` ${option.arg}` : "";
            return `${option.flag}${argSuffix}`.length;
        })
    );
    const maxLabelWidth = Math.max(...optionLabelWidths, 0);

    const lines: string[] = [];
    lines.push(
        title("gh-runs-cleanup"),
        "",
        "  Delete GitHub Actions workflow runs using the gh CLI.",
        "",
        heading("  Usage:"),
        `    ${styleCommandExample("gh runs-cleanup", styler)} ${arg("[options]")}`,
        ""
    );

    for (const section of HELP_SECTIONS) {
        lines.push(heading(`  ${section.title}:`));
        for (const option of section.options ?? []) {
            const plainArgPart = option.arg ? ` ${option.arg}` : "";
            const styledArgPart = option.arg ? ` ${arg(option.arg)}` : "";
            const labelPlain = `${option.flag}${plainArgPart}`;
            const labelStyled = `${flag(option.flag)}${styledArgPart}`;
            const spacing = " ".repeat(maxLabelWidth - labelPlain.length + 2);
            lines.push(`    ${labelStyled}${spacing}${option.description}`);
        }
        lines.push("");
    }

    lines.push(heading("  Notes:"));
    for (const note of HELP_NOTES) {
        lines.push(`    ${styleCommandExample(note, styler)}`);
    }
    lines.push("", heading("  Examples:"));
    for (const example of HELP_EXAMPLES) {
        lines.push(`    ${styleCommandExample(example, styler)}`);
    }
    lines.push("  ");

    return lines.join("\n");
}

export function printHelp(): string {
    return buildHelpText();
}

export function renderHelpText(styler: Styler): string {
    return buildHelpText(styler);
}
