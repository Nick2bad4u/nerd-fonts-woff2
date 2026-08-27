#!/usr/bin/env node

/**
 * Parallel WOFF2 bulk converter for Nerd Fonts.
 *
 * Converts all TTF/OTF source files to WOFF2 using reusable, isolated child
 * processes. A per-font timeout retires and replaces only the affected worker,
 * while successful workers keep their loaded native converter for later jobs.
 *
 * Reads: fonts/original/** /_.{ttf,otf} Writes: fonts/woff2/** /_.woff2
 * (mirrors the source tree) fonts/woff2/index.json (FontIndexEntry array)
 *
 * Reuses current WOFF2 outputs unless --force is passed. --failed-only adds a
 * safety gate that requires at least one reusable staged output.
 *
 * Usage: node scripts/bulk-convert-fonts.mjs --dry-run node
 * scripts/bulk-convert-fonts.mjs --convert --confirm --force node
 * scripts/bulk-convert-fonts.mjs --convert --confirm --failed-only
 */

import {
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
    DEFAULT_CONVERSION_CONCURRENCY,
    DEFAULT_FONT_TIMEOUT_SECONDS,
    DEFAULT_TIMEOUT_RETRIES,
    FAILURE_DETAIL_LIMIT,
    MAX_FONT_TIMEOUT_SECONDS,
    MAX_TIMEOUT_RETRIES,
    createConversionPasses,
    isFontTimeoutMessage,
    partitionConversionFailures,
} from "./font-conversion-policy.mjs";
import { FontConversionProcessPool } from "./font-conversion-process-pool.mjs";
import {
    assertPathInsideRepository,
    isMainModule,
} from "./nerd-fonts-release.mjs";
import {
    ANSI,
    formatBytes,
    formatDuration,
    renderProgressBar,
    resolveColorEnabled,
    styleText,
} from "./terminal-output.mjs";
import { atomicWriteJson } from "./safe-filesystem.mjs";

const repoRoot = process.cwd();
/** @type {BulkOptions} */
let options;
/** @type {unknown} */
let optionError;
try {
    options = parseBulkOptions(process.argv.slice(2), repoRoot);
} catch (error) {
    optionError = error;
    options = parseBulkOptions(["--dry-run"], repoRoot);
}
const sourceRoot = options.sourceDir;
const outputRoot = options.outputDir;
const indexFile = resolve(outputRoot, "index.json");
const workerScript = new URL("./woff2-convert-worker.mjs", import.meta.url);

const dryRun = options.dryRun || !options.convert;
const force = options.force;
const verbose = options.verbose;
const colorEnabled = resolveColorEnabled(options.color, process.stdout);

const CONCURRENCY = options.concurrency;
const FONT_TIMEOUT_MS = options.timeoutSeconds * 1000;
const CONVERSION_PASSES = createConversionPasses(
    CONCURRENCY,
    options.timeoutSeconds,
    options.timeoutRetries
);
const WOFF2_HEADER_SIZE = 48;

/**
 * @typedef {{
 *     convertMs: number | null;
 *     moduleMs: number;
 *     overheadMs: number | null;
 *     queueMs: number;
 *     readMs: number | null;
 *     totalMs: number;
 *     workerId: number;
 *     workerMs: number;
 *     workerReused: boolean;
 *     writeMs: number | null;
 * }} FontConversionTimings
 */

/**
 * @typedef {{
 *     color: boolean | null;
 *     concurrency: number;
 *     confirm: boolean;
 *     convert: boolean;
 *     dryRun: boolean;
 *     failedOnly: boolean;
 *     failureReport: string;
 *     force: boolean;
 *     outputDir: string;
 *     prune: boolean;
 *     publicOutputDir: string;
 *     publicSourceDir: string;
 *     sourceDir: string;
 *     timeoutRetries: number;
 *     timeoutSeconds: number;
 *     verbose: boolean;
 * }} BulkOptions
 */

/**
 * @param {readonly string[]} argumentsList
 * @param {string} root
 *
 * @returns {BulkOptions}
 */
