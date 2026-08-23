#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    createReadStream,
    existsSync,
    mkdirSync,
    readdirSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
    assertPathInsideRepository,
    isMainModule,
    parseChecksumManifest,
    parseSemverTag,
    releaseAssetBaseUrl,
    resolveUpstreamCommit,
    UPSTREAM_REPO,
} from "./nerd-fonts-release.mjs";

const ARCHIVE_SUFFIX = ".tar.xz";

/**
 * @typedef {{
 *     asJson: boolean;
 *     concurrency: number;
 *     confirmed: boolean;
 *     dryRun: boolean;
 *     families: readonly string[];
 *     help: boolean;
 *     outputDir: string;
 *     upstreamRef: string;
 * }} DownloadOptions
 */

/**
 * @param {readonly string[]} argumentsList
 * @param {string} repoRoot
 *
 * @returns {DownloadOptions}
 */
export function parseDownloadOptions(argumentsList, repoRoot = process.cwd()) {
    let asJson = false;
    let concurrency = 4;
    let confirmed = false;
    let dryRun = false;
    let help = false;
    const defaultOutputDir = resolve(repoRoot, "fonts", "original");
    let outputDir = defaultOutputDir;
    let upstreamRef = "";
    /** @type {string[]} */
    const families = [];

    for (let index = 0; index < argumentsList.length; index += 1) {
        const argument = argumentsList[index];
        if (argument === "--confirm") {
            confirmed = true;
            continue;
        }

        if (argument === "--dry-run") {
            dryRun = true;
            continue;
        }

        if (argument === "--help" || argument === "-h") {
            help = true;
            continue;
        }

        if (argument === "--json") {
            asJson = true;
            continue;
        }

        if (
            argument === "--concurrency" ||
            argument === "--family" ||
            argument === "--output-dir" ||
            argument === "--ref"
        ) {
            const value = argumentsList[index + 1];
            if (typeof value !== "string" || value.trim().length === 0) {
                throw new Error(`${argument} requires a non-empty value.`);
            }

            if (argument === "--concurrency") {
                concurrency = Number.parseInt(value, 10);
            } else if (argument === "--family") {
                families.push(value.trim());
            } else if (argument === "--output-dir") {
                outputDir = resolve(repoRoot, value);
            } else {
                upstreamRef = value.trim();
            }

            index += 1;
            continue;
        }

        throw new Error(`Unknown option: ${argument}`);
    }

    if (!help && parseSemverTag(upstreamRef) === null) {
        throw new Error("--ref is required and must look like v1.2.3.");
    }

    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
        throw new Error("--concurrency must be an integer from 1 through 8.");
    }

    if (!dryRun && !help && !confirmed) {
        throw new Error(
            "Downloading replaces the destination source tree. Add --confirm, or use --dry-run."
        );
    }

    assertPathInsideRepository(repoRoot, outputDir);
    const usesDefaultOutput =
        outputDir.toLowerCase() === defaultOutputDir.toLowerCase();
    if (!usesDefaultOutput) {
        const temporaryRoot = resolve(repoRoot, "temp");
        try {
            assertPathInsideRepository(temporaryRoot, outputDir);
        } catch {
            throw new Error(
                "A custom --output-dir must be a child of the repository temp directory."
            );
        }
    }

    if (families.length > 0 && usesDefaultOutput) {
        throw new Error(
            "--family requires a non-default --output-dir so a partial catalog cannot replace fonts/original."
        );
    }

    return {
        asJson,
        concurrency,
        confirmed,
        dryRun,
        families,
        help,
        outputDir,
        upstreamRef,
    };
}

/**
 * Reject archive entries that could escape the selected family directory.
 *
 * @param {string} entry
 *
 * @returns {void}
 */
export function validateArchiveEntry(entry) {
    const normalized = entry.replaceAll("\\", "/");
    const segments = normalized.split("/");
    if (
        normalized.includes("\0") ||
        normalized.startsWith("/") ||
        /^[A-Za-z]:\//v.test(normalized) ||
        segments.includes("..")
    ) {
        throw new Error(`Unsafe path in release archive: ${entry}`);
    }
}

/**
 * @param {string} archiveName
 *
 * @returns {string}
 */
