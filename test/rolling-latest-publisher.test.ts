import { spawnSync } from "node:child_process";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// eslint-disable-next-line unicorn/prefer-import-meta-properties -- Supported Node range includes versions without import.meta.dirname.
const testDirectory = nodePath.dirname(fileURLToPath(import.meta.url));
const repoRoot = nodePath.resolve(testDirectory, "..");
const coreUrl = pathToFileURL(
    nodePath.resolve(repoRoot, "scripts", "rolling-publish-core.mjs")
).href;
const migrationUrl = pathToFileURL(
    nodePath.resolve(repoRoot, "scripts", "migrate-rolling-latest.mjs")
).href;
const publisherUrl = pathToFileURL(
    nodePath.resolve(repoRoot, "scripts", "publish-latest-fonts.mjs")
).href;
// eslint-disable-next-line n/no-process-env -- Native-tool integration tests must preserve the platform environment.
const inheritedEnvironment = process.env;

const temporaryRoots: string[] = [];

function createFixtureRepository(): {
    remote: string;
    source: string;
    sourceCommit: string;
} {
    const root = mkdtempSync(nodePath.resolve(tmpdir(), "rolling-fonts-"));
    temporaryRoots.push(root);
    const source = nodePath.resolve(root, "source");
    const remote = nodePath.resolve(root, "remote.git");
    mkdirSync(source, { recursive: true });
    git(source, "init", "--initial-branch=source");
    git(source, "config", "user.name", "Rolling Publisher Test");
    git(source, "config", "user.email", "publisher@example.invalid");
    writeFileSync(
        nodePath.resolve(source, ".gitignore"),
        "fonts/original/\nfonts/woff2/\ntemp/\n"
    );
    writeFileSync(nodePath.resolve(source, "README.md"), "# fixture\n");
    git(source, "add", ".gitignore", "README.md");
    git(source, "commit", "-m", "fixture source");
    const sourceCommit = git(source, "rev-parse", "HEAD");
    git(root, "init", "--bare", remote);
    git(source, "remote", "add", "origin", remote);
    git(source, "push", "origin", "source:source", "source:main");

    const outputRoot = nodePath.resolve(source, "fonts", "woff2");
    mkdirSync(nodePath.resolve(outputRoot, "Alpha"), { recursive: true });
    mkdirSync(nodePath.resolve(outputRoot, "Beta"), { recursive: true });
    const files = [
        "Alpha/Alpha-Regular.woff2",
        "Alpha/Alpha-Bold.woff2",
        "Beta/Beta-Regular.woff2",
    ];
    for (const [index, path] of files.entries()) {
        writeFileSync(
            nodePath.resolve(outputRoot, path),
            Buffer.concat([
                Buffer.from("wOF2"),
                Buffer.alloc(20 + index, index + 1),
            ])
        );
    }
    writeFileSync(
        nodePath.resolve(outputRoot, "index.json"),
        `${JSON.stringify(
            files.map((path) => ({ path })),
            null,
            2
        )}\n`
    );
    writeFileSync(
        nodePath.resolve(outputRoot, "source-metadata.json"),
        `${JSON.stringify(
            {
                commitSha: "1".repeat(40),
                generatedAt: "2026-08-31T00:00:00.000Z",
                manifestSha256: "2".repeat(64),
                outputCount: files.length,
                planFingerprint: "3".repeat(64),
                sourceCount: files.length,
                upstreamRef: "v9.9.9",
            },
            null,
            2
        )}\n`
    );
    return { remote, source, sourceCommit };
}

function expectSuccess(result: {
    status: null | number;
    stderr: string;
    stdout: string;
}): void {
    if (result.status !== 0) {
        throw new Error(result.stderr || result.stdout);
    }

    expect(result.status).toBe(0);
}

function git(cwd: string, ...argumentsList: string[]): string {
    const result = run("git", argumentsList, cwd);
    if (result.status !== 0) {
        throw new Error(
            `git ${argumentsList.join(" ")} failed (${String(result.status)}): ${result.stderr || result.stdout}`
        );
    }
    return result.stdout.trim();
}

