import { spawnSync } from "node:child_process";
import * as nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// eslint-disable-next-line unicorn/prefer-import-meta-properties -- Supported Node range includes versions without import.meta.dirname.
const testDirectory = nodePath.dirname(fileURLToPath(import.meta.url));
const repoRoot = nodePath.resolve(testDirectory, "..");
// eslint-disable-next-line n/no-process-env -- Child-process fixtures must preserve the test runner's executable search path and platform environment.
const inheritedEnvironment = process.env;
const commandRunnerUrl = pathToFileURL(
    nodePath.resolve(repoRoot, "scripts", "command-runner.mjs")
).href;
const releaseIdentityUrl = pathToFileURL(
    nodePath.resolve(repoRoot, "scripts", "release-identity.mjs")
).href;
const safeFilesystemUrl = pathToFileURL(
    nodePath.resolve(repoRoot, "scripts", "safe-filesystem.mjs")
).href;
const transactionUrl = pathToFileURL(
    nodePath.resolve(repoRoot, "scripts", "update-transaction.mjs")
).href;
const updaterUrl = pathToFileURL(
    nodePath.resolve(repoRoot, "scripts", "update-nerd-fonts.mjs")
).href;
const hangingProcessFixture = nodePath.resolve(
    testDirectory,
    "fixtures",
    "hang-with-child.mjs"
);
const mockGitHubFetchFixtureUrl = pathToFileURL(
    nodePath.resolve(testDirectory, "fixtures", "mock-github-release-fetch.mjs")
).href;

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
        {
            cwd: repoRoot,
            encoding: "utf8",
            maxBuffer: 16 * 1024 * 1024,
            stdio: "pipe",
        }
    );
    return {
        status: result.status,
        stderr: result.stderr,
        stdout: result.stdout,
    };
}

function runUpdater(argumentsList: readonly string[]) {
    const result = spawnSync(
        process.execPath,
        [
            nodePath.resolve(repoRoot, "scripts", "update-nerd-fonts.mjs"),
            ...argumentsList,
        ],
        { cwd: repoRoot, encoding: "utf8", stdio: "pipe" }
    );
    return {
        status: result.status,
        stderr: result.stderr,
        stdout: result.stdout,
    };
}

