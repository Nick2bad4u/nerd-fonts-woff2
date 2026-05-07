import type { UnknownRecord } from "type-fest";

import { spawnSync } from "node:child_process";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    statSync,
    writeFileSync,
} from "node:fs";
import {
    basename,
    dirname,
    extname,
    join,
    normalize,
    relative,
    resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
    arrayAt,
    arrayFirst,
    arrayJoin,
    isDefined,
    isEmpty,
    isFinite,
    safeCastTo,
    setHas,
    stringSplit,
} from "ts-extras";

import type {
    ErrorCategory,
    FontIndexEntry,
    Mode,
    ParsedOptions,
    PlannedFontFile,
    RunSummary,
} from "./cli-types.js";

import { printHelp } from "./cli-help.js";

// ─── Local types ──────────────────────────────────────────────────────────────

type BuildConfigResult =
    | { readonly code: number; readonly ok: false }
    | { readonly config: ExecutionConfig; readonly ok: true };

type ErrorReporter = (message: string, category: ErrorCategory) => void;

type ExecutionConfig = {
    confirm: boolean;
    converter: string;
    converterArgs: readonly string[];
    dryRun: boolean;
    failFast: boolean;
    includeExts: ReadonlySet<string>;
    indexFile?: string;
    jsonOutput: boolean;
    maxFiles?: number;
    mode: Mode;
    outDir: string;
    sourceDirs: readonly string[];
    tempDir: string;
    verbose: boolean;
};

// ─── Output helpers ───────────────────────────────────────────────────────────

type ManifestFile = {
    converter?: string;
    converterArgs?: readonly string[];
    includeExts?: readonly string[];
    indexFile?: string;
    maxFiles?: number;
    outDir?: string;
    sourceDirs?: readonly string[];
    tempDir?: string;
};

type SingleFontResult = "converted" | "failed-break" | "failed-continue";

// ─── Error reporting ──────────────────────────────────────────────────────────

/**
 * Entry point for the nerd-font-woff2 CLI.
 *
 * Parses the provided argument list, builds an execution config, plans or
 * converts fonts, and returns a numeric exit code:
 *
 * - `0` success (plan or convert with no failures)
 * - `1` validation / configuration error
 * - `2` one or more conversion failures
 *
 * @param argv - Argument list (typically `process.argv.slice(2)`)
 *
 * @returns Exit code
 */
export function main(argv: readonly string[]): number {
    const options = parseArguments(argv);
    const result = buildExecutionConfig(options);

    if (!result.ok) {
        return result.code;
    }

    const { config } = result;
    const plan = buildPlan(config);

    if (!config.jsonOutput && config.verbose) {
        for (const planned of plan) {
            writeOut(
                `${planned.sourcePath} -> ${join(config.outDir, planned.relativeOutputPath)}`
            );
        }

        if (plan.length > 0) {
            writeOut("");
        }
    }

    const summary = convertFonts(config, plan);

    if (config.jsonOutput) {
        writeOut(JSON.stringify(summary, null, 2));
    } else {
        printTextSummary(summary, config.verbose);
    }

    return summary.failed > 0 ? 2 : 0;
}

function appendToListOption(
    // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- accumulator object is intentionally mutated by this function
    parsed: ParsedOptions,
    key: string,
    value: string
): void {
    const existing = parsed[key];
    const bucket: string[] = Array.isArray(existing)
        ? [...safeCastTo<readonly string[]>(existing)]
        : [];
    bucket.push(value);
    parsed[key] = bucket;
}

function buildConverterMessage(stdout: string, stderr: string): string {
    if (stderr.length > 0) {
        return stderr;
    }

    if (stdout.length > 0) {
        return stdout;
    }

    return "converter exited with non-zero status";
}

// ─── Utility helpers ──────────────────────────────────────────────────────────

