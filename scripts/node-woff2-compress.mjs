#!/usr/bin/env node

/**
 * Thin Node.js shim around ttf2woff2 that mimics the woff2_compress CLI
 * interface.
 *
 * Called as: node node-woff2-compress.mjs font.(ttf|otf) Produces: font.woff2
 * placed beside the input file, exactly like woff2_compress does.
 *
 * This removes the need for any system-level woff2 installation. The conversion
 * is performed entirely by the ttf2woff2 npm package, which bundles the Google
 * WOFF2 C++ library and falls back to an Emscripten build when native
 * compilation is unavailable.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import ttf2woff2 from "ttf2woff2";

const inputArg = process.argv[2];

if (typeof inputArg !== "string" || inputArg.trim().length === 0) {
    process.stderr.write(
        "Usage: node node-woff2-compress.mjs <font.(ttf|otf)>\n"
    );
    process.exitCode = 1;
} else {
    const inputPath = resolve(inputArg);
    const outputPath = inputPath.replace(/\.(?:otf|ttf)$/iu, ".woff2");

    const inputBuffer = readFileSync(inputPath);

    /** @type {Buffer} */
    const outputBuffer = ttf2woff2(inputBuffer);

    writeFileSync(outputPath, outputBuffer);
}
