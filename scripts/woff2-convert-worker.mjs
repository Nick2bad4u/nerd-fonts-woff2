/**
 * Worker thread for a single WOFF2 conversion.
 *
 * Receives: workerData = { outputPath: string, sourcePath: string } Posts back:
 * { error?: string, ok: boolean, sizeBytes?: number }
 *
 * Runs in an isolated thread so a hang or crash in ttf2woff2 can be safely
 * terminated by the parent without taking down the whole process.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { workerData, parentPort } from "node:worker_threads";

import ttf2woff2 from "ttf2woff2";

const { outputPath, sourcePath } = workerData;

try {
    const input = readFileSync(sourcePath);

    /** @type {Buffer} */
    const output = ttf2woff2(input);

    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, output);

    parentPort?.postMessage({ ok: true, sizeBytes: output.length });
} catch (err) {
    parentPort?.postMessage({
        error: err instanceof Error ? err.message : String(err),
        ok: false,
    });
}
