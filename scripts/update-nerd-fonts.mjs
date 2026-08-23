#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    statfsSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
    assertPathInsideRepository,
    compareSemverTags,
    fetchLatestUpstreamTag,
    isMainModule,
    parseSemverTag,
    readLocalSourceMetadata,
    readMetadataFile,
    UPSTREAM_REPOSITORY,
} from "./nerd-fonts-release.mjs";

/**
 * @typedef {{
 *     asJson: boolean;
 *     confirm: boolean;
 *     conversionConcurrency: number | null;
 *     convert: boolean;
 *     downloadConcurrency: number;
 *     dryRun: boolean;
 *     help: boolean;
 *     timeoutSeconds: number;
 *     upstreamRef: string | null;
 * }} UpdateOptions
 */

/**
 * @param {readonly string[]} argumentsList
 *
 * @returns {UpdateOptions}
 */
export function parseUpdateOptions(argumentsList) {
    /** @type {UpdateOptions} */
    const parsed = {
        asJson: false,
        confirm: false,
        conversionConcurrency: null,
        convert: false,
        downloadConcurrency: 4,
        dryRun: false,
        help: false,
        timeoutSeconds: 240,
        upstreamRef: null,
    };

    for (let index = 0; index < argumentsList.length; index += 1) {
        const argument = argumentsList[index];
        if (argument === "--confirm") {
            parsed.confirm = true;
            continue;
        }

        if (argument === "--convert") {
            parsed.convert = true;
            continue;
        }

        if (argument === "--dry-run") {
            parsed.dryRun = true;
            continue;
        }

        if (argument === "--help" || argument === "-h") {
            parsed.help = true;
            continue;
        }

        if (argument === "--json") {
            parsed.asJson = true;
            continue;
        }

        if (
            argument === "--concurrency" ||
            argument === "--download-concurrency" ||
            argument === "--ref" ||
            argument === "--timeout"
        ) {
            const value = argumentsList[index + 1];
            if (typeof value !== "string" || value.trim().length === 0) {
                throw new Error(`${argument} requires a non-empty value.`);
            }

            if (argument === "--concurrency") {
                parsed.conversionConcurrency = Number.parseInt(value, 10);
            } else if (argument === "--download-concurrency") {
                parsed.downloadConcurrency = Number.parseInt(value, 10);
            } else if (argument === "--ref") {
                parsed.upstreamRef = value.trim();
            } else {
                parsed.timeoutSeconds = Number.parseInt(value, 10);
            }

            index += 1;
            continue;
        }

        throw new Error(`Unknown option: ${argument}`);
    }

    if (
        parsed.upstreamRef !== null &&
        parseSemverTag(parsed.upstreamRef) === null
    ) {
        throw new Error("--ref must look like v1.2.3.");
    }

    if (
        !Number.isInteger(parsed.downloadConcurrency) ||
        parsed.downloadConcurrency < 1 ||
        parsed.downloadConcurrency > 8
    ) {
        throw new Error(
            "--download-concurrency must be an integer from 1 through 8."
        );
    }

    if (
        parsed.conversionConcurrency !== null &&
        (!Number.isInteger(parsed.conversionConcurrency) ||
            parsed.conversionConcurrency < 1 ||
            parsed.conversionConcurrency > 32)
    ) {
        throw new Error("--concurrency must be an integer from 1 through 32.");
    }

    if (!Number.isInteger(parsed.timeoutSeconds) || parsed.timeoutSeconds < 1) {
        throw new Error("--timeout must be a positive integer in seconds.");
    }

    if (parsed.convert && !parsed.confirm && !parsed.dryRun) {
        throw new Error(
            "Applying a font update requires both --convert and --confirm."
        );
    }

    return parsed;
}

/**
 * @param {string} command
 * @param {readonly string[]} argumentsList
 * @param {string} cwd
 * @param {"inherit" | "pipe"} [stdio]
 *
 * @returns {string}
 */
