#!/usr/bin/env node

/**
 * Verifies that the Node.js WOFF2 converter pipeline is ready to run.
 *
 * Checks:
 *
 * 1. The ttf2woff2 npm package is importable.
 * 2. The bundled node-woff2-compress.mjs shim exists.
 * 3. A live smoke-test conversion succeeds using a real font from fonts/original.
 *
 * No system tools (woff2_compress, Homebrew, etc.) are required. Run: node
 * scripts/setup-converter.mjs
 */

import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = process.cwd();
const shimPath = resolve(repoRoot, "scripts", "node-woff2-compress.mjs");
const fontsOriginal = resolve(repoRoot, "fonts", "original");

/**
 * Resolve the ttf2woff2 package.json path to confirm the package is installed.
 *
 * @returns {string | undefined}
 */
function resolveTtf2Woff2PackageJson() {
    try {
        const require = createRequire(import.meta.url);
        return require.resolve("ttf2woff2/package.json");
    } catch {
        return undefined;
    }
}

/**
 * Recursively find the first .ttf or .otf file in a directory tree.
 *
 * @param {string} directory - Root directory to search.
 *
 * @returns {string | undefined}
 */
function findFirstFont(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = join(directory, entry.name);
        if (entry.isDirectory()) {
            const found = findFirstFont(full);
            if (typeof found === "string") {
                return found;
            }
        } else if (/\.(?:otf|ttf)$/iu.test(entry.name)) {
            return full;
        }
    }

    return undefined;
}

/**
 * Run a smoke conversion on the first available source font.
 *
 * Returns skipped:true when no source fonts have been downloaded yet.
 *
 * @returns {Promise<{ error?: string; ok: boolean; skipped?: boolean }>}
 */
async function runSmokeTest() {
    if (!existsSync(fontsOriginal)) {
        return { ok: true, skipped: true };
    }

    const sampleFont = findFirstFont(fontsOriginal);
    if (typeof sampleFont !== "string") {
        return { ok: true, skipped: true };
    }

    try {
        const { default: ttf2woff2 } = await import("ttf2woff2");
        const inputBuffer = readFileSync(sampleFont);

        /** @type {Buffer} */
        const output = ttf2woff2(inputBuffer);

        if (output.length < 4 || output.toString("ascii", 0, 4) !== "wOF2") {
            return {
                error: `Unexpected output signature: ${output.subarray(0, 4).toString("hex")}`,
                ok: false,
            };
        }

        writeFileSync(join(tmpdir(), `nfw-smoke-${Date.now()}.woff2`), output);

        return { ok: true };
    } catch (error) {
        return {
            error: error instanceof Error ? error.message : String(error),
            ok: false,
        };
    }
}

let allPassed = true;

// 1. Check ttf2woff2 package
const packageJsonPath = resolveTtf2Woff2PackageJson();
if (typeof packageJsonPath === "string") {
    process.stdout.write(`\u2714 ttf2woff2 npm package is installed.\n`);
} else {
    process.stderr.write(
        `\u2718 ttf2woff2 is not installed. Run: npm install\n`
    );
    allPassed = false;
}

// 2. Check shim exists
if (existsSync(shimPath)) {
    process.stdout.write(
        `\u2714 Converter shim exists: scripts/node-woff2-compress.mjs\n`
    );
} else {
    process.stderr.write(`\u2718 Converter shim missing: ${shimPath}\n`);
    allPassed = false;
}

// 3. Smoke test
if (allPassed) {
    const smokeResult = await runSmokeTest();
    if (smokeResult.skipped === true) {
        process.stdout.write(
            `\u2714 Smoke test skipped (no source fonts yet \u2014 run npm run fonts:download first).\n`
        );
    } else if (smokeResult.ok) {
        process.stdout.write(
            `\u2714 Smoke test passed \u2014 ttf2woff2 converts a real font to WOFF2 successfully.\n`
        );
    } else {
        process.stderr.write(
            `\u2718 Smoke test failed: ${smokeResult.error ?? "unknown error"}\n`
        );
        allPassed = false;
    }
}

if (allPassed) {
    process.stdout.write(
        `\nAll checks passed. Ready to run:\n\n  npm run fonts:local\n\n`
    );
} else {
    process.stderr.write(
        `\nSome checks failed. Run "npm install" and retry.\n`
    );
    process.exitCode = 1;
}
