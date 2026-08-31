#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createReadStream, existsSync, mkdirSync, statfsSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { formatCommand, runCommand } from "./command-runner.mjs";
import { isMainModule } from "./nerd-fonts-release.mjs";
import {
    buildPublicationPlan,
    calculateFingerprint,
    inspectGeneratedCatalog,
    normalizeRemoteUrl,
    PublicationError,
    publishPublicationPlan,
    repositorySlugFromRemote,
    resolveRemoteRef,
    runGitCapture,
    serializePublicationError,
    verifyGeneratedCatalog,
} from "./rolling-publish-core.mjs";
import {
    assertLocalTransactionRoot,
    assertSafeRepositoryPath,
    atomicWriteJson,
    readJsonFile,
    removeTree,
    renameWithRetry,
} from "./safe-filesystem.mjs";
import {
    ANSI,
    formatBytes,
    resolveColorEnabled,
    styleText,
} from "./terminal-output.mjs";

// eslint-disable-next-line unicorn/prefer-import-meta-properties -- Keep the supported Node range explicit.
const moduleFilePath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(moduleFilePath), "..");
const MIGRATION_SCHEMA_VERSION = 1;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const OLD_TAGS = [
    "v1.0.1",
    "v1.0.2",
    "v1.0.3",
    "v1.0.4",
    "v1.0.5",
];

function githubCliEnvironment() {
    const environment = { ...process.env };
    if (
        environment["GH_TOKEN"] === undefined &&
        environment["GITHUB_TOKEN"] !== undefined
    ) {
        environment["GH_TOKEN"] = environment["GITHUB_TOKEN"];
    }
    Reflect.deleteProperty(environment, "GITHUB_TOKEN");
    return environment;
}

/** @param {NodeJS.WritableStream} [stdout] */
function printHelp(stdout = process.stdout) {
    stdout.write("Migrate to source + rolling orphan main.\n\n");
    stdout.write("Plan only (default):\n");
    stdout.write("  npm run repo:migrate:rolling-latest\n\n");
    stdout.write("Apply the reviewed migration:\n");
    stdout.write(
        "  npm run -- repo:migrate:rolling-latest -- --apply --confirm --plan-fingerprint <sha256>\n\n"
    );
    stdout.write("Options:\n");
    stdout.write(
        "  --apply                       Perform the remote cutover\n"
    );
    stdout.write(
        "  --confirm                     Confirm destructive ref changes\n"
    );
    stdout.write(
        "  --plan-fingerprint <sha256>   Required reviewed migration\n"
    );
    stdout.write(
        "  --json                        One JSON document on stdout\n"
    );
    stdout.write("  --verbose                     Detailed stderr progress\n");
    stdout.write(
        "  --break-stale-lock            Break an old unverifiable publish lock\n"
    );
    stdout.write("  --color / --no-color          ANSI output control\n");
    stdout.write("  --help                        Show this help\n");
}

/** @param {string[]} argumentsList */
export function parseMigrationArguments(argumentsList) {
    /**
     * @type {{
     *     apply: boolean;
     *     breakStaleLock: boolean;
     *     color: boolean | null;
     *     confirm: boolean;
     *     help: boolean;
     *     json: boolean;
     *     planFingerprint: string | null;
     *     verbose: boolean;
     * }}
     */
    const options = {
        apply: false,
        breakStaleLock: false,
        color: null,
        confirm: false,
        help: false,
        json: false,
        planFingerprint: null,
        verbose: false,
    };
    const seen = new Set();
    for (let index = 0; index < argumentsList.length; index += 1) {
        const token = argumentsList[index];
        if (token === "--") {
            if (index !== argumentsList.length - 1) {
                throw new Error("Unexpected arguments after --.");
            }
            break;
        }
        const equals = token?.indexOf("=") ?? -1;
        const name = equals > 0 ? token?.slice(0, equals) : token;
        const inlineValue = equals > 0 ? token?.slice(equals + 1) : undefined;
        if (name === "--color" || name === "--no-color") {
            if (inlineValue !== undefined) {
                throw new Error(`${String(name)} does not accept a value.`);
            }
            if (seen.has("color")) throw new Error("Duplicate color option.");
            seen.add("color");
            options.color = name === "--color";
            continue;
        }
        if (name === "--plan-fingerprint") {
            if (seen.has(name)) throw new Error(`Duplicate option: ${name}`);
            seen.add(name);
            const value = inlineValue ?? argumentsList[(index += 1)];
            if (value === undefined || !SHA256_PATTERN.test(value)) {
                throw new Error(
                    "--plan-fingerprint must be a lowercase SHA-256 value."
                );
            }
            options.planFingerprint = value;
            continue;
        }
        const propertyByOption = {
            "--apply": "apply",
            "--break-stale-lock": "breakStaleLock",
            "--confirm": "confirm",
            "--help": "help",
            "--json": "json",
            "--verbose": "verbose",
        };
        const property = Reflect.get(propertyByOption, String(name));
        if (typeof property !== "string") {
            throw new Error(`Unknown option: ${String(token)}`);
        }
        if (seen.has(name))
            throw new Error(`Duplicate option: ${String(name)}`);
        if (inlineValue !== undefined) {
            throw new Error(`${String(name)} does not accept a value.`);
        }
        seen.add(name);
        Reflect.set(options, property, true);
    }
    if (
        options.apply &&
        (!options.confirm || options.planFingerprint === null)
    ) {
        throw new Error(
            "Migration requires --apply, --confirm, and --plan-fingerprint <sha256>."
        );
    }
    if (
        !options.apply &&
        (options.breakStaleLock ||
            options.confirm ||
            options.planFingerprint !== null)
    ) {
        throw new Error(
            "Confirmation and fingerprints are valid only with --apply."
        );
    }
    return options;
}

/**
 * @param {string[]} argumentsList @param {{ cwd?: string; input?: unknown }}
 *   [options]
 */
function runGhJson(argumentsList, options = {}) {
    const completeArguments = [
        ...argumentsList,
        "--header",
        "X-GitHub-Api-Version: 2026-03-10",
    ];
    const result = spawnSync("gh", completeArguments, {
        cwd: options.cwd ?? repoRoot,
        encoding: "utf8",
        env: githubCliEnvironment(),
        input:
            options.input === undefined
                ? undefined
                : `${JSON.stringify(options.input)}\n`,
        maxBuffer: 32 * 1024 * 1024,
        shell: false,
        stdio: [
            "pipe",
            "pipe",
            "pipe",
        ],
        timeout: 30_000,
        windowsHide: true,
    });
    if (result.error !== undefined || result.status !== 0) {
        const diagnostic =
            result.stderr?.trim() ||
            result.stdout?.trim() ||
            result.error?.message ||
            "unknown failure";
        throw new PublicationError(
            `${formatCommand("gh", completeArguments)} failed: ${diagnostic}`,
            {
                category: "network",
                cause: result.error,
                code: "GH_COMMAND_FAILED",
                exitCode: 5,
                phase: "github",
            }
        );
    }
    const output = result.stdout.trim();
    return output.length === 0 ? null : JSON.parse(output);
}

