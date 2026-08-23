#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
    assertPathInsideRepository,
    isMainModule,
    parseSemverTag,
    readMetadataFile,
} from "./nerd-fonts-release.mjs";

/**
 * @typedef {{
 *     metadataFile: string;
 *     outputDir: string;
 *     publicOutputDir: string;
 *     publicSourceDir: string;
 *     requireMetadata: boolean;
 *     sourceDir: string;
 * }} VerifyOptions
 */

/**
 * @param {readonly string[]} argumentsList
 * @param {string} repoRoot
 *
 * @returns {VerifyOptions}
 */
export function parseVerifyOptions(argumentsList, repoRoot = process.cwd()) {
    /** @type {VerifyOptions} */
    const parsed = {
        metadataFile: resolve(
            repoRoot,
            "fonts",
            "woff2",
            "source-metadata.json"
        ),
        outputDir: resolve(repoRoot, "fonts", "woff2"),
        publicOutputDir: "fonts/woff2",
        publicSourceDir: "fonts/original",
        requireMetadata: false,
        sourceDir: resolve(repoRoot, "fonts", "original"),
    };
    let explicitMetadataFile = false;

    for (let index = 0; index < argumentsList.length; index += 1) {
        const argument = argumentsList[index];
        if (argument === "--require-metadata") {
            parsed.requireMetadata = true;
            continue;
        }

        if (
            argument === "--metadata-file" ||
            argument === "--output-dir" ||
            argument === "--public-output-dir" ||
            argument === "--public-source-dir" ||
            argument === "--source-dir"
        ) {
            const value = argumentsList[index + 1];
            if (typeof value !== "string" || value.trim().length === 0) {
                throw new Error(`${argument} requires a non-empty value.`);
            }

            if (argument === "--metadata-file") {
                parsed.metadataFile = resolve(repoRoot, value);
                explicitMetadataFile = true;
            } else if (argument === "--output-dir") {
                parsed.outputDir = resolve(repoRoot, value);
            } else if (argument === "--public-output-dir") {
                parsed.publicOutputDir = normalizePublicRoot(value);
            } else if (argument === "--public-source-dir") {
                parsed.publicSourceDir = normalizePublicRoot(value);
            } else {
                parsed.sourceDir = resolve(repoRoot, value);
            }

            index += 1;
            continue;
        }

        throw new Error(`Unknown option: ${argument}`);
    }

    if (!explicitMetadataFile) {
        parsed.metadataFile = resolve(parsed.outputDir, "source-metadata.json");
    }

    for (const checkedPath of [
        parsed.sourceDir,
        parsed.outputDir,
        parsed.metadataFile,
    ]) {
        assertPathInsideRepository(repoRoot, checkedPath);
    }

    return parsed;
}

/**
 * @param {string} value
 *
 * @returns {string}
 */