export function archiveFamilyName(archiveName) {
    if (!archiveName.endsWith(ARCHIVE_SUFFIX)) {
        throw new Error(`Unsupported Nerd Fonts archive: ${archiveName}`);
    }

    const family = archiveName.slice(0, -ARCHIVE_SUFFIX.length);
    if (!/^[\w.\-]+$/v.test(family)) {
        throw new Error(`Unsafe Nerd Fonts family name: ${family}`);
    }

    return family;
}

/**
 * @param {string} url
 *
 * @returns {Promise<Response>}
 */
async function fetchResponse(url) {
    const headers = { "User-Agent": "nerd-fonts-woff2-updater" };
    const response = await fetch(url, { headers, redirect: "follow" });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} while downloading ${url}`);
    }

    return response;
}

/**
 * @param {string} url
 *
 * @returns {Promise<string>}
 */
async function fetchText(url) {
    return (await fetchResponse(url)).text();
}

/**
 * @param {string} filePath
 *
 * @returns {Promise<string>}
 */
async function sha256File(filePath) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(filePath)) {
        hash.update(chunk);
    }

    return hash.digest("hex");
}

/**
 * @param {string} url
 * @param {string} destination
 * @param {string} expectedSha256
 *
 * @returns {Promise<"cached" | "downloaded">}
 */
async function downloadVerifiedFile(url, destination, expectedSha256) {
    if (
        existsSync(destination) &&
        statSync(destination).isFile() &&
        (await sha256File(destination)) === expectedSha256
    ) {
        return "cached";
    }

    const partial = `${destination}.part`;
    rmSync(partial, { force: true });
    const response = await fetchResponse(url);
    writeFileSync(partial, Buffer.from(await response.arrayBuffer()));
    const actualSha256 = await sha256File(partial);
    if (actualSha256 !== expectedSha256) {
        rmSync(partial, { force: true });
        throw new Error(
            `Checksum mismatch for ${basename(destination)}: expected ${expectedSha256}, received ${actualSha256}`
        );
    }

    rmSync(destination, { force: true });
    renameSync(partial, destination);
    return "downloaded";
}

/**
 * @returns {void}
 */
function assertTarAvailable() {
    const result = spawnSync("tar", ["--version"], {
        encoding: "utf8",
        stdio: "pipe",
    });
    if (result.status !== 0) {
        throw new Error(
            "The release updater requires bsdtar/libarchive with .tar.xz support."
        );
    }
}

/**
 * @param {string} archivePath
 * @param {string} destination
 *
 * @returns {void}
 */
function extractArchive(archivePath, destination) {
    const listResult = spawnSync("tar", ["-tf", archivePath], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: "pipe",
    });
    if (listResult.status !== 0) {
        const message = listResult.stderr.trim() || listResult.stdout.trim();
        throw new Error(
            `Unable to inspect ${basename(archivePath)}: ${message}`
        );
    }

    const entries = listResult.stdout
        .split(/\r?\n/v)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    if (entries.length === 0) {
        throw new Error(`Release archive is empty: ${basename(archivePath)}`);
    }

    for (const entry of entries) {
        validateArchiveEntry(entry);
    }

    mkdirSync(destination, { recursive: true });
    const extractResult = spawnSync(
        "tar",
        [
            "-xf",
            archivePath,
            "-C",
            destination,
        ],
        { encoding: "utf8", stdio: "pipe" }
    );
    if (extractResult.status !== 0) {
        const message =
            extractResult.stderr.trim() || extractResult.stdout.trim();
        throw new Error(
            `Unable to extract ${basename(archivePath)}: ${message}`
        );
    }
}

/**
 * @param {string} directory
 *
 * @returns {number}
 */
function countSourceFonts(directory) {
    let count = 0;
    const queue = [directory];
    while (queue.length > 0) {
        const current = queue.shift();
        if (typeof current !== "string") continue;

        for (const entry of readdirSync(current, { withFileTypes: true })) {
            const absolutePath = join(current, entry.name);
            if (entry.isDirectory()) {
                queue.push(absolutePath);
            } else if (entry.isFile() && /\.(?:otf|ttf)$/iv.test(entry.name)) {
                count += 1;
            }
        }
    }

    return count;
}

/**
 * @template T
 *
 * @param {readonly T[]} values
 * @param {number} concurrency
 * @param {(value: T, index: number) => Promise<void>} worker
 *
 * @returns {Promise<void>}
 */
async function runPool(values, concurrency, worker) {
    let nextIndex = 0;

    /** @returns {Promise<void>} */
    async function runWorker() {
        while (nextIndex < values.length) {
            const currentIndex = nextIndex;
            nextIndex += 1;
            const value = values[currentIndex];
            if (value !== undefined) {
                await worker(value, currentIndex);
            }
        }
    }

    await Promise.all(
        Array.from({ length: Math.min(concurrency, values.length) }, async () =>
            runWorker()
        )
    );
}

/**
 * Replace a directory only after its replacement has been fully prepared.
 *
 * @param {string} repoRoot
 * @param {string} stagingDir
 * @param {string} destinationDir
 * @param {string} backupDir
 *
 * @returns {void}
 */
function replaceDirectory(repoRoot, stagingDir, destinationDir, backupDir) {
    for (const checkedPath of [
        stagingDir,
        destinationDir,
        backupDir,
    ]) {
        assertPathInsideRepository(repoRoot, checkedPath);
    }

    mkdirSync(dirname(destinationDir), { recursive: true });
    rmSync(backupDir, { force: true, recursive: true });
    let movedExisting = false;
    try {
        if (existsSync(destinationDir)) {
            mkdirSync(dirname(backupDir), { recursive: true });
            renameSync(destinationDir, backupDir);
            movedExisting = true;
        }

        renameSync(stagingDir, destinationDir);
    } catch (error) {
        if (movedExisting && !existsSync(destinationDir)) {
            renameSync(backupDir, destinationDir);
        }

        throw error;
    }

    rmSync(backupDir, { force: true, recursive: true });
}

/**
 * @returns {void}
 */
function printHelp() {
    process.stdout.write(`Download verified Nerd Fonts release assets.\n\n`);
    process.stdout.write(`Usage:\n`);
    process.stdout.write(
        `  node scripts/download-nerd-fonts-sources.mjs --ref v3.5.1 --dry-run\n`
    );
    process.stdout.write(
        `  node scripts/download-nerd-fonts-sources.mjs --ref v3.5.1 --confirm\n\n`
    );
    process.stdout.write(`Options:\n`);
    process.stdout.write(`  --ref <tag>          Required release tag\n`);
    process.stdout.write(`  --output-dir <path>  Destination source tree\n`);
    process.stdout.write(
        `                       Custom destinations must be under temp/\n`
    );
    process.stdout.write(
        `  --family <name>      Limit to a family (repeatable)\n`
    );
    process.stdout.write(
        `  --concurrency <1-8>  Parallel downloads (default 4)\n`
    );
    process.stdout.write(
        `  --dry-run            Inspect the release without writing\n`
    );
    process.stdout.write(
        `  --confirm            Confirm destination replacement\n`
    );
    process.stdout.write(`  --json               Emit a JSON summary\n`);
}

/**
 * @param {readonly string[]} argumentsList
 * @param {string} repoRoot
 *
 * @returns {Promise<void>}
 */
export async function main(
    argumentsList = process.argv.slice(2),
    repoRoot = process.cwd()
) {
    const options = parseDownloadOptions(argumentsList, repoRoot);
    if (options.help) {
        printHelp();
        return;
    }

    assertTarAvailable();
    const baseUrl = releaseAssetBaseUrl(options.upstreamRef);
    const manifestText = await fetchText(`${baseUrl}/SHA-256.txt`);
    const checksums = parseChecksumManifest(manifestText);
    const allArchives = [...checksums.keys()]
        .filter((name) => name.endsWith(ARCHIVE_SUFFIX))
        .sort((left, right) => left.localeCompare(right));
    const availableFamilies = new Set(allArchives.map(archiveFamilyName));
    for (const family of options.families) {
        if (!availableFamilies.has(family)) {
            throw new Error(
                `Family not found in ${options.upstreamRef}: ${family}`
            );
        }
    }

    const selectedFamilies = new Set(options.families);
    const archives =
        selectedFamilies.size === 0
            ? allArchives
            : allArchives.filter((archive) =>
                  selectedFamilies.has(archiveFamilyName(archive))
              );
    const commitSha = resolveUpstreamCommit(options.upstreamRef);
    const plan = {
        archiveCount: archives.length,
        commitSha,
        destination: options.outputDir,
        mode: options.dryRun ? "dry-run" : "download",
        upstreamRef: options.upstreamRef,
        upstreamRepo: UPSTREAM_REPO,
    };

    if (options.dryRun) {
        if (options.asJson) {
            process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
        } else {
            process.stdout.write(
                `[dry-run] ${archives.length} verified release archives would be downloaded and extracted.\n`
            );
            process.stdout.write(`Upstream ref: ${options.upstreamRef}\n`);
            process.stdout.write(`Resolved commit: ${commitSha}\n`);
            process.stdout.write(`Destination: ${options.outputDir}\n`);
        }

        return;
    }

    const cacheDir = resolve(
        repoRoot,
        "temp",
        "nerd-fonts-cache",
        options.upstreamRef
    );
    const stagingDir = resolve(
        repoRoot,
        "temp",
        "nerd-fonts-staging",
        `${options.upstreamRef}-${process.pid}`
    );
    const backupDir = resolve(
        repoRoot,
        "temp",
        "nerd-fonts-backups",
        `${basename(options.outputDir)}-${process.pid}`
    );
    for (const checkedPath of [
        cacheDir,
        stagingDir,
        backupDir,
    ]) {
        assertPathInsideRepository(repoRoot, checkedPath);
    }

    mkdirSync(cacheDir, { recursive: true });
    rmSync(stagingDir, { force: true, recursive: true });
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(cacheDir, "SHA-256.txt"), manifestText, "utf8");

    let completedDownloads = 0;
    let downloadedCount = 0;
    let cachedCount = 0;
    await runPool(archives, options.concurrency, async (archive) => {
        const checksum = checksums.get(archive);
        if (typeof checksum !== "string") {
            throw new Error(`Missing checksum for ${archive}`);
        }

        const status = await downloadVerifiedFile(
            `${baseUrl}/${archive}`,
            join(cacheDir, archive),
            checksum
        );
        if (status === "cached") cachedCount += 1;
        else downloadedCount += 1;
        completedDownloads += 1;
        if (!options.asJson) {
            process.stdout.write(
                `Downloaded/verified ${completedDownloads}/${archives.length}: ${archive}\n`
            );
        }
    });

    let extractedCount = 0;
    for (const archive of archives) {
        const family = archiveFamilyName(archive);
        extractArchive(join(cacheDir, archive), join(stagingDir, family));
        extractedCount += 1;
        if (!options.asJson) {
            process.stdout.write(
                `Extracted ${extractedCount}/${archives.length}: ${family}\n`
            );
        }
    }

    const sourceCount = countSourceFonts(stagingDir);
    if (sourceCount === 0 || sourceCount < archives.length) {
        throw new Error(
            `Staged release contains an implausible source count: ${sourceCount}`
        );
    }

    const metadata = {
        archiveCount: archives.length,
        commitSha,
        downloadedAt: new Date().toISOString(),
        manifestSha256: createHash("sha256").update(manifestText).digest("hex"),
        sourceCount,
        upstreamRef: options.upstreamRef,
        upstreamRepo: UPSTREAM_REPO,
    };
    writeFileSync(
        join(stagingDir, ".source-metadata.json"),
        `${JSON.stringify(metadata, null, 2)}\n`,
        "utf8"
    );
    replaceDirectory(repoRoot, stagingDir, options.outputDir, backupDir);

    const result = {
        ...plan,
        cachedArchives: cachedCount,
        downloadedArchives: downloadedCount,
        sourceCount,
    };
    if (options.asJson) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
        process.stdout.write(`\nPrepared Nerd Fonts sources successfully.\n`);
        process.stdout.write(`Upstream ref: ${options.upstreamRef}\n`);
        process.stdout.write(`Source fonts: ${sourceCount}\n`);
        process.stdout.write(`Destination: ${options.outputDir}\n`);
    }
}

const moduleFilePath = fileURLToPath(import.meta.url);
if (isMainModule(process.argv[1], moduleFilePath)) {
    try {
        await main();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Error: ${message}\n`);
        process.exitCode = 1;
    }
}