function runCommand(command, argumentsList, cwd, stdio = "inherit") {
    const result = spawnSync(command, argumentsList, {
        cwd,
        encoding: "utf8",
        stdio,
    });
    if (result.error instanceof Error) {
        throw result.error;
    }

    if (result.status !== 0) {
        const message =
            typeof result.stderr === "string" && result.stderr.trim().length > 0
                ? result.stderr.trim()
                : typeof result.stdout === "string"
                  ? result.stdout.trim()
                  : "";
        throw new Error(
            `${command} ${argumentsList.join(" ")} failed${message.length > 0 ? `: ${message}` : ""}`
        );
    }

    return typeof result.stdout === "string" ? result.stdout.trim() : "";
}

/**
 * @returns {{ git: string; tar: string; ttf2woff2: string }}
 */
function inspectPrerequisites() {
    const git = runCommand("git", ["--version"], process.cwd(), "pipe");
    const tar = runCommand("tar", ["--version"], process.cwd(), "pipe")
        .split(/\r?\n/v)[0]
        ?.trim();
    const require = createRequire(import.meta.url);
    let converterPath;
    try {
        converterPath = require.resolve("ttf2woff2/package.json");
    } catch {
        throw new Error("ttf2woff2 is not installed. Run npm install first.");
    }

    return {
        git,
        tar: tar ?? "tar",
        ttf2woff2: converterPath,
    };
}

/**
 * @param {string} directory
 *
 * @returns {number}
 */
function measureDirectoryBytes(directory) {
    if (!existsSync(directory)) return 0;

    let total = 0;
    const queue = [directory];
    while (queue.length > 0) {
        const current = queue.shift();
        if (typeof current !== "string") continue;

        for (const entry of readdirSync(current, { withFileTypes: true })) {
            const absolutePath = join(current, entry.name);
            if (entry.isDirectory()) queue.push(absolutePath);
            else if (entry.isFile()) total += statSync(absolutePath).size;
        }
    }

    return total;
}

/**
 * @param {string} repoRoot
 * @param {number} compressedBytes
 *
 * @returns {{
 *     availableBytes: number;
 *     currentAssetBytes: number;
 *     estimatedWorkingBytes: number;
 *     ready: boolean;
 * }}
 */
function inspectDiskCapacity(repoRoot, compressedBytes) {
    const currentAssetBytes =
        measureDirectoryBytes(resolve(repoRoot, "fonts", "original")) +
        measureDirectoryBytes(resolve(repoRoot, "fonts", "woff2"));
    const estimatedWorkingBytes = Math.ceil(
        Math.max(currentAssetBytes * 1.25, compressedBytes * 20)
    );
    const fileSystem = statfsSync(repoRoot, { bigint: true });
    const availableBytes = Number(fileSystem.bavail * fileSystem.bsize);

    return {
        availableBytes,
        currentAssetBytes,
        estimatedWorkingBytes,
        ready: availableBytes >= estimatedWorkingBytes,
    };
}

/**
 * @param {string} upstreamRef
 *
 * @returns {Promise<{
 *     archiveCount: number;
 *     compressedBytes: number;
 *     publishedAt: string | null;
 *     releaseUrl: string;
 * }>}
 */