function buildExecutionConfig(
    options: Readonly<ParsedOptions>
): BuildConfigResult {
    const jsonOutput = options["json"] === true;

    if (options["help"] === true) {
        printHelp();
        return { code: 0, ok: false };
    }

    const reportError: ErrorReporter = jsonOutput
        ? emitJsonError
        : emitTextError;
    const manifestResult = loadManifest(
        getStringOption(options, "manifest"),
        reportError
    );
    if (!manifestResult.ok) {
        return manifestResult;
    }

    const { manifest } = manifestResult;

    const sourceDirs = resolveSources(options, manifest);
    const sourcesResult = validateSourceDirectories(sourceDirs, reportError);
    if (!sourcesResult.ok) {
        return sourcesResult;
    }

    const { confirm, dryRun, mode } = resolveMode(options);

    if (mode === "convert" && !dryRun && !confirm) {
        reportError(
            "Safety stop: pass --confirm for conversion, or use --dry-run.",
            "validation_error"
        );
        return { code: 1, ok: false };
    }

    const extsResult = resolveIncludeExts(options, manifest, reportError);
    if (!extsResult.ok) {
        return extsResult;
    }

    const maxFilesRaw =
        getStringOption(options, "max-files") ??
        (typeof manifest.maxFiles === "number"
            ? String(manifest.maxFiles)
            : undefined);
    const maxResult = resolveMaxFiles(maxFilesRaw, reportError);
    if (!maxResult.ok) {
        return maxResult;
    }

    const converterResult = resolveConverter(options, manifest, reportError);
    if (!converterResult.ok) {
        return converterResult;
    }

    const { indexFileRaw, outDir, tempDir } = resolveDirectories(
        options,
        manifest
    );

    const config: ExecutionConfig = {
        confirm,
        converter: converterResult.cmd,
        converterArgs: converterResult.args,
        dryRun,
        failFast: options["fail-fast"] === true,
        includeExts: extsResult.exts,
        jsonOutput,
        mode,
        outDir,
        sourceDirs,
        tempDir,
        verbose: options["verbose"] === true,
        ...(typeof maxResult.maxFiles === "number"
            ? { maxFiles: maxResult.maxFiles }
            : {}),
        ...(typeof indexFileRaw === "string"
            ? { indexFile: resolve(indexFileRaw) }
            : {}),
    };

    return { config, ok: true };
}

function buildIndexEntries(
    config: Readonly<ExecutionConfig>,
    plan: readonly Readonly<PlannedFontFile>[],
    convertedTargets: ReadonlySet<string>
): FontIndexEntry[] {
    const entries: FontIndexEntry[] = [];

    for (const planned of plan) {
        const outputPath = resolve(
            join(config.outDir, planned.relativeOutputPath)
        );
        const converted = setHas(convertedTargets, outputPath);
        const pathSegments = stringSplit(
            planned.relativeOutputPath.replaceAll("\\", "/"),
            "/"
        );
        const firstSegment = arrayFirst(pathSegments) ?? "unknown";

        let sizeBytes: null | number = null;
        if (existsSync(outputPath)) {
            sizeBytes = statSync(outputPath).size;
        }

        entries.push({
            converted,
            family: firstSegment,
            fileName: arrayAt(pathSegments, -1) ?? "",
            outputPath,
            sizeBytes,
            sourcePath: planned.sourcePath,
        });
    }

    return entries;
}

function buildPlan(config: Readonly<ExecutionConfig>): PlannedFontFile[] {
    const plans: PlannedFontFile[] = [];

    for (const sourceDir of config.sourceDirs) {
        const files = listFontFiles(sourceDir, config.includeExts);
        const sourceRoot = basename(sourceDir);

        for (const sourcePath of files) {
            const relativeInputPath = normalize(
                relative(sourceDir, sourcePath)
            );
            const relativeOutputPath = normalize(
                join(
                    sourceRoot,
                    relativeInputPath.replace(/\.(?:otf|ttf)$/iu, ".woff2")
                )
            );

            plans.push({
                relativeInputPath,
                relativeOutputPath,
                sourcePath,
                sourceRoot,
            });
        }
    }

    return plans
        .toSorted((left, right) =>
            left.relativeOutputPath.localeCompare(right.relativeOutputPath)
        )
        .slice(0, config.maxFiles ?? plans.length);
}