describe("nerd Fonts updater hardening", () => {
    it("parses exact values, aliases, equals forms, duplicates, and terminators", () => {
        expect.assertions(4);

        const result = runInlineModule(`
            import { parseUpdateOptions } from ${JSON.stringify(updaterUrl)};
            const invalid = [
                ["--concurrency", "8workers"],
                ["--concurrency=0"],
                ["--download-concurrency=33"],
                ["--apply=true"],
                ["--timeout=240seconds"],
                ["--timeout=86401"],
                ["--ref", "v3.5.1", "--ref=v3.5.1"],
                ["--apply", "--convert"],
                ["--apply", "--confirm"],
                ["--ref=v3.5.1", "--", "unexpected"],
            ].map((argumentsList) => {
                try {
                    parseUpdateOptions(argumentsList);
                    return null;
                } catch (error) {
                    return error.message;
                }
            });
            const fingerprint = "a".repeat(64);
            const valid = parseUpdateOptions([
                "--ref=v3.5.1",
                "--download-concurrency=8",
                "--apply",
                "--confirm",
                "--plan-fingerprint=" + fingerprint,
                "--",
            ]);
            process.stdout.write(JSON.stringify({ invalid, valid }));
        `);
        const output = JSON.parse(result.stdout) as {
            invalid: Array<null | string>;
            valid: {
                apply: boolean;
                downloadConcurrency: number;
                planFingerprint: string;
                upstreamRef: string;
            };
        };

        expect(result.status).toBe(0);
        expect(output.invalid).toStrictEqual(
            expect.arrayContaining([
                expect.stringContaining("integer from 1 through 32"),
                expect.stringContaining("integer from 1 through 86400"),
                expect.stringContaining("does not accept a value"),
                expect.stringContaining("cannot be specified more than once"),
                expect.stringContaining("cannot be combined"),
                expect.stringContaining("requires --plan-fingerprint"),
                expect.stringContaining("Unexpected positional argument"),
            ])
        );
        expect(output.valid).toMatchObject({
            apply: true,
            downloadConcurrency: 8,
            upstreamRef: "v3.5.1",
        });
        expect(output.valid.planFingerprint).toBe("a".repeat(64));
    });

    it("emits one JSON failure document with a stable usage exit code", () => {
        expect.assertions(5);

        const result = runUpdater(["--json", "--apply"]);
        const output = JSON.parse(result.stdout) as {
            error: { category: string; code: number; phase: string };
            ok: boolean;
            status: string;
        };

        expect(result.status).toBe(2);
        expect(result.stderr).not.toContain("npm error");
        expect(output.ok).toBe(false);
        expect(output.status).toBe("failed");
        expect(output.error).toMatchObject({
            category: "usage",
            code: 2,
            phase: "arguments",
        });
    });

    it("preserves the npm 12 separator contract", () => {
        expect.assertions(16);

        const runNpm = (
            scriptArguments: string,
            environment: NodeJS.ProcessEnv = inheritedEnvironment
        ) =>
            process.platform === "win32"
                ? spawnSync(
                      "pwsh.exe",
                      [
                          "-NoLogo",
                          "-NoProfile",
                          "-Command",
                          `npm run -- fonts:update -- ${scriptArguments}; exit $LASTEXITCODE`,
                      ],
                      {
                          cwd: repoRoot,
                          encoding: "utf8",
                          env: environment,
                          stdio: "pipe",
                      }
                  )
                : spawnSync(
                      "npm",
                      [
                          "run",
                          "--",
                          "fonts:update",
                          "--",
                          ...scriptArguments.split(" "),
                      ],
                      {
                          cwd: repoRoot,
                          encoding: "utf8",
                          env: environment,
                          stdio: "pipe",
                      }
                  );
        const result = runNpm("--help");

        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain(
            "Safely update the complete Nerd Fonts"
        );
        expect(result.stdout).toContain("--plan-fingerprint <sha256>");

        const jsonFailure = runNpm("--json --apply");
        const parsedFailure = JSON.parse(jsonFailure.stdout) as {
            ok: boolean;
        };

        expect(jsonFailure.status).toBe(2);
        expect(jsonFailure.stderr).not.toContain("npm error");
        expect(parsedFailure.ok).toBe(false);

        const mockEnvironment = {
            ...inheritedEnvironment,
            NODE_OPTIONS: `--import=${mockGitHubFetchFixtureUrl}`,
        };
        const statusBefore = spawnSync("git", ["status", "--porcelain=v1"], {
            cwd: repoRoot,
            encoding: "utf8",
            stdio: "pipe",
        }).stdout;
        const npmPlan = runNpm("--json --ref v3.5.1", mockEnvironment);
        const nodePlan = spawnSync(
            process.execPath,
            [
                nodePath.resolve(repoRoot, "scripts", "update-nerd-fonts.mjs"),
                "--json",
                "--ref",
                "v3.5.1",
            ],
            {
                cwd: repoRoot,
                encoding: "utf8",
                env: mockEnvironment,
                stdio: "pipe",
            }
        );
        const outsidePlan = spawnSync(
            process.execPath,
            [
                nodePath.resolve(repoRoot, "scripts", "update-nerd-fonts.mjs"),
                "--json",
                "--ref",
                "v3.5.1",
            ],
            {
                cwd: nodePath.dirname(repoRoot),
                encoding: "utf8",
                env: mockEnvironment,
                stdio: "pipe",
            }
        );
        const statusAfter = spawnSync("git", ["status", "--porcelain=v1"], {
            cwd: repoRoot,
            encoding: "utf8",
            stdio: "pipe",
        }).stdout;
        const npmPlanOutput = JSON.parse(npmPlan.stdout) as {
            archiveCount: number;
            planFingerprint: string;
            status: string;
        };
        const nodePlanOutput = JSON.parse(nodePlan.stdout) as {
            archiveCount: number;
            planFingerprint: string;
            status: string;
        };
        const outsidePlanOutput = JSON.parse(outsidePlan.stdout) as {
            planFingerprint: string;
            status: string;
        };

        expect(npmPlan.status).toBe(0);
        expect(nodePlan.status).toBe(0);
        expect(outsidePlan.status).toBe(0);
        expect(npmPlanOutput.status).toBe("planned");
        expect(nodePlanOutput.status).toBe("planned");
        expect(npmPlanOutput.planFingerprint).toBe(
            nodePlanOutput.planFingerprint
        );
        expect(outsidePlanOutput).toMatchObject({
            planFingerprint: nodePlanOutput.planFingerprint,
            status: "planned",
        });
        expect([
            npmPlanOutput.archiveCount,
            nodePlanOutput.archiveCount,
        ]).toStrictEqual([1, 1]);
        expect(statusAfter).toBe(statusBefore);
    }, 30_000);
});