async function fetchReleaseInformation(upstreamRef) {
    const headers = {
        Accept: "application/vnd.github+json",
        "User-Agent": "nerd-fonts-woff2-updater",
    };
    const releaseApiUrl =
        `https://api.github.com/repos/${UPSTREAM_REPOSITORY}/releases/tags/` +
        upstreamRef;
    let response = null;
    let lastNetworkError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
            response = await fetch(releaseApiUrl, { headers });
        } catch (error) {
            lastNetworkError = error;
            if (attempt === 3) break;
            await new Promise((resolvePromise) => {
                setTimeout(resolvePromise, attempt * 500);
            });
            continue;
        }

        if (response.ok) break;

        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt === 3) {
            throw new Error(
                `GitHub release lookup failed for ${upstreamRef}: HTTP ${response.status}`
            );
        }

        await new Promise((resolvePromise) => {
            setTimeout(resolvePromise, attempt * 500);
        });
    }

    if (response === null || !response.ok) {
        throw new Error(
            `GitHub release lookup failed for ${upstreamRef} after 3 attempts.`,
            lastNetworkError === undefined
                ? undefined
                : { cause: lastNetworkError }
        );
    }

    const release = await response.json();
    if (typeof release !== "object" || release === null) {
        throw new Error(
            `GitHub returned invalid release data for ${upstreamRef}.`
        );
    }

    const assetsValue = Reflect.get(release, "assets");
    const assets = Array.isArray(assetsValue) ? assetsValue : [];
    const tarAssets = assets.filter((asset) => {
        return (
            typeof asset === "object" &&
            asset !== null &&
            String(Reflect.get(asset, "name")).endsWith(".tar.xz")
        );
    });
    const hasChecksum = assets.some(
        (asset) =>
            typeof asset === "object" &&
            asset !== null &&
            Reflect.get(asset, "name") === "SHA-256.txt"
    );
    if (tarAssets.length === 0 || !hasChecksum) {
        throw new Error(
            `${upstreamRef} does not expose the expected .tar.xz assets and SHA-256.txt manifest.`
        );
    }

    const compressedBytes = tarAssets.reduce((total, asset) => {
        const size = Reflect.get(asset, "size");
        return total + (typeof size === "number" ? size : 0);
    }, 0);
    const publishedAt = Reflect.get(release, "published_at");

    return {
        archiveCount: tarAssets.length,
        compressedBytes,
        publishedAt: typeof publishedAt === "string" ? publishedAt : null,
        releaseUrl: `https://github.com/${UPSTREAM_REPOSITORY}/releases/tag/${upstreamRef}`,
    };
}

/**
 * @param {string} repoRoot
 * @param {string} stagingSources
 * @param {string} stagingOutputs
 * @param {string} destinationSources
 * @param {string} destinationOutputs
 * @param {string} backupRoot
 *
 * @returns {void}
 */
function promoteAssetTrees(
    repoRoot,
    stagingSources,
    stagingOutputs,
    destinationSources,
    destinationOutputs,
    backupRoot
) {
    const backupSources = resolve(backupRoot, "original");
    const backupOutputs = resolve(backupRoot, "woff2");
    const stateFile = resolve(backupRoot, "promotion-state.json");
    for (const checkedPath of [
        stagingSources,
        stagingOutputs,
        destinationSources,
        destinationOutputs,
        backupRoot,
        backupSources,
        backupOutputs,
        stateFile,
    ]) {
        assertPathInsideRepository(repoRoot, checkedPath);
    }

    if (!existsSync(stagingSources) || !existsSync(stagingOutputs)) {
        throw new Error("Staged source and output trees must both exist.");
    }

    rmSync(backupRoot, { force: true, recursive: true });
    mkdirSync(backupRoot, { recursive: true });
    writeFileSync(
        stateFile,
        `${JSON.stringify(
            {
                hadOutputs: existsSync(destinationOutputs),
                hadSources: existsSync(destinationSources),
                state: "promoting",
            },
            null,
            2
        )}\n`,
        "utf8"
    );
    let oldSourcesMoved = false;
    let oldOutputsMoved = false;
    let newSourcesInstalled = false;
    let newOutputsInstalled = false;
    try {
        if (existsSync(destinationSources)) {
            renameSync(destinationSources, backupSources);
            oldSourcesMoved = true;
        }

        if (existsSync(destinationOutputs)) {
            renameSync(destinationOutputs, backupOutputs);
            oldOutputsMoved = true;
        }

        mkdirSync(dirname(destinationSources), { recursive: true });
        renameSync(stagingSources, destinationSources);
        newSourcesInstalled = true;
        renameSync(stagingOutputs, destinationOutputs);
        newOutputsInstalled = true;
    } catch (error) {
        if (newOutputsInstalled) {
            rmSync(destinationOutputs, { force: true, recursive: true });
        }

        if (oldOutputsMoved) {
            renameSync(backupOutputs, destinationOutputs);
        }

        if (newSourcesInstalled) {
            rmSync(destinationSources, { force: true, recursive: true });
        }

        if (oldSourcesMoved) {
            renameSync(backupSources, destinationSources);
        }

        rmSync(backupRoot, { force: true, recursive: true });
        throw error;
    }
}