/** @param {string} slug */
function inspectGitHubState(slug) {
    const repository = runGhJson(["api", `repos/${slug}`]);
    const rulesetSummaries = /** @type {unknown[]} */ (
        runGhJson(["api", `repos/${slug}/rulesets`]) ?? []
    );
    const rulesets = rulesetSummaries.map((summary) => {
        const id = Reflect.get(Object(summary), "id");
        return runGhJson(["api", `repos/${slug}/rulesets/${String(id)}`]);
    });
    let pages = null;
    try {
        pages = runGhJson(["api", `repos/${slug}/pages`]);
    } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("HTTP 404")) {
            throw error;
        }
    }
    const releases = /** @type {unknown[]} */ (
        runGhJson([
            "api",
            `repos/${slug}/releases`,
            "--paginate",
            "--slurp",
        ]) ?? []
    ).flat();
    return {
        defaultBranch: Reflect.get(Object(repository), "default_branch"),
        pages,
        releases: releases
            .filter((release) =>
                OLD_TAGS.includes(
                    String(Reflect.get(Object(release), "tag_name"))
                )
            )
            .map((release) => ({
                assets: Reflect.get(Object(release), "assets"),
                id: Reflect.get(Object(release), "id"),
                name: Reflect.get(Object(release), "name"),
                publishedAt: Reflect.get(Object(release), "published_at"),
                tagName: Reflect.get(Object(release), "tag_name"),
                targetCommitish: Reflect.get(
                    Object(release),
                    "target_commitish"
                ),
            })),
        rulesets,
    };
}

/** @param {Record<string, unknown>} existing */
export function createSourceRulesetBody(existing) {
    return {
        bypass_actors: Array.isArray(existing["bypass_actors"])
            ? existing["bypass_actors"]
            : [],
        conditions: {
            ref_name: { exclude: [], include: ["refs/heads/source"] },
        },
        enforcement: existing["enforcement"] ?? "active",
        name: existing["name"] ?? "Source protection",
        rules: Array.isArray(existing["rules"])
            ? existing["rules"]
            : [{ type: "non_fast_forward" }],
        target: "branch",
    };
}

export function createDistributionRulesetBody() {
    return {
        bypass_actors: [],
        conditions: {
            ref_name: { exclude: [], include: ["refs/heads/main"] },
        },
        enforcement: "active",
        name: "Rolling distribution main",
        rules: [{ type: "deletion" }],
        target: "branch",
    };
}

/** @param {string} path @param {unknown} body */
function writeApiBody(path, body) {
    mkdirSync(dirname(path), { recursive: true });
    return atomicWriteJson(path, body);
}

/**
 * @param {string} slug
 * @param {string} endpoint
 * @param {"POST" | "PUT"} method
 * @param {string} bodyPath
 */
async function writeGitHubApi(slug, endpoint, method, bodyPath) {
    await runCommand(
        "gh",
        [
            "api",
            `repos/${slug}/${endpoint}`,
            "--method",
            method,
            "--input",
            bodyPath,
            "--header",
            "X-GitHub-Api-Version: 2026-03-10",
        ],
        {
            absoluteTimeoutMs: 30_000,
            cwd: repoRoot,
            env: githubCliEnvironment(),
            mode: "capture",
        }
    );
}

/**
 * @param {string} mirrorRoot @param {string} sourceHead @param {string}
 *   remoteUrl @param {"interactive" | "json"} [mode]
 */
async function prepareFilteredMirror(
    mirrorRoot,
    sourceHead,
    remoteUrl,
    mode = "interactive"
) {
    removeTree(mirrorRoot);
    await runCommand(
        "git",
        [
            "clone",
            "--mirror",
            "--no-hardlinks",
            repoRoot,
            mirrorRoot,
        ],
        {
            absoluteTimeoutMs: 2 * 60 * 60 * 1000,
            cwd: repoRoot,
            inactivityTimeoutMs: 10 * 60 * 1000,
            mode,
        }
    );
    const mirrorContext = { gitDir: mirrorRoot, repoRoot, workTree: repoRoot };
    runGitCapture(mirrorContext, [
        "update-ref",
        "refs/heads/source",
        sourceHead,
    ]);
    runGitCapture(mirrorContext, [
        "remote",
        "set-url",
        "origin",
        remoteUrl,
    ]);
    await runCommand(
        "git",
        [
            "--git-dir",
            mirrorRoot,
            "filter-repo",
            "--force",
            "--path",
            "fonts/woff2",
            "--invert-paths",
            "--refs",
            "refs/heads/source",
        ],
        {
            absoluteTimeoutMs: 2 * 60 * 60 * 1000,
            cwd: repoRoot,
            inactivityTimeoutMs: 10 * 60 * 1000,
            mode,
        }
    );
    const remotes = runGitCapture(mirrorContext, ["remote"])
        .split(/\r?\n/u)
        .filter(Boolean);
    if (remotes.includes("origin")) {
        runGitCapture(mirrorContext, [
            "remote",
            "set-url",
            "origin",
            remoteUrl,
        ]);
    } else {
        runGitCapture(mirrorContext, [
            "remote",
            "add",
            "origin",
            remoteUrl,
        ]);
    }
    assertSourceHistoryFontFree(mirrorContext);
    return mirrorContext;
}

/**
 * @param {string} mirrorRoot
 * @param {string} migrationRoot
 * @param {string} sourceCommit
 * @param {(message: string) => void} progress
 * @param {"interactive" | "json"} mode
 */
