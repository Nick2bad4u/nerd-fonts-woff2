import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// eslint-disable-next-line unicorn/prefer-import-meta-properties -- Supported Node range includes versions without import.meta.dirname.
const testDirectory = nodePath.dirname(fileURLToPath(import.meta.url));
const repoRoot = nodePath.resolve(testDirectory, "..");
const workflowPath = nodePath.resolve(
    repoRoot,
    "scripts",
    "nerd-fonts-update-workflow.mjs"
);
const workflowUrl = pathToFileURL(workflowPath).href;
const releaseIdentityUrl = pathToFileURL(
    nodePath.resolve(repoRoot, "scripts", "release-identity.mjs")
).href;
const mockGitHubFetchFixtureUrl = pathToFileURL(
    nodePath.resolve(testDirectory, "fixtures", "mock-github-release-fetch.mjs")
).href;
// eslint-disable-next-line n/no-process-env -- Integration fixtures need the test runner's executable search path.
const inheritedEnvironment = process.env;

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

function runNpm(
    argumentsList: readonly string[],
    environment: typeof process.env = inheritedEnvironment
) {
    if (process.platform === "win32") {
        const npmExecPath = environment["npm_execpath"];
        if (npmExecPath === undefined) {
            throw new Error(
                "npm_execpath is required for the PowerShell npm integration test."
            );
        }
        const npmCliPath = nodePath.resolve(
            nodePath.dirname(npmExecPath),
            "npm-cli.js"
        );
        const childEnvironment = Object.fromEntries(
            Object.entries(environment).filter(
                ([variableName]) =>
                    !variableName.toLowerCase().startsWith("npm_")
            )
        );
        const powerShellPath = nodePath.resolve(
            environment["ProgramFiles"] ?? String.raw`C:\Program Files`,
            "PowerShell",
            "7",
            "pwsh.exe"
        );
        return spawnSync(
            powerShellPath,
            [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-CommandWithArgs",
                "& $env:TEST_NODE_PATH $env:TEST_NPM_CLI_PATH @args; $nativeExitCode = $LASTEXITCODE; exit $nativeExitCode",
                ...argumentsList,
            ],
            {
                cwd: repoRoot,
                encoding: "utf8",
                env: {
                    ...childEnvironment,
                    TEST_NODE_PATH: process.execPath,
                    TEST_NPM_CLI_PATH: npmCliPath,
                },
                stdio: "pipe",
            }
        );
    }
    const npmExecPath = environment["npm_execpath"];
    if (npmExecPath === undefined) {
        throw new Error(
            "npm_execpath is required for the npm integration test."
        );
    }
    const npmCliPath = nodePath.resolve(
        nodePath.dirname(npmExecPath),
        "npm-cli.js"
    );
    return spawnSync(process.execPath, [npmCliPath, ...argumentsList], {
        cwd: repoRoot,
        encoding: "utf8",
        env: environment,
        stdio: "pipe",
    });
}

