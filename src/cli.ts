#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, normalize, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { printHelp } from "./cli-help.js";
import { type ErrorCategory, type FontIndexEntry, type Mode, type ParsedOptions, type PlannedFontFile, type RunSummary } from "./cli-types.js";

type ExecutionConfig = {
    confirm: boolean;
    converter: string;
    converterArgs: string[];
    dryRun: boolean;
    failFast: boolean;
    includeExts: Set<string>;
    indexFile?: string;
    jsonOutput: boolean;
    maxFiles?: number;
    mode: Mode;
    outDir: string;
    sourceDirs: string[];
    tempDir: string;
    verbose: boolean;
};

type ManifestFile = {
    converter?: string;
    converterArgs?: string[];
    includeExts?: string[];
    indexFile?: string;
    maxFiles?: number;
    outDir?: string;
    sourceDirs?: string[];
    tempDir?: string;
};

function parseArguments(args: string[]): ParsedOptions {
    const parsed: ParsedOptions = {};

    for (let index = 0; index < args.length; index += 1) {
        const token = args[index];
        if (!token?.startsWith("--")) {
            continue;
        }

        const [rawKey, inlineValue] = token.slice(2).split("=", 2);
        const key = (rawKey ?? "").trim();

        if (
            key === "help" ||
            key === "dry-run" ||
            key === "confirm" ||
            key === "yes" ||
            key === "convert" ||
            key === "json" ||
            key === "verbose" ||
            key === "fail-fast"
        ) {
            parsed[key] = true;
            continue;
        }

        const nextToken = args[index + 1];
        const value =
            inlineValue ??
            (nextToken && !nextToken.startsWith("--") ? nextToken : "");

        if (
            inlineValue === undefined &&
            typeof nextToken === "string" &&
            !nextToken.startsWith("--")
        ) {
            index += 1;
        }

        if (
            key === "source-dir" ||
            key === "converter-arg" ||
            key === "include-ext"
        ) {
            const existing = parsed[key];
            const bucket = Array.isArray(existing) ? existing : [];
            bucket.push(value);
            parsed[key] = bucket;
            continue;
        }

        parsed[key] = value;
    }

    return parsed;
}