async function verifyFilteredSource(
    mirrorRoot,
    migrationRoot,
    sourceCommit,
    progress,
    mode
) {
    const npmCli = process.env["npm_execpath"];
    if (npmCli === undefined) {
        throw new PublicationError(
            "npm_execpath is unavailable; run the migration through npm 12.",
            {
                category: "prerequisite",
                code: "NPM_CLI_MISSING",
                exitCode: 4,
                phase: "source-gates",
            }
        );
    }
    const npmEnvironment = { ...process.env };
    for (const name of Object.keys(npmEnvironment)) {
        if (name.toLowerCase() === "npm_config_allow_scripts") {
            Reflect.deleteProperty(npmEnvironment, name);
        }
    }
    const gateRoot = resolve(migrationRoot, "source-gate");
    assertSafeRepositoryPath(repoRoot, gateRoot);
    removeTree(gateRoot);
    try {
        await runLongCommand(
            "git",
            [
                "--git-dir",
                mirrorRoot,
                "worktree",
                "add",
                "--detach",
                gateRoot,
                sourceCommit,
            ],
            { mode }
        );
        progress(
            "Installing the filtered source tree without lifecycle scripts."
        );
        await runLongCommand(
            process.execPath,
            [
                npmCli,
                "ci",
                "--ignore-scripts",
            ],
            { cwd: gateRoot, env: npmEnvironment, mode }
        );
        for (const gate of [
            "build",
            "typecheck",
            "lint",
            "test",
        ]) {
            progress(`Running filtered source gate: npm run ${gate}.`);
            await runLongCommand(
                process.execPath,
                [
                    npmCli,
                    "run",
                    gate,
                ],
                {
                    cwd: gateRoot,
                    env: npmEnvironment,
                    mode,
                }
            );
        }
    } finally {
        removeTree(gateRoot);
        try {
            runGitCapture(
                { gitDir: mirrorRoot, repoRoot, workTree: repoRoot },
                ["worktree", "prune"]
            );
        } catch {
            // A failed gate remains the primary diagnostic; a later plan can prune.
        }
    }
}

/**
 * @param {{ gitDir?: string; repoRoot: string; workTree?: string }} context
 * @param {string} [ref]
 */
export function assertSourceHistoryFontFree(
    context,
    ref = "refs/heads/source"
) {
    const filteredPaths = runGitCapture(context, [
        "rev-list",
        "--objects",
        ref,
        "--",
        "fonts/woff2",
    ]);
    if (filteredPaths.length > 0) {
        throw new PublicationError(
            "Filtered source history still contains fonts/woff2 objects.",
            {
                category: "verification",
                code: "HISTORY_FILTER_FAILED",
                exitCode: 7,
                phase: "history-filter",
            }
        );
    }
}

/**
 * @param {{
 *     mode?: "interactive" | "json";
 *     progress?: (message: string) => void;
 * }} [options]
 */
export async function buildMigrationPlan(options = {}) {
    const progress = options.progress ?? (() => {});
    const mode = options.mode ?? "interactive";
    assertLocalTransactionRoot(repoRoot);
    const context = { remote: "origin", repoRoot };
    const trackedStatus = runGitCapture(context, [
        "status",
        "--porcelain",
        "--untracked-files=no",
    ]);
    if (trackedStatus.length > 0) {
        throw new PublicationError(
            "Commit all tracked implementation changes before planning migration.",
            {
                category: "repository",
                code: "DIRTY_MIGRATION_SOURCE",
                exitCode: 3,
                phase: "preflight",
            }
        );
    }
    const branch = runGitCapture(context, ["branch", "--show-current"]);
    if (branch !== "main") {
        throw new PublicationError(
            `Initial migration must run from main, not ${branch || "detached HEAD"}.`,
            {
                category: "repository",
                code: "WRONG_MIGRATION_BRANCH",
                exitCode: 3,
                phase: "preflight",
            }
        );
    }
    try {
        runGitCapture(context, ["filter-repo", "--version"]);
    } catch (error) {
        throw new PublicationError(
            "git-filter-repo is required for the one-time history migration.",
            {
                category: "prerequisite",
                cause: error,
                code: "GIT_FILTER_REPO_MISSING",
                exitCode: 4,
                phase: "preflight",
            }
        );
    }
    const authentication = spawnSync("gh", ["auth", "status"], {
        cwd: repoRoot,
        encoding: "utf8",
        env: githubCliEnvironment(),
        shell: false,
        stdio: [
            "ignore",
            "pipe",
            "pipe",
        ],
        timeout: 30_000,
        windowsHide: true,
    });
    if (authentication.error !== undefined || authentication.status !== 0) {
        throw new PublicationError("GitHub CLI authentication is required.", {
            category: "prerequisite",
            cause: authentication.error,
            code: "GH_AUTH_REQUIRED",
            exitCode: 4,
            phase: "preflight",
        });
    }
    const sourceHead = runGitCapture(context, ["rev-parse", "HEAD"]);
    const remoteUrl = normalizeRemoteUrl(
        runGitCapture(context, [
            "remote",
            "get-url",
            "origin",
        ])
    );
    const slug = repositorySlugFromRemote(remoteUrl);
    const remoteMain = resolveRemoteRef(context, "origin", "refs/heads/main");
    if (remoteMain === null) {
        throw new PublicationError("origin/main is missing.", {
            category: "repository",
            code: "REMOTE_MAIN_MISSING",
            exitCode: 3,
            phase: "preflight",
        });
    }
    progress("Inspecting GitHub repository settings and old refs.");
    const github = inspectGitHubState(slug);
    const nonemptyRelease = github.releases.find(
        (release) =>
            Array.isArray(Reflect.get(Object(release), "assets")) &&
            /** @type {unknown[]} */ (Reflect.get(Object(release), "assets"))
                .length > 0
    );
    if (nonemptyRelease !== undefined) {
        throw new PublicationError(
            `Refusing to retire ${String(Reflect.get(Object(nonemptyRelease), "tagName"))} because its GitHub Release contains assets.`,
            {
                category: "repository",
                code: "RELEASE_HAS_ASSETS",
                exitCode: 3,
                phase: "preflight",
            }
        );
    }
    progress("Verifying the complete local source and WOFF2 catalogs.");
    await verifyGeneratedCatalog(repoRoot, mode);
    const tags = Object.fromEntries(
        OLD_TAGS.map((tag) => [
            tag,
            resolveRemoteRef(context, "origin", `refs/tags/${tag}`),
        ])
    );
    const availableBytes =
        statfsSync(repoRoot).bavail * statfsSync(repoRoot).bsize;
    const catalog = inspectGeneratedCatalog(repoRoot);
    if (catalog.fontCount !== 2_252 || catalog.indexCount !== 2_252) {
        throw new PublicationError(
            `The first rolling migration requires the reviewed 2,252-font catalog; found ${String(catalog.fontCount)} fonts and ${String(catalog.indexCount)} index entries.`,
            {
                category: "verification",
                code: "MIGRATION_CATALOG_COUNT_CHANGED",
                exitCode: 7,
                phase: "preflight",
            }
        );
    }
    const requiredDiskBytes = catalog.totalBytes * 4;
    if (availableBytes < requiredDiskBytes) {
        throw new PublicationError(
            `Migration requires at least ${formatBytes(requiredDiskBytes)} free for the mirror, bundle, and smoke clones; only ${formatBytes(availableBytes)} is available.`,
            {
                category: "repository",
                code: "INSUFFICIENT_DISK",
                exitCode: 3,
                phase: "preflight",
            }
        );
    }
    const migrationRoot = resolve(
        repoRoot,
        "temp",
        "rolling-latest-migration",
        calculateFingerprint({ remoteMain, sourceHead }).slice(0, 16)
    );
    assertSafeRepositoryPath(repoRoot, migrationRoot);
    mkdirSync(migrationRoot, { recursive: true });
    const mirrorRoot = resolve(migrationRoot, "filtered.git");
    progress("Building a disposable font-free source mirror.");
    const mirrorContext = await prepareFilteredMirror(
        mirrorRoot,
        sourceHead,
        remoteUrl,
        mode
    );
    const filteredSource = runGitCapture(mirrorContext, [
        "rev-parse",
        "refs/heads/source",
    ]);
    progress(
        "Verifying build, typecheck, lint, and tests on font-free source."
    );
    await verifyFilteredSource(
        mirrorRoot,
        migrationRoot,
        filteredSource,
        progress,
        mode
    );
    progress("Constructing the orphan distribution snapshot and seed plan.");
    const publication = buildPublicationPlan(mirrorContext, {
        expectedMainCommit: remoteMain,
        sourceCommit: filteredSource,
    });
    const payload = {
        availableBytes,
        github,
        migrationRoot,
        mirrorRoot,
        oldTags: tags,
        publication,
        requiredDiskBytes,
        remoteMain,
        remoteUrl,
        repository: slug,
        schemaVersion: MIGRATION_SCHEMA_VERSION,
        sourceHead,
        rewrittenSource: filteredSource,
    };
    const plan = {
        ...payload,
        planFingerprint: calculateFingerprint({
            kind: "rolling-latest-migration-plan",
            value: payload,
        }),
        status: "planned",
    };
    await atomicWriteJson(resolve(migrationRoot, "migration-plan.json"), plan);
    await atomicWriteJson(
        resolve(repoRoot, "temp", "rolling-latest-migration", "latest.json"),
        plan
    );
    return plan;
}