/**
 * Recover a promotion interrupted between directory renames. A transaction
 * marked as promoted keeps the verified new trees; an in-progress transaction
 * restores the prior trees.
 *
 * @param {string} repoRoot
 * @param {string} backupRoot
 * @param {string} destinationSources
 * @param {string} destinationOutputs
 *
 * @returns {"none" | "restored" | "completed"}
 */
function recoverInterruptedPromotion(
    repoRoot,
    backupRoot,
    destinationSources,
    destinationOutputs
) {
    if (!existsSync(backupRoot)) return "none";

    const backupSources = resolve(backupRoot, "original");
    const backupOutputs = resolve(backupRoot, "woff2");
    const stateFile = resolve(backupRoot, "promotion-state.json");
    for (const checkedPath of [
        backupRoot,
        backupSources,
        backupOutputs,
        stateFile,
        destinationSources,
        destinationOutputs,
    ]) {
        assertPathInsideRepository(repoRoot, checkedPath);
    }

    if (!existsSync(stateFile)) {
        if (existsSync(backupSources) || existsSync(backupOutputs)) {
            throw new Error(
                `Promotion backup exists without transaction state: ${backupRoot}`
            );
        }

        rmSync(backupRoot, { force: true, recursive: true });
        return "none";
    }

    const stateValue = JSON.parse(readFileSync(stateFile, "utf8"));
    if (typeof stateValue !== "object" || stateValue === null) {
        throw new Error(`Invalid promotion state: ${stateFile}`);
    }

    const state = Reflect.get(stateValue, "state");
    if (state === "promoted") {
        rmSync(backupSources, { force: true, recursive: true });
        rmSync(backupOutputs, { force: true, recursive: true });
        rmSync(stateFile, { force: true });
        rmSync(backupRoot, { force: true, recursive: true });
        return "completed";
    }

    if (state !== "promoting") {
        throw new Error(
            `Unknown promotion state in ${stateFile}: ${String(state)}`
        );
    }

    const hadSources = Reflect.get(stateValue, "hadSources") === true;
    const hadOutputs = Reflect.get(stateValue, "hadOutputs") === true;
    if (existsSync(backupOutputs)) {
        rmSync(destinationOutputs, { force: true, recursive: true });
        renameSync(backupOutputs, destinationOutputs);
    } else if (!hadOutputs) {
        rmSync(destinationOutputs, { force: true, recursive: true });
    }

    if (existsSync(backupSources)) {
        rmSync(destinationSources, { force: true, recursive: true });
        renameSync(backupSources, destinationSources);
    } else if (!hadSources) {
        rmSync(destinationSources, { force: true, recursive: true });
    }

    rmSync(stateFile, { force: true });
    rmSync(backupRoot, { force: true, recursive: true });
    return "restored";
}

/**
 * Mark a verified promotion complete before removing its old-tree backups. The
 * state file is removed last so a process interruption never makes a partial
 * backup look restorable.
 *
 * @param {string} repoRoot
 * @param {string} backupRoot
 *
 * @returns {void}
 */
function completePromotion(repoRoot, backupRoot) {
    const backupSources = resolve(backupRoot, "original");
    const backupOutputs = resolve(backupRoot, "woff2");
    const stateFile = resolve(backupRoot, "promotion-state.json");
    for (const checkedPath of [
        backupRoot,
        backupSources,
        backupOutputs,
        stateFile,
    ]) {
        assertPathInsideRepository(repoRoot, checkedPath);
    }

    writeFileSync(
        stateFile,
        `${JSON.stringify({ state: "promoted" }, null, 2)}\n`,
        "utf8"
    );
    rmSync(backupSources, { force: true, recursive: true });
    rmSync(backupOutputs, { force: true, recursive: true });
    rmSync(stateFile, { force: true });
    rmSync(backupRoot, { force: true, recursive: true });
}

/**
 * Prevent concurrent update applications. Stale lock files left by a crashed
 * process are removed only after confirming that their recorded PID is gone.
 *
 * @param {string} repoRoot
 *
 * @returns {() => void}
 */