function emitError(
    message: string,
    category: ErrorCategory,
    asJson: boolean
): number {
    if (asJson) {
        console.error(
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
        return 1;
    }

    console.error(`Error: ${message}`);
    return 1;
}

function collectListOption(options: ParsedOptions, key: string): string[] {
    const value = options[key];

    if (Array.isArray(value)) {
        return value
            .flatMap((part) => part.split(","))
            .map((part) => part.trim())
            .filter((part) => part.length > 0);
    }

    if (typeof value === "string") {
        return value
            .split(",")
            .map((part) => part.trim())
            .filter((part) => part.length > 0);
    }

    return [];
}

function getStringOption(options: ParsedOptions, key: string): string | undefined {
    const value = options[key];
    if (typeof value !== "string") {
        return undefined;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function parseManifest(pathToManifest: string): ManifestFile {
    const raw = readFileSync(pathToManifest, "utf8");
    const parsed = JSON.parse(raw) as unknown;

    if (typeof parsed !== "object" || parsed === null) {
        throw new Error("manifest root must be a JSON object");
    }

    const manifest = parsed as Record<string, unknown>;

    const getString = (key: string): string | undefined =>
        typeof manifest[key] === "string" ? manifest[key] : undefined;
    const getStringArray = (key: string): string[] | undefined => {
        const value = manifest[key];
        if (!Array.isArray(value)) {
            return undefined;
        }

        const entries = value.filter((entry): entry is string => typeof entry === "string");
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

function toNonEmptyArray(value: string[] | undefined): string[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
}

function normalizeExtList(entries: string[]): Set<string> {
    const normalized = entries
        .map((entry) => entry.trim().toLowerCase())
        .map((entry) => (entry.startsWith(".") ? entry.slice(1) : entry))
        .filter((entry) => entry.length > 0);

    return new Set(normalized);
}

function buildExecutionConfig(options: ParsedOptions): ExecutionConfig | number {
    const jsonOutput = options["json"] === true;

    if (options["help"] === true) {
        printHelp();
        return 0;
    }

    const manifestPath = getStringOption(options, "manifest");
    let manifest: ManifestFile = {};

    if (typeof manifestPath === "string") {
        try {
            manifest = parseManifest(resolve(manifestPath));
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return emitError(
                `failed to read --manifest file: ${message}`,
                "validation_error",
                jsonOutput
            );
        }
    }

    const sourceFromManifest = toNonEmptyArray(manifest.sourceDirs);
    const sourceFromFlags = collectListOption(options, "source-dir");
    const sourceDirs = Array.from(
        new Set(
            [...sourceFromManifest, ...sourceFromFlags].map((entry) =>
                resolve(entry)
            )
        )
    );

    if (sourceDirs.length === 0) {
        return emitError(
            "at least one --source-dir is required (or sourceDirs in --manifest).",
            "validation_error",
            jsonOutput
        );
    }

    for (const sourceDir of sourceDirs) {
        if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
            return emitError(
                `source directory does not exist: ${sourceDir}`,
                "validation_error",
                jsonOutput
            );
        }
    }

    const mode: Mode = options["convert"] === true ? "convert" : "plan";
    const dryRun = options["dry-run"] === true;
    const confirm = options["confirm"] === true || options["yes"] === true;

    if (mode === "convert" && !dryRun && !confirm) {
        return emitError(
            "Safety stop: pass --confirm for conversion, or use --dry-run.",
            "validation_error",
            jsonOutput
        );
    }

    const includeFromManifest = toNonEmptyArray(manifest.includeExts);
    const includeFromFlags = collectListOption(options, "include-ext");
    let includeEntries = ["ttf", "otf"];
    if (includeFromManifest.length > 0) {
        includeEntries = includeFromManifest;
    }
    if (includeFromFlags.length > 0) {
        includeEntries = includeFromFlags;
    }

    const includeExts = normalizeExtList(includeEntries);

    const unsupportedExts = Array.from(includeExts).filter(
        (ext) => ext !== "ttf" && ext !== "otf"
    );
    if (unsupportedExts.length > 0) {
        return emitError(
            `unsupported --include-ext values: ${unsupportedExts.join(", ")} (allowed: ttf, otf).`,
            "validation_error",
            jsonOutput
        );
    }

    const maxFilesRaw =
        getStringOption(options, "max-files") ??
        (typeof manifest.maxFiles === "number" ? String(manifest.maxFiles) : undefined);
    const maxFiles =
        typeof maxFilesRaw === "string"
            ? Number.parseInt(maxFilesRaw, 10)
            : undefined;

    if (
        maxFilesRaw !== undefined &&
        (!Number.isFinite(maxFiles) || (maxFiles ?? 0) < 1)
    ) {
        return emitError(
            "--max-files must be a positive integer.",
            "validation_error",
            jsonOutput
        );
    }

    const outDir = resolve(
        getStringOption(options, "out-dir") ??
            manifest.outDir ??
            "assets/woff2"
    );
    const tempDir = resolve(
        getStringOption(options, "temp-dir") ??
            manifest.tempDir ??
            "temp/work"
    );
    const indexFile =
        getStringOption(options, "index-file") ?? manifest.indexFile;

    const converter =
        getStringOption(options, "converter") ?? manifest.converter ?? "woff2_compress";
    if (converter.trim().length === 0) {
        return emitError(
            "--converter must be a non-empty command.",
            "validation_error",
            jsonOutput
        );
    }

    const converterArgs = [
        ...toNonEmptyArray(manifest.converterArgs),
        ...collectListOption(options, "converter-arg"),
    ];

    const config: ExecutionConfig = {
        confirm,
        converter,
        converterArgs,
        dryRun,
        failFast: options["fail-fast"] === true,
        includeExts,
        jsonOutput,
        mode,
        outDir,
        sourceDirs,
        tempDir,
        verbose: options["verbose"] === true,
    };

    if (typeof indexFile === "string") {
        config.indexFile = resolve(indexFile);
    }

    if (typeof maxFiles === "number") {
        config.maxFiles = maxFiles;
    }

    return config;
}

function listFontFiles(sourceDir: string, includeExts: Set<string>): string[] {
    const discovered: string[] = [];
    const queue: string[] = [sourceDir];

    while (queue.length > 0) {
        const current = queue.shift();
        if (typeof current !== "string") {
            continue;
        }

        const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) =>
            a.name.localeCompare(b.name)
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
            if (includeExts.has(extension)) {
                discovered.push(absolutePath);
            }
        }
    }

    return discovered;
}

function buildPlan(config: ExecutionConfig): PlannedFontFile[] {
    const plans: PlannedFontFile[] = [];

    for (const sourceDir of config.sourceDirs) {
        const files = listFontFiles(sourceDir, config.includeExts);
        const sourceRoot = basename(sourceDir);

        for (const sourcePath of files) {
            const relativeInputPath = normalize(relative(sourceDir, sourcePath));
            const relativeOutputPath = normalize(
                join(
                    sourceRoot,
                    relativeInputPath.replace(/\.(ttf|otf)$/iu, ".woff2")
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

    const sorted = plans.toSorted((left, right) =>
        left.relativeOutputPath.localeCompare(right.relativeOutputPath)
    );

    if (typeof config.maxFiles === "number") {
        return sorted.slice(0, config.maxFiles);
    }

    return sorted;
}

function writeIndexFile(indexFile: string, entries: FontIndexEntry[]): void {
    mkdirSync(dirname(indexFile), { recursive: true });
    writeFileSync(indexFile, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
}

function buildIndexEntries(
    config: ExecutionConfig,
    plan: PlannedFontFile[],
    convertedTargets: Set<string>
): FontIndexEntry[] {
    const entries: FontIndexEntry[] = [];

    for (const planned of plan) {
        const outputPath = resolve(join(config.outDir, planned.relativeOutputPath));
        const converted = convertedTargets.has(outputPath);

        const firstSegment = planned.relativeOutputPath.split(/[\\/]/u)[0] ?? "unknown";

        let sizeBytes: number | null = null;
        if (existsSync(outputPath)) {
            sizeBytes = statSync(outputPath).size;
        }

        entries.push({
            converted,
            family: firstSegment,
            fileName: planned.relativeOutputPath.split(/[\\/]/u).at(-1) ?? "",
            outputPath,
            sizeBytes,
            sourcePath: planned.sourcePath,
        });
    }

    return entries;
}

function convertFonts(config: ExecutionConfig, plan: PlannedFontFile[]): RunSummary {
    const startedAt = Date.now();

    let converted = 0;
    const failures: string[] = [];
    const convertedTargets = new Set<string>();

    if (config.mode === "convert" && !config.dryRun) {
        mkdirSync(config.tempDir, { recursive: true });
        mkdirSync(config.outDir, { recursive: true });
    }

    for (const planned of plan) {
        const outputPath = resolve(join(config.outDir, planned.relativeOutputPath));

        if (config.mode !== "convert" || config.dryRun) {
            continue;
        }

        const stagedInput = resolve(
            join(config.tempDir, "staging", planned.sourceRoot, planned.relativeInputPath)
        );
        mkdirSync(dirname(stagedInput), { recursive: true });
        copyFileSync(planned.sourcePath, stagedInput);

        const commandResult = spawnSync(config.converter, [...config.converterArgs, stagedInput], {
            encoding: "utf8",
            shell: false,
        });

        if (commandResult.status !== 0) {
            const stderr = commandResult.stderr.trim();
            const stdout = commandResult.stdout.trim();
            let message = "converter exited with non-zero status";
            if (stdout.length > 0) {
                message = stdout;
            }
            if (stderr.length > 0) {
                message = stderr;
            }

            failures.push(`${planned.sourcePath}: ${message}`);
            if (config.failFast) {
                break;
            }
            continue;
        }

        const stagedOutput = stagedInput.replace(/\.(ttf|otf)$/iu, ".woff2");
        if (!existsSync(stagedOutput)) {
            failures.push(
                `${planned.sourcePath}: converter did not produce expected .woff2 output`
            );
            if (config.failFast) {
                break;
            }
            continue;
        }

        mkdirSync(dirname(outputPath), { recursive: true });
        copyFileSync(stagedOutput, outputPath);
        convertedTargets.add(outputPath);
        converted += 1;
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

function printTextSummary(summary: RunSummary, verbose: boolean): void {
    console.log(`Mode: ${summary.mode}${summary.dryRun ? " (dry-run)" : ""}`);
    console.log(`Planned files: ${summary.planned}`);
    console.log(`Converted files: ${summary.converted}`);
    console.log(`Failed files: ${summary.failed}`);
    console.log(`Skipped files: ${summary.skipped}`);
    console.log(`Output directory: ${summary.outDir}`);

    if (typeof summary.indexFile === "string") {
        console.log(`Index file: ${summary.indexFile}`);
    }

    if (verbose && summary.failures.length > 0) {
        console.log("");
        console.log("Failures:");
        for (const failure of summary.failures) {
            console.log(`- ${failure}`);
        }
    }
}

export function main(argv: string[]): number {
    const options = parseArguments(argv);
    const configOrCode = buildExecutionConfig(options);

    if (typeof configOrCode === "number") {
        return configOrCode;
    }

    const config = configOrCode;
    const plan = buildPlan(config);

    if (!config.jsonOutput && config.verbose) {
        for (const planned of plan) {
            console.log(`${planned.sourcePath} -> ${join(config.outDir, planned.relativeOutputPath)}`);
        }
        if (plan.length > 0) {
            console.log("");
        }
    }

    const summary = convertFonts(config, plan);

    if (config.jsonOutput) {
        console.log(JSON.stringify(summary, null, 2));
    } else {
        printTextSummary(summary, config.verbose);
    }

    return summary.failed > 0 ? 2 : 0;
}

const isDirectExecution =
    typeof process.argv[1] === "string" &&
    fileURLToPath(import.meta.url) === process.argv[1];

export function runCli(): void {
    process.exitCode = main(process.argv.slice(2));
}

if (isDirectExecution) {
    runCli();
}
