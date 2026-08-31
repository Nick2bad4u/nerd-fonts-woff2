import { spawnSync } from "node:child_process";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import * as nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// eslint-disable-next-line unicorn/prefer-import-meta-properties -- Node support lint rejects import.meta.dirname for the configured range.
const testDirectory = nodePath.dirname(fileURLToPath(import.meta.url));
const repoRoot = nodePath.resolve(testDirectory, "..");
const updaterModuleUrl = pathToFileURL(
    nodePath.resolve(repoRoot, "scripts", "update-nerd-fonts.mjs")
).href;
const bulkConverterModuleUrl = pathToFileURL(
    nodePath.resolve(repoRoot, "scripts", "bulk-convert-fonts.mjs")
).href;
const conversionPoolModuleUrl = pathToFileURL(
    nodePath.resolve(repoRoot, "scripts", "font-conversion-process-pool.mjs")
).href;
const conversionPolicyModuleUrl = pathToFileURL(
    nodePath.resolve(repoRoot, "scripts", "font-conversion-policy.mjs")
).href;
const mockConversionWorkerUrl = pathToFileURL(
    nodePath.resolve(
        repoRoot,
        "test",
        "fixtures",
        "mock-font-conversion-worker.mjs"
    )
).href;
const processPoolIntegrationTimeoutMs = 15_000;

function runInlineModule(source: string): {
    status: null | number;
    stderr: string;
    stdout: string;
} {
    const result = spawnSync(
        process.execPath,
        [
            "--input-type=module",
            "--eval",
            source,
        ],
        { cwd: repoRoot, encoding: "utf8", stdio: "pipe" }
    );

    return {
        status: result.status,
        stderr: result.stderr,
        stdout: result.stdout,
    };
}

function runScript(
    scriptName: string,
    argumentsList: readonly string[] = []
): { status: null | number; stderr: string; stdout: string } {
    const result = spawnSync(
        process.execPath,
        [nodePath.resolve(repoRoot, "scripts", scriptName), ...argumentsList],
        { cwd: repoRoot, encoding: "utf8", stdio: "pipe" }
    );

    return {
        status: result.status,
        stderr: result.stderr,
        stdout: result.stdout,
    };
}