describe("process and filesystem hardening", () => {
    it("streams JSON diagnostics, bounds output, strips tokens, and times out", () => {
        expect.assertions(12);

        const result = runInlineModule(`
            import { runCommand } from ${JSON.stringify(commandRunnerUrl)};
            import { serializeError } from ${JSON.stringify(updaterUrl)};
            const diagnostic = [];
            const sink = { write(value) { diagnostic.push(Buffer.from(value).toString("utf8")); } };
            const routed = await runCommand(process.execPath, [
                "--eval",
                "process.stdout.write('out'); process.stderr.write('err')",
            ], {
                absoluteTimeoutMs: 5_000,
                cwd: ${JSON.stringify(repoRoot)},
                mode: "json",
                stderr: sink,
                stdout: sink,
            });
            const large = await runCommand(process.execPath, [
                "--eval",
                "process.stdout.write('x'.repeat(2 * 1024 * 1024))",
            ], {
                absoluteTimeoutMs: 5_000,
                cwd: ${JSON.stringify(repoRoot)},
                maxTailBytes: 1024 * 1024,
                mode: "capture",
            });
            const tokenProbe = await runCommand(process.execPath, [
                "--eval",
                "process.stdout.write(process.env.GITHUB_TOKEN ?? 'missing')",
            ], {
                absoluteTimeoutMs: 5_000,
                cwd: ${JSON.stringify(repoRoot)},
                env: {
                    ...process.env,
                    [["GITHUB", "TOKEN"].join("_")]: "must-not-reach-child",
                },
                mode: "capture",
            });
            let timedOut;
            let descendantAlive;
            let serialized;
            try {
                await runCommand(process.execPath, [${JSON.stringify(hangingProcessFixture)}], {
                    absoluteTimeoutMs: 150,
                    cwd: ${JSON.stringify(repoRoot)},
                    killGraceMs: 50,
                    mode: "capture",
                });
            } catch (error) {
                serialized = serializeError(error);
                const descendantPid = Number(error.stdout.trim());
                try {
                    process.kill(descendantPid, 0);
                    descendantAlive = true;
                } catch {
                    descendantAlive = false;
                }
                timedOut = {
                    command: error.command,
                    name: error.name,
                    timeoutKind: error.timeoutKind,
                };
            }
            process.stdout.write(JSON.stringify({
                descendantAlive,
                diagnostic: diagnostic.join(""),
                largeLength: large.stdout.length,
                routed,
                serialized,
                timedOut,
                tokenVisible: tokenProbe.stdout,
            }));
        `);
        const output = JSON.parse(result.stdout) as {
            descendantAlive: boolean;
            diagnostic: string;
            largeLength: number;
            routed: { stderr: string; stdout: string };
            serialized: {
                command: {
                    command: string;
                    stderr: string;
                    stdout: string;
                    timeoutKind: string;
                };
            };
            timedOut: {
                command: string;
                name: string;
                timeoutKind: string;
            };
            tokenVisible: string;
        };

        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        expect(output.diagnostic).toContain("out");
        expect(output.diagnostic).toContain("err");
        expect(output.routed).toMatchObject({ stderr: "err", stdout: "out" });
        expect(output.largeLength).toBe(1024 ** 2);
        expect(output.tokenVisible).toBe("missing");
        expect(output.descendantAlive).toBe(false);
        expect(output.serialized.command).toMatchObject({
            command: process.execPath,
            stderr: "",
            timeoutKind: "absolute",
        });
        expect(output.serialized.command.stdout).toMatch(/^\d+$/v);
        expect(output.timedOut.name).toBe("CommandExecutionError");
        expect(output.timedOut).toMatchObject({
            command: process.execPath,
            timeoutKind: "absolute",
        });
    });

    it("retries only transient Windows rename failures", () => {
        expect.assertions(5);

        const result = runInlineModule(`
            import { renameWithRetry } from ${JSON.stringify(safeFilesystemUrl)};
            let transientAttempts = 0;
            const sleeps = [];
            await renameWithRetry("source", "destination", {
                rename() {
                    transientAttempts += 1;
                    if (transientAttempts < 3) {
                        const error = new Error("busy");
                        error.code = transientAttempts === 1 ? "EPERM" : "EBUSY";
                        throw error;
                    }
                },
                sleep(milliseconds) { sleeps.push(milliseconds); return Promise.resolve(); },
            });
            let structuralAttempts = 0;
            let structuralCode;
            try {
                await renameWithRetry("source", "destination", {
                    rename() {
                        structuralAttempts += 1;
                        const error = new Error("different volume");
                        error.code = "EXDEV";
                        throw error;
                    },
                    sleep() { throw new Error("must not sleep"); },
                });
            } catch (error) {
                structuralCode = error.code;
            }
            process.stdout.write(JSON.stringify({
                sleeps,
                structuralAttempts,
                structuralCode,
                transientAttempts,
            }));
        `);
        const output = JSON.parse(result.stdout) as {
            sleeps: number[];
            structuralAttempts: number;
            structuralCode: string;
            transientAttempts: number;
        };

        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        expect(output.transientAttempts).toBe(3);
        expect(output.sleeps).toStrictEqual([100, 200]);
        expect(output).toMatchObject({
            structuralAttempts: 1,
            structuralCode: "EXDEV",
        });
    });

    it("classifies README provenance and rejects missing or mixed markers", () => {
        expect.assertions(7);

        const result = runInlineModule(`
            import {
                prepareReadmeRelease,
                verifyReadmeRelease,
            } from ${JSON.stringify(transactionUrl)};
            const current = "Nerd Fonts v3.5.1 https://github.com/ryanoasis/nerd-fonts/releases/tag/v3.5.1";
            const previous = "Nerd Fonts v3.4.0 https://github.com/ryanoasis/nerd-fonts/releases/download/v3.4.0/Font.tar.xz";
            const same = prepareReadmeRelease(current, "v3.5.1");
            const updated = prepareReadmeRelease(previous, "v3.5.1");
            verifyReadmeRelease(updated.content, "v3.5.1");
            const failures = [];
            for (const value of [
                "no release provenance",
                "Nerd Fonts v3.4.0 https://github.com/ryanoasis/nerd-fonts/releases/tag/v3.5.1",
            ]) {
                try {
                    prepareReadmeRelease(value, "v3.5.1");
                } catch (error) {
                    failures.push(error.message);
                }
            }
            process.stdout.write(JSON.stringify({ failures, same, updated }));
        `);
        const output = JSON.parse(result.stdout) as {
            failures: string[];
            same: { status: string };
            updated: { content: string; status: string };
        };

        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        expect(output.same.status).toBe("already-current");
        expect(output.updated.status).toBe("updated");
        expect(output.updated.content).toContain("v3.5.1");
        expect(output.failures[0]).toContain("does not contain");
        expect(output.failures[1]).toContain("inconsistent");
    });

    it("rolls back every pre-commit fault and preserves committed state", () => {
        expect.assertions(8);

        const result = runInlineModule(`
            import {
                mkdirSync,
                mkdtempSync,
                readFileSync,
                rmSync,
                writeFileSync,
            } from "node:fs";
            import { resolve } from "node:path";
            import {
                beginUpdateTransaction,
                commitUpdateTransaction,
                createTransactionPaths,
                installTransactionReadme,
                prepareReadmeRelease,
                recoverUpdateTransaction,
            } from ${JSON.stringify(transactionUrl)};

            const tempParent = resolve(${JSON.stringify(repoRoot)}, "temp");
            mkdirSync(tempParent, { recursive: true });
            const preCommitSteps = [
                "journal-created",
                "readme-staged",
                "sources-backed-up",
                "outputs-backed-up",
                "readme-backed-up",
                "sources-installed",
                "outputs-installed",
            ];
            const cleanupSteps = [
                "commit-state-written",
                "remove source backup",
                "remove output backup",
                "remove README backup",
                "remove transaction journal",
                "remove transaction root",
            ];
            const oldReadme = "Nerd Fonts v3.4.0 https://github.com/ryanoasis/nerd-fonts/releases/tag/v3.4.0";
            const newReadme = prepareReadmeRelease(oldReadme, "v3.5.1").content;

            function fixture() {
                const root = mkdtempSync(resolve(tempParent, "updater-transaction-"));
                const destinationSources = resolve(root, "canonical", "original");
                const destinationOutputs = resolve(root, "canonical", "woff2");
                const stagingSources = resolve(root, "staging", "original");
                const stagingOutputs = resolve(root, "staging", "woff2");
                const readmeFile = resolve(root, "README.md");
                for (const directory of [
                    destinationSources,
                    destinationOutputs,
                    stagingSources,
                    stagingOutputs,
                ]) mkdirSync(directory, { recursive: true });
                writeFileSync(resolve(destinationSources, "old.txt"), "old-source");
                writeFileSync(resolve(destinationOutputs, "old.txt"), "old-output");
                writeFileSync(resolve(stagingSources, "new.txt"), "new-source");
                writeFileSync(resolve(stagingOutputs, "new.txt"), "new-output");
                writeFileSync(readmeFile, oldReadme);
                const paths = createTransactionPaths(
                    root,
                    resolve(root, "transaction"),
                    stagingSources,
                    stagingOutputs,
                    destinationSources,
                    destinationOutputs,
                    readmeFile,
                    "v3.5.1",
                );
                return { paths, readmeFile, root };
            }

            const rolledBack = [];
            for (const step of preCommitSteps) {
                const current = fixture();
                try {
                    await beginUpdateTransaction(current.paths, newReadme, {
                        afterStep(actual) {
                            if (actual === step) throw new Error("fault " + step);
                        },
                    });
                } catch {}
                const recovery = await recoverUpdateTransaction(current.paths);
                rolledBack.push({
                    oldOutput: readFileSync(resolve(current.paths.destinationOutputs, "old.txt"), "utf8"),
                    oldReadme: readFileSync(current.readmeFile, "utf8"),
                    oldSource: readFileSync(resolve(current.paths.destinationSources, "old.txt"), "utf8"),
                    recovery,
                    step,
                });
                rmSync(current.root, { force: true, recursive: true });
            }

            const readmeFault = fixture();
            await beginUpdateTransaction(readmeFault.paths, newReadme);
            try {
                await installTransactionReadme(readmeFault.paths, {
                    afterStep() { throw new Error("README replacement fault"); },
                });
            } catch {}
            const readmeRecovery = await recoverUpdateTransaction(readmeFault.paths);
            const readmeRestored = readFileSync(readmeFault.readmeFile, "utf8");
            rmSync(readmeFault.root, { force: true, recursive: true });

            const committed = [];
            for (const step of cleanupSteps) {
                const current = fixture();
                await beginUpdateTransaction(current.paths, newReadme);
                await installTransactionReadme(current.paths);
                let errorCommitted = false;
                try {
                    await commitUpdateTransaction(current.paths, {
                        afterStep(actual) {
                            if (actual === step) throw new Error("fault " + step);
                        },
                    });
                } catch (error) {
                    errorCommitted = error.committed === true;
                }
                const recovery = await recoverUpdateTransaction(current.paths);
                committed.push({
                    errorCommitted,
                    newOutput: readFileSync(resolve(current.paths.destinationOutputs, "new.txt"), "utf8"),
                    newReadme: readFileSync(current.readmeFile, "utf8"),
                    newSource: readFileSync(resolve(current.paths.destinationSources, "new.txt"), "utf8"),
                    recovery,
                    step,
                });
                rmSync(current.root, { force: true, recursive: true });
            }
            process.stdout.write(JSON.stringify({
                committed,
                readmeRecovery,
                readmeRestored,
                rolledBack,
            }));
        `);
        const output = JSON.parse(result.stdout) as {
            committed: Array<{
                errorCommitted: boolean;
                newOutput: string;
                newReadme: string;
                newSource: string;
            }>;
            readmeRecovery: string;
            readmeRestored: string;
            rolledBack: Array<{
                oldOutput: string;
                oldReadme: string;
                oldSource: string;
                recovery: string;
            }>;
        };

        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        expect(output.rolledBack).toHaveLength(7);
        expect(output.rolledBack).toStrictEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    oldOutput: "old-output",
                    oldSource: "old-source",
                    recovery: "restored",
                }),
            ])
        );
        expect(output.readmeRecovery).toBe("restored");
        expect(output.readmeRestored).toContain("v3.4.0");
        expect(output.committed).toHaveLength(6);
        expect(output.committed).toStrictEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    errorCommitted: true,
                    newOutput: "new-output",
                    newSource: "new-source",
                }),
            ])
        );
    });

    it("enforces lock ownership and explicit malformed-lock recovery", () => {
        expect.assertions(9);

        const result = runInlineModule(`
            import { spawnSync } from "node:child_process";
            import {
                existsSync,
                mkdirSync,
                mkdtempSync,
                rmSync,
                utimesSync,
                writeFileSync,
            } from "node:fs";
            import { resolve } from "node:path";
            import { acquireUpdateLock } from ${JSON.stringify(transactionUrl)};
            const tempParent = resolve(${JSON.stringify(repoRoot)}, "temp");
            mkdirSync(tempParent, { recursive: true });
            const root = mkdtempSync(resolve(tempParent, "updater-lock-"));
            const first = await acquireUpdateLock(root, { targetRef: "v3.5.1" });
            let activeError;
            try {
                await acquireUpdateLock(root, {
                    breakStaleLock: true,
                    targetRef: "v3.5.1",
                });
            } catch (error) {
                activeError = error.message;
            }
            writeFileSync(first.lockFile, JSON.stringify({
                hostname: "other",
                nonce: "other",
                pid: process.pid,
            }));
            let ownershipError;
            try {
                await first.release();
            } catch (error) {
                ownershipError = error.message;
            }
            const remainedAfterMismatch = existsSync(first.lockFile);
            rmSync(first.lockFile, { force: true });

            const lockDirectory = resolve(root, "temp", "nerd-fonts-update");
            const lockFile = resolve(lockDirectory, "update.lock");
            mkdirSync(lockDirectory, { recursive: true });
            writeFileSync(lockFile, "not json");
            let recentMalformedError;
            try {
                await acquireUpdateLock(root, {
                    breakStaleLock: true,
                    targetRef: "v3.5.1",
                });
            } catch (error) {
                recentMalformedError = error.message;
            }
            const old = new Date(Date.now() - 20 * 60 * 1000);
            utimesSync(lockFile, old, old);
            const recovered = await acquireUpdateLock(root, {
                breakStaleLock: true,
                targetRef: "v3.5.1",
            });
            await recovered.release();
            const released = !existsSync(lockFile);
            const deadPid = spawnSync(process.execPath, ["--eval", ""], {
                stdio: "ignore",
            }).pid;
            writeFileSync(lockFile, JSON.stringify({
                hostname: "dead-owner-host",
                nonce: "dead-owner-nonce",
                pid: deadPid,
                schemaVersion: 1,
                startedAt: new Date().toISOString(),
                targetRef: "v3.5.1",
            }));
            const deadOwnerRecovered = await acquireUpdateLock(root, {
                targetRef: "v3.5.1",
            });
            await deadOwnerRecovered.release();
            const deadOwnerReleased = !existsSync(lockFile);
            rmSync(root, { force: true, recursive: true });
            process.stdout.write(JSON.stringify({
                activeError,
                deadOwnerReleased,
                ownershipError,
                recentMalformedError,
                released,
                remainedAfterMismatch,
            }));
        `);
        const output = JSON.parse(result.stdout) as Record<string, unknown>;

        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        expect(output["activeError"]).toContain("update is active");
        expect(output["ownershipError"]).toContain("Unable to release");
        expect(output["recentMalformedError"]).toContain("too recent to break");
        expect(output["remainedAfterMismatch"]).toBe(true);
        expect(output["released"]).toBe(true);
        expect(output["deadOwnerReleased"]).toBe(true);
        expect(output).not.toHaveProperty("token");
    });

    it("rejects junction escapes and tampered transaction journal paths", () => {
        expect.assertions(6);

        const result = runInlineModule(`
            import {
                mkdirSync,
                mkdtempSync,
                readFileSync,
                rmSync,
                symlinkSync,
                writeFileSync,
            } from "node:fs";
            import { resolve } from "node:path";
            import {
                assertSafeRepositoryPath,
                atomicWriteJson,
            } from ${JSON.stringify(safeFilesystemUrl)};
            import {
                beginUpdateTransaction,
                createTransactionPaths,
                prepareReadmeRelease,
                recoverUpdateTransaction,
            } from ${JSON.stringify(transactionUrl)};
            const parent = resolve(${JSON.stringify(repoRoot)}, "temp");
            mkdirSync(parent, { recursive: true });
            const root = mkdtempSync(resolve(parent, "updater-paths-"));
            const outside = mkdtempSync(resolve(parent, "updater-outside-"));
            writeFileSync(resolve(outside, "outside.txt"), "outside");
            let junctionResult = "unsupported";
            try {
                const link = resolve(root, "linked");
                symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
                try {
                    assertSafeRepositoryPath(root, resolve(link, "outside.txt"));
                    junctionResult = "accepted";
                } catch (error) {
                    junctionResult = error.message;
                }
            } catch {}

            const destinationSources = resolve(root, "canonical", "original");
            const destinationOutputs = resolve(root, "canonical", "woff2");
            const stagingSources = resolve(root, "staging", "original");
            const stagingOutputs = resolve(root, "staging", "woff2");
            const readmeFile = resolve(root, "README.md");
            for (const directory of [
                destinationSources,
                destinationOutputs,
                stagingSources,
                stagingOutputs,
            ]) mkdirSync(directory, { recursive: true });
            writeFileSync(resolve(destinationSources, "old.txt"), "old");
            writeFileSync(resolve(destinationOutputs, "old.txt"), "old");
            writeFileSync(resolve(stagingSources, "new.txt"), "new");
            writeFileSync(resolve(stagingOutputs, "new.txt"), "new");
            const oldReadme = "Nerd Fonts v3.4.0 https://github.com/ryanoasis/nerd-fonts/releases/tag/v3.4.0";
            writeFileSync(readmeFile, oldReadme);
            const paths = createTransactionPaths(
                root,
                resolve(root, "transaction"),
                stagingSources,
                stagingOutputs,
                destinationSources,
                destinationOutputs,
                readmeFile,
                "v3.5.1",
            );
            await beginUpdateTransaction(
                paths,
                prepareReadmeRelease(oldReadme, "v3.5.1").content,
            );
            const stateFile = resolve(paths.transactionRoot, "promotion-state.json");
            const state = JSON.parse(readFileSync(stateFile, "utf8"));
            state.paths.stagedReadme = resolve(outside, "outside.txt");
            await atomicWriteJson(stateFile, state);
            let journalError;
            try {
                await recoverUpdateTransaction(paths);
            } catch (error) {
                journalError = error.message;
            }
            const outsideContents = readFileSync(resolve(outside, "outside.txt"), "utf8");
            rmSync(root, { force: true, recursive: true });
            rmSync(outside, { force: true, recursive: true });
            process.stdout.write(JSON.stringify({
                journalError,
                junctionResult,
                outsideContents,
            }));
        `);
        const output = JSON.parse(result.stdout) as {
            journalError: string;
            junctionResult: string;
            outsideContents: string;
        };

        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        expect(output.journalError).toContain("unsafe staged README path");
        expect(output.outsideContents).toBe("outside");
        expect(output.junctionResult).not.toBe("accepted");
        expect(output.junctionResult).toMatch(
            /(?:external link|junction|symlink|unsupported)/iv
        );
    });
});

