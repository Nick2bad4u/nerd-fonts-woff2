#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
    cpSync,
    existsSync,
    mkdirSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const UPSTREAM_REPO = "https://github.com/ryanoasis/nerd-fonts.git";
const DEFAULT_UPSTREAM_REF = "v3.4.0";

const repoRoot = process.cwd();
const upstreamCloneDir = resolve(repoRoot, "temp", "nerd-fonts-upstream");
const patchedFontsDir = resolve(upstreamCloneDir, "patched-fonts");
const destinationDir = resolve(repoRoot, "fonts", "original");

/**
 * Runs a git command and throws on failure.
 *
 * @param {readonly string[]} argumentsList
 * @param {string} [cwd]
 *
 * @returns {void}
 */
function runGit(argumentsList, cwd = repoRoot) {
    const result = spawnSync("git", argumentsList, {
        cwd,
        encoding: "utf8",
        stdio: "pipe",
    });

    if (result.status !== 0) {
        const message = result.stderr.trim() || result.stdout.trim();
        throw new Error(`git ${argumentsList.join(" ")} failed: ${message}`);
    }
}

/**
 * Runs a git command and returns trimmed stdout.
 *
 * @param {readonly string[]} argumentsList
 * @param {string} [cwd]
 *
 * @returns {string}
 */
function runGitCapture(argumentsList, cwd = repoRoot) {
    const result = spawnSync("git", argumentsList, {
        cwd,
        encoding: "utf8",
        stdio: "pipe",
    });

    if (result.status !== 0) {
        const message = result.stderr.trim() || result.stdout.trim();
        throw new Error(`git ${argumentsList.join(" ")} failed: ${message}`);
    }

    return result.stdout.trim();
}

/**
 * Resolve the upstream Nerd Fonts ref from CLI args.
 *
 * Usage: node scripts/download-nerd-fonts-sources.mjs --ref v3.4.0
 *
 * @returns {string}
 */
function resolveTargetRef() {
    const refFlagIndex = process.argv.indexOf("--ref");
    if (refFlagIndex === -1) {
        return DEFAULT_UPSTREAM_REF;
    }

    const value = process.argv[refFlagIndex + 1];
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error("--ref requires a non-empty value.");
    }

    return value.trim();
}

/**
 * Collect all TTF/OTF files recursively from a directory.
 *
 * @param {string} directory
 *
 * @returns {string[]}
 */
function collectFontFiles(directory) {
    const queue = [directory];
    const fonts = [];

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

            if (!entry.isFile()) {
                continue;
            }

            const lowerName = entry.name.toLowerCase();
            if (lowerName.endsWith(".ttf") || lowerName.endsWith(".otf")) {
                fonts.push(absolutePath);
            }
        }
    }

    return fonts;
}

/**
 * Downloads and stages upstream Nerd Fonts patched sources into fonts/original.
 *
 * @returns {void}
 */
function main() {
    const upstreamRef = resolveTargetRef();

    runGit(["--version"]);

    mkdirSync(resolve(repoRoot, "temp"), { recursive: true });
    mkdirSync(resolve(repoRoot, "fonts"), { recursive: true });

    if (!existsSync(upstreamCloneDir)) {
        runGit([
            "clone",
            "--depth",
            "1",
            "--filter=blob:none",
            "--sparse",
            UPSTREAM_REPO,
            upstreamCloneDir,
        ]);
    }

    runGit(
        [
            "sparse-checkout",
            "set",
            "patched-fonts",
        ],
        upstreamCloneDir
    );
    runGit(
        [
            "fetch",
            "--depth",
            "1",
            "origin",
            upstreamRef,
        ],
        upstreamCloneDir
    );
    runGit(
        [
            "checkout",
            "--detach",
            "FETCH_HEAD",
        ],
        upstreamCloneDir
    );

    if (
        !existsSync(patchedFontsDir) ||
        !statSync(patchedFontsDir).isDirectory()
    ) {
        throw new Error(`Could not find patched fonts at ${patchedFontsDir}`);
    }

    rmSync(destinationDir, { force: true, recursive: true });
    mkdirSync(destinationDir, { recursive: true });

    cpSync(patchedFontsDir, destinationDir, {
        dereference: true,
        force: true,
        recursive: true,
    });

    const fontFiles = collectFontFiles(destinationDir);
    const commitSha = runGitCapture(["rev-parse", "HEAD"], upstreamCloneDir);

    const metadata = {
        commitSha,
        downloadedAt: new Date().toISOString(),
        sourceCount: fontFiles.length,
        upstreamRef,
        upstreamRepo: UPSTREAM_REPO,
    };
    writeFileSync(
        resolve(destinationDir, ".source-metadata.json"),
        `${JSON.stringify(metadata, null, 2)}\n`,
        "utf8"
    );

    process.stdout.write(
        `Downloaded Nerd Fonts sources into: ${destinationDir}\n`
    );
    process.stdout.write(`Upstream ref: ${upstreamRef}\n`);
    process.stdout.write(`Resolved commit: ${commitSha}\n`);
    process.stdout.write(`Detected source font files: ${fontFiles.length}\n`);
}

try {
    main();
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
}