function acquireUpdateLock(repoRoot) {
    const lockFile = resolve(
        repoRoot,
        "temp",
        "nerd-fonts-update",
        "update.lock"
    );
    assertPathInsideRepository(repoRoot, lockFile);
    mkdirSync(dirname(lockFile), { recursive: true });

    /** @returns {() => void} */
    function acquire() {
        let descriptor;
        try {
            descriptor = openSync(lockFile, "wx");
        } catch (error) {
            if (
                !(error instanceof Error) ||
                Reflect.get(error, "code") !== "EEXIST"
            ) {
                throw error;
            }

            let recordedPid = null;
            try {
                const lockValue = JSON.parse(readFileSync(lockFile, "utf8"));
                const pidValue = Reflect.get(lockValue, "pid");
                if (typeof pidValue === "number") recordedPid = pidValue;
            } catch {
                throw new Error(
                    `Update lock exists but is unreadable: ${lockFile}`
                );
            }

            if (
                typeof recordedPid !== "number" ||
                !Number.isInteger(recordedPid) ||
                recordedPid < 1
            ) {
                throw new Error(
                    `Update lock does not contain a valid PID: ${lockFile}`
                );
            }

            let processIsActive = false;
            try {
                process.kill(recordedPid, 0);
                processIsActive = true;
            } catch (processError) {
                if (
                    processError instanceof Error &&
                    Reflect.get(processError, "code") !== "ESRCH"
                ) {
                    processIsActive = true;
                }
            }

            if (processIsActive) {
                throw new Error(
                    `Another Nerd Fonts update is active (PID ${recordedPid}).`
                );
            }

            rmSync(lockFile, { force: true });
            return acquire();
        }

        if (typeof descriptor !== "number") {
            throw new TypeError(`Failed to open update lock: ${lockFile}`);
        }

        try {
            writeFileSync(
                descriptor,
                `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2)}\n`,
                "utf8"
            );
        } catch (error) {
            closeSync(descriptor);
            rmSync(lockFile, { force: true });
            throw error;
        }
        let released = false;
        return () => {
            if (released) return;
            released = true;
            closeSync(descriptor);
            rmSync(lockFile, { force: true });
        };
    }

    return acquire();
}

/**
 * Keep user-facing upstream provenance and release-asset links synchronized
 * with the generated asset set.
 *
 * @param {string} repoRoot
 * @param {string} targetRef
 *
 * @returns {boolean}
 */
function updateReadmeRelease(repoRoot, targetRef) {
    const readmeFile = resolve(repoRoot, "README.md");
    const original = readFileSync(readmeFile, "utf8");
    const updated = original
        .replaceAll(/Nerd Fonts v\d+\.\d+\.\d+/gv, `Nerd Fonts ${targetRef}`)
        .replaceAll(
            /(ryanoasis\/nerd-fonts\/releases\/(?:download|tag)\/)v\d+\.\d+\.\d+/gv,
            `$1${targetRef}`
        );
    if (updated === original) return false;

    writeFileSync(readmeFile, updated, "utf8");
    return true;
}

/**
 * @returns {void}
 */