export function parseBulkOptions(argumentsList, root = process.cwd()) {
    /** @type {BulkOptions} */
    const parsed = {
        color: null,
        concurrency: DEFAULT_CONVERSION_CONCURRENCY,
        confirm: false,
        convert: false,
        dryRun: false,
        failedOnly: false,
        failureReport: "",
        force: false,
        outputDir: resolve(root, "fonts", "woff2"),
        prune: false,
        publicOutputDir: "fonts/woff2",
        publicSourceDir: "fonts/original",
        sourceDir: resolve(root, "fonts", "original"),
        timeoutRetries: DEFAULT_TIMEOUT_RETRIES,
        timeoutSeconds: DEFAULT_FONT_TIMEOUT_SECONDS,
        verbose: false,
    };

    for (let index = 0; index < argumentsList.length; index += 1) {
        const argument = argumentsList[index];
        if (
            argument === "--color" ||
            argument === "--confirm" ||
            argument === "--convert" ||
            argument === "--dry-run" ||
            argument === "--failed-only" ||
            argument === "--force" ||
            argument === "--no-color" ||
            argument === "--prune" ||
            argument === "--verbose"
        ) {
            const key = argument.slice(2).replace("-", "");
            if (key === "color") {
                if (parsed.color === false) {
                    throw new Error(
                        "--color and --no-color cannot be combined."
                    );
                }

                parsed.color = true;
            } else if (key === "nocolor") {
                if (parsed.color === true) {
                    throw new Error(
                        "--color and --no-color cannot be combined."
                    );
                }

                parsed.color = false;
            } else if (key === "dryrun") parsed.dryRun = true;
            else if (key === "confirm") parsed.confirm = true;
            else if (key === "convert") parsed.convert = true;
            else if (key === "force") parsed.force = true;
            else if (key === "failedonly") parsed.failedOnly = true;
            else if (key === "prune") parsed.prune = true;
            else parsed.verbose = true;
            continue;
        }

        const equalsMatch =
            /^--(concurrency|failure-report|timeout|timeout-retries)=(.+)$/v.exec(
                argument ?? ""
            );
        if (equalsMatch !== null) {
            const [
                ,
                name,
                value,
            ] = equalsMatch;
            if (name === "concurrency") {
                parsed.concurrency = parseIntegerOption(
                    value ?? "",
                    "--concurrency",
                    1,
                    32
                );
            } else if (name === "failure-report") {
                parsed.failureReport = resolve(root, value ?? "");
            } else if (name === "timeout-retries") {
                parsed.timeoutRetries = parseIntegerOption(
                    value ?? "",
                    "--timeout-retries",
                    0,
                    MAX_TIMEOUT_RETRIES
                );
            } else {
                parsed.timeoutSeconds = parseIntegerOption(
                    value ?? "",
                    "--timeout",
                    1,
                    MAX_FONT_TIMEOUT_SECONDS
                );
            }

            continue;
        }

        if (
            argument === "--concurrency" ||
            argument === "--failure-report" ||
            argument === "--output-dir" ||
            argument === "--public-output-dir" ||
            argument === "--public-source-dir" ||
            argument === "--source-dir" ||
            argument === "--timeout" ||
            argument === "--timeout-retries"
        ) {
            const value = argumentsList[index + 1];
            if (typeof value !== "string" || value.trim().length === 0) {
                throw new Error(`${argument} requires a non-empty value.`);
            }

            if (argument === "--concurrency") {
                parsed.concurrency = parseIntegerOption(value, argument, 1, 32);
            } else if (argument === "--failure-report") {
                parsed.failureReport = resolve(root, value);
            } else if (argument === "--output-dir") {
                parsed.outputDir = resolve(root, value);
            } else if (argument === "--public-output-dir") {
                parsed.publicOutputDir = normalizePublicPath(value);
            } else if (argument === "--public-source-dir") {
                parsed.publicSourceDir = normalizePublicPath(value);
            } else if (argument === "--source-dir") {
                parsed.sourceDir = resolve(root, value);
            } else if (argument === "--timeout-retries") {
                parsed.timeoutRetries = parseIntegerOption(
                    value,
                    argument,
                    0,
                    MAX_TIMEOUT_RETRIES
                );
            } else {
                parsed.timeoutSeconds = parseIntegerOption(
                    value,
                    argument,
                    1,
                    MAX_FONT_TIMEOUT_SECONDS
                );
            }

            index += 1;
            continue;
        }

        throw new Error(`Unknown option: ${argument}`);
    }

    if (parsed.convert && !parsed.confirm && !parsed.dryRun) {
        throw new Error(
            "Real conversion requires both --convert and --confirm."
        );
    }

    if (parsed.prune && !parsed.convert && !parsed.dryRun) {
        throw new Error("--prune requires --convert and --confirm.");
    }
    if (parsed.failedOnly && !parsed.convert) {
        throw new Error("--failed-only requires --convert and --confirm.");
    }
    if (parsed.failedOnly && parsed.force) {
        throw new Error("--failed-only and --force cannot be combined.");
    }

    if (parsed.failureReport.length === 0) {
        parsed.failureReport = resolve(
            parsed.outputDir,
            ".conversion-failures.json"
        );
    }

    for (const checkedPath of [
        parsed.sourceDir,
        parsed.outputDir,
        parsed.failureReport,
    ]) {
        assertPathInsideRepository(root, checkedPath);
    }

    return parsed;
}