/** @param {string} path */
function sha256LargeFile(path) {
    return new Promise((resolvePromise, rejectPromise) => {
        const digest = createHash("sha256");
        const input = createReadStream(path);
        input.on("data", (chunk) => digest.update(chunk));
        input.once("error", rejectPromise);
        input.once("end", () => resolvePromise(digest.digest("hex")));
    });
}

/**
 * @param {string} command
 * @param {readonly string[]} argumentsList
 * @param {{
 *     cwd?: string;
 *     env?: NodeJS.ProcessEnv;
 *     mode?: "interactive" | "json";
 * }} [options]
 */
async function runLongCommand(command, argumentsList, options = {}) {
    return runCommand(command, argumentsList, {
        absoluteTimeoutMs: 3 * 60 * 60 * 1000,
        cwd: options.cwd ?? repoRoot,
        ...(options.env === undefined ? {} : { env: options.env }),
        mode: options.mode ?? "interactive",
    });
}

/**
 * Push only the rewritten source branch from a clone created with `--mirror`.
 *
 * A mirror clone persists `remote.origin.mirror=true`; Git otherwise rejects an
 * explicit refspec as an attempt to combine mirror and scoped push modes.
 *
 * @param {string} mirrorRoot
 * @param {"interactive" | "json"} [mode]
 */
export async function pushFilteredSourceBranch(
    mirrorRoot,
    mode = "interactive"
) {
    await runLongCommand(
        "git",
        [
            "--git-dir",
            mirrorRoot,
            "-c",
            "remote.origin.mirror=false",
            "push",
            "origin",
            "refs/heads/source:refs/heads/source",
        ],
        { mode }
    );
}

/** @param {string} slug @param {string} branch */
async function setDefaultBranch(slug, branch) {
    await runCommand(
        "gh",
        [
            "api",
            `repos/${slug}`,
            "--method",
            "PATCH",
            "--field",
            `default_branch=${branch}`,
            "--header",
            "X-GitHub-Api-Version: 2026-03-10",
        ],
        {
            absoluteTimeoutMs: 30_000,
            cwd: repoRoot,
            env: githubCliEnvironment(),
            mode: "capture",
        }
    );
}

/** @param {Record<string, unknown>} plan */
function requireMigrationPlan(plan) {
    if (
        plan["schemaVersion"] !== MIGRATION_SCHEMA_VERSION ||
        typeof plan["planFingerprint"] !== "string" ||
        typeof plan["mirrorRoot"] !== "string" ||
        typeof plan["repository"] !== "string" ||
        typeof plan["rewrittenSource"] !== "string"
    ) {
        throw new PublicationError("Invalid rolling-latest migration plan.", {
            category: "usage",
            code: "INVALID_MIGRATION_PLAN",
            exitCode: 2,
            phase: "validate",
        });
    }
}

/**
 * @param {Record<string, unknown>} plan
 * @param {{
 *     breakStaleLock?: boolean;
 *     mode?: "interactive" | "json";
 *     progress?: (message: string) => void;
 *     warning?: (message: string) => void;
 * }} [options]
 */