function run(
    command: string,
    argumentsList: readonly string[],
    cwd = repoRoot
): { status: null | number; stderr: string; stdout: string } {
    const result = spawnSync(command, argumentsList, {
        cwd,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        stdio: "pipe",
        windowsHide: true,
    });
    return {
        status: result.status,
        stderr: result.stderr,
        stdout: result.stdout,
    };
}

function runInlineModule(source: string, cwd = repoRoot) {
    return run(
        process.execPath,
        [
            "--input-type=module",
            "--eval",
            source,
        ],
        cwd
    );
}

describe("rolling latest publisher", () => {
    // eslint-disable-next-line vitest/no-hooks -- Every temporary Git repository must be removed even after an assertion failure.
    afterEach(() => {
        let root = temporaryRoots.pop();
        while (root !== undefined) {
            rmSync(root, { force: true, recursive: true });
            root = temporaryRoots.pop();
        }
    });

    it("parses exact mutation gates, aliases, equals forms, and terminators", () => {
        expect.assertions(5);

        const result = runInlineModule(`
            import { parsePublishArguments } from ${JSON.stringify(publisherUrl)};
            import { parseMigrationArguments } from ${JSON.stringify(migrationUrl)};
            const hash = "a".repeat(64);
            const publish = parsePublishArguments([
                "--apply",
                "--confirm",
                "--plan-fingerprint=" + hash,
                "--verbose",
            ]);
            const migration = parseMigrationArguments([
                "--apply",
                "--confirm",
                "--plan-fingerprint",
                hash,
            ]);
            const invalid = [
                () => parsePublishArguments(["--apply"]),
                () => parsePublishArguments(["--verbose", "--verbose"]),
                () => parsePublishArguments(["--apply=true"]),
                () => parsePublishArguments(["--", "extra"]),
                () => parseMigrationArguments(["--json=true"]),
            ].map((callback) => {
                try { callback(); return null; }
                catch (error) { return error.message; }
            });
            process.stdout.write(JSON.stringify({ invalid, migration, publish }));
        `);

        expectSuccess(result);

        const output = JSON.parse(result.stdout) as {
            invalid: Array<null | string>;
            migration: Record<string, unknown>;
            publish: Record<string, unknown>;
        };

        expect(output.publish).toMatchObject({
            apply: true,
            confirm: true,
            planFingerprint: "a".repeat(64),
            verbose: true,
        });
        expect(output.migration).toMatchObject({
            apply: true,
            confirm: true,
            planFingerprint: "a".repeat(64),
        });
        expect(output.invalid).not.toContain(null);
        expect(output.invalid).toHaveLength(5);
    });

    it("serializes plans canonically and partitions duplicate blobs deterministically", () => {
        expect.assertions(5);

        const result = runInlineModule(`
            import {
                calculateFingerprint,
                partitionStagedObjects,
                stableSerialize,
            } from ${JSON.stringify(coreUrl)};
            const entries = [
                { mode: "100644", objectId: "a".repeat(40), path: "b.woff2", size: 6 },
                { mode: "100644", objectId: "b".repeat(40), path: "c.woff2", size: 6 },
                { mode: "100644", objectId: "a".repeat(40), path: "a.woff2", size: 6 },
            ];
            const chunks = partitionStagedObjects(entries, {
                maximumEstimatedBytes: 1_000_000,
                targetBytes: 7,
            });
            const left = { source: "abc", catalog: { bytes: 3, count: 2 } };
            const right = { catalog: { count: 2, bytes: 3 }, source: "abc" };
            process.stdout.write(JSON.stringify({
                chunks,
                equal: calculateFingerprint(left) === calculateFingerprint(right),
                serialized: stableSerialize(right),
            }));
        `);

        expectSuccess(result);

        const output = JSON.parse(result.stdout) as {
            chunks: Array<{ objectCount: number; paths: string[] }>;
            equal: boolean;
            serialized: string;
        };

        expect(output.equal).toBe(true);
        expect(output.serialized).toBe(
            '{"catalog":{"bytes":3,"count":2},"source":"abc"}'
        );
        expect(output.chunks).toHaveLength(2);
        expect(output.chunks[0]).toMatchObject({
            objectCount: 1,
            paths: ["b.woff2", "a.woff2"],
        });
    });

    it("publishes parentless chunks locally, resumes cleanup, and protects main with a lease", () => {
        expect.assertions(12);

        const fixture = createFixtureRepository();
        const sourceTreeish = JSON.stringify(
            [
                fixture.sourceCommit,
                "^{",
                "tree}",
            ].join("")
        );
        const result = runInlineModule(
            String.raw`
                import {
                    buildPublicationPlan,
                    publishPublicationPlan,
                    runGitCapture,
                    serializePublicationError,
                } from ${JSON.stringify(coreUrl)};
                const context = { remote: "origin", repoRoot: ${JSON.stringify(fixture.source)} };
                const plan = buildPublicationPlan(context, {
                    chunkTargetBytes: 60,
                    remoteUrl: "https://github.com/example/rolling-fonts",
                    repository: "example/rolling-fonts",
                    sourceCommit: ${JSON.stringify(fixture.sourceCommit)},
                });
                const firstSeed = plan.chunks[0];
                runGitCapture(context, [
                    "push",
                    "origin",
                    String(firstSeed.commitId) + ":" + String(firstSeed.ref),
                ]);
                runGitCapture(context, [
                    "config", "remote.origin.mirror", "true",
                ]);
                const stageFinalCommit = async ({ finalCommit, finalRef }) => {
                    const remoteContext = {
                        gitDir: ${JSON.stringify(fixture.remote)},
                        repoRoot: ${JSON.stringify(fixture.source)},
                    };
                    runGitCapture(remoteContext, [
                        "fetch", ${JSON.stringify(fixture.source)}, finalCommit,
                    ]);
                    runGitCapture(remoteContext, [
                        "update-ref", finalRef, finalCommit,
                    ]);
                };
                const first = await publishPublicationPlan(plan, {
                    context,
                    mode: "json",
                    preferExistingObjects: false,
                    pushDelayMs: 0,
                    stageFinalCommit,
                    verifyRemote: false,
                });
                const installedMain = runGitCapture(context, [
                    "ls-remote", "origin", "refs/heads/main",
                ]).slice(0, 40);
                const commitBody = runGitCapture(context, [
                    "cat-file", "commit", String(plan.finalCommit),
                ]);
                const treePaths = runGitCapture(context, [
                    "ls-tree", "-r", "--name-only", String(plan.finalCommit),
                ]).split(/\r?\n/u);
                const seedsAfterSuccess = runGitCapture(context, [
                    "ls-remote", "origin", "refs/heads/upload/font-catalog/*",
                ]);

                const outputPath = ${JSON.stringify(
                    nodePath.resolve(
                        fixture.source,
                        "fonts",
                        "woff2",
                        "Alpha",
                        "Alpha-Regular.woff2"
                    )
                )};
                const original = await import("node:fs").then(({ readFileSync }) => readFileSync(outputPath));
                original[original.length - 1] ^= 0xff;
                await import("node:fs").then(({ writeFileSync }) => writeFileSync(outputPath, original));
                const conflictingPlan = buildPublicationPlan(context, {
                    chunkTargetBytes: 60,
                    expectedMainCommit: String(plan.finalCommit),
                    remoteUrl: "https://github.com/example/rolling-fonts",
                    repository: "example/rolling-fonts",
                    sourceCommit: ${JSON.stringify(fixture.sourceCommit)},
                });
                const sourceTree = runGitCapture(context, ["rev-parse", ${sourceTreeish}]);
                const competitor = runGitCapture(context, ["commit-tree", sourceTree], {
                    env: {
                        GIT_AUTHOR_DATE: "2026-08-31T01:00:00Z",
                        GIT_COMMITTER_DATE: "2026-08-31T01:00:00Z",
                    },
                    input: "competing main\n",
                });
                runGitCapture(context, [
                    "-c", "remote.origin.mirror=false", "push", "--force", "origin",
                    competitor + ":refs/heads/main",
                ]);
                let conflict;
                try {
                    await publishPublicationPlan(conflictingPlan, {
                        context,
                        mode: "json",
                        pushDelayMs: 0,
                        verifyRemote: false,
                    });
                } catch (error) {
                    conflict = serializePublicationError(error);
                }
                const finalRemote = runGitCapture(context, [
                    "ls-remote", "origin", "refs/heads/main",
                ]).split(/\s+/u)[0];
                process.stdout.write(JSON.stringify({
                    chunks: plan.chunks.length,
                    commitBody,
                    conflict,
                    competitor,
                    finalRemote,
                    first,
                    installedMain,
                    plan,
                    seedsAfterSuccess,
                    treePaths,
                }));
            `,
            fixture.source
        );

        expectSuccess(result);

        const output = JSON.parse(result.stdout) as {
            chunks: number;
            commitBody: string;
            competitor: string;
            conflict: Record<string, unknown>;
            finalRemote: string;
            first: Record<string, unknown>;
            installedMain: string;
            plan: Record<string, unknown>;
            seedsAfterSuccess: string;
            treePaths: string[];
        };

        expect(output.chunks).toBeGreaterThan(1);
        expect(
            (
                output.plan["chunks"] as Array<{
                    measuredPackBytes: number;
                }>
            ).every((chunk) => chunk.measuredPackBytes > 0)
        ).toBe(true);
        expect(output.commitBody).not.toMatch(/^parent /mv);
        expect(output.plan["finalRef"]).toMatch(/\/final$/v);
        expect(output.installedMain).toBe(output.plan["finalCommit"]);
        expect(output.first).toMatchObject({ status: "published" });
        expect(output.seedsAfterSuccess).toBe("");
        expect(output.treePaths).toContain("fonts/woff2/index.json");
        expect(output.treePaths).not.toContain("fonts/original/secret.ttf");
        expect(output.conflict).toMatchObject({
            code: "LEASE_CONFLICT",
            phase: "lease",
        });
        expect(output.finalRemote).toBe(output.competitor);
    }, 30_000);

    it("skips seed upload when the reviewed root is already staged", () => {
        expect.assertions(4);

        const fixture = createFixtureRepository();
        const result = runInlineModule(
            `
                import {
                    buildPublicationPlan,
                    publishPublicationPlan,
                    runGitCapture,
                } from ${JSON.stringify(coreUrl)};
                const context = {
                    remote: "origin",
                    repoRoot: ${JSON.stringify(fixture.source)},
                };
                const plan = buildPublicationPlan(context, {
                    chunkTargetBytes: 60,
                    remoteUrl: "https://github.com/example/rolling-fonts",
                    repository: "example/rolling-fonts",
                    sourceCommit: ${JSON.stringify(fixture.sourceCommit)},
                });
                const progress = [];
                const stageFinalCommit = async ({ finalCommit, finalRef }) => {
                    const remoteContext = {
                        gitDir: ${JSON.stringify(fixture.remote)},
                        repoRoot: ${JSON.stringify(fixture.source)},
                    };
                    runGitCapture(remoteContext, [
                        "fetch", ${JSON.stringify(fixture.source)}, finalCommit,
                    ]);
                    runGitCapture(remoteContext, [
                        "update-ref", finalRef, finalCommit,
                    ]);
                };
                const published = await publishPublicationPlan(plan, {
                    context,
                    mode: "json",
                    onProgress: (message) => progress.push(message),
                    pushDelayMs: 0,
                    stageFinalCommit,
                    verifyRemote: false,
                });
                const main = runGitCapture(context, [
                    "ls-remote", "origin", "refs/heads/main",
                ]).slice(0, 40);
                const temporaryRefs = runGitCapture(context, [
                    "ls-remote", "origin", "refs/heads/upload/font-catalog/*",
                ]);
                process.stdout.write(JSON.stringify({
                    main,
                    progress,
                    published,
                    temporaryRefs,
                }));
            `,
            fixture.source
        );

        expectSuccess(result);

        const output = JSON.parse(result.stdout) as {
            main: string;
            progress: string[];
            published: Record<string, unknown>;
            temporaryRefs: string;
        };

        expect(output.main).toBe(output.published["finalCommit"]);
        expect(output.progress).not.toStrictEqual(
            expect.arrayContaining([expect.stringMatching(/^Uploading seed /v)])
        );
        expect(output.temporaryRefs).toBe("");
    }, 30_000);
});

