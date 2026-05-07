#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = process.cwd();
const sourceRoot = resolve(repoRoot, "fonts", "original");
const outputRoot = resolve(repoRoot, "fonts", "woff2");
const tempRoot = resolve(repoRoot, "temp", "work");
const indexFile = resolve(outputRoot, "index.json");
const cliFile = resolve(repoRoot, "dist", "src", "cli.js");

/**
 * Absolute path to the Node.js WOFF2 converter shim bundled with this project.
 * Uses the ttf2woff2 npm package — no system installation required.
 */
const defaultConverterScript = resolve(
    repoRoot,
    "scripts",
    "node-woff2-compress.mjs"
);

/**
 * Parse script options.
 *
 * Supported flags:
 *
 * - --dry-run
 * - --verbose
 * - --converter command (default: node)
 * - --converter-arg value (default: path to node-woff2-compress.mjs; repeatable)
 *
 * The default converter is the bundled Node.js shim that uses the ttf2woff2 npm
 * package — no system woff2 installation required.
 *
 * @returns {{
 *     converter: string;
 *     converterArgs: readonly string[];
 *     dryRun: boolean;
 *     verbose: boolean;
 * }}
 */
function parseScriptOptions() {
    let converter = process.execPath;
    const converterArgs = [defaultConverterScript];
    let dryRun = false;
    let verbose = false;

    for (let index = 2; index < process.argv.length; index += 1) {
        const token = process.argv[index];
        if (token === "--dry-run") {
            dryRun = true;
            continue;
        }

        if (token === "--verbose") {
            verbose = true;
            continue;
        }

        if (token === "--converter") {
            const value = process.argv[index + 1];
            if (typeof value !== "string" || value.trim().length === 0) {
                throw new Error("--converter requires a non-empty value.");
            }

            converter = value.trim();
            index += 1;
            continue;
        }

        if (token === "--converter-arg") {
            const value = process.argv[index + 1];
            if (typeof value !== "string") {
                throw new TypeError("--converter-arg requires a value.");
            }

            converterArgs.push(value);
            index += 1;
        }
    }

    return {
        converter,
        converterArgs,
        dryRun,
        verbose,
    };
}

/**
 * Resolve all top-level font family source directories.
 *
 * @returns {string[]}
 */
function getSourceDirectories() {
    if (!existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory()) {
        throw new Error(
            `Source directory not found: ${sourceRoot}. Run npm run fonts:download first.`
        );
    }

    return readdirSync(sourceRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => resolve(sourceRoot, entry.name))
        .sort((a, b) => a.localeCompare(b));
}

/**
 * Run nerd-font-woff2 conversion for all local source families.
 *
 * @returns {void}
 */
function main() {
    const options = parseScriptOptions();

    if (!existsSync(cliFile)) {
        throw new Error(
            `Built CLI entrypoint not found at ${cliFile}. Run npm run build first.`
        );
    }

    const sourceDirs = getSourceDirectories();

    if (sourceDirs.length === 0) {
        throw new Error(`No font family directories found in ${sourceRoot}`);
    }

    mkdirSync(outputRoot, { recursive: true });
    mkdirSync(tempRoot, { recursive: true });

    const args = [
        cliFile,
        ...sourceDirs.flatMap((sourceDir) => ["--source-dir", sourceDir]),
        "--out-dir",
        outputRoot,
        "--temp-dir",
        tempRoot,
        "--index-file",
        indexFile,
        "--converter",
        options.converter,
        ...options.converterArgs.flatMap((value) => ["--converter-arg", value]),
        ...(options.verbose ? ["--verbose"] : []),
        ...(options.dryRun ? ["--dry-run"] : ["--convert", "--confirm"]),
    ];

    const result = spawnSync(process.execPath, args, {
        cwd: repoRoot,
        stdio: "inherit",
    });

    if (result.error instanceof Error) {
        throw result.error;
    }

    process.exitCode = result.status ?? 1;
}

try {
    main();
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
}