export async function applyMigrationPlan(plan, options = {}) {
    requireMigrationPlan(plan);
    const progress = options.progress ?? (() => {});
    const warning = options.warning ?? (() => {});
    const mode = options.mode ?? "interactive";
    const context = { remote: "origin", repoRoot };
    const sourceHead = String(plan["sourceHead"]);
    const remoteMain = String(plan["remoteMain"]);
    const slug = String(plan["repository"]);
    const mirrorRoot = String(plan["mirrorRoot"]);
    const migrationRoot = String(plan["migrationRoot"]);
    const mirrorContext = { gitDir: mirrorRoot, repoRoot, workTree: repoRoot };
    const publication = /** @type {Record<string, unknown>} */ (
        plan["publication"]
    );
    const journalFile = resolve(migrationRoot, "migration-state.json");
    const apiRoot = resolve(migrationRoot, "api");
    const backupRoot = resolve(repoRoot, "temp", "repository-backups");
    const backupBundle = resolve(
        backupRoot,
        `nerd-fonts-woff2-pre-rolling-${sourceHead.slice(0, 12)}.bundle`
    );
    assertSafeRepositoryPath(repoRoot, migrationRoot);
    assertSafeRepositoryPath(repoRoot, backupRoot);
    const journalExisted = existsSync(journalFile);
    /** @type {Record<string, unknown>} */
    const state = journalExisted
        ? /** @type {Record<string, unknown>} */ (readJsonFile(journalFile))
        : {
              mainInstalled: false,
              phase: "initialized",
              planFingerprint: plan["planFingerprint"],
              schemaVersion: MIGRATION_SCHEMA_VERSION,
          };
    if (
        state["schemaVersion"] !== MIGRATION_SCHEMA_VERSION ||
        state["planFingerprint"] !== plan["planFingerprint"]
    ) {
        throw new PublicationError(
            "Migration journal does not belong to the reviewed plan.",
            {
                category: "recovery",
                code: "MIGRATION_JOURNAL_MISMATCH",
                exitCode: 9,
                phase: "recovery",
            }
        );
    }
    const canonicalOutputPath = resolve(repoRoot, "fonts", "woff2");
    const checkoutStagedOutput = resolve(migrationRoot, "working-woff2");
    if (!existsSync(canonicalOutputPath) && existsSync(checkoutStagedOutput)) {
        await renameWithRetry(checkoutStagedOutput, canonicalOutputPath);
    }
    await atomicWriteJson(journalFile, state);
    if (!existsSync(mirrorRoot)) {
        throw new PublicationError(
            "The reviewed disposable mirror is missing; create a new plan.",
            {
                category: "repository",
                code: "MIRROR_MISSING",
                exitCode: 3,
                phase: "validate",
            }
        );
    }
    const localHead = runGitCapture(context, ["rev-parse", "HEAD"]);
    if (
        localHead !== sourceHead &&
        localHead !== String(plan["rewrittenSource"])
    ) {
        throw new PublicationError(
            "Local HEAD changed after migration review.",
            {
                category: "repository",
                code: "SOURCE_HEAD_CHANGED",
                exitCode: 3,
                phase: "validate",
            }
        );
    }
    const currentRemoteMain = resolveRemoteRef(
        context,
        "origin",
        "refs/heads/main"
    );
    const reviewedFinalMain = String(publication["finalCommit"]);
    if (
        currentRemoteMain !== remoteMain &&
        currentRemoteMain !== reviewedFinalMain
    ) {
        throw new PublicationError(
            "Remote main changed after migration review.",
            {
                category: "repository",
                code: "REMOTE_MAIN_CHANGED",
                exitCode: 3,
                phase: "validate",
            }
        );
    }
    if (currentRemoteMain === reviewedFinalMain) {
        state["mainInstalled"] = true;
    }
    if (
        runGitCapture(mirrorContext, ["rev-parse", "refs/heads/source"]) !==
        plan["rewrittenSource"]
    ) {
        throw new PublicationError(
            "Filtered source mirror changed after review.",
            {
                category: "repository",
                code: "FILTERED_SOURCE_CHANGED",
                exitCode: 3,
                phase: "validate",
            }
        );
    }
    const reviewedGitHub = /** @type {Record<string, unknown>} */ (
        plan["github"]
    );
    const currentGitHub = inspectGitHubState(slug);
    const remoteMutationMayHaveStarted = [
        "source-pushed",
        "settings-updated",
        "main-verified",
        "old-refs-retired",
        "checkout-transitioned",
    ].includes(String(state["phase"]));
    if (
        (!journalExisted || !remoteMutationMayHaveStarted) &&
        calculateFingerprint(currentGitHub) !==
            calculateFingerprint(reviewedGitHub)
    ) {
        throw new PublicationError(
            "GitHub default-branch, ruleset, Pages, or old-release state changed after review.",
            {
                category: "repository",
                code: "GITHUB_STATE_CHANGED",
                exitCode: 3,
                phase: "validate",
            }
        );
    }
    const reviewedTags = /** @type {Record<string, unknown>} */ (
        plan["oldTags"]
    );
    const currentTags = Object.fromEntries(
        OLD_TAGS.map((tag) => [
            tag,
            resolveRemoteRef(context, "origin", `refs/tags/${tag}`),
        ])
    );
    if (
        state["mainInstalled"] !== true &&
        calculateFingerprint(currentTags) !== calculateFingerprint(reviewedTags)
    ) {
        throw new PublicationError(
            "Remote tags changed after migration review.",
            {
                category: "repository",
                code: "TAG_STATE_CHANGED",
                exitCode: 3,
                phase: "validate",
            }
        );
    }
    progress("Revalidating the local catalog before migration mutation.");
    await verifyGeneratedCatalog(repoRoot, mode);
    const rebuiltPublication = buildPublicationPlan(mirrorContext, {
        expectedMainCommit: remoteMain,
        sourceCommit: String(plan["rewrittenSource"]),
    });
    if (rebuiltPublication.planFingerprint !== publication["planFingerprint"]) {
        throw new PublicationError(
            "Distribution publication changed after migration review.",
            {
                category: "usage",
                code: "PUBLICATION_PLAN_CHANGED",
                exitCode: 2,
                phase: "validate",
            }
        );
    }

    let mainInstalled = state["mainInstalled"] === true;
    /** @type {number | null} */
    let sourceRulesetId = null;
    /** @type {number | null} */
    let distributionRulesetId = null;
    try {
        if (!existsSync(backupBundle)) {
            progress("Creating a complete local Git bundle backup.");
            mkdirSync(backupRoot, { recursive: true });
            await runLongCommand(
                "git",
                [
                    "bundle",
                    "create",
                    backupBundle,
                    "--all",
                ],
                { mode }
            );
        }
        runGitCapture(
            context,
            [
                "bundle",
                "verify",
                backupBundle,
            ],
            {
                timeoutMs: 3 * 60 * 60 * 1000,
            }
        );
        const bundleSha256 = await sha256LargeFile(backupBundle);
        await atomicWriteJson(`${backupBundle}.json`, {
            bundle: backupBundle,
            createdAt: new Date().toISOString(),
            sha256: bundleSha256,
            sourceHead,
        });
        state["backupBundle"] = backupBundle;
        state["backupSha256"] = bundleSha256;
        state["phase"] = "backup-verified";
        await atomicWriteJson(journalFile, state);

        const github = /** @type {Record<string, unknown>} */ (plan["github"]);
        await atomicWriteJson(
            resolve(backupRoot, `github-state-${sourceHead.slice(0, 12)}.json`),
            github
        );
        progress("Publishing the rewritten font-free source branch.");
        await pushFilteredSourceBranch(mirrorRoot, mode);
        if (
            resolveRemoteRef(mirrorContext, "origin", "refs/heads/source") !==
            plan["rewrittenSource"]
        ) {
            throw new PublicationError("Remote source verification failed.", {
                category: "verification",
                code: "SOURCE_PUSH_VERIFY_FAILED",
                exitCode: 7,
                phase: "source-push",
            });
        }
        state["phase"] = "source-pushed";
        await atomicWriteJson(journalFile, state);

        progress("Changing the default branch and branch rulesets.");
        await setDefaultBranch(slug, "source");
        const rulesets = /** @type {Record<string, unknown>[]} */ (
            github["rulesets"]
        );
        const sourceRulesets = rulesets.filter((ruleset) =>
            /** @type {unknown[]} */ (ruleset["rules"] ?? []).some(
                (rule) =>
                    Reflect.get(Object(rule), "type") === "non_fast_forward"
            )
        );
        if (sourceRulesets.length !== 1) {
            throw new PublicationError(
                `Expected exactly one reviewed non-fast-forward ruleset; found ${String(sourceRulesets.length)}.`,
                {
                    category: "repository",
                    code: "SOURCE_RULESET_MISSING",
                    exitCode: 3,
                    phase: "ruleset",
                }
            );
        }
        const sourceRuleset = /** @type {Record<string, unknown>} */ (
            sourceRulesets[0]
        );
        sourceRulesetId = Number(sourceRuleset["id"]);
        const sourceRulesetBody = resolve(apiRoot, "source-ruleset.json");
        const distributionRulesetBody = resolve(
            apiRoot,
            "distribution-ruleset.json"
        );
        await writeApiBody(
            sourceRulesetBody,
            createSourceRulesetBody(sourceRuleset)
        );
        await writeApiBody(
            distributionRulesetBody,
            createDistributionRulesetBody()
        );
        await writeGitHubApi(
            slug,
            `rulesets/${sourceRulesetId}`,
            "PUT",
            sourceRulesetBody
        );
        const existingDistribution = inspectGitHubState(slug).rulesets.find(
            (ruleset) =>
                Reflect.get(Object(ruleset), "name") ===
                "Rolling distribution main"
        );
        if (existingDistribution === undefined) {
            await writeGitHubApi(
                slug,
                "rulesets",
                "POST",
                distributionRulesetBody
            );
        } else {
            await writeGitHubApi(
                slug,
                `rulesets/${String(Reflect.get(Object(existingDistribution), "id"))}`,
                "PUT",
                distributionRulesetBody
            );
        }
        const reviewedSettings = inspectGitHubState(slug);
        const reviewedRulesets = reviewedSettings.rulesets;
        const distributionRuleset = reviewedRulesets.find(
            (ruleset) =>
                Reflect.get(Object(ruleset), "name") ===
                "Rolling distribution main"
        );
        distributionRulesetId = Number(
            Reflect.get(Object(distributionRuleset), "id")
        );
        const finalSourceRuleset = reviewedRulesets.find(
            (ruleset) =>
                Number(Reflect.get(Object(ruleset), "id")) === sourceRulesetId
        );
        /** @param {unknown} ruleset */
        const comparableRuleset = (ruleset) => ({
            bypass_actors: Reflect.get(Object(ruleset), "bypass_actors") ?? [],
            conditions: Reflect.get(Object(ruleset), "conditions"),
            enforcement: Reflect.get(Object(ruleset), "enforcement"),
            name: Reflect.get(Object(ruleset), "name"),
            rules: Reflect.get(Object(ruleset), "rules"),
            target: Reflect.get(Object(ruleset), "target"),
        });
        if (
            !Number.isSafeInteger(distributionRulesetId) ||
            reviewedSettings.defaultBranch !== "source" ||
            finalSourceRuleset === undefined ||
            calculateFingerprint(comparableRuleset(finalSourceRuleset)) !==
                calculateFingerprint(createSourceRulesetBody(sourceRuleset)) ||
            calculateFingerprint(comparableRuleset(distributionRuleset)) !==
                calculateFingerprint(createDistributionRulesetBody())
        ) {
            throw new PublicationError("GitHub ruleset revalidation failed.", {
                category: "verification",
                code: "RULESET_VERIFY_FAILED",
                exitCode: 7,
                phase: "ruleset",
            });
        }
        state["distributionRulesetId"] = distributionRulesetId;
        state["phase"] = "settings-updated";
        await atomicWriteJson(journalFile, state);

        progress("Publishing the first rolling orphan main snapshot.");
        const publicationResult = await publishPublicationPlan(publication, {
            breakStaleLock: options.breakStaleLock ?? false,
            context: mirrorContext,
            mode,
            onProgress: progress,
            onWarning: warning,
        });
        mainInstalled = true;
        state["mainInstalled"] = true;
        state["publication"] = publicationResult;
        state["phase"] = "main-verified";
        await atomicWriteJson(journalFile, state);

        const pages = Reflect.get(Object(inspectGitHubState(slug)), "pages");
        const pagesSource = Reflect.get(Object(pages), "source");
        if (
            pages !== null &&
            Reflect.get(Object(pagesSource), "branch") !== "main"
        ) {
            warning(
                "GitHub Pages is not configured to deploy the rolling main branch; font publication remains valid."
            );
        }

        progress("Retiring font-bearing v1.0.x releases and tags.");
        const releases = /** @type {Record<string, unknown>[]} */ (
            inspectGitHubState(slug).releases
        );
        for (const release of releases) {
            const tag = String(release["tagName"]);
            await runCommand(
                "gh",
                [
                    "release",
                    "delete",
                    tag,
                    "--yes",
                    "--repo",
                    slug,
                ],
                {
                    absoluteTimeoutMs: 30_000,
                    cwd: repoRoot,
                    env: githubCliEnvironment(),
                    mode,
                }
            );
        }
        const existingTags = OLD_TAGS.filter(
            (tag) =>
                resolveRemoteRef(
                    mirrorContext,
                    "origin",
                    `refs/tags/${tag}`
                ) !== null
        );
        if (existingTags.length > 0) {
            await runLongCommand(
                "git",
                [
                    "--git-dir",
                    mirrorRoot,
                    "push",
                    "origin",
                    "--delete",
                    ...existingTags,
                ],
                { mode }
            );
        }
        if (
            OLD_TAGS.some(
                (tag) =>
                    resolveRemoteRef(
                        mirrorContext,
                        "origin",
                        `refs/tags/${tag}`
                    ) !== null
            )
        ) {
            throw new PublicationError("One or more old tags remain remote.", {
                category: "cleanup",
                cleanupPending: true,
                code: "TAG_CLEANUP_FAILED",
                committed: true,
                exitCode: 9,
                phase: "tag-cleanup",
            });
        }
        state["phase"] = "old-refs-retired";
        await atomicWriteJson(journalFile, state);

        progress("Transitioning the active checkout to source.");
        const outputPath = canonicalOutputPath;
        const stagedOutput = checkoutStagedOutput;
        /** @type {unknown} */
        let transitionFailure;
        const activeBranch = runGitCapture(context, [
            "branch",
            "--show-current",
        ]);
        if (
            activeBranch !== "main" &&
            activeBranch !== "pre-rolling-migration" &&
            activeBranch !== "source"
        ) {
            transitionFailure = new PublicationError(
                `Cannot resume checkout transition from ${activeBranch || "detached HEAD"}.`,
                {
                    category: "cleanup",
                    cleanupPending: true,
                    code: "CHECKOUT_TRANSITION_BRANCH",
                    committed: true,
                    exitCode: 9,
                    phase: "checkout-transition",
                }
            );
        } else if (activeBranch !== "source") {
            try {
                if (existsSync(stagedOutput)) {
                    if (existsSync(outputPath)) removeTree(stagedOutput);
                    else await renameWithRetry(stagedOutput, outputPath);
                }
                await renameWithRetry(outputPath, stagedOutput);
                await runLongCommand(
                    "git",
                    [
                        "fetch",
                        "origin",
                        "source",
                        "main",
                        "--prune",
                    ],
                    { mode }
                );
                if (
                    activeBranch === "main" &&
                    runGitCapture(context, [
                        "branch",
                        "--list",
                        "pre-rolling-migration",
                    ]).length > 0
                ) {
                    throw new PublicationError(
                        "Local pre-rolling-migration branch already exists.",
                        {
                            category: "repository",
                            code: "LOCAL_BACKUP_BRANCH_EXISTS",
                            exitCode: 3,
                            phase: "checkout-transition",
                        }
                    );
                }
                if (activeBranch === "main") {
                    runGitCapture(context, [
                        "branch",
                        "-m",
                        "main",
                        "pre-rolling-migration",
                    ]);
                }
                const sourceBranchExists =
                    runGitCapture(context, [
                        "branch",
                        "--list",
                        "source",
                    ]).length > 0;
                runGitCapture(
                    context,
                    sourceBranchExists
                        ? ["switch", "source"]
                        : [
                              "switch",
                              "--create",
                              "source",
                              "--track",
                              "origin/source",
                          ]
                );
            } catch (error) {
                transitionFailure = error;
            }
        } else if (
            runGitCapture(context, [
                "branch",
                "--list",
                "pre-rolling-migration",
            ]).length === 0
        ) {
            transitionFailure = new PublicationError(
                "The source checkout is missing its local pre-migration backup branch.",
                {
                    category: "cleanup",
                    cleanupPending: true,
                    code: "LOCAL_BACKUP_BRANCH_MISSING",
                    committed: true,
                    exitCode: 9,
                    phase: "checkout-transition",
                }
            );
        }
        /** @type {unknown} */
        let outputRestoreFailure;
        if (existsSync(stagedOutput) && !existsSync(outputPath)) {
            try {
                await renameWithRetry(stagedOutput, outputPath);
            } catch (error) {
                outputRestoreFailure = error;
            }
        }
        if (
            transitionFailure !== undefined ||
            outputRestoreFailure !== undefined
        ) {
            throw new AggregateError(
                [transitionFailure, outputRestoreFailure].filter(
                    (error) => error !== undefined
                ),
                "The remote migration committed, but the active checkout transition was incomplete."
            );
        }
        const localTags = runGitCapture(context, ["tag", "--list"])
            .split(/\r?\n/u)
            .filter((tag) => OLD_TAGS.includes(tag));
        if (localTags.length > 0) {
            runGitCapture(context, [
                "tag",
                "--delete",
                ...localTags,
            ]);
        }
        runGitCapture(context, [
            "remote",
            "set-head",
            "origin",
            "--auto",
        ]);
        const finalStatus = runGitCapture(context, [
            "status",
            "--porcelain",
            "--untracked-files=no",
        ]);
        if (finalStatus.length > 0) {
            throw new PublicationError(
                `The transitioned source checkout is dirty:\n${finalStatus}`,
                {
                    category: "cleanup",
                    cleanupPending: true,
                    code: "CHECKOUT_TRANSITION_DIRTY",
                    committed: true,
                    exitCode: 9,
                    phase: "checkout-transition",
                }
            );
        }
        state["phase"] = "checkout-transitioned";
        await atomicWriteJson(journalFile, state);

        progress("Running fresh shallow source and main clone smoke tests.");
        const smokeRoot = resolve(migrationRoot, "smoke");
        removeTree(smokeRoot);
        mkdirSync(smokeRoot, { recursive: true });
        await runLongCommand(
            "git",
            [
                "clone",
                "--depth",
                "1",
                "--branch",
                "source",
                String(plan["remoteUrl"]),
                resolve(smokeRoot, "source"),
            ],
            { mode }
        );
        await runLongCommand(
            "git",
            [
                "clone",
                "--depth",
                "1",
                "--branch",
                "main",
                String(plan["remoteUrl"]),
                resolve(smokeRoot, "main"),
            ],
            { mode }
        );
        const smokeContext = { repoRoot: resolve(smokeRoot, "main") };
        if (
            runGitCapture(smokeContext, [
                "rev-list",
                "--count",
                "HEAD",
            ]) !== "1"
        ) {
            throw new PublicationError(
                "Remote main is not a one-commit snapshot.",
                {
                    category: "verification",
                    code: "MAIN_NOT_ORPHAN",
                    exitCode: 7,
                    phase: "smoke-clone",
                }
            );
        }
        removeTree(smokeRoot);
        removeTree(
            resolve(repoRoot, "temp", "rolling-latest-migration", "latest.json")
        );
        removeTree(migrationRoot);
        return {
            backupBundle,
            backupSha256: bundleSha256,
            main: publication["finalCommit"],
            source: plan["rewrittenSource"],
            status: "migrated",
        };
    } catch (error) {
        const committed =
            mainInstalled || Reflect.get(Object(error), "committed") === true;
        if (!committed) {
            /** @type {unknown[]} */
            const rollbackFailures = [];
            const github = /** @type {Record<string, unknown>} */ (
                plan["github"]
            );
            try {
                await setDefaultBranch(
                    slug,
                    String(github["defaultBranch"] ?? "main")
                );
            } catch (rollbackError) {
                rollbackFailures.push(rollbackError);
            }
            const originalRulesets = /** @type {Record<string, unknown>[]} */ (
                github["rulesets"]
            );
            const originalSourceRuleset = originalRulesets.find(
                (ruleset) => Number(ruleset["id"]) === sourceRulesetId
            );
            if (
                originalSourceRuleset !== undefined &&
                sourceRulesetId !== null
            ) {
                try {
                    const restorePath = resolve(
                        apiRoot,
                        "restore-ruleset.json"
                    );
                    await writeApiBody(restorePath, {
                        bypass_actors:
                            originalSourceRuleset["bypass_actors"] ?? [],
                        conditions: originalSourceRuleset["conditions"],
                        enforcement: originalSourceRuleset["enforcement"],
                        name: originalSourceRuleset["name"],
                        rules: originalSourceRuleset["rules"],
                        target: originalSourceRuleset["target"],
                    });
                    await writeGitHubApi(
                        slug,
                        `rulesets/${sourceRulesetId}`,
                        "PUT",
                        restorePath
                    );
                } catch (rollbackError) {
                    rollbackFailures.push(rollbackError);
                }
            }
            if (distributionRulesetId !== null) {
                try {
                    await runCommand(
                        "gh",
                        [
                            "api",
                            `repos/${slug}/rulesets/${distributionRulesetId}`,
                            "--method",
                            "DELETE",
                            "--header",
                            "X-GitHub-Api-Version: 2026-03-10",
                        ],
                        {
                            absoluteTimeoutMs: 30_000,
                            cwd: repoRoot,
                            env: githubCliEnvironment(),
                            mode: "capture",
                        }
                    );
                } catch (rollbackError) {
                    rollbackFailures.push(rollbackError);
                }
            }
            if (rollbackFailures.length > 0) {
                throw new AggregateError(
                    [error, ...rollbackFailures],
                    "Migration failed and repository-setting rollback was incomplete."
                );
            }
        } else if (error instanceof Error) {
            Reflect.set(error, "committed", true);
            Reflect.set(error, "cleanupPending", true);
        }
        throw error;
    }
}