describe("reviewed Nerd Fonts update workflow", () => {
    it("parses safe review, apply, and guided commands", () => {
        expect.assertions(4);

        const result = runInlineModule(`
            import { parseWorkflowArguments } from ${JSON.stringify(workflowUrl)};
            const review = parseWorkflowArguments([
                "review",
                "--ref=v3.5.1",
                "--verbose",
            ]);
            const apply = parseWorkflowArguments([
                "apply",
                "--confirm",
                "--allow-dirty",
                "--concurrency=3",
                "--failed-only",
                "--timeout-retries=1",
            ]);
            const guided = parseWorkflowArguments(["guided", "--timeout=300"]);
            const invalid = [
                ["apply"],
                ["apply", "--confirm", "--plan-fingerprint", "a".repeat(64)],
                ["guided", "--confirm"],
                ["review", "--allow-dirty"],
                ["review", "--failed-only"],
                ["review", "--plan-file", "../outside.json"],
                ["review", "--", "--plan-file", "inside.json"],
            ].map((argumentsList) => {
                try {
                    parseWorkflowArguments(argumentsList);
                    return null;
                } catch (error) {
                    return error.message;
                }
            });
            process.stdout.write(JSON.stringify({ apply, guided, invalid, review }));
        `);
        const output = JSON.parse(result.stdout) as {
            apply: { applyArguments: string[]; mode: string };
            guided: { mode: string; planArguments: string[] };
            invalid: Array<null | string>;
            review: { mode: string; planArguments: string[] };
        };

        expect(result.status).toBe(0);
        expect(output.review).toMatchObject({ mode: "review" });
        expect(output.apply).toMatchObject({ mode: "apply" });
        expect({
            applyArguments: output.apply.applyArguments,
            guided: output.guided,
            invalid: output.invalid,
            reviewArguments: output.review.planArguments,
        }).toMatchObject({
            applyArguments: expect.arrayContaining([
                "--apply",
                "--confirm",
                "--allow-dirty",
                "--concurrency",
                "3",
                "--failed-only",
                "--timeout-retries",
                "1",
            ]),
            guided: {
                mode: "guided",
                planArguments: expect.arrayContaining(["--timeout", "300"]),
            },
            invalid: expect.arrayContaining([
                expect.stringContaining("requires exactly one --confirm"),
                expect.stringContaining("managed by"),
                expect.stringContaining("does not accept --confirm"),
                expect.stringContaining("apply-only override"),
                expect.stringContaining("outside repository"),
                expect.stringContaining("Unexpected positional argument"),
            ]),
            reviewArguments: expect.arrayContaining([
                "--ref",
                "v3.5.1",
                "--verbose",
            ]),
        });
    });

    it("saves, validates, and applies only the reviewed identity", () => {
        expect.assertions(4);

        const result = runInlineModule(`
            import {
                runReviewedUpdateWorkflow,
                validateReviewedPlan,
            } from ${JSON.stringify(workflowUrl)};
            import { calculatePlanFingerprint } from ${JSON.stringify(releaseIdentityUrl)};

            const identity = {
                archives: [{
                    createdAt: "2026-08-21T08:00:09Z",
                    digest: "sha256:" + "b".repeat(64),
                    id: 1,
                    manifestSha256: "b".repeat(64),
                    name: "Example.tar.xz",
                    size: 123,
                    updatedAt: "2026-08-21T08:00:09Z",
                }],
                checksumManifest: {
                    createdAt: "2026-08-21T10:32:31Z",
                    digest: "sha256:" + "c".repeat(64),
                    id: 2,
                    manifestSha256: "c".repeat(64),
                    name: "SHA-256.txt",
                    size: 456,
                    updatedAt: "2026-08-21T10:32:32Z",
                },
                commitSha: "d".repeat(40),
                publishedAt: "2026-08-21T15:21:46Z",
                releaseId: 3,
                schemaVersion: 1,
                upstreamRef: "v3.5.1",
                upstreamRepository: "ryanoasis/nerd-fonts",
            };
            const fingerprint = calculatePlanFingerprint(identity);
            const plan = {
                archiveCount: 1,
                identity,
                mode: "plan",
                ok: true,
                planFingerprint: fingerprint,
                status: "planned",
                targetRef: "v3.5.1",
                updateAvailable: true,
            };
            let saved;
            const calls = [];
            const updater = async (argumentsList) => {
                calls.push(argumentsList);
                return argumentsList.includes("--apply")
                    ? { ok: true, status: "updated" }
                    : plan;
            };
            const review = await runReviewedUpdateWorkflow(
                ["review", "--ref", "v3.5.1"],
                {
                    now: () => new Date("2026-08-25T12:00:00Z"),
                    runUpdater: updater,
                    write: () => {},
                    writePlan: async (_path, value) => { saved = value; },
                }
            );
            const apply = await runReviewedUpdateWorkflow(
                ["apply", "--confirm"],
                {
                    readPlan: () => saved,
                    runUpdater: updater,
                    write: () => {},
                }
            );
            const guided = await runReviewedUpdateWorkflow(
                ["guided"],
                {
                    prompt: async () => fingerprint,
                    runUpdater: updater,
                    write: () => {},
                    writePlan: async () => {},
                }
            );
            const tampered = structuredClone(saved);
            tampered.plan.identity.releaseId = 4;
            let tamperError;
            try {
                validateReviewedPlan(tampered);
            } catch (error) {
                tamperError = error.message;
            }
            process.stdout.write(JSON.stringify({
                apply,
                applyCall: calls[1],
                guided,
                guidedCall: calls[3],
                review,
                saved,
                tamperError,
            }));
        `);
        const output = JSON.parse(result.stdout) as {
            apply: { status: string };
            applyCall: string[];
            guided: { status: string };
            guidedCall: string[];
            review: { status: string };
            saved: {
                plan: { planFingerprint: string };
                reviewedAt: string;
                schemaVersion: number;
            };
            tamperError: string;
        };

        expect(result.status).toBe(0);
        expect(output).toMatchObject({
            apply: { status: "updated" },
            guided: { status: "updated" },
            review: { status: "reviewed" },
            saved: {
                reviewedAt: "2026-08-25T12:00:00.000Z",
                schemaVersion: 1,
            },
            tamperError: expect.stringContaining("was modified"),
        });
        expect(output.applyCall).toStrictEqual(
            expect.arrayContaining([
                "--apply",
                "--confirm",
                "--ref",
                "v3.5.1",
                "--plan-fingerprint",
                output.saved.plan.planFingerprint,
            ])
        );
        expect(output.guidedCall).toStrictEqual(
            expect.arrayContaining([
                "--apply",
                "--confirm",
                "--plan-fingerprint",
                output.saved.plan.planFingerprint,
            ])
        );
    });

    it("exposes working npm 12 aliases and writes a valid reviewed plan", () => {
        expect.assertions(10);

        const packageJson = JSON.parse(
            readFileSync(nodePath.resolve(repoRoot, "package.json"), "utf8")
        ) as { scripts: Record<string, string> };

        expect(packageJson.scripts).toMatchObject({
            "fonts:update:apply": expect.stringContaining(" apply"),
            "fonts:update:guided": expect.stringContaining(" guided"),
            "fonts:update:resume": expect.stringContaining("--failed-only"),
            "fonts:update:review": expect.stringContaining(" review"),
        });

        const help = runNpm([
            "run",
            "--",
            "fonts:update:guided",
            "--",
            "--help",
        ]);

        expect(
            help.status,
            `npm guided help failed:\nstdout:\n${help.stdout}\nstderr:\n${help.stderr}`
        ).toBe(0);
        expect(help.stderr).not.toContain("npm error");
        expect(help.stdout).toContain("npm run fonts:update:guided");

        const temporaryRoot = mkdtempSync(
            nodePath.resolve(repoRoot, "temp", "workflow-test-")
        );
        const planFile = nodePath.resolve(temporaryRoot, "reviewed-plan.json");
        try {
            const review = runNpm(
                [
                    "run",
                    "--",
                    "fonts:update:review",
                    "--",
                    "--ref",
                    "v3.5.1",
                    "--plan-file",
                    nodePath.relative(repoRoot, planFile),
                    "--no-color",
                ],
                {
                    ...inheritedEnvironment,
                    NODE_OPTIONS: `--import=${mockGitHubFetchFixtureUrl}`,
                }
            );
            const envelope = JSON.parse(readFileSync(planFile, "utf8")) as {
                plan: {
                    archiveCount: number;
                    planFingerprint: string;
                    targetRef: string;
                };
                schemaVersion: number;
            };

            expect(review.status).toBe(0);
            expect(review.stderr).not.toContain("npm error");
            expect(review.stdout).toContain("Reviewed plan saved");
            expect(envelope).toMatchObject({
                plan: {
                    archiveCount: 1,
                    targetRef: "v3.5.1",
                },
                schemaVersion: 1,
            });
            expect(envelope.plan.planFingerprint).toMatch(/^[\da-f]{64}$/v);
            expect(review.stdout).toContain(envelope.plan.planFingerprint);
        } finally {
            rmSync(temporaryRoot, { force: true, recursive: true });
        }
    }, 30_000);
});