function collectListOption(
    options: Readonly<ParsedOptions>,
    key: string
): readonly string[] {
    const value = options[key];

    if (Array.isArray(value)) {
        return safeCastTo<readonly string[]>(value)
            .flatMap((part) => stringSplit(part, ","))
            .map((part) => part.trim())
            .filter((part) => part.length > 0);
    }

    if (typeof value === "string") {
        return stringSplit(value, ",")
            .map((part) => part.trim())
            .filter((part) => part.length > 0);
    }

    return [];
}

function convertFonts(
    config: Readonly<ExecutionConfig>,
    plan: readonly Readonly<PlannedFontFile>[]
): RunSummary {
    const startedAt = Date.now();
    let converted = 0;
    const failures: string[] = [];
    const convertedTargets = new Set<string>();

    if (config.mode === "convert" && !config.dryRun) {
        mkdirSync(config.tempDir, { recursive: true });
        mkdirSync(config.outDir, { recursive: true });
    }

    for (const planned of plan) {
        const outputPath = resolve(
            join(config.outDir, planned.relativeOutputPath)
        );

        if (config.mode !== "convert" || config.dryRun) {
            continue;
        }

        const result = convertSingleFont(
            config,
            planned,
            outputPath,
            convertedTargets,
            failures
        );

        if (result === "converted") {
            converted += 1;
        } else if (result === "failed-break") {
            break;
        }
    }

    if (typeof config.indexFile === "string") {
        const entries = buildIndexEntries(config, plan, convertedTargets);
        writeIndexFile(config.indexFile, entries);
    }

    const summary: RunSummary = {
        converted,
        dryRun: config.dryRun,
        durationMs: Date.now() - startedAt,
        failed: failures.length,
        failures,
        mode: config.mode,
        outDir: config.outDir,
        planned: plan.length,
        skipped: plan.length - converted - failures.length,
        tempDir: config.tempDir,
    };

    if (typeof config.indexFile === "string") {
        summary.indexFile = config.indexFile;
    }

    return summary;
}

function convertSingleFont(
    config: Readonly<ExecutionConfig>,
    planned: Readonly<PlannedFontFile>,
    outputPath: string,
    convertedTargets: Set<string>,
    // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- failures accumulator is mutated via push() to collect error messages
    failures: string[]
): SingleFontResult {
    const stagedInput = resolve(
        join(
            config.tempDir,
            "staging",
            planned.sourceRoot,
            planned.relativeInputPath
        )
    );
    mkdirSync(dirname(stagedInput), { recursive: true });
    copyFileSync(planned.sourcePath, stagedInput);

    const commandResult = spawnSync(
        config.converter,
        [...config.converterArgs, stagedInput],
        { encoding: "utf8", shell: false }
    );

    if (commandResult.status !== 0) {
        failures.push(
            `${planned.sourcePath}: ${buildConverterMessage(
                commandResult.stdout.trim(),
                commandResult.stderr.trim()
            )}`
        );
        return config.failFast ? "failed-break" : "failed-continue";
    }

    const stagedOutput = stagedInput.replace(/\.(?:otf|ttf)$/iu, ".woff2");
    if (!existsSync(stagedOutput)) {
        failures.push(
            `${planned.sourcePath}: converter did not produce expected .woff2 output`
        );
        return config.failFast ? "failed-break" : "failed-continue";
    }

    mkdirSync(dirname(outputPath), { recursive: true });
    copyFileSync(stagedOutput, outputPath);
    convertedTargets.add(outputPath);
    return "converted";
}
function emitJsonError(message: string, category: ErrorCategory): void {
    writeErr(
        JSON.stringify(
            {
                error: {
                    category,
                    message,
                },
            },
            null,
            2
        )
    );
}

function emitTextError(message: string): void {
    writeErr(`Error: ${message}`);
}