/**
 * @param {string[]} argumentsList
 * @param {{
 *     stderr?: NodeJS.WritableStream;
 *     stdout?: NodeJS.WritableStream;
 * }} [io]
 */
export async function main(argumentsList = process.argv.slice(2), io = {}) {
    const stdout = io.stdout ?? process.stdout;
    const stderr = io.stderr ?? process.stderr;
    let options;
    try {
        options = parseMigrationArguments(argumentsList);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const serialized = serializePublicationError(
            new PublicationError(message, {
                category: "usage",
                cause: error,
                code: "INVALID_ARGUMENTS",
                exitCode: 2,
                phase: "arguments",
            })
        );
        if (argumentsList.includes("--json")) {
            stdout.write(
                `${JSON.stringify({ error: serialized, status: "failed" })}\n`
            );
        } else {
            stderr.write(`${message}\n`);
        }
        process.exitCode = 2;
        return;
    }
    if (options.help) {
        if (options.json)
            stdout.write(`${JSON.stringify({ status: "help" })}\n`);
        else printHelp(stdout);
        return;
    }
    const color = resolveColorEnabled(
        options.color,
        /** @type {{ isTTY?: boolean }} */ (stderr)
    );
    /** @param {string} message */
    const progress = (message) => {
        if (options.verbose || !options.json) {
            stderr.write(
                `${styleText(color, ANSI.cyan, "[migration]")} ${message}\n`
            );
        }
    };
    /** @param {string} message */
    const warning = (message) => {
        stderr.write(
            `${styleText(color, ANSI.yellow, "warning:")} ${message}\n`
        );
    };
    try {
        let plan;
        if (options.apply) {
            const latestPath = resolve(
                repoRoot,
                "temp",
                "rolling-latest-migration",
                "latest.json"
            );
            if (!existsSync(latestPath)) {
                throw new PublicationError(
                    "No saved migration plan exists; run plan mode first.",
                    {
                        category: "usage",
                        code: "MIGRATION_PLAN_MISSING",
                        exitCode: 2,
                        phase: "validate",
                    }
                );
            }
            plan = /** @type {Record<string, unknown>} */ (
                readJsonFile(latestPath)
            );
        } else {
            plan = await buildMigrationPlan({
                mode: options.json ? "json" : "interactive",
                progress,
            });
        }
        if (!options.apply) {
            const applyCommand = `npm run -- repo:migrate:rolling-latest -- --apply --confirm --plan-fingerprint ${String(plan["planFingerprint"])}`;
            if (options.json) {
                stdout.write(
                    `${JSON.stringify({ applyCommand, plan, status: "planned" })}\n`
                );
            } else {
                const publication = /** @type {Record<string, unknown>} */ (
                    plan["publication"]
                );
                const catalog = /** @type {Record<string, unknown>} */ (
                    publication["catalog"]
                );
                stdout.write(
                    `${styleText(color, [ANSI.bold, ANSI.cyan], "Rolling-latest migration plan")}\n`
                );
                stdout.write(`Current HEAD: ${String(plan["sourceHead"])}\n`);
                stdout.write(
                    `New source:   ${String(plan["rewrittenSource"])}\n`
                );
                stdout.write(
                    `New main:     ${String(publication["finalCommit"])}\n`
                );
                stdout.write(
                    `Catalog:      ${String(catalog["fontCount"])} fonts, ${formatBytes(Number(catalog["totalBytes"]))}\n`
                );
                stdout.write(
                    `Free disk:    ${formatBytes(Number(plan["availableBytes"]))}\n`
                );
                stdout.write(
                    `Fingerprint:  ${styleText(color, ANSI.green, String(plan["planFingerprint"]))}\n\n${applyCommand}\n`
                );
            }
            return;
        }
        if (options.planFingerprint !== plan["planFingerprint"]) {
            throw new PublicationError(
                "The supplied migration fingerprint does not match the saved plan.",
                {
                    category: "usage",
                    code: "MIGRATION_FINGERPRINT_MISMATCH",
                    exitCode: 2,
                    phase: "validate",
                }
            );
        }
        const result = await applyMigrationPlan(plan, {
            breakStaleLock: options.breakStaleLock,
            mode: options.json ? "json" : "interactive",
            progress,
            warning,
        });
        if (options.json) stdout.write(`${JSON.stringify(result)}\n`);
        else {
            stdout.write(
                `${styleText(color, [ANSI.bold, ANSI.green], "Rolling-latest migration completed.")}\n`
            );
            stdout.write(`source: ${String(result.source)}\n`);
            stdout.write(`main:   ${String(result.main)}\n`);
            stdout.write(`Backup: ${String(result.backupBundle)}\n`);
            stdout.write(`SHA256: ${String(result.backupSha256)}\n`);
        }
    } catch (error) {
        const serialized = serializePublicationError(error);
        const exitCode =
            error instanceof PublicationError
                ? error.exitCode
                : Number(Reflect.get(Object(error), "exitCode")) || 1;
        if (options.json) {
            stdout.write(
                `${JSON.stringify({ error: serialized, status: "failed" })}\n`
            );
        } else {
            stderr.write(
                `${styleText(color, ANSI.red, "Migration failed:")} ${
                    error instanceof Error ? error.message : String(error)
                }\n`
            );
        }
        process.exitCode = exitCode;
    }
}

if (isMainModule(process.argv[1], moduleFilePath)) {
    await main();
}
