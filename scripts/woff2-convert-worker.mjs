/**
 * Persistent process worker for WOFF2 conversion.
 *
 * The parent dispatches one job at a time over IPC. The native converter is
 * loaded once, then reused until the parent requests shutdown or retires this
 * process after a timeout/crash.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";

if (typeof process.send !== "function") {
    throw new Error("WOFF2 conversion worker requires a parent IPC channel.");
}

const moduleStartedAt = performance.now();
const { default: ttf2woff2 } = await import("ttf2woff2");
const moduleMs = performance.now() - moduleStartedAt;
let busy = false;

process.send({ moduleMs, type: "ready" });

process.on("message", (message) => {
    if (typeof message !== "object" || message === null) return;
    const type = Reflect.get(message, "type");
    if (type === "shutdown") {
        if (!busy) process.exit(0);
        return;
    }

    if (type !== "convert" || busy) return;
    const jobId = Reflect.get(message, "jobId");
    const outputPath = Reflect.get(message, "outputPath");
    const sourcePath = Reflect.get(message, "sourcePath");
    if (
        !Number.isInteger(jobId) ||
        typeof outputPath !== "string" ||
        typeof sourcePath !== "string"
    ) {
        return;
    }

    busy = true;
    const taskStartedAt = performance.now();
    let activePhase = "read";
    let phaseStartedAt = taskStartedAt;
    const timings = { convertMs: 0, readMs: 0, taskMs: 0, writeMs: 0 };
    try {
        const input = readFileSync(sourcePath);
        timings.readMs = performance.now() - phaseStartedAt;

        activePhase = "convert";
        phaseStartedAt = performance.now();
        /** @type {Buffer} */
        const output = ttf2woff2(input);
        timings.convertMs = performance.now() - phaseStartedAt;

        activePhase = "write";
        phaseStartedAt = performance.now();
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, output);
        timings.writeMs = performance.now() - phaseStartedAt;
        timings.taskMs = performance.now() - taskStartedAt;
        process.send?.({
            jobId,
            ok: true,
            sizeBytes: output.length,
            timings,
            type: "result",
        });
    } catch (error) {
        const failedPhaseMs = performance.now() - phaseStartedAt;
        if (activePhase === "read") timings.readMs = failedPhaseMs;
        else if (activePhase === "convert") timings.convertMs = failedPhaseMs;
        else timings.writeMs = failedPhaseMs;
        timings.taskMs = performance.now() - taskStartedAt;
        process.send?.({
            error: error instanceof Error ? error.message : String(error),
            jobId,
            ok: false,
            timings,
            type: "result",
        });
    } finally {
        busy = false;
    }
});

process.once("disconnect", () => {
    process.exit(0);
});
