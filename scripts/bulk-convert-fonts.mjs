#!/usr/bin/env node

/**
 * Fast in-process bulk WOFF2 converter for Nerd Fonts.
 *
 * Loads ttf2woff2 once and converts all TTF/OTF source files in a single
 * Node.js process \u2014 no per-font process startup overhead.
 *
 * Reads: fonts/original/** /_.{ttf,otf} Writes: fonts/woff2/** /_.woff2
 * (mirroring the source tree) fonts/woff2/index.json (FontIndexEntry array)
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
    readFileSync,
    readdirSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import ttf2woff2 from "ttf2woff2";

const repoRoot = process.cwd();
const sourceRoot = resolve(repoRoot, "fonts", "original");
const outputRoot = resolve(repoRoot, "fonts", "woff2");
const indexFile = resolve(outputRoot, "index.json");

const dryRun = process.argv.includes("--dry-run");
const force = process.argv.includes("--force");

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
 * @returns {string[]} - Absolute paths to matching font files.
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
 * Convert a source font path to its expected WOFF2 output path.
 *
 * @param {string} sourcePath - Absolute path to the source .ttf or .otf file.
 *
 * @returns {string} - Absolute path to the target .woff2 file.
 */
function toOutputPath(sourcePath) {
    const rel = relative(sourceRoot, sourcePath);
    return resolve(outputRoot, rel.replace(/\.(?:otf|ttf)$/iu, ".woff2"));
}

/**
 * Extract the Nerd Fonts family name from a source path. The family is the
 * first path segment under fonts/original.
 *
 * @param {string} sourcePath - Absolute path to the source font.
 *
 * @returns {string}
 */
function extractFamily(sourcePath) {
    const rel = relative(sourceRoot, sourcePath);
    const firstSegment = rel.split(/[\\/]/u)[0];
    return typeof firstSegment === "string" && firstSegment.length > 0
        ? firstSegment
        : "Unknown";
}

/**
 * Check whether an existing output file is already up-to-date.
 *
 * @param {string} outputPath - Target .woff2 file path.
 * @param {string} sourcePath - Source .ttf/.otf file path.
 *
 * @returns {boolean}
 */
function isUpToDate(outputPath, sourcePath) {
    if (!existsSync(outputPath)) {
        return false;
    }

    const sourceMtime = statSync(sourcePath).mtimeMs;
    const outputMtime = statSync(outputPath).mtimeMs;
    return outputMtime >= sourceMtime;
}

/**
 * Convert a single font file and return the index entry.
 *
 * @param {string} sourcePath - Absolute source font path.
 * @param {string} outputPath - Absolute target woff2 path.
 *
 * @returns {{ entry: FontIndexEntry; skipped: boolean }}
 */
function convertFont(sourcePath, outputPath) {
    const family = extractFamily(sourcePath);
    const fileName = outputPath.split(/[\\/]/u).at(-1) ?? "";

    if (!force && isUpToDate(outputPath, sourcePath)) {
        const sizeBytes = statSync(outputPath).size;
        return {
            entry: {
                converted: false,
                family,
                fileName,
                outputPath,
                sizeBytes,
                sourcePath,
            },
            skipped: true,
        };
    }

    if (dryRun) {
        return {
            entry: {
                converted: false,
                family,
                fileName,
                outputPath,
                sizeBytes: null,
                sourcePath,
            },
            skipped: false,
        };
    }

    const inputBuffer = readFileSync(sourcePath);

    /** @type {Buffer} */
    const outputBuffer = ttf2woff2(inputBuffer);

    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, outputBuffer);

    return {
        entry: {
            converted: true,
            family,
            fileName,
            outputPath,
            sizeBytes: outputBuffer.length,
            sourcePath,
        },
        skipped: false,
    };
}

/**
 * Write the font asset index file.
 *
 * @param {readonly FontIndexEntry[]} entries - All index entries.
 *
 * @returns {void}
 */
function writeIndex(entries) {
    mkdirSync(dirname(indexFile), { recursive: true });
    writeFileSync(indexFile, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
}

/**
 * Process all source fonts and collect conversion results.
 *
 * @param {readonly string[]} sourceFonts - Absolute paths to source fonts.
 *
 * @returns {{
 *     converted: number;
 *     entries: FontIndexEntry[];
 *     failed: number;
 *     failures: string[];
 *     skipped: number;
 * }}
 */
function runConversionLoop(sourceFonts) {
    /** @type {FontIndexEntry[]} */
    const entries = [];
    /** @type {string[]} */
    const failures = [];
    let converted = 0;
    let skipped = 0;
    let failed = 0;

    for (let index = 0; index < sourceFonts.length; index += 1) {
        const sourcePath = sourceFonts[index];
        if (typeof sourcePath !== "string") {
            continue;
        }

        const outputPath = toOutputPath(sourcePath);

        try {
            const result = convertFont(sourcePath, outputPath);
            entries.push(result.entry);
            if (result.skipped) {
                skipped += 1;
            } else {
                converted += 1;
            }
        } catch (error) {
            failed += 1;
            const message =
                error instanceof Error ? error.message : String(error);
            failures.push(`${sourcePath}: ${message}`);
            process.stderr.write(`  [FAIL] ${sourcePath}: ${message}\n`);
        }

        // Progress report every 100 fonts
        if ((index + 1) % 100 === 0 || index + 1 === sourceFonts.length) {
            const pct = Math.round(((index + 1) / sourceFonts.length) * 100);
            process.stdout.write(
                `  ${index + 1}/${sourceFonts.length} (${pct}%) \u2014 converted:${converted} skipped:${skipped} failed:${failed}\n`
            );
        }
    }

    return { converted, entries, failed, failures, skipped };
}

/**
 * Main bulk-conversion entry point.
 *
 * @returns {void}
 */
function main() {
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

    process.stdout.write(
        `${dryRun ? "[dry-run] " : ""}Converting ${sourceFonts.length} fonts...\n`
    );

    const startMs = Date.now();
    const { converted, entries, failed, failures, skipped } =
        runConversionLoop(sourceFonts);

    if (!dryRun) {
        writeIndex(entries);
    }

    const durationMs = Date.now() - startMs;
    const durationSec = (durationMs / 1000).toFixed(1);

    process.stdout.write(`\nDone in ${durationSec}s.\n`);
    process.stdout.write(
        `  Converted: ${converted}  Skipped: ${skipped}  Failed: ${failed}\n`
    );

    if (!dryRun) {
        process.stdout.write(`  Index:     ${indexFile}\n`);
    }

    for (const failure of failures) {
        process.stderr.write(`  [FAIL] ${failure}\n`);
    }

    if (failed > 0) {
        process.exitCode = 1;
    }
}

try {
    main();
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
}
