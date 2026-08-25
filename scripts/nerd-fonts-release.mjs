import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { assertSafeRepositoryPath } from "./safe-filesystem.mjs";

export const UPSTREAM_REPO = "https://github.com/ryanoasis/nerd-fonts.git";
export const UPSTREAM_REPOSITORY = "ryanoasis/nerd-fonts";

/**
 * @param {string} text
 *
 * @returns {{ major: number; minor: number; patch: number } | null}
 */
export function parseSemverTag(text) {
    const match = /^v(\d+)\.(\d+)\.(\d+)$/v.exec(text.trim());
    if (match === null) {
        return null;
    }

    const [
        ,
        majorRaw,
        minorRaw,
        patchRaw,
    ] = match;
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
export function compareSemverTags(left, right) {
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
 * Return all stable semantic-version tags published by Nerd Fonts.
 *
 * @returns {string[]}
 */
export function fetchUpstreamTags() {
    const result = spawnSync(
        "git",
        [
            "ls-remote",
            "--refs",
            "--tags",
            UPSTREAM_REPO,
        ],
        {
            encoding: "utf8",
            maxBuffer: 64 * 1024 * 1024,
            stdio: "pipe",
            timeout: 30_000,
            windowsHide: true,
        }
    );

    if (result.status !== 0) {
        const message = result.stderr.trim() || result.stdout.trim();
        throw new Error(`git ls-remote failed: ${message}`);
    }

    return result.stdout
        .split(/\r?\n/v)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => line.split(/\s+/v)[1] ?? "")
        .map((ref) => ref.replace("refs/tags/", ""))
        .filter((tag) => parseSemverTag(tag) !== null)
        .sort(compareSemverTags);
}

/**
 * @returns {string}
 */
export function fetchLatestUpstreamTag() {
    const latestTag = fetchUpstreamTags().at(-1);
    if (typeof latestTag !== "string") {
        throw new TypeError(
            "No stable version tags found in the upstream Nerd Fonts repository."
        );
    }

    return latestTag;
}

/**
 * Resolve an annotated or lightweight upstream tag to its commit SHA.
 *
 * @param {string} ref
 *
 * @returns {string}
 */
export function resolveUpstreamCommit(ref) {
    const result = spawnSync(
        "git",
        [
            "ls-remote",
            UPSTREAM_REPO,
            `refs/tags/${ref}`,
            `refs/tags/${ref}^{}`,
        ],
        {
            encoding: "utf8",
            maxBuffer: 64 * 1024 * 1024,
            stdio: "pipe",
            timeout: 30_000,
            windowsHide: true,
        }
    );

    if (result.status !== 0) {
        const message = result.stderr.trim() || result.stdout.trim();
        throw new Error(`Unable to resolve upstream tag ${ref}: ${message}`);
    }

    const lines = result.stdout
        .split(/\r?\n/v)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    const peeled = lines.find((line) => line.endsWith(`refs/tags/${ref}^{}`));
    const selected = peeled ?? lines[0];
    const sha = selected?.split(/\s+/v)[0];
    if (typeof sha !== "string" || !/^[\da-f]{40}$/v.test(sha)) {
        throw new Error(`Upstream tag not found: ${ref}`);
    }

    return sha;
}

/**
 * @typedef {{
 *     archiveCount?: number;
 *     commitSha?: string;
 *     downloadedAt?: string;
 *     generatedAt?: string;
 *     manifestSha256?: string;
 *     outputCount?: number;
 *     planFingerprint?: string | null;
 *     sourceCount?: number;
 *     upstreamRef?: string;
 *     upstreamRepo?: string;
 * }} SourceMetadata
 */

/**
 * @param {string} filePath
 *
 * @returns {SourceMetadata | null}
 */
export function readMetadataFile(filePath) {
    if (!existsSync(filePath)) {
        return null;
    }

    try {
        const parsed = JSON.parse(readFileSync(filePath, "utf8"));
        if (typeof parsed !== "object" || parsed === null) return null;
        for (const key of [
            "archiveCount",
            "outputCount",
            "sourceCount",
        ]) {
            const value = Reflect.get(parsed, key);
            if (
                value !== undefined &&
                (!Number.isSafeInteger(value) || Number(value) < 0)
            ) {
                return null;
            }
        }

        return parsed;
    } catch {
        return null;
    }
}

/**
 * Prefer committed output provenance, while retaining compatibility with the
 * older gitignored source metadata file.
 *
 * @param {string} repoRoot
 *
 * @returns {{ file: string; metadata: SourceMetadata } | null}
 */
export function readLocalSourceMetadata(repoRoot) {
    const candidates = [
        resolve(repoRoot, "fonts", "woff2", "source-metadata.json"),
        resolve(repoRoot, "fonts", "original", ".source-metadata.json"),
    ];

    for (const file of candidates) {
        const metadata = readMetadataFile(file);
        if (metadata !== null) {
            return { file, metadata };
        }
    }

    return null;
}

/**
 * @param {string} ref
 *
 * @returns {string}
 */
export function releaseAssetBaseUrl(ref) {
    if (parseSemverTag(ref) === null) {
        throw new Error(`Release ref must look like v1.2.3. Received: ${ref}`);
    }

    return `https://github.com/${UPSTREAM_REPOSITORY}/releases/download/${ref}`;
}

/**
 * @param {string} text
 *
 * @returns {Map<string, string>}
 */
export function parseChecksumManifest(text) {
    const checksums = new Map();

    for (const rawLine of text.split(/\r?\n/v)) {
        const line = rawLine.trim();
        if (line.length === 0) {
            continue;
        }

        const match = /^([\da-f]{64})\s+\*?(.+)$/iv.exec(line);
        if (match === null) {
            throw new Error(`Invalid SHA-256 manifest line: ${rawLine}`);
        }

        const [
            ,
            checksum,
            fileName,
        ] = match;
        if (typeof checksum !== "string" || typeof fileName !== "string") {
            throw new Error(`Invalid SHA-256 manifest line: ${rawLine}`);
        }

        checksums.set(fileName, checksum.toLowerCase());
    }

    if (checksums.size === 0) {
        throw new Error("The Nerd Fonts SHA-256 manifest is empty.");
    }

    return checksums;
}

/**
 * @param {string} repoRoot
 * @param {string} targetPath
 *
 * @returns {void}
 */
export function assertPathInsideRepository(repoRoot, targetPath) {
    assertSafeRepositoryPath(repoRoot, targetPath);
}

/**
 * @param {string | undefined} scriptPath
 * @param {string} moduleFilePath
 *
 * @returns {boolean}
 */
export function isMainModule(scriptPath, moduleFilePath) {
    return (
        typeof scriptPath === "string" &&
        resolve(scriptPath).toLowerCase() ===
            resolve(moduleFilePath).toLowerCase()
    );
}