function normalizePublicRoot(value) {
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
 * @param {string} rootDir
 * @param {(name: string) => boolean} filter
 *
 * @returns {string[]}
 */
function collectFiles(rootDir, filter) {
    const queue = [rootDir];
    /** @type {string[]} */
    const files = [];

    while (queue.length > 0) {
        const current = queue.shift();
        if (typeof current !== "string") continue;

        for (const entry of readdirSync(current, { withFileTypes: true })) {
            const absolutePath = join(current, entry.name);
            if (entry.isDirectory()) queue.push(absolutePath);
            else if (entry.isFile() && filter(entry.name)) {
                files.push(absolutePath);
            }
        }
    }

    return files.sort((left, right) => left.localeCompare(right));
}

/**
 * @param {string} root
 * @param {string} filePath
 * @param {string} publicRoot
 *
 * @returns {string}
 */
function toPublicPath(root, filePath, publicRoot) {
    return `${publicRoot}/${relative(root, filePath).split(sep).join("/")}`;
}

/**
 * Normalize both portable paths and the legacy absolute Windows paths already
 * committed by older versions of the generator.
 *
 * @param {string} value
 * @param {string} publicRoot
 *
 * @returns {string}
 */
export function normalizeIndexPath(value, publicRoot) {
    const normalized = value.replaceAll("\\", "/").replace(/^\.\//v, "");
    if (normalized === publicRoot || normalized.startsWith(`${publicRoot}/`)) {
        return normalized;
    }

    const marker = `/${publicRoot}/`;
    const markerIndex = normalized.toLowerCase().indexOf(marker.toLowerCase());
    if (markerIndex >= 0) {
        return normalized.slice(markerIndex + 1);
    }

    throw new Error(`Index path is outside ${publicRoot}: ${value}`);
}

/**
 * @param {string} filePath
 *
 * @returns {void}
 */
function assertWoff2Signature(filePath) {
    const signature = readFileSync(filePath).subarray(0, 4).toString("ascii");
    if (signature !== "wOF2") {
        throw new Error(
            `Invalid WOFF2 signature in ${filePath}. Found: ${signature}`
        );
    }
}

/**
 * @param {unknown} parsedIndex
 * @param {ReadonlyMap<string, { absoluteOutput: string; source: string }>} expected
 * @param {VerifyOptions} options
 *
 * @returns {number}
 */
function validateIndexEntries(parsedIndex, expected, options) {
    if (!Array.isArray(parsedIndex) || parsedIndex.length === 0) {
        throw new Error("fonts/woff2/index.json is missing entries.");
    }

    if (parsedIndex.length !== expected.size) {
        throw new Error(
            `Index entry count ${parsedIndex.length} does not match expected output count ${expected.size}.`
        );
    }

    const seen = new Set();
    for (const entry of parsedIndex) {
        if (typeof entry !== "object" || entry === null) {
            throw new Error("Index contains a non-object entry.");
        }

        const outputPath = Reflect.get(entry, "outputPath");
        const sourcePath = Reflect.get(entry, "sourcePath");
        const sizeBytes = Reflect.get(entry, "sizeBytes");
        if (typeof outputPath !== "string" || typeof sourcePath !== "string") {
            throw new Error("Index entry is missing outputPath or sourcePath.");
        }

        const normalizedOutput = normalizeIndexPath(
            outputPath,
            options.publicOutputDir
        );
        const normalizedSource = normalizeIndexPath(
            sourcePath,
            options.publicSourceDir
        );
        const expectedEntry = expected.get(normalizedOutput);
        if (expectedEntry === undefined) {
            throw new Error(`Unexpected index output path: ${outputPath}`);
        }

        if (normalizedSource !== expectedEntry.source) {
            throw new Error(
                `Index source path does not match ${normalizedOutput}: ${sourcePath}`
            );
        }

        if (seen.has(normalizedOutput)) {
            throw new Error(`Duplicate index output path: ${normalizedOutput}`);
        }

        if (
            typeof sizeBytes !== "number" ||
            sizeBytes !== statSync(expectedEntry.absoluteOutput).size
        ) {
            throw new Error(`Index size does not match ${normalizedOutput}.`);
        }

        seen.add(normalizedOutput);
    }

    return seen.size;
}

/**
 * @param {VerifyOptions} options
 * @param {number} sourceCount
 * @param {number} outputCount
 *
 * @returns {string | null}
 */
function validateMetadata(options, sourceCount, outputCount) {
    const metadata = readMetadataFile(options.metadataFile);
    if (metadata === null) {
        if (options.requireMetadata) {
            throw new Error(
                `Missing or invalid metadata: ${options.metadataFile}`
            );
        }

        return null;
    }

    if (
        typeof metadata.upstreamRef !== "string" ||
        parseSemverTag(metadata.upstreamRef) === null
    ) {
        throw new Error("Source metadata has an invalid upstreamRef.");
    }

    if (metadata.sourceCount !== sourceCount) {
        throw new Error(
            `Metadata sourceCount ${String(metadata.sourceCount)} does not match ${sourceCount}.`
        );
    }

    if (
        metadata.outputCount !== undefined &&
        metadata.outputCount !== outputCount
    ) {
        throw new Error(
            `Metadata outputCount ${String(metadata.outputCount)} does not match ${outputCount}.`
        );
    }

    return metadata.upstreamRef;
}

/**
 * @param {readonly string[]} argumentsList
 * @param {string} repoRoot
 *
 * @returns {void}
 */
export function main(
    argumentsList = process.argv.slice(2),
    repoRoot = process.cwd()
) {
    const options = parseVerifyOptions(argumentsList, repoRoot);
    if (
        !existsSync(options.sourceDir) ||
        !statSync(options.sourceDir).isDirectory()
    ) {
        throw new Error(`Missing source directory: ${options.sourceDir}`);
    }

    if (
        !existsSync(options.outputDir) ||
        !statSync(options.outputDir).isDirectory()
    ) {
        throw new Error(`Missing output directory: ${options.outputDir}`);
    }

    const sourceFonts = collectFiles(options.sourceDir, (name) =>
        /\.(?:otf|ttf)$/iv.test(name)
    );
    const outputFonts = collectFiles(options.outputDir, (name) =>
        /\.woff2$/iv.test(name)
    );
    if (sourceFonts.length === 0 || outputFonts.length === 0) {
        throw new Error("Source and output font trees must both be non-empty.");
    }

    /** @type {Map<string, { absoluteOutput: string; source: string }>} */
    const expected = new Map();
    for (const sourceFile of sourceFonts) {
        const relativeSource = relative(options.sourceDir, sourceFile);
        const absoluteOutput = resolve(
            options.outputDir,
            relativeSource.replace(/\.(?:otf|ttf)$/iv, ".woff2")
        );
        const publicOutput = toPublicPath(
            options.outputDir,
            absoluteOutput,
            options.publicOutputDir
        );
        expected.set(publicOutput, {
            absoluteOutput,
            source: toPublicPath(
                options.sourceDir,
                sourceFile,
                options.publicSourceDir
            ),
        });
    }

    const actualOutputSet = new Set(outputFonts);
    const missing = [...expected.values()].filter(
        ({ absoluteOutput }) => !actualOutputSet.has(absoluteOutput)
    );
    if (missing.length > 0) {
        const sample = missing
            .slice(0, 10)
            .map(({ absoluteOutput }) => absoluteOutput)
            .join("\n- ");
        throw new Error(
            `Missing ${missing.length} expected WOFF2 files. Sample:\n- ${sample}`
        );
    }

    const expectedAbsoluteSet = new Set(
        [...expected.values()].map(({ absoluteOutput }) => absoluteOutput)
    );
    const stale = outputFonts.filter(
        (outputFile) => !expectedAbsoluteSet.has(outputFile)
    );
    if (stale.length > 0) {
        throw new Error(
            `Found ${stale.length} stale WOFF2 files with no source. Sample:\n- ${stale.slice(0, 10).join("\n- ")}`
        );
    }

    for (const outputFont of outputFonts) {
        assertWoff2Signature(outputFont);
    }

    const indexFile = resolve(options.outputDir, "index.json");
    if (!existsSync(indexFile)) {
        throw new Error(`Missing index file: ${indexFile}`);
    }

    const verifiedIndexCount = validateIndexEntries(
        JSON.parse(readFileSync(indexFile, "utf8")),
        expected,
        options
    );
    const upstreamRef = validateMetadata(
        options,
        sourceFonts.length,
        outputFonts.length
    );

    process.stdout.write(`Verified source fonts: ${sourceFonts.length}\n`);
    process.stdout.write(
        `Verified output WOFF2 files: ${outputFonts.length}\n`
    );
    process.stdout.write(`Verified index entries: ${verifiedIndexCount}\n`);
    process.stdout.write(
        `Verified source metadata: ${upstreamRef ?? "not required (legacy asset set)"}\n`
    );
}

const moduleFilePath = fileURLToPath(import.meta.url);
if (isMainModule(process.argv[1], moduleFilePath)) {
    try {
        main();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Error: ${message}\n`);
        process.exitCode = 1;
    }
}