describe("github distribution tree staging", () => {
    it("disables mirror mode for every scoped remote push", () => {
        expect.assertions(2);

        const result = runInlineModule(
            `
                import { scopedPushArguments } from ${JSON.stringify(coreUrl)};
                process.stdout.write(JSON.stringify(
                    scopedPushArguments("backup", "--delete", "v1.0.1")
                ));
            `,
            repoRoot
        );

        expectSuccess(result);

        expect(JSON.parse(result.stdout)).toStrictEqual([
            "-c",
            "remote.backup.mirror=false",
            "push",
            "backup",
            "--delete",
            "v1.0.1",
        ]);
    });

    it("stages the WOFF2 hierarchy through bounded directory trees", () => {
        expect.assertions(9);

        const result = runInlineModule(
            `
                import { stageWoff2TreeHierarchy } from ${JSON.stringify(coreUrl)};
                const requests = [];
                const progress = [];
                const request = async (endpoint, body, requestName) => {
                    requests.push({ body, endpoint, requestName });
                    return { sha: requests.length.toString(16).padStart(40, "0") };
                };
                const objects = [
                    { mode: "100644", path: "fonts/woff2/Beta/Beta.woff2", sha: "b".repeat(40) },
                    { mode: "100644", path: "fonts/woff2/Alpha/Regular.woff2", sha: "a".repeat(40) },
                    { mode: "100644", path: "fonts/woff2/index.json", sha: "c".repeat(40) },
                    { mode: "100644", path: "fonts/woff2/Alpha/Bold.woff2", sha: "d".repeat(40) },
                ];
                const tree = await stageWoff2TreeHierarchy(objects, {
                    delayBetweenTreeWritesMs: 0,
                    maxEntriesPerTreeWrite: 1,
                    onProgress: (message) => progress.push(message),
                    request,
                });
                let duplicateCode = null;
                try {
                    await stageWoff2TreeHierarchy([objects[0], objects[0]], {
                        delayBetweenTreeWritesMs: 0,
                        request,
                    });
                } catch (error) {
                    duplicateCode = error.code;
                }
                process.stdout.write(JSON.stringify({
                    duplicateCode,
                    progress,
                    requests,
                    tree,
                }));
            `,
            repoRoot
        );

        expectSuccess(result);

        const output = JSON.parse(result.stdout) as {
            duplicateCode: string;
            progress: string[];
            requests: Array<{
                body: {
                    base_tree?: string;
                    tree: Array<{ path: string; type: string }>;
                };
                endpoint: string;
                requestName: string;
            }>;
            tree: string;
        };

        expect(output.requests).toHaveLength(6);
        expect(
            output.requests.every(({ body }) => body.tree.length === 1)
        ).toBe(true);
        expect(
            output.requests
                .slice(0, 3)
                .flatMap(({ body }) => body.tree.map(({ path }) => path))
        ).toStrictEqual([
            "Bold.woff2",
            "Regular.woff2",
            "Beta.woff2",
        ]);
        expect(
            output.requests.slice(3).flatMap(({ body }) => body.tree)
        ).toMatchObject([
            { path: "Alpha", type: "tree" },
            { path: "Beta", type: "tree" },
            { path: "index.json", type: "blob" },
        ]);
        expect(output.requests[1]?.body.base_tree).toBe("1".padStart(40, "0"));
        expect(output.progress).toHaveLength(6);
        expect(output.tree).toBe("6".padStart(40, "0"));
        expect(output.duplicateCode).toBe("CATALOG_PATH_CONFLICT");
    });

    it("preserves the reviewed terminal newline in the GitHub commit", () => {
        expect.assertions(5);

        const result = runInlineModule(
            `
                import { stageFinalCommitOnGitHub } from ${JSON.stringify(coreUrl)};
                const treeShas = ["1".repeat(40), "2".repeat(40), "3".repeat(40)];
                let treeIndex = 0;
                let commitBody = null;
                const request = async (endpoint, body) => {
                    if (endpoint === "git/trees") {
                        return { sha: treeShas[treeIndex++] };
                    }
                    if (endpoint === "git/commits") {
                        commitBody = body;
                        return { sha: "4".repeat(40) };
                    }
                    return { ref: "refs/heads/upload/font-catalog/test/final" };
                };
                const plan = {
                    catalog: { fontTree: "2".repeat(40) },
                    chunks: [{ objects: [
                        {
                            mode: "100644",
                            objectId: "a".repeat(40),
                            path: "fonts/woff2/Alpha/Alpha.woff2",
                        },
                        {
                            mode: "100644",
                            objectId: "b".repeat(40),
                            path: "fonts/woff2/index.json",
                        },
                    ] }],
                    commitIdentity: {
                        date: "2026-08-31T00:00:00Z",
                        email: "publisher@example.invalid",
                        name: "publisher",
                    },
                    distributionTree: "3".repeat(40),
                    finalCommit: "4".repeat(40),
                    finalCommitMessage: "reviewed message",
                    finalRef: "refs/heads/upload/font-catalog/test/final",
                    remote: "origin",
                    repository: "example/rolling-fonts",
                    sourceTree: "c".repeat(40),
                };
                await stageFinalCommitOnGitHub(
                    plan,
                    { repoRoot: ${JSON.stringify(repoRoot)} },
                    ${JSON.stringify(repoRoot)},
                    {
                        delayBetweenTreeWritesMs: 0,
                        request,
                    }
                );
                process.stdout.write(JSON.stringify({ commitBody, treeIndex }));
            `,
            repoRoot
        );

        expectSuccess(result);

        const output = JSON.parse(result.stdout) as {
            commitBody: {
                message: string;
                parents: string[];
                tree: string;
            };
            treeIndex: number;
        };

        expect(output.treeIndex).toBe(3);
        expect(output.commitBody.message).toBe("reviewed message\n");
        expect(output.commitBody.parents).toStrictEqual([]);
        expect(output.commitBody.tree).toBe("3".repeat(40));
    });
});

