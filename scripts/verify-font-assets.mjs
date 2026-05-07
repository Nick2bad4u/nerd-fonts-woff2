#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const repoRoot = process.cwd();
const sourceRoot = resolve(repoRoot, "fonts", "original");
const outputRoot = resolve(repoRoot, "fonts", "woff2");
const indexFile = resolve(outputRoot, "index.json");

/**
 * Recursively collect files in a directory that match a filename predicate.
 *
 * @param {string} rootDir
 * @param {(name: string) => boolean} filter
 *
 * @returns {string[]}
 */
function collectFiles(rootDir, filter) {
    const queue = [rootDir];
    const files = [];

    while (queue.length > 0) {
        const current = queue.shift();
        if (typeof current !== "string") {
            continue;
        }

        for (const entry of readdirSync(current, { withFileTypes: true })) {
            const absolutePath = join(current, entry.name);
            if (entry.isDirectory()) {
                queue.push(absolutePath);
                continue;
            }

            if (entry.isFile() && filter(entry.name)) {
                files.push(absolutePath);
            }
        }
    }

    return files.sort((a, b) => a.localeCompare(b));
}

/**
 * Map a source TTF/OTF path under fonts/original to its expected WOFF2 output
 * path.
 *
 * @param {string} sourceFile
 *
 * @returns {string}
 */
function expectedOutputPathFromSource(sourceFile) {
    const relativeSource = relative(sourceRoot, sourceFile);
    const parts = relativeSource.split(/[\\/]/u);
    const family = parts[0];
    if (typeof family !== "string" || family.length === 0) {
        throw new Error(
            `Unable to determine family from source file ${sourceFile}`
        );
    }

    const withinFamily = parts.slice(1).join("/");
    const outputRelative = withinFamily.replace(/\.(?:ttf|otf)$/iu, ".woff2");
    return resolve(outputRoot, family, outputRelative);
}

/**
 * Ensure a file starts with the WOFF2 magic header.
 *
 * @param {string} filePath
 *
 * @returns {void}
 */
function assertWoff2Signature(filePath) {
    const header = readFileSync(filePath).subarray(0, 4);
    const signature = header.toString("ascii");
    if (signature !== "wOF2") {
        throw new Error(
            `Invalid WOFF2 signature in ${filePath}. Found: ${signature}`
        );
    }
}

/**
 * Validate parsed index entries against generated output files.
 *
 * @param {unknown} parsedIndex
 * @param {ReadonlySet<string>} outputSet
 *
 * @returns {number}
 */
function validateIndexEntries(parsedIndex, outputSet) {
    if (!Array.isArray(parsedIndex) || parsedIndex.length === 0) {
        throw new Error("fonts/woff2/index.json is missing entries.");
    }

    for (const entry of parsedIndex) {
        if (typeof entry !== "object" || entry === null) {
            throw new Error(
                "fonts/woff2/index.json contains a non-object entry."
            );
        }

        const outputPath = Reflect.get(entry, "outputPath");
        if (typeof outputPath !== "string" || outputPath.length === 0) {
            throw new Error(
                "fonts/woff2/index.json contains an entry without outputPath."
            );
        }

        if (!outputSet.has(outputPath)) {
            throw new Error(
                `Index outputPath does not match generated files: ${outputPath}`
            );
        }
    }

    return parsedIndex.length;
}

/**
 * Verify converted font asset integrity and index consistency.
 *
 * @returns {void}
 */
function main() {
    if (!existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory()) {
        throw new Error(`Missing source directory: ${sourceRoot}`);
    }

    if (!existsSync(outputRoot) || !statSync(outputRoot).isDirectory()) {
        throw new Error(`Missing output directory: ${outputRoot}`);
    }

    const sourceFonts = collectFiles(sourceRoot, (name) =>
        /\.(?:ttf|otf)$/iu.test(name)
    );
    const outputFonts = collectFiles(outputRoot, (name) =>
        /\.woff2$/iu.test(name)
    );

    if (sourceFonts.length === 0) {
        throw new Error("No source fonts found under fonts/original.");
    }

    if (outputFonts.length === 0) {
        throw new Error("No generated WOFF2 files found under fonts/woff2.");
    }

    const missingOutputs = [];
    for (const sourceFont of sourceFonts) {
        const expectedOutput = expectedOutputPathFromSource(sourceFont);
        if (!existsSync(expectedOutput)) {
            missingOutputs.push(expectedOutput);
        }
    }

    if (missingOutputs.length > 0) {
        const sample = missingOutputs.slice(0, 10).join("\n- ");
        throw new Error(
            `Missing ${missingOutputs.length} expected WOFF2 files. Sample:\n- ${sample}`
        );
    }

    for (const outputFont of outputFonts) {
        assertWoff2Signature(outputFont);
    }

    if (!existsSync(indexFile)) {
        throw new Error(`Missing index file: ${indexFile}`);
    }

    const parsedIndex = JSON.parse(readFileSync(indexFile, "utf8"));
    const outputSet = new Set(outputFonts);
    const verifiedIndexCount = validateIndexEntries(parsedIndex, outputSet);

    process.stdout.write(`Verified source fonts: ${sourceFonts.length}\n`);
    process.stdout.write(
        `Verified output WOFF2 files: ${outputFonts.length}\n`
    );
    process.stdout.write(`Verified index entries: ${verifiedIndexCount}\n`);
}

try {
    main();
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
}