describe("repository identity", () => {
    it("rejects a caller-supplied directory that is not the Git worktree root", () => {
        expect.assertions(5);

        const result = runInlineModule(`
            import { main } from ${JSON.stringify(updaterUrl)};
            let failure;
            try {
                await main(["--ref", "v3.5.1"], ${JSON.stringify(testDirectory)});
            } catch (error) {
                failure = {
                    category: error.category,
                    code: error.exitCode,
                    message: error.message,
                    phase: error.phase,
                };
            }
            process.stdout.write(JSON.stringify(failure));
        `);
        const output = JSON.parse(result.stdout) as {
            category: string;
            code: number;
            message: string;
            phase: string;
        };

        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        expect(output).toMatchObject({
            category: "repository-state",
            code: 3,
            phase: "repository-root",
        });
        expect(output.message).toContain("repository root mismatch");
        expect(output.message).toContain(repoRoot);
    });
});

describe("reviewed release identity", () => {
    it("fingerprints all reviewed identity fields and honors rate-limit retry headers", () => {
        expect.assertions(7);

        const result = runInlineModule(`
            import {
                calculatePlanFingerprint,
                fetchWithGitHubRetries,
            } from ${JSON.stringify(releaseIdentityUrl)};
            const identity = {
                archives: [{ id: 1, name: "Font.tar.xz", size: 2, manifestSha256: "a".repeat(64) }],
                checksumManifest: { id: 2, manifestSha256: "b".repeat(64) },
                commitSha: "c".repeat(40),
                publishedAt: "2026-08-21T00:00:00Z",
                releaseId: 3,
                upstreamRef: "v3.5.1",
            };
            const base = calculatePlanFingerprint(identity);
            const changed = [
                { ...identity, releaseId: 4 },
                { ...identity, commitSha: "d".repeat(40) },
                { ...identity, archives: [{ ...identity.archives[0], id: 8 }] },
                { ...identity, archives: [{ ...identity.archives[0], name: "Other.tar.xz" }] },
                { ...identity, archives: [{ ...identity.archives[0], size: 9 }] },
                { ...identity, archives: [{ ...identity.archives[0], manifestSha256: "f".repeat(64) }] },
                { ...identity, checksumManifest: { ...identity.checksumManifest, manifestSha256: "e".repeat(64) } },
            ].map(calculatePlanFingerprint);
            const calls = [];
            const sleeps = [];
            const responses = [
                new Response("", {
                    headers: {
                        "retry-after": "0",
                        "x-github-request-id": "request-1",
                    },
                    status: 403,
                }),
                new Response("ok", { status: 200 }),
            ];
            const response = await fetchWithGitHubRetries("https://api.github.test/value", {
                attempts: 2,
                authenticated: false,
                fetchImplementation(url, init) {
                    calls.push({ headers: init.headers, url });
                    return Promise.resolve(responses.shift());
                },
                random: () => 0,
                sleep(milliseconds) { sleeps.push(milliseconds); return Promise.resolve(); },
            });
            process.stdout.write(JSON.stringify({
                base,
                calls,
                changed,
                response: await response.text(),
                sleeps,
            }));
        `);
        const output = JSON.parse(result.stdout) as {
            base: string;
            calls: Array<{ headers: Record<string, string> }>;
            changed: string[];
            response: string;
            sleeps: number[];
        };

        const changedFingerprints = new Set(output.changed);
        const apiVersionHeader = Object.entries(
            output.calls[0]?.headers ?? {}
        ).find(([name]) => name.toLowerCase() === "x-github-api-version")?.[1];

        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        expect(output.base).toMatch(/^[\da-f]{64}$/v);
        expect(changedFingerprints.size).toBe(7);
        expect(output.changed).not.toContain(output.base);
        expect(output.response).toBe("ok");
        expect(apiVersionHeader).toBe("2026-03-10");
    });
});
