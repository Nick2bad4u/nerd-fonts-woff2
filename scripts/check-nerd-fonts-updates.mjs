#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const UPSTREAM_REPO = "https://github.com/ryanoasis/nerd-fonts.git";
const repoRoot = process.cwd();
const metadataFile = resolve(
    repoRoot,
    "fonts",
    "original",
    ".source-metadata.json"
);

const asJson = process.argv.includes("--json");
const failOnUpdate = process.argv.includes("--fail-on-update");

/**
 * @param {string} text
 *
 * @returns {{ major: number; minor: number; patch: number } | null}
 */
function parseSemverTag(text) {
    const match = /^v(\d+)\.(\d+)\.(\d+)$/u.exec(text.trim());
    if (match === null) {
        return null;
    }

    const majorRaw = match[1];
    const minorRaw = match[2];
    const patchRaw = match[3];
    if (
        typeof majorRaw !== "string" ||
        typeof minorRaw !== "string" ||
        typeof patchRaw !== "string"
    ) {
        return null;
    }

    return {
        major: Number.parseInt(majorRaw, 10),
        minor: Number.parseInt(minorRaw, 10),
        patch: Number.parseInt(patchRaw, 10),
    };
}

/**
 * @param {string} left
 * @param {string} right
 *
 * @returns {number}
 */
function compareSemverTags(left, right) {
    const a = parseSemverTag(left);
    const b = parseSemverTag(right);
    if (a === null || b === null) {
        return left.localeCompare(right);
    }

    if (a.major !== b.major) return a.major - b.major;
    if (a.minor !== b.minor) return a.minor - b.minor;
    return a.patch - b.patch;
}

/**
 * @returns {string[]}
 */
function fetchUpstreamTags() {
    const result = spawnSync(
        "git",
        [
            "ls-remote",
            "--refs",
            "--tags",
            UPSTREAM_REPO,
        ],
        { encoding: "utf8", stdio: "pipe" }
    );

    if (result.status !== 0) {
        const message = result.stderr.trim() || result.stdout.trim();
        throw new Error(`git ls-remote failed: ${message}`);
    }

    return result.stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => line.split(/\s+/u)[1] ?? "")
        .map((ref) => ref.replace("refs/tags/", ""))
        .filter((tag) => /^v\d+\.\d+\.\d+$/u.test(tag))
        .sort(compareSemverTags);
}

/**
 * @returns {{
 *     upstreamRef?: string;
 *     commitSha?: string;
 *     downloadedAt?: string;
 * } | null}
 */
function readLocalMetadata() {
    if (!existsSync(metadataFile)) {
        return null;
    }

    const parsed = JSON.parse(readFileSync(metadataFile, "utf8"));
    if (typeof parsed !== "object" || parsed === null) {
        return null;
    }

    return parsed;
}

/**
 *
 */

/**
 *
 */
function main() {
    const localMeta = readLocalMetadata();
    const tags = fetchUpstreamTags();
    const latestTag = tags.at(-1);

    if (typeof latestTag !== "string") {
        throw new TypeError(
            "No version tags found in upstream Nerd Fonts repository."
        );
    }

    const localRef =
        localMeta !== null && typeof localMeta.upstreamRef === "string"
            ? localMeta.upstreamRef
            : null;
    const updateAvailable =
        localRef === null ? true : compareSemverTags(localRef, latestTag) < 0;

    const result = {
        localRef,
        latestTag,
        metadataFile,
        updateAvailable,
        upstreamRepo: UPSTREAM_REPO,
    };

    if (asJson) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
        process.stdout.write(`Upstream latest Nerd Fonts tag: ${latestTag}\n`);
        process.stdout.write(
            `Local source ref: ${localRef ?? "(missing metadata)"}\n`
        );
        process.stdout.write(
            `Update available: ${updateAvailable ? "yes" : "no"}\n`
        );
        process.stdout.write(`Metadata file: ${metadataFile}\n`);
    }

    if (updateAvailable && failOnUpdate) {
        process.exitCode = 2;
    }
}

try {
    main();
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
}