function printHelp() {
    process.stdout.write(
        `Safely update the complete Nerd Fonts WOFF2 asset set.\n\n`
    );
    process.stdout.write(`Plan the latest release (default):\n`);
    process.stdout.write(`  npm run fonts:update\n\n`);
    process.stdout.write(`Apply the reviewed plan:\n`);
    process.stdout.write(
        `  npm run -- fonts:update -- --ref v3.5.1 --convert --confirm\n\n`
    );
    process.stdout.write(`Options:\n`);
    process.stdout.write(
        `  --ref <tag>                 Target tag (default latest)\n`
    );
    process.stdout.write(
        `  --convert --confirm         Apply download and conversion\n`
    );
    process.stdout.write(
        `  --dry-run                   Force non-mutating plan mode\n`
    );
    process.stdout.write(
        `  --download-concurrency <n>  1-8 downloads (default 4)\n`
    );
    process.stdout.write(
        `  --concurrency <n>           1-32 conversion workers\n`
    );
    process.stdout.write(
        `  --timeout <seconds>         Per-font timeout (default 240)\n`
    );
    process.stdout.write(
        `  --json                      Emit plan/result JSON\n`
    );
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
    const options = parseUpdateOptions(argumentsList);
    if (options.help) {
        printHelp();
        return;
    }

    const prerequisites = inspectPrerequisites();
    const targetRef = options.upstreamRef ?? fetchLatestUpstreamTag();
    const local = readLocalSourceMetadata(repoRoot);
    const localRef =
        local !== null && typeof local.metadata.upstreamRef === "string"
            ? local.metadata.upstreamRef
            : null;
    const updateAvailable =
        localRef === null || compareSemverTags(localRef, targetRef) < 0;
    const release = await fetchReleaseInformation(targetRef);
    const disk = inspectDiskCapacity(repoRoot, release.compressedBytes);
    const plan = {
        ...release,
        currentRef: localRef,
        disk,
        metadataFile: local?.file ?? null,
        mode: options.convert && !options.dryRun ? "apply" : "plan",
        prerequisites,
        targetRef,
        updateAvailable,
    };

    if (!options.convert || options.dryRun) {
        if (options.asJson) {
            process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
        } else {
            process.stdout.write(`Nerd Fonts update plan\n`);
            process.stdout.write(
                `  Current generated ref: ${localRef ?? "unknown"}\n`
            );
            process.stdout.write(`  Target release:        ${targetRef}\n`);
            process.stdout.write(
                `  Update available:      ${updateAvailable ? "yes" : "no"}\n`
            );
            process.stdout.write(
                `  Release archives:      ${release.archiveCount}\n`
            );
            process.stdout.write(
                `  Compressed download:   ${(release.compressedBytes / 1024 / 1024).toFixed(1)} MiB\n`
            );
            process.stdout.write(
                `  Estimated workspace:  ${(disk.estimatedWorkingBytes / 1024 / 1024 / 1024).toFixed(1)} GiB\n`
            );
            process.stdout.write(
                `  Available disk:        ${(disk.availableBytes / 1024 / 1024 / 1024).toFixed(1)} GiB (${disk.ready ? "ready" : "insufficient"})\n`
            );
            process.stdout.write(
                `  Published:             ${release.publishedAt}\n`
            );
            process.stdout.write(
                `  Release:               ${release.releaseUrl}\n\n`
            );
            process.stdout.write(
                `No files were changed. To apply this exact ref:\n`
            );
            process.stdout.write(
                `  npm run -- fonts:update -- --ref ${targetRef} --convert --confirm\n`
            );
        }

        return;
    }

    if (localRef !== null && compareSemverTags(targetRef, localRef) < 0) {
        throw new Error(
            `Refusing to downgrade from ${localRef} to ${targetRef}. Use a newer target.`
        );
    }

    if (!disk.ready) {
        throw new Error(
            `Insufficient free space: estimated ${disk.estimatedWorkingBytes} bytes, available ${disk.availableBytes} bytes.`
        );
    }

    const updateRoot = resolve(
        repoRoot,
        "temp",
        "nerd-fonts-update",
        targetRef
    );
    const stagingSources = resolve(updateRoot, "sources");
    const stagingOutputs = resolve(updateRoot, "woff2");
    const backupRoot = resolve(
        repoRoot,
        "temp",
        "nerd-fonts-update",
        "promotion-transaction"
    );
    const destinationSources = resolve(repoRoot, "fonts", "original");
    const destinationOutputs = resolve(repoRoot, "fonts", "woff2");
    for (const checkedPath of [
        updateRoot,
        stagingSources,
        stagingOutputs,
        backupRoot,
        destinationSources,
        destinationOutputs,
    ]) {
        assertPathInsideRepository(repoRoot, checkedPath);
    }
    const releaseUpdateLock = acquireUpdateLock(repoRoot);
    const childStdio = options.asJson ? "pipe" : "inherit";
    try {
        const recovery = recoverInterruptedPromotion(
            repoRoot,
            backupRoot,
            destinationSources,
            destinationOutputs
        );
        if (recovery !== "none" && !options.asJson) {
            process.stdout.write(
                `Recovered an interrupted asset promotion (${recovery}).\n`
            );
        }

        runCommand(
            process.execPath,
            [
                resolve(repoRoot, "scripts", "download-nerd-fonts-sources.mjs"),
                "--ref",
                targetRef,
                "--output-dir",
                stagingSources,
                "--concurrency",
                String(options.downloadConcurrency),
                "--confirm",
            ],
            repoRoot,
            childStdio
        );

        rmSync(stagingOutputs, { force: true, recursive: true });
        const convertArguments = [
            resolve(repoRoot, "scripts", "bulk-convert-fonts.mjs"),
            "--source-dir",
            stagingSources,
            "--output-dir",
            stagingOutputs,
            "--public-source-dir",
            "fonts/original",
            "--public-output-dir",
            "fonts/woff2",
            "--timeout",
            String(options.timeoutSeconds),
            "--force",
            "--convert",
            "--confirm",
        ];
        if (options.conversionConcurrency !== null) {
            convertArguments.push(
                "--concurrency",
                String(options.conversionConcurrency)
            );
        }

        runCommand(process.execPath, convertArguments, repoRoot, childStdio);

        const sourceMetadata = readMetadataFile(
            resolve(stagingSources, ".source-metadata.json")
        );
        if (
            sourceMetadata === null ||
            typeof sourceMetadata.sourceCount !== "number"
        ) {
            throw new Error("Staged source metadata is missing or invalid.");
        }

        const indexValue = JSON.parse(
            readFileSync(resolve(stagingOutputs, "index.json"), "utf8")
        );
        if (!Array.isArray(indexValue)) {
            throw new TypeError("Staged WOFF2 index is invalid.");
        }

        const outputMetadata = {
            ...sourceMetadata,
            generatedAt: new Date().toISOString(),
            outputCount: indexValue.length,
        };
        const stagedMetadataFile = resolve(
            stagingOutputs,
            "source-metadata.json"
        );
        writeFileSync(
            stagedMetadataFile,
            `${JSON.stringify(outputMetadata, null, 2)}\n`,
            "utf8"
        );

        const verificationArguments = [
            resolve(repoRoot, "scripts", "verify-font-assets.mjs"),
            "--source-dir",
            stagingSources,
            "--output-dir",
            stagingOutputs,
            "--metadata-file",
            stagedMetadataFile,
            "--public-source-dir",
            "fonts/original",
            "--public-output-dir",
            "fonts/woff2",
            "--require-metadata",
        ];
        runCommand(
            process.execPath,
            verificationArguments,
            repoRoot,
            childStdio
        );

        promoteAssetTrees(
            repoRoot,
            stagingSources,
            stagingOutputs,
            destinationSources,
            destinationOutputs,
            backupRoot
        );
        runCommand(
            process.execPath,
            [
                resolve(repoRoot, "scripts", "verify-font-assets.mjs"),
                "--require-metadata",
            ],
            repoRoot,
            childStdio
        );
        completePromotion(repoRoot, backupRoot);
        const readmeUpdated = updateReadmeRelease(repoRoot, targetRef);

        const result = {
            ...plan,
            metadataFile: resolve(destinationOutputs, "source-metadata.json"),
            outputCount: indexValue.length,
            readmeUpdated,
            sourceCount: sourceMetadata.sourceCount,
        };
        if (options.asJson) {
            process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } else {
            process.stdout.write(
                `\nNerd Fonts ${targetRef} update completed.\n`
            );
            process.stdout.write(
                `  Source fonts: ${sourceMetadata.sourceCount}\n`
            );
            process.stdout.write(`  WOFF2 files:  ${indexValue.length}\n`);
            process.stdout.write(
                `  Metadata:     ${resolve(destinationOutputs, "source-metadata.json")}\n`
            );
        }
    } catch (error) {
        try {
            recoverInterruptedPromotion(
                repoRoot,
                backupRoot,
                destinationSources,
                destinationOutputs
            );
        } catch (recoveryError) {
            throw new AggregateError(
                [error, recoveryError],
                "The update failed and automatic asset rollback also failed."
            );
        }

        throw error;
    } finally {
        releaseUpdateLock();
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
