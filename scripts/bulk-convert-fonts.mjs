#!/usr/bin/env node

/**
 * Parallel WOFF2 bulk converter for Nerd Fonts.
 *
 * Converts all TTF/OTF source files to WOFF2 using a pool of Worker threads.
 * Each conversion runs in an isolated thread with a per-font timeout so a hung
 * or crashing font never stalls the whole run.
 *
 * Reads: fonts/original/** /_.{ttf,otf} Writes: fonts/woff2/** /_.woff2
 * (mirrors the source tree) fonts/woff2/index.json (FontIndexEntry array)
 *
 * Skips already-up-to-date files unless --force is passed.
 *
 * Usage: node scripts/bulk-convert-fonts.mjs node
 * scripts/bulk-convert-fonts.mjs --force node scripts/bulk-convert-fonts.mjs
 * --dry-run
 */

import {
    existsSync,
    mkdirSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { cpus } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import {
    assertPathInsideRepository,
    isMainModule,
} from "./nerd-fonts-release.mjs";

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

/**
 * Maximum parallel conversions. Cap at 8 (32 for user-provided) to avoid
 * excessive memory use.
 */
const CONCURRENCY = options.concurrency ?? Math.min(cpus().length, 8);

/** Kill a worker if a single font takes longer than this. */
const FONT_TIMEOUT_MS = (options.timeoutSeconds ?? 60) * 1000;

/**
 * @typedef {{
 *     concurrency: number | null;
 *     confirm: boolean;
 *     convert: boolean;
 *     dryRun: boolean;
 *     force: boolean;
 *     outputDir: string;
 *     prune: boolean;
 *     publicOutputDir: string;
 *     publicSourceDir: string;
 *     sourceDir: string;
 *     timeoutSeconds: number | null;
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
        concurrency: null,
        confirm: false,
        convert: false,
        dryRun: false,
        force: false,
        outputDir: resolve(root, "fonts", "woff2"),
        prune: false,
        publicOutputDir: "fonts/woff2",
        publicSourceDir: "fonts/original",
        sourceDir: resolve(root, "fonts", "original"),
        timeoutSeconds: null,
    };

    for (let index = 0; index < argumentsList.length; index += 1) {
        const argument = argumentsList[index];
        if (
            argument === "--confirm" ||
            argument === "--convert" ||
            argument === "--dry-run" ||
            argument === "--force" ||
            argument === "--prune"
        ) {
            const key = argument.slice(2).replace("-", "");
            if (key === "dryrun") parsed.dryRun = true;
            else if (key === "confirm") parsed.confirm = true;
            else if (key === "convert") parsed.convert = true;
            else if (key === "force") parsed.force = true;
            else parsed.prune = true;
            continue;
        }

        const equalsMatch = /^--(concurrency|timeout)=(.+)$/v.exec(
            argument ?? ""
        );
        if (equalsMatch !== null) {
            const [
                ,
                name,
                value,
            ] = equalsMatch;
            if (name === "concurrency") {
                parsed.concurrency = Number.parseInt(value ?? "", 10);
            } else {
                parsed.timeoutSeconds = Number.parseInt(value ?? "", 10);
            }

            continue;
        }

        if (
            argument === "--concurrency" ||
            argument === "--output-dir" ||
            argument === "--public-output-dir" ||
            argument === "--public-source-dir" ||
            argument === "--source-dir" ||
            argument === "--timeout"
        ) {
            const value = argumentsList[index + 1];
            if (typeof value !== "string" || value.trim().length === 0) {
                throw new Error(`${argument} requires a non-empty value.`);
            }

            if (argument === "--concurrency") {
                parsed.concurrency = Number.parseInt(value, 10);
            } else if (argument === "--output-dir") {
                parsed.outputDir = resolve(root, value);
            } else if (argument === "--public-output-dir") {
                parsed.publicOutputDir = normalizePublicPath(value);
            } else if (argument === "--public-source-dir") {
                parsed.publicSourceDir = normalizePublicPath(value);
            } else if (argument === "--source-dir") {
                parsed.sourceDir = resolve(root, value);
            } else {
                parsed.timeoutSeconds = Number.parseInt(value, 10);
            }

            index += 1;
            continue;
        }

        throw new Error(`Unknown option: ${argument}`);
    }

    if (
        parsed.concurrency !== null &&
        (!Number.isInteger(parsed.concurrency) ||
            parsed.concurrency < 1 ||
            parsed.concurrency > 32)
    ) {
        throw new Error("--concurrency must be an integer from 1 through 32.");
    }

    if (
        parsed.timeoutSeconds !== null &&
        (!Number.isInteger(parsed.timeoutSeconds) || parsed.timeoutSeconds < 1)
    ) {
        throw new Error("--timeout must be a positive integer in seconds.");
    }

    if (parsed.convert && !parsed.confirm && !parsed.dryRun) {
        throw new Error(
            "Real conversion requires both --convert and --confirm."
        );
    }

    if (parsed.prune && !parsed.convert && !parsed.dryRun) {
        throw new Error("--prune requires --convert and --confirm.");
    }

    for (const checkedPath of [parsed.sourceDir, parsed.outputDir]) {
        assertPathInsideRepository(root, checkedPath);
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
 * Return true if the output file exists and is newer than the source.
 *
 * @param {string} outputPath
 * @param {string} sourcePath
 *
 * @returns {boolean}
 */
function isUpToDate(outputPath, sourcePath) {
    if (!existsSync(outputPath)) {
        return false;
    }

    return statSync(outputPath).mtimeMs >= statSync(sourcePath).mtimeMs;
}

/**
 * Convert one font in a dedicated Worker thread.
 *
 * Always resolves (never rejects) — failures are surfaced via `ok: false`. A
 * hung worker is terminated after FONT_TIMEOUT_MS.
 *
 * @param {string} sourcePath
 * @param {string} outputPath
 *
 * @returns {Promise<{ error?: string; ok: boolean; sizeBytes?: number }>}
 */
function convertInWorker(sourcePath, outputPath) {
    return new Promise((resolvePromise) => {
        const worker = new Worker(workerScript, {
            workerData: { outputPath, sourcePath },
        });

        let settled = false;

        // Declare timer before settle so settle can reference it without
        // triggering the no-use-before-define rule.
        /** @type {ReturnType<typeof setTimeout>} */
        let timer;

        /**
         * @param {{ error?: string; ok: boolean; sizeBytes?: number }} result
         */
        function settle(result) {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(timer);
            resolvePromise(result);
        }

        timer = setTimeout(() => {
            worker.terminate().catch(() => undefined);
            settle({
                error: [
                    `timed out after ${FONT_TIMEOUT_MS / 1000}s`,
                    `source: ${sourcePath}`,
                    "Try raising --timeout=<seconds> (e.g. --timeout=240) and/or reducing --concurrency.",
                ].join(". "),
                ok: false,
            });
        }, FONT_TIMEOUT_MS);

        worker.once(
            "message",
            (
                /**
                 * @type {{
                 *     ok: boolean;
                 *     sizeBytes?: number;
                 *     error?: string;
                 * }}
                 */ msg
            ) => {
                settle(msg);
            }
        );

        worker.once("error", (err) => {
            worker.terminate().catch(() => undefined);
            settle({
                error: err instanceof Error ? err.message : String(err),
                ok: false,
            });
        });

        worker.once("exit", (code) => {
            if (code !== 0) {
                settle({ error: `worker exited with code ${code}`, ok: false });
            }
        });
    });
}

/**
 * Print a progress line every 50 fonts or at the final font.
 *
 * @param {number} completed
 * @param {number} total
 *
 * @returns {void}
 */
function printProgress(completed, total) {
    if (completed % 50 === 0 || completed === total) {
        const pct = Math.round((completed / total) * 100);
        process.stdout.write(`  ${completed}/${total} (${pct}%)\n`);
    }
}

/**
 * Run conversions for all fonts up to CONCURRENCY at a time.
 *
 * @param {readonly string[]} sourceFonts
 *
 * @returns {Promise<{
 *     converted: number;
 *     entries: FontIndexEntry[];
 *     failed: number;
 *     failures: string[];
 *     skipped: number;
 * }>}
 */
async function runConversionLoop(sourceFonts) {
    /** @type {(FontIndexEntry | undefined)[]} */
    const entries = new Array(sourceFonts.length);
    /** @type {string[]} */
    const failures = [];
    let converted = 0;
    let skipped = 0;
    let failed = 0;
    let completed = 0;

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
        const family = extractFamily(sourcePath);
        const fileName = outputPath.split(/[\\/]/u).at(-1) ?? "";

        // Already up to date — skip without converting
        if (!force && isUpToDate(outputPath, sourcePath)) {
            entries[index] = {
                converted: false,
                family,
                fileName,
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
            skipped += 1;
            completed += 1;
            printProgress(completed, sourceFonts.length);
            return;
        }

        // Dry-run: record intent without writing files
        if (dryRun) {
            entries[index] = {
                converted: false,
                family,
                fileName,
                outputPath: toPublicPath(
                    outputRoot,
                    outputPath,
                    options.publicOutputDir
                ),
                sizeBytes: null,
                sourcePath: toPublicPath(
                    sourceRoot,
                    sourcePath,
                    options.publicSourceDir
                ),
            };
            converted += 1;
            completed += 1;
            printProgress(completed, sourceFonts.length);
            return;
        }

        const result = await convertInWorker(sourcePath, outputPath);

        if (result.ok) {
            entries[index] = {
                converted: true,
                family,
                fileName,
                outputPath: toPublicPath(
                    outputRoot,
                    outputPath,
                    options.publicOutputDir
                ),
                sizeBytes: result.sizeBytes ?? null,
                sourcePath: toPublicPath(
                    sourceRoot,
                    sourcePath,
                    options.publicSourceDir
                ),
            };
            converted += 1;
        } else {
            const message = result.error ?? "unknown error";
            entries[index] = {
                converted: false,
                family,
                fileName,
                outputPath: toPublicPath(
                    outputRoot,
                    outputPath,
                    options.publicOutputDir
                ),
                sizeBytes: null,
                sourcePath: toPublicPath(
                    sourceRoot,
                    sourcePath,
                    options.publicSourceDir
                ),
            };
            failures.push(`${sourcePath}: ${message}`);
            process.stderr.write(`  [FAIL] ${fileName}: ${message}\n`);
            failed += 1;
        }

        completed += 1;
        printProgress(completed, sourceFonts.length);
    }

    // Concurrency pool — keep up to CONCURRENCY tasks in flight at once
    /** @type {Set<Promise<void>>} */
    const running = new Set();

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

        if (running.size >= CONCURRENCY) {
            await Promise.race(running);
        }
    }

    // Wait for any remaining in-flight tasks
    await Promise.all(running);

    return {
        converted,
        entries: /** @type {FontIndexEntry[]} */ (entries.filter(Boolean)),
        failed,
        failures,
        skipped,
    };
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

    process.stdout.write(
        `${dryRun ? "[dry-run] Planning" : "Converting"} ${sourceFonts.length} fonts` +
            ` (${CONCURRENCY} parallel workers, ${FONT_TIMEOUT_MS / 1000}s timeout each)...\n`
    );

    const startMs = Date.now();
    const { converted, entries, failed, failures, skipped } =
        await runConversionLoop(sourceFonts);

    if (!dryRun && failed === 0) {
        if (options.prune) {
            for (const staleOutput of staleOutputs) {
                assertPathInsideRepository(repoRoot, staleOutput);
                rmSync(staleOutput, { force: true });
            }
        }

        writeIndex(entries);
    }

    const durationSec = ((Date.now() - startMs) / 1000).toFixed(1);

    process.stdout.write(`\nDone in ${durationSec}s.\n`);
    process.stdout.write(
        `  ${dryRun ? "Would convert" : "Converted"}: ${converted}  Skipped: ${skipped}  Failed: ${failed}\n`
    );

    process.stdout.write(
        `  Stale outputs: ${staleOutputs.length}${options.prune ? " (prune requested)" : ""}\n`
    );

    if (!dryRun && failed === 0) {
        process.stdout.write(`  Index:     ${indexFile}\n`);
    }

    if (failures.length > 0) {
        process.stderr.write(`\nFailed fonts:\n`);
        for (const f of failures) {
            process.stderr.write(`  ${f}\n`);
        }
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