/**
 * @param {string} value
 * @param {string} optionName
 * @param {number} minimum
 * @param {number} maximum
 *
 * @returns {number}
 */
function parseIntegerOption(value, optionName, minimum, maximum) {
    const integerPattern = minimum === 0 ? /^(?:0|[1-9]\d*)$/v : /^[1-9]\d*$/v;
    if (!integerPattern.test(value)) {
        throw new Error(
            `${optionName} must be an integer from ${minimum} through ${maximum}.`
        );
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
        throw new Error(
            `${optionName} must be an integer from ${minimum} through ${maximum}.`
        );
    }
    return parsed;
}

/**
 * @param {string} value
 *
 * @returns {string}
 */
function normalizePublicPath(value) {
    if (
        isAbsolute(value) ||
        value.replaceAll("\\", "/").split("/").includes("..")
    ) {
        throw new Error(
            `Public index path must be repository-relative: ${value}`
        );
    }

    return value
        .replaceAll("\\", "/")
        .replace(/^\.\//v, "")
        .replace(/\/$/v, "");
}

/**
 * @typedef {{
 *     converted: boolean;
 *     family: string;
 *     fileName: string;
 *     outputPath: string;
 *     sizeBytes: number | null;
 *     sourcePath: string;
 * }} FontIndexEntry
 */

/**
 * Recursively collect all .ttf and .otf files under a directory.
 *
 * @param {string} directory - Root directory to walk.
 *
 * @returns {string[]} Absolute paths to matching font files.
 */
function collectSourceFonts(directory) {
    /** @type {string[]} */
    const results = [];
    const queue = [directory];

    while (queue.length > 0) {
        const current = queue.shift();
        if (typeof current !== "string") {
            continue;
        }

        for (const entry of readdirSync(current, { withFileTypes: true })) {
            const full = join(current, entry.name);
            if (entry.isDirectory()) {
                queue.push(full);
            } else if (/\.(?:otf|ttf)$/iu.test(entry.name)) {
                results.push(full);
            }
        }
    }

    return results.sort((a, b) => a.localeCompare(b));
}

/**
 * @param {string} directory
 *
 * @returns {string[]}
 */
function collectOutputFonts(directory) {
    if (!existsSync(directory)) {
        return [];
    }

    /** @type {string[]} */
    const results = [];
    const queue = [directory];
    while (queue.length > 0) {
        const current = queue.shift();
        if (typeof current !== "string") continue;

        for (const entry of readdirSync(current, { withFileTypes: true })) {
            const full = join(current, entry.name);
            if (entry.isDirectory()) queue.push(full);
            else if (entry.isFile() && /\.woff2$/iv.test(entry.name)) {
                results.push(full);
            }
        }
    }

    return results.sort((left, right) => left.localeCompare(right));
}

/**
 * Derive the WOFF2 output path that mirrors the source tree.
 *
 * @param {string} sourcePath
 *
 * @returns {string}
 */
function toOutputPath(sourcePath) {
    const rel = relative(sourceRoot, sourcePath);
    return resolve(outputRoot, rel.replace(/\.(?:otf|ttf)$/iu, ".woff2"));
}

/**
 * Create a portable repository-relative path for the committed asset index.
 *
 * @param {string} root
 * @param {string} filePath
 * @param {string} publicRoot
 *
 * @returns {string}
 */
function toPublicPath(root, filePath, publicRoot) {
    const relativePath = relative(root, filePath);
    return `${publicRoot}/${relativePath.split(sep).join("/")}`;
}

/**
 * Extract the top-level family name (first path segment under fonts/original).
 *
 * @param {string} sourcePath
 *
 * @returns {string}
 */
function extractFamily(sourcePath) {
    const rel = relative(sourceRoot, sourcePath);
    const first = rel.split(/[\\/]/u)[0];
    return typeof first === "string" && first.length > 0 ? first : "Unknown";
}

/**
 * Return true only when an existing output is plausibly complete and belongs to
 * the current staged source tree. Full catalog verification still runs before
 * promotion.
 *
 * @param {string} outputPath
 * @param {string} sourcePath
 *
 * @returns {boolean}
 */
export function isReusableOutput(outputPath, sourcePath) {
    if (!existsSync(outputPath)) return false;

    const outputStat = statSync(outputPath);
    const sourceStat = statSync(sourcePath);
    if (
        !outputStat.isFile() ||
        outputStat.size < WOFF2_HEADER_SIZE ||
        outputStat.mtimeMs < sourceStat.mtimeMs
    ) {
        return false;
    }

    const descriptor = openSync(outputPath, "r");
    try {
        const header = Buffer.allocUnsafe(WOFF2_HEADER_SIZE);
        if (
            readSync(descriptor, header, 0, WOFF2_HEADER_SIZE, 0) !==
            WOFF2_HEADER_SIZE
        ) {
            return false;
        }
        return (
            header.toString("ascii", 0, 4) === "wOF2" &&
            header.readUInt32BE(8) === outputStat.size
        );
    } finally {
        closeSync(descriptor);
    }
}

/**
 * @param {string} sourcePath
 * @param {boolean} converted
 *
 * @returns {FontIndexEntry}
 */
function createIndexEntry(sourcePath, converted) {
    const outputPath = toOutputPath(sourcePath);
    return {
        converted,
        family: extractFamily(sourcePath),
        fileName: outputPath.split(/[\\/]/u).at(-1) ?? "",
        outputPath: toPublicPath(
            outputRoot,
            outputPath,
            options.publicOutputDir
        ),
        sizeBytes: statSync(outputPath).size,
        sourcePath: toPublicPath(
            sourceRoot,
            sourcePath,
            options.publicSourceDir
        ),
    };
}

/**
 * Prevent source filenames from injecting terminal control sequences into
 * verbose output while keeping the repository-relative path recognizable.
 *
 * @param {string} value
 *
 * @returns {string}
 */
function sanitizeTerminalText(value) {
    return value.replaceAll(/[\u0000-\u001F\u007F-\u009F]/gv, (character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return `\\u${codePoint.toString(16).padStart(4, "0")}`;
    });
}

/**
 * @param {string} sourcePath
 *
 * @returns {string}
 */
function displayFontPath(sourcePath) {
    return sanitizeTerminalText(
        relative(sourceRoot, sourcePath).split(sep).join("/")
    );
}

/**
 * @param {number} completed
 * @param {number} total
 *
 * @returns {string}
 */
function progressPrefix(completed, total) {
    const countWidth = String(total).length;
    const count = `${String(completed).padStart(countWidth, " ")}/${total}`;
    const percentage = `${((completed / total) * 100).toFixed(1).padStart(5, " ")}%`;
    return (
        styleText(
            colorEnabled,
            ANSI.cyan,
            renderProgressBar(completed, total, 20)
        ) +
        ` ${styleText(colorEnabled, ANSI.bold, count)} ` +
        styleText(colorEnabled, ANSI.dim, percentage)
    );
}

/**
 * @param {string} sourcePath
 * @param {number} ordinal
 * @param {number} completed
 * @param {number} total
 * @param {number} active
 *
 * @returns {void}
 */
function printFontStart(sourcePath, ordinal, completed, total, active) {
    if (!verbose) return;
    const queuePosition = `queue ${ordinal}/${total}`;
    process.stdout.write(
        `  ${progressPrefix(completed, total)} ` +
            `${styleText(colorEnabled, [ANSI.bold, ANSI.magenta], "START")} ` +
            `${styleText(colorEnabled, ANSI.bold, displayFontPath(sourcePath))} ` +
            `${styleText(colorEnabled, ANSI.dim, `(${queuePosition}; active ${active})`)}\n`
    );
}

/**
 * @typedef {"DONE" | "FAIL" | "PLAN" | "SKIP"} FontProgressStatus
 */

/**
 * @param {FontProgressStatus} status
 *
 * @returns {string}
 */
function statusColor(status) {
    if (status === "DONE") return ANSI.green;
    if (status === "FAIL") return ANSI.red;
    if (status === "PLAN") return ANSI.cyan;
    return ANSI.yellow;
}

/**
 * @param {FontConversionTimings} timings
 *
 * @returns {string[]}
 */
export function formatConversionTimings(timings) {
    const workerLabel = timings.workerReused
        ? `worker #${timings.workerId} reused`
        : `worker #${timings.workerId} ${formatDuration(timings.workerMs)}`;
    const details = [
        workerLabel,
        timings.workerReused
            ? "module cached"
            : `module ${formatDuration(timings.moduleMs)}`,
    ];
    if (timings.queueMs >= 1) {
        details.push(`queue ${formatDuration(timings.queueMs)}`);
    }

    if (
        timings.readMs === null ||
        timings.convertMs === null ||
        timings.writeMs === null
    ) {
        details.push("phases unavailable");
    } else {
        details.push(`read ${formatDuration(timings.readMs)}`);
        details.push(`convert ${formatDuration(timings.convertMs)}`);
        details.push(`write ${formatDuration(timings.writeMs)}`);
        if (timings.overheadMs !== null) {
            details.push(`overhead ${formatDuration(timings.overheadMs)}`);
        }
    }

    details.push(`total ${formatDuration(timings.totalMs)}`);
    return details;
}

/**
 * @param {FontProgressStatus} status
 * @param {string} sourcePath
 * @param {number} completed
 * @param {number} total
 * @param {number} active
 * @param {FontConversionTimings | null} timings
 * @param {number | null | undefined} sizeBytes
 *
 * @returns {void}
 */
function printFontResult(
    status,
    sourcePath,
    completed,
    total,
    active,
    timings,
    sizeBytes
) {
    if (!verbose) {
        if (completed % 50 === 0 || completed === total) {
            process.stdout.write(`  ${progressPrefix(completed, total)}\n`);
        }

        return;
    }

    const details = [];
    if (timings !== null) details.push(...formatConversionTimings(timings));
    if (typeof sizeBytes === "number") details.push(formatBytes(sizeBytes));
    details.push(`active ${active}`);
    process.stdout.write(
        `  ${progressPrefix(completed, total)} ` +
            `${styleText(colorEnabled, [ANSI.bold, statusColor(status)], status.padEnd(5, " "))} ` +
            `${styleText(colorEnabled, ANSI.bold, displayFontPath(sourcePath))} ` +
            `${styleText(colorEnabled, ANSI.dim, `(${details.join("; ")})`)}\n`
    );
}

/**
 * @typedef {{
 *     message: string;
 *     sourcePath: string;
 *     timedOut: boolean;
 *     timings: FontConversionTimings;
 * }} FontFailure
 */

/**
 * Run one conversion pass. The caller decides whether timeout failures receive
 * another pass with a more conservative worker policy.
 *
 * @param {readonly string[]} sourceFonts
 * @param {{ concurrency: number; timeoutSeconds: number }} pass
 *
 * @returns {Promise<{
 *     converted: number;
 *     convertedSources: string[];
 *     failures: FontFailure[];
 * }>}
 */
async function runConversionLoop(sourceFonts, pass) {
    const conversionPool = dryRun
        ? null
        : new FontConversionProcessPool({
              size: pass.concurrency,
              timeoutMs: pass.timeoutSeconds * 1000,
              workerUrl: workerScript,
          });
    /** @type {FontFailure[]} */
    const failures = [];
    /** @type {string[]} */
    const convertedSources = [];
    let converted = 0;
    let completed = 0;
    let active = 0;

    /**
     * Process a single font and store the result at its original index slot.
     *
     * @param {string} sourcePath
     * @param {number} index
     *
     * @returns {Promise<void>}
     */
    async function processFont(sourcePath, index) {
        const outputPath = toOutputPath(sourcePath);
        const fileName = outputPath.split(/[\\/]/u).at(-1) ?? "";

        // Dry-run: record intent without writing files
        if (dryRun) {
            converted += 1;
            convertedSources.push(sourcePath);
            completed += 1;
            printFontResult(
                "PLAN",
                sourcePath,
                completed,
                sourceFonts.length,
                active,
                null,
                null
            );
            return;
        }

        active += 1;
        printFontStart(
            sourcePath,
            index + 1,
            completed,
            sourceFonts.length,
            active
        );
        const fontStartedAt = Date.now();
        /**
         * @type {{
         *     error?: string;
         *     ok: boolean;
         *     sizeBytes?: number;
         *     timings: FontConversionTimings;
         * }}
         */
        let result;
        try {
            if (conversionPool === null) {
                throw new Error("Conversion worker pool is unavailable.");
            }

            result = await conversionPool.convert(sourcePath, outputPath);
        } catch (error) {
            result = {
                error: error instanceof Error ? error.message : String(error),
                ok: false,
                timings: {
                    convertMs: null,
                    moduleMs: 0,
                    overheadMs: null,
                    queueMs: 0,
                    readMs: null,
                    totalMs: Date.now() - fontStartedAt,
                    workerId: 0,
                    workerMs: 0,
                    workerReused: false,
                    writeMs: null,
                },
            };
        } finally {
            active -= 1;
        }

        /** @type {FontProgressStatus} */
        let progressStatus;
        if (result.ok) {
            converted += 1;
            convertedSources.push(sourcePath);
            progressStatus = "DONE";
        } else {
            const message = result.error ?? "unknown error";
            failures.push({
                message,
                sourcePath,
                timedOut: isFontTimeoutMessage(message),
                timings: result.timings,
            });
            if (!verbose) {
                const failureDescription = sanitizeTerminalText(
                    `${fileName}: ${message}`
                );
                process.stderr.write(
                    `  ${styleText(colorEnabled, [ANSI.bold, ANSI.red], "[FAIL]")} ${failureDescription}\n`
                );
            }
            progressStatus = "FAIL";
        }

        completed += 1;
        printFontResult(
            progressStatus,
            sourcePath,
            completed,
            sourceFonts.length,
            active,
            result.timings,
            result.sizeBytes
        );
    }

    // Concurrency pool — keep up to the pass limit in flight at once.
    /** @type {Set<Promise<void>>} */
    const running = new Set();

    try {
        for (let i = 0; i < sourceFonts.length; i += 1) {
            const sourcePath = sourceFonts[i];
            if (typeof sourcePath !== "string") {
                continue;
            }

            /** @type {Promise<void>} */
            let task;
            task = processFont(sourcePath, i).finally(() => {
                running.delete(task);
            });
            running.add(task);

            if (running.size >= pass.concurrency) {
                await Promise.race(running);
            }
        }

        // Wait for any remaining in-flight tasks
        await Promise.all(running);
    } finally {
        await conversionPool?.close();
    }

    return {
        converted,
        convertedSources,
        failures,
    };
}

/**
 * Persist every final failure without flooding the parent command's diagnostic
 * tail. The report is removed after a clean conversion.
 *
 * @param {readonly (FontFailure & { pass: number })[]} failures
 *
 * @returns {Promise<void>}
 */
async function writeFailureReport(failures) {
    await atomicWriteJson(options.failureReport, {
        failedOnly: options.failedOnly,
        failures: failures.map((failure) => ({
            message: failure.message,
            outputPath: relative(outputRoot, toOutputPath(failure.sourcePath))
                .split(sep)
                .join("/"),
            pass: failure.pass,
            sourcePath: relative(sourceRoot, failure.sourcePath)
                .split(sep)
                .join("/"),
            timedOut: failure.timedOut,
            totalMs: failure.timings.totalMs,
        })),
        generatedAt: new Date().toISOString(),
        outputDir: outputRoot,
        schemaVersion: 1,
        sourceDir: sourceRoot,
    });
}

/**
 * Write the font asset index file.
 *
 * @param {readonly FontIndexEntry[]} entries
 *
 * @returns {void}
 */
function writeIndex(entries) {
    mkdirSync(dirname(indexFile), { recursive: true });
    writeFileSync(indexFile, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
}

/**
 * Main bulk-conversion entry point.
 *
 * @returns {Promise<void>}
 */
async function main() {
    if (!existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory()) {
        throw new Error(
            `Source directory not found: ${sourceRoot}. Run npm run fonts:download first.`
        );
    }

    if (!dryRun) {
        mkdirSync(outputRoot, { recursive: true });
    }

    const sourceFonts = collectSourceFonts(sourceRoot);

    if (sourceFonts.length === 0) {
        throw new Error(`No .ttf or .otf files found under ${sourceRoot}.`);
    }

    const outputOwners = new Map();
    for (const sourcePath of sourceFonts) {
        const outputPath = toOutputPath(sourcePath);
        const existingSource = outputOwners.get(outputPath);
        if (typeof existingSource === "string") {
            throw new Error(
                `Sources map to the same WOFF2 output: ${existingSource} and ${sourcePath}`
            );
        }

        outputOwners.set(outputPath, sourcePath);
    }

    const expectedOutputSet = new Set(outputOwners.keys());
    const staleOutputs = collectOutputFonts(outputRoot).filter(
        (outputPath) => !expectedOutputSet.has(outputPath)
    );

    const startMs = Date.now();
    const reusableSources = force
        ? []
        : sourceFonts.filter((sourcePath) =>
              isReusableOutput(toOutputPath(sourcePath), sourcePath)
          );
    const reusableSet = new Set(reusableSources);
    const conversionCandidates = force
        ? sourceFonts
        : sourceFonts.filter((sourcePath) => !reusableSet.has(sourcePath));
    if (
        options.failedOnly &&
        !dryRun &&
        reusableSources.length === 0 &&
        conversionCandidates.length > 0
    ) {
        throw new Error(
            "--failed-only found no validated staged WOFF2 outputs to reuse. Run a normal apply instead."
        );
    }

    const action = dryRun
        ? "[dry-run] Planning"
        : options.failedOnly
          ? "Resuming"
          : "Converting";
    process.stdout.write(
        `${styleText(colorEnabled, [ANSI.bold, ANSI.cyan], action)} ` +
            `${styleText(colorEnabled, ANSI.bold, String(conversionCandidates.length))} of ` +
            `${styleText(colorEnabled, ANSI.bold, String(sourceFonts.length))} fonts ` +
            `${styleText(
                colorEnabled,
                ANSI.dim,
                `(${CONCURRENCY} worker ${CONCURRENCY === 1 ? "process" : "processes"}, ${FONT_TIMEOUT_MS / 1000}s timeout each, ${options.timeoutRetries} timeout ${options.timeoutRetries === 1 ? "retry" : "retries"})`
            )}...\n`
    );
    if (reusableSources.length > 0) {
        process.stdout.write(
            `  Reusing ${reusableSources.length} validated WOFF2 outputs.\n`
        );
    }

    const convertedSources = new Set();
    /** @type {(FontFailure & { pass: number })[]} */
    const finalFailures = [];
    let pendingSources = conversionCandidates;
    const passes = dryRun ? CONVERSION_PASSES.slice(0, 1) : CONVERSION_PASSES;
    for (let passIndex = 0; passIndex < passes.length; passIndex += 1) {
        const pass = passes[passIndex];
        if (pass === undefined || pendingSources.length === 0) break;
        if (passIndex > 0) {
            process.stdout.write(
                `\n${styleText(colorEnabled, [ANSI.bold, ANSI.yellow], `Retry pass ${pass.number}/${passes.length}`)}: ` +
                    `${pendingSources.length} timed-out fonts with ${pass.concurrency} ` +
                    `${pass.concurrency === 1 ? "worker" : "workers"} and a ${pass.timeoutSeconds}s timeout.\n`
            );
        }

        const result = await runConversionLoop(pendingSources, pass);
        for (const sourcePath of result.convertedSources) {
            convertedSources.add(sourcePath);
        }

        const partitioned = partitionConversionFailures(
            result.failures.map((failure) => ({
                ...failure,
                pass: pass.number,
            })),
            passIndex < passes.length - 1
        );
        finalFailures.push(...partitioned.finalFailures);
        pendingSources = partitioned.retrySources;
    }

    if (!dryRun && finalFailures.length === 0) {
        const invalidOutputs = sourceFonts.filter(
            (sourcePath) =>
                !isReusableOutput(toOutputPath(sourcePath), sourcePath)
        );
        for (const sourcePath of invalidOutputs) {
            finalFailures.push({
                message: "output is missing or failed WOFF2 resume validation",
                pass: CONVERSION_PASSES.at(-1)?.number ?? 1,
                sourcePath,
                timedOut: false,
                timings: {
                    convertMs: null,
                    moduleMs: 0,
                    overheadMs: null,
                    queueMs: 0,
                    readMs: null,
                    totalMs: 0,
                    workerId: 0,
                    workerMs: 0,
                    workerReused: false,
                    writeMs: null,
                },
            });
        }
    }

    const converted = convertedSources.size;
    const failed = finalFailures.length;
    const skipped = reusableSources.length;

    if (!dryRun && failed === 0) {
        if (options.prune) {
            for (const staleOutput of staleOutputs) {
                assertPathInsideRepository(repoRoot, staleOutput);
                rmSync(staleOutput, { force: true });
            }
        }

        writeIndex(
            sourceFonts.map((sourcePath) =>
                createIndexEntry(sourcePath, convertedSources.has(sourcePath))
            )
        );
        rmSync(options.failureReport, { force: true });
    } else if (!dryRun) {
        await writeFailureReport(finalFailures);
    }

    const duration = formatDuration(Date.now() - startMs);
    const completionLabel = failed > 0 ? "Finished with failures" : "Done";

    process.stdout.write(
        `\n${styleText(
            colorEnabled,
            [ANSI.bold, failed > 0 ? ANSI.red : ANSI.green],
            completionLabel
        )} in ${duration}.\n`
    );
    process.stdout.write(
        `  ${dryRun ? "Would convert" : "Converted"}: ` +
            `${styleText(colorEnabled, ANSI.green, String(converted))}  ` +
            `Skipped: ${styleText(colorEnabled, ANSI.yellow, String(skipped))}  ` +
            `Failed: ${styleText(
                colorEnabled,
                failed > 0 ? ANSI.red : ANSI.green,
                String(failed)
            )}\n`
    );

    process.stdout.write(
        `  Stale outputs: ${staleOutputs.length}${options.prune ? " (prune requested)" : ""}\n`
    );

    if (!dryRun && failed === 0) {
        process.stdout.write(`  Index:     ${indexFile}\n`);
    }

    if (finalFailures.length > 0) {
        process.stderr.write(
            `\n${styleText(colorEnabled, [ANSI.bold, ANSI.red], "Failed fonts:")}\n`
        );
        for (const failure of finalFailures.slice(0, FAILURE_DETAIL_LIMIT)) {
            const description = `${displayFontPath(failure.sourcePath)}: ${failure.message}`;
            process.stderr.write(
                `  ${styleText(colorEnabled, ANSI.red, sanitizeTerminalText(description))}\n`
            );
        }
        if (finalFailures.length > FAILURE_DETAIL_LIMIT) {
            process.stderr.write(
                `  ... ${finalFailures.length - FAILURE_DETAIL_LIMIT} more failures.\n`
            );
        }
        process.stderr.write(
            `  Full failure report: ${options.failureReport}\n`
        );
    }

    if (failed > 0) {
        process.exitCode = 1;
    }
}

const moduleFilePath = fileURLToPath(import.meta.url);
if (isMainModule(process.argv[1], moduleFilePath)) {
    if (optionError !== undefined) {
        const message =
            optionError instanceof Error
                ? optionError.message
                : String(optionError);
        process.stderr.write(`Error: ${message}\n`);
        process.exitCode = 1;
    } else {
        try {
            await main();
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            process.stderr.write(`Error: ${message}\n`);
            process.exitCode = 1;
        }
    }
}