function getStringOption(
    options: Readonly<ParsedOptions>,
    key: string
): string | undefined {
    const value = options[key];
    if (typeof value !== "string") {
        return undefined;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

// ─── Manifest parsing ─────────────────────────────────────────────────────────

// ─── Argument parsing ─────────────────────────────────────────────────────────
function isBooleanFlag(key: string): boolean {
    return (
        key === "help" ||
        key === "dry-run" ||
        key === "confirm" ||
        key === "yes" ||
        key === "convert" ||
        key === "json" ||
        key === "verbose" ||
        key === "fail-fast"
    );
}

// ─── Font discovery ───────────────────────────────────────────────────────────

function isListFlag(key: string): boolean {
    return (
        key === "source-dir" || key === "converter-arg" || key === "include-ext"
    );
}

// ─── Index building ───────────────────────────────────────────────────────────

function listFontFiles(
    sourceDir: string,
    includeExts: ReadonlySet<string>
): string[] {
    const discovered: string[] = [];
    const queue: string[] = [sourceDir];

    while (queue.length > 0) {
        const current = queue.shift();
        if (!isDefined(current)) {
            continue;
        }

        const entries = readdirSync(current, { withFileTypes: true }).toSorted(
            (a, b) => a.name.localeCompare(b.name)
        );

        for (const entry of entries) {
            const absolutePath = join(current, entry.name);

            if (entry.isDirectory()) {
                queue.push(absolutePath);
                continue;
            }

            if (!entry.isFile()) {
                continue;
            }

            const extension = extname(entry.name)
                .replace(/^\./u, "")
                .toLowerCase();

            if (setHas(includeExts, extension)) {
                discovered.push(absolutePath);
            }
        }
    }

    return discovered;
}

function loadManifest(
    manifestPath: string | undefined,
    reportError: ErrorReporter
): { code: number; ok: false } | { manifest: ManifestFile; ok: true } {
    if (!isDefined(manifestPath)) {
        return { manifest: {}, ok: true };
    }

    try {
        return { manifest: parseManifest(resolve(manifestPath)), ok: true };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reportError(
            `failed to read --manifest file: ${message}`,
            "validation_error"
        );
        return { code: 1, ok: false };
    }
}

// ─── Build plan ───────────────────────────────────────────────────────────────

function normalizeExtList(entries: readonly string[]): ReadonlySet<string> {
    const normalized = entries
        .map((entry) => entry.trim().toLowerCase())
        .map((entry) => (entry.startsWith(".") ? entry.slice(1) : entry))
        .filter((entry) => entry.length > 0);

    return new Set(normalized);
}

// ─── Conversion ───────────────────────────────────────────────────────────────

function parseArguments(args: readonly string[]): ParsedOptions {
    const parsed: ParsedOptions = {};

    for (let index = 0; index < args.length; index += 1) {
        const token = args[index];
        if (!isDefined(token) || !token.startsWith("--")) {
            continue;
        }

        const eqIndex = token.indexOf("=");
        const rawKey =
            eqIndex === -1 ? token.slice(2) : token.slice(2, eqIndex);
        const inlineValue: string | undefined =
            eqIndex === -1 ? undefined : token.slice(eqIndex + 1);
        const key = rawKey.trim();

        if (isBooleanFlag(key)) {
            parsed[key] = true;
            continue;
        }

        const nextToken = args[index + 1];
        const value = resolveTokenValue(inlineValue, nextToken);

        if (
            !isDefined(inlineValue) &&
            typeof nextToken === "string" &&
            !nextToken.startsWith("--")
        ) {
            index += 1;
        }

        if (isListFlag(key)) {
            appendToListOption(parsed, key, value);
            continue;
        }

        parsed[key] = value;
    }

    return parsed;
}

function parseManifest(pathToManifest: string): ManifestFile {
    const raw = readFileSync(pathToManifest, "utf8");
    const parsed = JSON.parse(raw) as unknown;

    if (typeof parsed !== "object" || parsed === null) {
        throw new Error("manifest root must be a JSON object");
    }

    const manifest = parsed as UnknownRecord;

    const getString = (key: string): string | undefined =>
        typeof manifest[key] === "string" ? manifest[key] : undefined;

    const getStringArray = (key: string): string[] | undefined => {
        const value = manifest[key];
        if (!Array.isArray(value)) {
            return undefined;
        }

        const entries = value.filter(
            (entry): entry is string => typeof entry === "string"
        );
        return entries.length === value.length ? entries : undefined;
    };

    const manifestFile: ManifestFile = {};

    const converter = getString("converter");
    if (typeof converter === "string") {
        manifestFile.converter = converter;
    }

    const converterArgs = getStringArray("converterArgs");
    if (Array.isArray(converterArgs)) {
        manifestFile.converterArgs = converterArgs;
    }

    const includeExts = getStringArray("includeExts");
    if (Array.isArray(includeExts)) {
        manifestFile.includeExts = includeExts;
    }

    const indexFile = getString("indexFile");
    if (typeof indexFile === "string") {
        manifestFile.indexFile = indexFile;
    }

    if (typeof manifest["maxFiles"] === "number") {
        manifestFile.maxFiles = manifest["maxFiles"];
    }

    const outDir = getString("outDir");
    if (typeof outDir === "string") {
        manifestFile.outDir = outDir;
    }

    const sourceDirs = getStringArray("sourceDirs");
    if (Array.isArray(sourceDirs)) {
        manifestFile.sourceDirs = sourceDirs;
    }

    const tempDir = getString("tempDir");
    if (typeof tempDir === "string") {
        manifestFile.tempDir = tempDir;
    }

    return manifestFile;
}

function printTextSummary(
    summary: Readonly<RunSummary>,
    verbose: boolean
): void {
    writeOut(`Mode: ${summary.mode}${summary.dryRun ? " (dry-run)" : ""}`);
    writeOut(`Planned files: ${summary.planned}`);
    writeOut(`Converted files: ${summary.converted}`);
    writeOut(`Failed files: ${summary.failed}`);
    writeOut(`Skipped files: ${summary.skipped}`);
    writeOut(`Output directory: ${summary.outDir}`);

    if (typeof summary.indexFile === "string") {
        writeOut(`Index file: ${summary.indexFile}`);
    }

    if (verbose && summary.failures.length > 0) {
        writeOut("");
        writeOut("Failures:");
        for (const failure of summary.failures) {
            writeOut(`- ${failure}`);
        }
    }
}

function resolveConverter(
    options: Readonly<ParsedOptions>,
    manifest: Readonly<ManifestFile>,
    reportError: ErrorReporter
):
    | { args: readonly string[]; cmd: string; ok: true }
    | { code: number; ok: false } {
    const cmd =
        getStringOption(options, "converter") ??
        manifest.converter ??
        "woff2_compress";

    if (cmd.trim().length === 0) {
        reportError(
            "--converter must be a non-empty command.",
            "validation_error"
        );
        return { code: 1, ok: false };
    }

    const args: readonly string[] = [
        ...toNonEmptyArray(manifest.converterArgs),
        ...collectListOption(options, "converter-arg"),
    ];

    return { args, cmd, ok: true };
}

// ─── Config builder ───────────────────────────────────────────────────────────

function resolveDirectories(
    options: Readonly<ParsedOptions>,
    manifest: Readonly<ManifestFile>
): { indexFileRaw: string | undefined; outDir: string; tempDir: string } {
    return {
        indexFileRaw:
            getStringOption(options, "index-file") ?? manifest.indexFile,
        outDir: resolve(
            getStringOption(options, "out-dir") ??
                manifest.outDir ??
                "assets/woff2"
        ),
        tempDir: resolve(
            getStringOption(options, "temp-dir") ??
                manifest.tempDir ??
                "temp/work"
        ),
    };
}

function resolveIncludeExts(
    options: Readonly<ParsedOptions>,
    manifest: Readonly<ManifestFile>,
    reportError: ErrorReporter
): { code: number; ok: false } | { exts: ReadonlySet<string>; ok: true } {
    const includeFromManifest = toNonEmptyArray(manifest.includeExts);
    const includeFromFlags = collectListOption(options, "include-ext");
    let includeEntries: readonly string[] = ["ttf", "otf"];

    if (includeFromManifest.length > 0) {
        includeEntries = includeFromManifest;
    }

    if (includeFromFlags.length > 0) {
        includeEntries = includeFromFlags;
    }

    const includeExts = normalizeExtList(includeEntries);
    const unsupportedExts = [...includeExts].filter(
        (ext) => ext !== "ttf" && ext !== "otf"
    );

    if (unsupportedExts.length > 0) {
        reportError(
            `unsupported --include-ext values: ${arrayJoin(unsupportedExts, ", ")} (allowed: ttf, otf).`,
            "validation_error"
        );
        return { code: 1, ok: false };
    }

    return { exts: includeExts, ok: true };
}

function resolveMaxFiles(
    maxFilesRaw: string | undefined,
    reportError: ErrorReporter
): { code: number; ok: false } | { maxFiles: number | undefined; ok: true } {
    if (!isDefined(maxFilesRaw)) {
        return { maxFiles: undefined, ok: true };
    }

    const parsedMax = Number.parseInt(maxFilesRaw, 10);
    if (!isFinite(parsedMax) || parsedMax < 1) {
        reportError(
            "--max-files must be a positive integer.",
            "validation_error"
        );
        return { code: 1, ok: false };
    }

    return { maxFiles: parsedMax, ok: true };
}

function resolveMode(options: Readonly<ParsedOptions>): {
    confirm: boolean;
    dryRun: boolean;
    mode: Mode;
} {
    return {
        confirm: options["confirm"] === true || options["yes"] === true,
        dryRun: options["dry-run"] === true,
        mode: options["convert"] === true ? "convert" : "plan",
    };
}

function resolveSources(
    options: Readonly<ParsedOptions>,
    manifest: Readonly<ManifestFile>
): readonly string[] {
    const sourceFromManifest = toNonEmptyArray(manifest.sourceDirs);
    const sourceFromFlags = collectListOption(options, "source-dir");
    return [
        ...new Set(
            [...sourceFromManifest, ...sourceFromFlags].map((entry) =>
                resolve(entry)
            )
        ),
    ];
}

function resolveTokenValue(
    inlineValue: string | undefined,
    nextToken: string | undefined
): string {
    if (isDefined(inlineValue)) {
        return inlineValue;
    }

    if (isDefined(nextToken) && !nextToken.startsWith("--")) {
        return nextToken;
    }

    return "";
}

function toNonEmptyArray(
    value: readonly string[] | undefined
): readonly string[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
}

function validateSourceDirectories(
    sourceDirs: readonly string[],
    reportError: ErrorReporter
): { code: number; ok: false } | { ok: true } {
    if (isEmpty(sourceDirs)) {
        reportError(
            "at least one --source-dir is required (or sourceDirs in --manifest).",
            "validation_error"
        );
        return { code: 1, ok: false };
    }

    for (const sourceDir of sourceDirs) {
        if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
            reportError(
                `source directory does not exist: ${sourceDir}`,
                "validation_error"
            );
            return { code: 1, ok: false };
        }
    }

    return { ok: true };
}

function writeErr(message: string): void {
    process.stderr.write(`${message}\n`);
}

// ─── Output formatting ────────────────────────────────────────────────────────

function writeIndexFile(
    indexFile: string,
    entries: readonly Readonly<FontIndexEntry>[]
): void {
    mkdirSync(dirname(indexFile), { recursive: true });
    writeFileSync(indexFile, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
}

// ─── Entry points ─────────────────────────────────────────────────────────────

function writeOut(message: string): void {
    process.stdout.write(`${message}\n`);
}

const isDirectExecution =
    typeof process.argv[1] === "string" &&
    fileURLToPath(import.meta.url) === process.argv[1];

/**
 * Runs the CLI using `process.argv` and sets `process.exitCode` accordingly.
 */
export function runCli(): void {
    process.exitCode = main(process.argv.slice(2));
}

if (isDirectExecution) {
    runCli();
}
