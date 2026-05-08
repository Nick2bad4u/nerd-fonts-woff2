import type { UnknownRecord } from "type-fest";

import { execFile } from "node:child_process";
import {
    closeSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    readSync,
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

// ─── Color helpers ────────────────────────────────────────────────────────────

function colText(
    text: string,
    code: string,
    stream: Readonly<{ isTTY?: boolean }> = process.stdout
): string {
    return supportsColor(stream) ? `\u001B[${code}m${text}\u001B[0m` : text;
}

function supportsColor(stream: Readonly<{ isTTY?: boolean }>): boolean {
    return stream.isTTY === true;
}

const c = {
    bold: (t: string): string => colText(t, "1"),
    cyan: (t: string): string => colText(t, "36"),
    dim: (t: string): string => colText(t, "2"),
    green: (t: string): string => colText(t, "32"),
    magenta: (t: string): string => colText(t, "35"),
    red: (t: string): string => colText(t, "31"),
    yellow: (t: string): string => colText(t, "33"),
};

// ─── Local types ──────────────────────────────────────────────────────────────

type BuildConfigResult =
    | { readonly code: number; readonly ok: false }
    | { readonly config: ExecutionConfig; readonly ok: true };

type ErrorReporter = (message: string, category: ErrorCategory) => void;

type ExecutionConfig = {
    concurrency: number;
    confirm: boolean;
    converter: string;
    converterArgs: readonly string[];
    debug: boolean;
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
    timeout?: number;
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
export async function main(argv: readonly string[]): Promise<number> {
    const options = parseArguments(argv);
    const result = buildExecutionConfig(options);

    if (!result.ok) {
        return result.code;
    }

    const { config } = result;
    const plan = buildPlan(config);

    if (config.debug) {
        writeOut(c.dim(`[debug] converter: ${config.converter}`));
        writeOut(c.dim(`[debug] concurrency: ${String(config.concurrency)}`));
        writeOut(
            c.dim(
                `[debug] timeout: ${
                    typeof config.timeout === "number"
                        ? `${String(config.timeout)} ms`
                        : "none"
                }`
            )
        );
        writeOut(c.dim(`[debug] outDir: ${config.outDir}`));
        writeOut(c.dim(`[debug] tempDir: ${config.tempDir}`));
        writeOut(c.dim(`[debug] planned files: ${String(plan.length)}`));
        writeOut("");
    }

    if (!config.jsonOutput && config.verbose) {
        for (const planned of plan) {
            const ext = extname(planned.sourcePath).slice(1).toLowerCase();
            const extLabel = `[.${ext}]`;
            writeOut(
                `  ${c.cyan(planned.sourcePath)} ${c.dim("\u2192")} ${c.magenta(join(config.outDir, planned.relativeOutputPath))} ${c.dim(extLabel)}`
            );
        }

        if (plan.length > 0) {
            writeOut("");
        }
    }

    const summary = await convertFonts(config, plan);

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

    const concurrencyRaw = getStringOption(options, "concurrency");
    const concurrencyResult = resolveConcurrency(concurrencyRaw, reportError);
    if (!concurrencyResult.ok) {
        return concurrencyResult;
    }

    const timeoutRaw = getStringOption(options, "timeout");
    const timeoutResult = resolveTimeout(timeoutRaw, reportError);
    if (!timeoutResult.ok) {
        return timeoutResult;
    }

    const debug = options["debug"] === true;

    const { indexFileRaw, outDir, tempDir } = resolveDirectories(
        options,
        manifest
    );

    const config: ExecutionConfig = {
        concurrency: concurrencyResult.concurrency,
        confirm,
        converter: converterResult.cmd,
        converterArgs: converterResult.args,
        debug,
        dryRun,
        failFast: options["fail-fast"] === true,
        includeExts: extsResult.exts,
        jsonOutput,
        mode,
        outDir,
        sourceDirs,
        tempDir,
        verbose: debug || options["verbose"] === true,
        ...(typeof maxResult.maxFiles === "number"
            ? { maxFiles: maxResult.maxFiles }
            : {}),
        ...(typeof indexFileRaw === "string"
            ? { indexFile: resolve(indexFileRaw) }
            : {}),
        ...(typeof timeoutResult.timeout === "number"
            ? { timeout: timeoutResult.timeout }
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

async function convertFonts(
    config: Readonly<ExecutionConfig>,
    plan: readonly Readonly<PlannedFontFile>[]
): Promise<RunSummary> {
    const startedAt = Date.now();
    let converted = 0;
    const failures: string[] = [];
    const convertedTargets = new Set<string>();
    let shouldStop = false;

    if (config.mode === "convert" && !config.dryRun) {
        mkdirSync(config.tempDir, { recursive: true });
        mkdirSync(config.outDir, { recursive: true });

        const queue = [...plan];
        const limit = Math.max(
            1,
            Math.min(config.concurrency, plan.length > 0 ? plan.length : 1)
        );

        const worker = async (): Promise<void> => {
            while (queue.length > 0 && !shouldStop) {
                const planned = queue.shift();
                if (!isDefined(planned)) {
                    continue;
                }

                const outputPath = resolve(
                    join(config.outDir, planned.relativeOutputPath)
                );

                if (config.debug) {
                    writeOut(
                        c.dim(`[debug] converting: ${planned.sourcePath}`)
                    );
                }

                // eslint-disable-next-line no-await-in-loop -- intentional: sequential within this worker; parallelism is achieved across multiple workers
                const result = await convertSingleFont(
                    config,
                    planned,
                    outputPath,
                    convertedTargets,
                    failures
                );

                if (result === "converted") {
                    converted += 1;
                    if (config.verbose) {
                        writeOut(
                            `  ${c.green("\u2714")} ${c.cyan(basename(planned.sourcePath))}`
                        );
                    }
                } else if (result === "failed-break") {
                    // eslint-disable-next-line require-atomic-updates -- Node.js is single-threaded; no true race between check and assignment
                    shouldStop = true;
                } else if (result === "failed-continue" && config.verbose) {
                    writeOut(
                        `  ${c.red("\u2716")} ${c.cyan(basename(planned.sourcePath))}`
                    );
                }
            }
        };

        if (plan.length > 0) {
            await Promise.all(Array.from({ length: limit }, worker));
        }
    }

    if (
        config.mode === "convert" &&
        !config.dryRun &&
        typeof config.indexFile === "string"
    ) {
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

    if (
        config.mode === "convert" &&
        !config.dryRun &&
        typeof config.indexFile === "string"
    ) {
        summary.indexFile = config.indexFile;
    }

    return summary;
}

async function convertSingleFont(
    config: Readonly<ExecutionConfig>,
    planned: Readonly<PlannedFontFile>,
    outputPath: string,
    convertedTargets: Set<string>,
    // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- failures accumulator is mutated via push() to collect error messages
    failures: string[]
): Promise<SingleFontResult> {
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

    const commandResult = await runConverter(
        config.converter,
        [...config.converterArgs, stagedInput],
        config.timeout
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

    if (!isValidWoff2File(stagedOutput)) {
        failures.push(
            `${planned.sourcePath}: converter output failed WOFF2 magic bytes validation`
        );
        return config.failFast ? "failed-break" : "failed-continue";
    }

    mkdirSync(dirname(outputPath), { recursive: true });
    copyFileSync(stagedOutput, outputPath);
    convertedTargets.add(outputPath);
    return "converted";
}

// ─── WOFF2 validation ─────────────────────────────────────────────────────────

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

// ─── Converter runner ─────────────────────────────────────────────────────────

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

// ─── Argument parsing ─────────────────────────────────────────────────────────
function isBooleanFlag(key: string): boolean {
    return (
        key === "debug" ||
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

function isListFlag(key: string): boolean {
    return (
        key === "source-dir" || key === "converter-arg" || key === "include-ext"
    );
}

// ─── Manifest parsing ─────────────────────────────────────────────────────────

/**
 * Validates that a file begins with the WOFF2 magic bytes (0x774F4632 =
 * "wOF2"). Returns `false` if the file cannot be read or is too short.
 */
function isValidWoff2File(filePath: string): boolean {
    // WOFF2 magic: "wOF2" = 0x77 0x4F 0x46 0x32
    const magic = [
        0x77,
        0x4f,
        0x46,
        0x32,
    ] as const;
    try {
        const fd = openSync(filePath, "r");
        const buffer = Buffer.alloc(4);
        let bytesRead = 0;
        try {
            bytesRead = readSync(fd, buffer, 0, 4, 0);
        } finally {
            closeSync(fd);
        }
        return (
            bytesRead === 4 &&
            buffer[0] === arrayFirst(magic) &&
            buffer[1] === magic[1] &&
            buffer[2] === magic[2] &&
            buffer[3] === magic[3]
        );
    } catch {
        return false;
    }
}

// ─── Font discovery ───────────────────────────────────────────────────────────

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

// ─── Index building ───────────────────────────────────────────────────────────

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

function normalizeExtList(entries: readonly string[]): ReadonlySet<string> {
    const normalized = entries
        .map((entry) => entry.trim().toLowerCase())
        .map((entry) => (entry.startsWith(".") ? entry.slice(1) : entry))
        .filter((entry) => entry.length > 0);

    return new Set(normalized);
}

// ─── Build plan ───────────────────────────────────────────────────────────────

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

// ─── Conversion ───────────────────────────────────────────────────────────────

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
    const modeLabel = `${summary.mode}${summary.dryRun ? " (dry-run)" : ""}`;
    writeOut(`Mode:             ${c.bold(modeLabel)}`);
    writeOut(`Planned files:    ${c.cyan(String(summary.planned))}`);
    writeOut(
        `Converted files:  ${
            summary.converted > 0
                ? c.green(String(summary.converted))
                : String(summary.converted)
        }`
    );
    writeOut(
        `Failed files:     ${
            summary.failed > 0
                ? c.red(String(summary.failed))
                : String(summary.failed)
        }`
    );
    writeOut(`Skipped files:    ${String(summary.skipped)}`);
    const durationStr = `${String(summary.durationMs)} ms`;
    writeOut(`Duration:         ${c.dim(durationStr)}`);
    writeOut(`Output directory: ${summary.outDir}`);

    if (typeof summary.indexFile === "string") {
        writeOut(`Index file: ${summary.indexFile}`);
    }

    if (verbose && summary.failures.length > 0) {
        writeOut("");
        writeOut(c.bold(c.red("Failures:")));
        for (const failure of summary.failures) {
            writeOut(`  ${c.red("\u2716")} ${failure}`);
        }
    }
}

function resolveConcurrency(
    raw: string | undefined,
    reportError: ErrorReporter
): { code: number; ok: false } | { concurrency: number; ok: true } {
    if (!isDefined(raw)) {
        return { concurrency: 1, ok: true };
    }

    const parsed = Number.parseInt(raw, 10);
    if (!isFinite(parsed) || parsed < 1) {
        reportError(
            "--concurrency must be a positive integer.",
            "validation_error"
        );
        return { code: 1, ok: false };
    }

    return { concurrency: parsed, ok: true };
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

function resolveDirectories(
    options: Readonly<ParsedOptions>,
    manifest: Readonly<ManifestFile>
): { indexFileRaw: string | undefined; outDir: string; tempDir: string } {
    const outDir = resolve(
        getStringOption(options, "out-dir") ?? manifest.outDir ?? "assets/woff2"
    );

    return {
        indexFileRaw:
            getStringOption(options, "index-file") ??
            manifest.indexFile ??
            join(outDir, "index.json"),
        outDir,
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

// ─── Config builder ───────────────────────────────────────────────────────────

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

function resolveTimeout(
    raw: string | undefined,
    reportError: ErrorReporter
): { code: number; ok: false } | { ok: true; timeout: number | undefined } {
    if (!isDefined(raw)) {
        return { ok: true, timeout: 60_000 };
    }

    const parsed = Number.parseInt(raw, 10);
    if (!isFinite(parsed) || parsed < 1) {
        reportError(
            "--timeout must be a positive integer (milliseconds).",
            "validation_error"
        );
        return { code: 1, ok: false };
    }

    return { ok: true, timeout: parsed };
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

/**
 * Runs an external converter process asynchronously. Resolves with the exit
 * status and captured stdout/stderr. If `timeout` is provided (in
 * milliseconds), the process is killed after that time.
 */
async function runConverter(
    cmd: string,
    args: readonly string[],
    timeout: number | undefined
): Promise<{ status: number; stderr: string; stdout: string }> {
    return new Promise<{ status: number; stderr: string; stdout: string }>(
        (_resolve) => {
            execFile(
                cmd,
                [...args],
                { timeout: timeout ?? 0 },
                function onConverterDone(error, stdout, stderr) {
                    if (error === null) {
                        _resolve({ status: 0, stderr, stdout });
                    } else {
                        const status =
                            typeof error.code === "number" ? error.code : 1;
                        _resolve({ status, stderr, stdout });
                    }
                }
            );
        }
    );
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
    void (async () => {
        // Store result before assigning to avoid require-atomic-updates
        const exitCode = await main(process.argv.slice(2));
        // eslint-disable-next-line require-atomic-updates -- intentional: we own process.exitCode
        process.exitCode = exitCode;
    })();
}

if (isDirectExecution) {
    runCli();
}