describe("font maintenance script safety", () => {
    it("documents the safe update plan and explicit apply gates", () => {
        expect.assertions(8);

        const result = runScript("update-nerd-fonts.mjs", [
            "--verbose",
            "--help",
        ]);

        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain("npm run fonts:update");
        expect(result.stdout).toContain("--apply --confirm");
        expect(result.stdout).toContain("--verbose");
        expect(result.stdout).toContain("--color / --no-color");
        expect(result.stdout).toContain("--failed-only");
        expect(result.stdout).toContain("--timeout-retries");
    });

    it("renders persistent stage progress with details and timing", () => {
        expect.assertions(10);

        const result = runInlineModule(String.raw`
            import {
                createProgressReporter,
                renderProgressBar,
            } from ${JSON.stringify(updaterModuleUrl)};
            const messages = [];
            let timestamp = 0;
            const progress = createProgressReporter(
                true,
                2,
                false,
                (message) => { messages.push(message); },
                () => timestamp,
            );
            progress.start("Resolve release");
            timestamp = 250;
            progress.detail("Running: git ls-remote");
            timestamp = 1500;
            progress.complete("Resolved v3.5.1");
            timestamp = 61_500;
            progress.start("Convert fonts");
            timestamp = 151_500;
            progress.complete("Converted fonts");
            const coloredMessages = [];
            timestamp = 0;
            const coloredProgress = createProgressReporter(
                true,
                1,
                true,
                (message) => { coloredMessages.push(message); },
                () => timestamp,
            );
            coloredProgress.start("Colored stage");
            process.stdout.write(
                renderProgressBar(1, 2) + "\n" + messages.join("") +
                    coloredMessages.join(""),
            );
        `);

        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");

        expect(result.stdout).toContain("[████████░░░░░░░░]");
        expect(result.stdout).toContain("stage 1/2 START Resolve release");
        expect(result.stdout).toContain("[stage 1/2] Running: git ls-remote");
        expect(result.stdout).toContain("stage 1/2 DONE Resolved v3.5.1");
        expect(result.stdout).toContain("(1.5s)");
        expect(result.stdout).toContain("stage 2/2 START Convert fonts");
        expect(result.stdout).toContain("(1m 30s)");
        expect(result.stdout).toContain("\u{1B}[");
    });

    it("rejects update application without confirmation before network work", () => {
        expect.assertions(3);

        const result = runScript("update-nerd-fonts.mjs", [
            "--ref",
            "v3.5.1",
            "--convert",
        ]);

        expect(result.status).toBe(2);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("requires --apply and --confirm");
    });

    it("rejects a source replacement without confirmation", () => {
        expect.assertions(3);

        const result = runScript("download-nerd-fonts-sources.mjs", [
            "--ref",
            "v3.5.1",
        ]);

        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("Add --confirm, or use --dry-run");
    });

    it("validates the reviewed commit gate before downloader network work", () => {
        expect.assertions(3);

        const result = runScript("download-nerd-fonts-sources.mjs", [
            "--ref",
            "v3.5.1",
            "--expected-commit-sha",
            "not-a-commit",
            "--dry-run",
        ]);

        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(
            "--expected-commit-sha must be a 40-character Git SHA"
        );
    });

    it("restricts custom download destinations to temp", () => {
        expect.assertions(3);

        const result = runScript("download-nerd-fonts-sources.mjs", [
            "--ref",
            "v3.5.1",
            "--output-dir",
            "src",
            "--confirm",
        ]);

        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(
            "custom --output-dir must be a child of the repository temp directory"
        );
    });

    it("rejects bulk conversion without confirmation", () => {
        expect.assertions(3);

        const result = runScript("bulk-convert-fonts.mjs", ["--convert"]);

        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(
            "requires both --convert and --confirm"
        );
    });

    it("uses conservative defaults and retries only timed-out fonts", () => {
        expect.assertions(8);

        const result = runInlineModule(`
            import {
                calculateConversionDeadlineMs,
                createConversionPasses,
                isFontTimeoutMessage,
                partitionConversionFailures,
            } from ${JSON.stringify(conversionPolicyModuleUrl)};
            import { parseBulkOptions } from ${JSON.stringify(bulkConverterModuleUrl)};
            const options = parseBulkOptions([
                "--convert",
                "--confirm",
                "--failed-only",
            ]);
            const passes = createConversionPasses(
                options.concurrency,
                options.timeoutSeconds,
                options.timeoutRetries,
            );
            const partitioned = partitionConversionFailures([
                { sourcePath: "timed-out.ttf", timedOut: true },
                { sourcePath: "invalid.ttf", timedOut: false },
            ], true);
            const finalPartition = partitionConversionFailures([
                { sourcePath: "still-timed-out.ttf", timedOut: true },
            ], false);
            const invalid = [
                ["--timeout-retries=3"],
                ["--timeout-retries=00"],
                ["--timeout=240seconds"],
                ["--failed-only", "--convert", "--confirm", "--force"],
            ].map((argumentsList) => {
                try {
                    parseBulkOptions(argumentsList);
                    return null;
                } catch (error) {
                    return error.message;
                }
            });
            process.stdout.write(JSON.stringify({
                deadline: calculateConversionDeadlineMs(2_252, passes),
                finalPartition,
                invalid,
                options,
                partitioned,
                passes,
                timeoutDetected: isFontTimeoutMessage("timed out after 240s. source: Example.ttf"),
            }));
        `);
        const output = JSON.parse(result.stdout) as {
            deadline: number;
            finalPartition: {
                finalFailures: Array<{ sourcePath: string }>;
                retrySources: string[];
            };
            invalid: Array<null | string>;
            options: {
                concurrency: number;
                failedOnly: boolean;
                timeoutRetries: number;
                timeoutSeconds: number;
            };
            partitioned: {
                finalFailures: Array<{ sourcePath: string }>;
                retrySources: string[];
            };
            passes: Array<{
                concurrency: number;
                number: number;
                timeoutSeconds: number;
            }>;
            timeoutDetected: boolean;
        };

        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        expect(output.options).toMatchObject({
            concurrency: 4,
            failedOnly: true,
            timeoutRetries: 2,
            timeoutSeconds: 1200,
        });
        expect(output.passes).toStrictEqual([
            { concurrency: 4, number: 1, timeoutSeconds: 1200 },
            { concurrency: 2, number: 2, timeoutSeconds: 1800 },
            { concurrency: 1, number: 3, timeoutSeconds: 2400 },
        ]);
        expect(output.partitioned).toStrictEqual({
            finalFailures: [{ sourcePath: "invalid.ttf", timedOut: false }],
            retrySources: ["timed-out.ttf"],
        });
        expect(output.finalPartition).toStrictEqual({
            finalFailures: [
                { sourcePath: "still-timed-out.ttf", timedOut: true },
            ],
            retrySources: [],
        });
        expect(output.invalid).toStrictEqual(
            expect.arrayContaining([
                expect.stringContaining("integer from 0 through 2"),
                expect.stringContaining("integer from 1 through 86400"),
                expect.stringContaining("cannot be combined"),
            ])
        );
        expect(output.timeoutDetected && output.deadline > 2_147_483_647).toBe(
            true
        );
    });

    it("reuses only complete, current WOFF2 staging outputs", () => {
        expect.assertions(3);

        const result = runInlineModule(`
            import {
                mkdtempSync,
                mkdirSync,
                rmSync,
                utimesSync,
                writeFileSync,
            } from "node:fs";
            import { resolve } from "node:path";
            import { isReusableOutput } from ${JSON.stringify(bulkConverterModuleUrl)};
            const fixtureRoot = mkdtempSync(resolve(${JSON.stringify(repoRoot)}, "temp", "font-resume-"));
            const source = resolve(fixtureRoot, "sources", "Font.ttf");
            const output = resolve(fixtureRoot, "outputs", "Font.woff2");
            mkdirSync(resolve(fixtureRoot, "sources"), { recursive: true });
            mkdirSync(resolve(fixtureRoot, "outputs"), { recursive: true });
            try {
                writeFileSync(source, "source");
                const validWoff2 = Buffer.alloc(48);
                validWoff2.write("wOF2", 0, "ascii");
                validWoff2.writeUInt32BE(validWoff2.length, 8);
                writeFileSync(output, validWoff2);
                const valid = isReusableOutput(output, source);
                const invalidWoff2 = Buffer.from(validWoff2);
                invalidWoff2.write("bad!", 0, "ascii");
                writeFileSync(output, invalidWoff2);
                const badSignature = isReusableOutput(output, source);
                const invalidLengthWoff2 = Buffer.from(validWoff2);
                invalidLengthWoff2.writeUInt32BE(validWoff2.length + 1, 8);
                writeFileSync(output, invalidLengthWoff2);
                const badLength = isReusableOutput(output, source);
                writeFileSync(output, validWoff2);
                const old = new Date(Date.now() - 60_000);
                const newer = new Date();
                utimesSync(output, old, old);
                utimesSync(source, newer, newer);
                const stale = isReusableOutput(output, source);
                process.stdout.write(JSON.stringify({ badLength, badSignature, stale, valid }));
            } finally {
                rmSync(fixtureRoot, { force: true, recursive: true });
            }
        `);
        const output = JSON.parse(result.stdout) as {
            badLength: boolean;
            badSignature: boolean;
            stale: boolean;
            valid: boolean;
        };

        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        expect(output).toStrictEqual({
            badLength: false,
            badSignature: false,
            stale: false,
            valid: true,
        });
    });

    it("failed-only conversion preserves reusable output and reports the remainder", () => {
        expect.assertions(9);

        const fixtureRoot = mkdtempSync(
            nodePath.resolve(repoRoot, "temp", "font-failed-only-")
        );
        const sourceRoot = nodePath.resolve(fixtureRoot, "sources", "Family");
        const outputRoot = nodePath.resolve(fixtureRoot, "outputs");
        const reusableOutput = nodePath.resolve(
            outputRoot,
            "Family",
            "Keep.woff2"
        );
        const failureReport = nodePath.resolve(fixtureRoot, "failures.json");
        mkdirSync(sourceRoot, { recursive: true });
        mkdirSync(nodePath.dirname(reusableOutput), { recursive: true });
        writeFileSync(nodePath.resolve(sourceRoot, "Fail.ttf"), "invalid");
        writeFileSync(nodePath.resolve(sourceRoot, "Keep.ttf"), "source");
        const reusableContents = Buffer.alloc(48);
        reusableContents.write("wOF2", 0, "ascii");
        reusableContents.writeUInt32BE(reusableContents.length, 8);
        writeFileSync(reusableOutput, reusableContents);

        try {
            const result = runScript("bulk-convert-fonts.mjs", [
                "--source-dir",
                nodePath.resolve(fixtureRoot, "sources"),
                "--output-dir",
                outputRoot,
                "--failure-report",
                failureReport,
                "--concurrency",
                "1",
                "--timeout-retries",
                "0",
                "--failed-only",
                "--convert",
                "--confirm",
                "--no-color",
            ]);
            const report = JSON.parse(readFileSync(failureReport, "utf8")) as {
                failedOnly: boolean;
                failures: Array<{
                    sourcePath: string;
                    timedOut: boolean;
                }>;
                schemaVersion: number;
            };

            expect(result.status).toBe(1);
            expect(result.stdout).toContain("Resuming 1 of 2 fonts");
            expect(result.stdout).toContain(
                "Reusing 1 validated WOFF2 outputs"
            );
            expect(result.stderr).toContain("Full failure report:");
            expect(report).toMatchObject({
                failedOnly: true,
                schemaVersion: 1,
            });
            expect(report.failures).toHaveLength(1);
            expect(report.failures[0]).toMatchObject({
                sourcePath: "Family/Fail.ttf",
                timedOut: false,
            });
            expect(readFileSync(reusableOutput)).toStrictEqual(
                reusableContents
            );
            expect(result.stdout).not.toContain("START Family/Keep.ttf");
        } finally {
            rmSync(fixtureRoot, { force: true, recursive: true });
        }
    }, 15_000);

    it("rejects source files that map to one WOFF2 output", () => {
        expect.assertions(3);

        const fixtureRoot = mkdtempSync(
            nodePath.resolve(repoRoot, "temp", "font-collision-")
        );
        const sourceRoot = nodePath.resolve(fixtureRoot, "sources", "Family");
        const outputRoot = nodePath.resolve(fixtureRoot, "outputs");
        mkdirSync(sourceRoot, { recursive: true });
        writeFileSync(nodePath.resolve(sourceRoot, "SameName.ttf"), "");
        writeFileSync(nodePath.resolve(sourceRoot, "SameName.otf"), "");

        try {
            const result = runScript("bulk-convert-fonts.mjs", [
                "--source-dir",
                nodePath.resolve(fixtureRoot, "sources"),
                "--output-dir",
                outputRoot,
                "--dry-run",
            ]);

            expect(result.status).toBe(1);
            expect(result.stdout).toBe("");
            expect(result.stderr).toContain(
                "Sources map to the same WOFF2 output"
            );
        } finally {
            rmSync(fixtureRoot, { force: true, recursive: true });
        }
    });

    it("shows each exact font with progress and controllable ANSI color", () => {
        expect.assertions(10);

        const fixtureRoot = mkdtempSync(
            nodePath.resolve(repoRoot, "temp", "font-progress-")
        );
        const sourceRoot = nodePath.resolve(fixtureRoot, "sources", "Family");
        const outputRoot = nodePath.resolve(fixtureRoot, "outputs");
        mkdirSync(sourceRoot, { recursive: true });
        writeFileSync(nodePath.resolve(sourceRoot, "ExactFont.ttf"), "");

        try {
            const commonArguments = [
                "--source-dir",
                nodePath.resolve(fixtureRoot, "sources"),
                "--output-dir",
                outputRoot,
                "--dry-run",
                "--verbose",
            ];
            const colored = runScript("bulk-convert-fonts.mjs", [
                ...commonArguments,
                "--color",
            ]);
            const plain = runScript("bulk-convert-fonts.mjs", [
                ...commonArguments,
                "--no-color",
            ]);

            expect(colored.status).toBe(0);
            expect(colored.stderr).toBe("");
            expect(colored.stdout).toContain("Family/ExactFont.ttf");
            expect(colored.stdout).toContain("1/1");
            expect(colored.stdout).toContain("100.0%");
            expect(colored.stdout).toContain("PLAN");
            expect(colored.stdout).toContain("\u{1B}[");

            expect(plain.status).toBe(0);
            expect(plain.stdout).toContain("Family/ExactFont.ttf");
            expect(plain.stdout).not.toContain("\u{1B}[");
        } finally {
            rmSync(fixtureRoot, { force: true, recursive: true });
        }
    });

    it("reuses a healthy conversion process and formats phase timings", () => {
        expect.assertions(15);

        const result = runInlineModule(`
            import { FontConversionProcessPool } from ${JSON.stringify(conversionPoolModuleUrl)};
            import { formatConversionTimings } from ${JSON.stringify(bulkConverterModuleUrl)};
            const pool = new FontConversionProcessPool({
                size: 1,
                timeoutMs: 1_000,
                workerUrl: new URL(${JSON.stringify(mockConversionWorkerUrl)}),
            });
            try {
                const first = await pool.convert("first", "unused");
                const failed = await pool.convert("fail", "unused");
                const second = await pool.convert("second", "unused");
                process.stdout.write(JSON.stringify({
                    failed,
                    first,
                    formatted: formatConversionTimings(second.timings),
                    second,
                }));
            } finally {
                await pool.close();
            }
        `);

        const output = JSON.parse(result.stdout) as {
            failed: {
                error?: string;
                ok: boolean;
                timings: { workerId: number; workerReused: boolean };
            };
            first: {
                ok: boolean;
                timings: {
                    moduleMs: number;
                    workerId: number;
                    workerReused: boolean;
                };
            };
            formatted: string[];
            second: {
                ok: boolean;
                timings: {
                    moduleMs: number;
                    overheadMs: null | number;
                    workerId: number;
                    workerReused: boolean;
                };
            };
        };

        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        expect(output.first.ok).toBe(true);
        expect(output.first.timings.workerReused).toBe(false);
        expect(output.first.timings.moduleMs).toBe(0);
        expect(output.failed.ok).toBe(false);
        expect(output.failed.error).toBe("fixture conversion failure");
        expect(output.failed.timings.workerId).toBe(
            output.first.timings.workerId
        );
        expect(output.failed.timings.workerReused).toBe(true);
        expect(output.second.ok).toBe(true);
        expect(output.second.timings.workerId).toBe(
            output.first.timings.workerId
        );
        expect(output.second.timings.workerReused).toBe(true);
        expect(output.second.timings.moduleMs).toBe(0);
        expect(output.second.timings.overheadMs ?? -1).toBeGreaterThanOrEqual(
            0
        );
        expect(output.formatted).toStrictEqual(
            expect.arrayContaining([
                expect.stringMatching(/^worker #\d+ reused$/v),
                "module cached",
                "read 0.8ms",
                "convert 10.2ms",
                "write 0.7ms",
                expect.stringMatching(/^overhead /v),
                expect.stringMatching(/^total /v),
            ])
        );
    }, processPoolIntegrationTimeoutMs);

    it("runs up to the configured process-pool concurrency", () => {
        expect.assertions(10);

        const result = runInlineModule(`
            import { FontConversionProcessPool } from ${JSON.stringify(conversionPoolModuleUrl)};
            const pool = new FontConversionProcessPool({
                size: 2,
                timeoutMs: 1_000,
                workerUrl: new URL(${JSON.stringify(mockConversionWorkerUrl)}),
            });
            try {
                const [first, second] = await Promise.all([
                    pool.convert("delay-first", "unused"),
                    pool.convert("delay-second", "unused"),
                ]);
                const third = await pool.convert("third", "unused");
                process.stdout.write(JSON.stringify({ first, second, third }));
            } finally {
                await pool.close();
            }
        `);

        const output = JSON.parse(result.stdout) as {
            first: {
                ok: boolean;
                timings: { workerId: number; workerReused: boolean };
            };
            second: {
                ok: boolean;
                timings: { workerId: number; workerReused: boolean };
            };
            third: {
                ok: boolean;
                timings: { workerId: number; workerReused: boolean };
            };
        };

        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        expect(output.first.ok).toBe(true);
        expect(output.second.ok).toBe(true);
        expect(output.first.timings.workerId).not.toBe(
            output.second.timings.workerId
        );
        expect(output.first.timings.workerReused).toBe(false);
        expect(output.second.timings.workerReused).toBe(false);
        expect(output.third.ok).toBe(true);
        expect(output.third.timings.workerReused).toBe(true);
        expect([
            output.first.timings.workerId,
            output.second.timings.workerId,
        ]).toContain(output.third.timings.workerId);
    }, processPoolIntegrationTimeoutMs);

    it("replaces timed-out and crashed conversion processes", () => {
        expect.assertions(20);

        const result = runInlineModule(`
            import { FontConversionProcessPool } from ${JSON.stringify(conversionPoolModuleUrl)};
            const pool = new FontConversionProcessPool({
                size: 1,
                timeoutMs: 500,
                workerUrl: new URL(${JSON.stringify(mockConversionWorkerUrl)}),
            });
            try {
                const timedOut = await pool.convert("hang", "unused");
                const afterTimeout = await pool.convert("after-timeout", "unused");
                const crashed = await pool.convert("crash", "unused");
                const afterCrash = await pool.convert("after-crash", "unused");
                const malformed = await pool.convert("malformed", "unused");
                const afterMalformed = await pool.convert("after-malformed", "unused");
                process.stdout.write(JSON.stringify({
                    afterCrash,
                    afterMalformed,
                    afterTimeout,
                    crashed,
                    malformed,
                    timedOut,
                }));
            } finally {
                await pool.close();
            }
        `);

        const output = JSON.parse(result.stdout) as {
            afterCrash: {
                ok: boolean;
                timings: { workerId: number; workerReused: boolean };
            };
            afterMalformed: {
                ok: boolean;
                timings: { workerId: number; workerReused: boolean };
            };
            afterTimeout: {
                ok: boolean;
                timings: { workerId: number; workerReused: boolean };
            };
            crashed: {
                error?: string;
                ok: boolean;
                timings: { workerId: number };
            };
            malformed: {
                error?: string;
                ok: boolean;
                timings: { workerId: number };
            };
            timedOut: {
                error?: string;
                ok: boolean;
                timings: { totalMs: number; workerId: number };
            };
        };

        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        expect(output.timedOut.ok).toBe(false);
        expect(output.timedOut.error).toMatch(
            /timed out after 0\.5s.+Try --timeout=601/v
        );
        expect(output.timedOut.timings.totalMs).toBeGreaterThanOrEqual(400);
        expect(output.afterTimeout.ok).toBe(true);
        expect(output.afterTimeout.timings.workerId).not.toBe(
            output.timedOut.timings.workerId
        );
        expect(output.afterTimeout.timings.workerReused).toBe(false);
        expect(output.crashed.ok).toBe(false);
        expect(output.crashed.error).toMatch(/worker (?:IPC|exited)/v);
        expect(output.crashed.timings.workerId).toBe(
            output.afterTimeout.timings.workerId
        );
        expect(output.afterCrash.ok).toBe(true);
        expect(output.afterCrash.timings.workerId).not.toBe(
            output.crashed.timings.workerId
        );
        expect(output.afterCrash.timings.workerReused).toBe(false);
        expect(output.malformed.ok).toBe(false);
        expect(output.malformed.error).toContain("invalid conversion result");
        expect(output.malformed.timings.workerId).toBe(
            output.afterCrash.timings.workerId
        );
        expect(output.afterMalformed.ok).toBe(true);
        expect(output.afterMalformed.timings.workerId).not.toBe(
            output.malformed.timings.workerId
        );
        expect(output.afterMalformed.timings.workerReused).toBe(false);
    }, processPoolIntegrationTimeoutMs);

    it("closes active conversion processes and refuses later jobs", () => {
        expect.assertions(8);

        const result = runInlineModule(`
            import { FontConversionProcessPool } from ${JSON.stringify(conversionPoolModuleUrl)};
            const pool = new FontConversionProcessPool({
                size: 1,
                timeoutMs: 1_000,
                workerUrl: new URL(${JSON.stringify(mockConversionWorkerUrl)}),
            });
            const pending = pool.convert("hang", "unused");
            await pool.close();
            const interrupted = await pending;
            const afterClose = await pool.convert("after-close", "unused");
            process.stdout.write(JSON.stringify({ afterClose, interrupted }));
        `);

        const output = JSON.parse(result.stdout) as {
            afterClose: {
                error?: string;
                ok: boolean;
                timings: { workerId: number };
            };
            interrupted: {
                error?: string;
                ok: boolean;
                timings: { workerId: number };
            };
        };

        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        expect(output.interrupted.ok).toBe(false);
        expect(output.interrupted.error).toContain("closed during the job");
        expect(output.interrupted.timings.workerId).toBeGreaterThan(0);
        expect(output.afterClose.ok).toBe(false);
        expect(output.afterClose.error).toContain("worker pool is closed");
        expect(output.afterClose.timings.workerId).toBe(0);
    }, processPoolIntegrationTimeoutMs);

    it("rejects repository traversal in public verification paths", () => {
        expect.assertions(3);

        const result = runScript("verify-font-assets.mjs", [
            "--public-output-dir",
            "../outside",
        ]);

        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(
            "Public index path must be repository-relative"
        );
    });

    it("rejects an asset directory outside the repository", () => {
        expect.assertions(3);

        const result = runScript("bulk-convert-fonts.mjs", [
            "--source-dir",
            "..",
            "--dry-run",
        ]);

        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("Refusing path outside repository");
    });

    it("rejects unknown update-check options before querying upstream", () => {
        expect.assertions(3);

        const result = runScript("check-nerd-fonts-updates.mjs", [
            "--unexpected",
        ]);

        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("Unknown option: --unexpected");
    });
});