describe("rolling latest publisher recovery and contracts", () => {
    it("detects font-bearing source history and accepts a clean orphan replacement", () => {
        expect.assertions(4);

        const fixture = createFixtureRepository();
        const oldMain = git(fixture.source, "rev-parse", "HEAD");
        const oldTreeish = JSON.stringify(
            [
                oldMain,
                "^{",
                "tree}",
            ].join("")
        );
        git(fixture.source, "add", "--force", "fonts/woff2/index.json");
        git(fixture.source, "commit", "-m", "track a generated file");
        const result = runInlineModule(
            String.raw`
                import { assertSourceHistoryFontFree } from ${JSON.stringify(migrationUrl)};
                import { runGitCapture } from ${JSON.stringify(coreUrl)};
                const context = { repoRoot: ${JSON.stringify(fixture.source)} };
                let rejected = null;
                try { assertSourceHistoryFontFree(context); }
                catch (error) { rejected = error.code; }
                const tree = runGitCapture(context, ["rev-parse", ${oldTreeish}]);
                const clean = runGitCapture(context, ["commit-tree", tree], {
                    env: {
                        GIT_AUTHOR_DATE: "2026-08-31T02:00:00Z",
                        GIT_COMMITTER_DATE: "2026-08-31T02:00:00Z",
                    },
                    input: "clean orphan source\n",
                });
                runGitCapture(context, ["update-ref", "refs/heads/source", clean]);
                assertSourceHistoryFontFree(context);
                process.stdout.write(JSON.stringify({ clean, rejected }));
            `,
            fixture.source
        );

        expectSuccess(result);

        const output = JSON.parse(result.stdout) as {
            clean: string;
            rejected: string;
        };

        expect(output.rejected).toBe("HISTORY_FILTER_FAILED");
        expect(output.clean).toMatch(/^[0-9a-f]{40}$/v);
        expect(git(fixture.source, "rev-list", "--count", output.clean)).toBe(
            "1"
        );
    }, 30_000);

    it("enforces active, dead-owner, and explicitly broken malformed locks", () => {
        expect.assertions(6);

        const root = mkdtempSync(
            nodePath.resolve(tmpdir(), "rolling-font-lock-")
        );
        temporaryRoots.push(root);
        const lockFile = nodePath.resolve(root, "publish.lock");
        const result = runInlineModule(
            `
                import { existsSync, utimesSync, writeFileSync } from "node:fs";
                import { hostname } from "node:os";
                import { acquirePublishLock } from ${JSON.stringify(coreUrl)};
                const lockFile = ${JSON.stringify(lockFile)};
                const first = await acquirePublishLock(lockFile, "first");
                let activeCode = null;
                try { await acquirePublishLock(lockFile, "second"); }
                catch (error) { activeCode = error.code; }
                await first();

                writeFileSync(lockFile, JSON.stringify({
                    hostname: hostname(),
                    nonce: "dead-owner",
                    pid: 2_147_483_647,
                    schemaVersion: 1,
                    startedAt: "2026-08-30T00:00:00.000Z",
                    target: "dead",
                }));
                const deadReplacement = await acquirePublishLock(lockFile, "replacement");
                await deadReplacement();
                const deadRemoved = !existsSync(lockFile);

                writeFileSync(lockFile, "not json");
                const old = new Date(Date.now() - 20 * 60 * 1000);
                utimesSync(lockFile, old, old);
                let malformedCode = null;
                try { await acquirePublishLock(lockFile, "young"); }
                catch (error) { malformedCode = error.code; }
                const broken = await acquirePublishLock(lockFile, "broken", {
                    breakStaleLock: true,
                });
                await broken();
                process.stdout.write(JSON.stringify({
                    activeCode,
                    brokenRemoved: !existsSync(lockFile),
                    deadRemoved,
                    malformedCode,
                }));
            `,
            root
        );

        expectSuccess(result);

        const output = JSON.parse(result.stdout) as {
            activeCode: string;
            brokenRemoved: boolean;
            deadRemoved: boolean;
            malformedCode: string;
        };

        expect(output.activeCode).toBe("PUBLISH_LOCKED");
        expect(output.deadRemoved).toBe(true);
        expect(output.malformedCode).toBe("PUBLISH_LOCKED");
        expect(output.brokenRemoved).toBe(true);
        expect(
            readFileSync(nodePath.resolve(repoRoot, ".gitignore"), "utf8")
        ).toContain("fonts/woff2/");
    });

    it("builds distinct source and rolling-distribution branch rules", () => {
        expect.assertions(6);

        const result = runInlineModule(`
            import {
                createDistributionRulesetBody,
                createSourceRulesetBody,
            } from ${JSON.stringify(migrationUrl)};
            const source = createSourceRulesetBody({
                enforcement: "active",
                name: "Existing protection",
                rules: [
                    { type: "non_fast_forward" },
                    { type: "copilot_code_review" },
                ],
            });
            const distribution = createDistributionRulesetBody();
            process.stdout.write(JSON.stringify({ distribution, source }));
        `);

        expectSuccess(result);

        const output = JSON.parse(result.stdout) as {
            distribution: Record<string, unknown>;
            source: Record<string, unknown>;
        };

        expect(output.source["conditions"]).toStrictEqual({
            ref_name: { exclude: [], include: ["refs/heads/source"] },
        });
        expect(output.source["rules"]).toContainEqual({
            type: "non_fast_forward",
        });
        expect(output.distribution["conditions"]).toStrictEqual({
            ref_name: { exclude: [], include: ["refs/heads/main"] },
        });
        expect(output.distribution["rules"]).toStrictEqual([
            { type: "deletion" },
        ]);
        expect(output.distribution["rules"]).not.toContainEqual({
            type: "non_fast_forward",
        });
    });

    it("pushes only source from a mirror-configured migration clone", () => {
        expect.assertions(4);

        const fixture = createFixtureRepository();
        const fixtureRoot = nodePath.dirname(fixture.source);
        const mirror = nodePath.resolve(fixtureRoot, "migration.git");
        git(fixtureRoot, "clone", "--mirror", fixture.source, mirror);
        git(
            fixtureRoot,
            "--git-dir",
            mirror,
            "remote",
            "set-url",
            "origin",
            fixture.remote
        );

        expect(
            git(
                fixtureRoot,
                "--git-dir",
                mirror,
                "config",
                "--bool",
                "remote.origin.mirror"
            )
        ).toBe("true");

        const result = runInlineModule(
            `
                import { pushFilteredSourceBranch } from ${JSON.stringify(migrationUrl)};
                await pushFilteredSourceBranch(${JSON.stringify(mirror)}, "json");
            `,
            fixture.source
        );

        expectSuccess(result);

        expect(
            git(fixtureRoot, "--git-dir", fixture.remote, "rev-parse", "source")
        ).toBe(fixture.sourceCommit);

        expect(
            git(fixtureRoot, "--git-dir", fixture.remote, "rev-parse", "main")
        ).toBe(fixture.sourceCommit);
    });

    it("keeps JSON stdout pure for argument failures and documents rolling URLs", () => {
        expect.assertions(9);

        const publisher = run(process.execPath, [
            nodePath.resolve(repoRoot, "scripts", "publish-latest-fonts.mjs"),
            "--json",
            "--apply",
        ]);

        expect(publisher.status).toBe(2);

        const parsedPublisher = JSON.parse(publisher.stdout) as unknown;

        expect(parsedPublisher).toBeTypeOf("object");
        expect(parsedPublisher).toMatchObject({
            error: { code: "INVALID_ARGUMENTS" },
            status: "failed",
        });

        const readme = readFileSync(
            nodePath.resolve(repoRoot, "README.md"),
            "utf8"
        );
        const fontUrls =
            readme.match(/https:\/\/\S+\/fonts\/woff2\/\S+/gv) ?? [];

        expect(fontUrls.length).toBeGreaterThan(0);
        expect(
            fontUrls.every(
                (url) =>
                    url.includes("@main/fonts/woff2/") ||
                    url.includes("/main/fonts/woff2/")
            )
        ).toBe(true);
        expect(readme).toContain("approximately 12 hours");
        expect(readme).toContain("best-effort");
        expect(readme).toContain("Raw GitHub");
        expect(git(repoRoot, "ls-files", "--", "temp")).toBe("");
    });

    it("registers all standalone npm 12 command surfaces", () => {
        expect.assertions(6);

        const packageJson = JSON.parse(
            readFileSync(nodePath.resolve(repoRoot, "package.json"), "utf8")
        ) as { packageManager: string; scripts: Record<string, string> };

        expect(packageJson.packageManager).toBe("npm@12.0.2");
        expect(packageJson.scripts).toMatchObject({
            "fonts:publish:latest": expect.stringContaining(
                "publish-latest-fonts.mjs"
            ),
            "fonts:publish:resume": expect.stringContaining("--resume"),
            "fonts:refresh:latest": expect.stringContaining(
                "font-publish-workflow.mjs"
            ),
            "repo:migrate:rolling-latest": expect.stringContaining(
                "migrate-rolling-latest.mjs"
            ),
        });

        const commands = new Map([
            ["fonts:publish:latest", "Publish the rolling latest"],
            ["fonts:refresh:latest", "Refresh, verify, commit"],
            ["repo:migrate:rolling-latest", "Migrate to source"],
        ]);
        for (const [command, expectedHelp] of commands) {
            let result;
            if (process.platform === "win32") {
                const powerShell = nodePath.resolve(
                    inheritedEnvironment["ProgramFiles"] ??
                        String.raw`C:\Program Files`,
                    "PowerShell",
                    "7",
                    "pwsh.exe"
                );
                const runPowerShellNpm = (useLeadingSeparator: boolean) =>
                    run(powerShell, [
                        "-NoLogo",
                        "-NoProfile",
                        "-NonInteractive",
                        "-Command",
                        `& npm run ${useLeadingSeparator ? "-- " : ""}${command} -- --help; $exitCode = $LASTEXITCODE; exit $exitCode`,
                    ]);

                // This workstation's npm.ps1 shim requires the documented
                // leading separator; clean npm 12 shims forward it instead.
                result = runPowerShellNpm(true);
                if (
                    result.status !== 0 ||
                    !result.stdout.includes(expectedHelp)
                ) {
                    result = runPowerShellNpm(false);
                }
            } else {
                result = run("npm", ["run", command, "--", "--help"]);
            }

            if (!result.stdout.includes(expectedHelp)) {
                throw new Error(result.stderr || result.stdout);
            }

            expectSuccess(result);
        }

        expect(
            readFileSync(
                nodePath.resolve(
                    repoRoot,
                    ".github",
                    "workflows",
                    "release.yml"
                ),
                "utf8"
            )
        ).toContain('DEFAULT_RELEASE_BRANCH: "source"');
    }, 30_000);
});
