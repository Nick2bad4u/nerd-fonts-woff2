import { spawnSync } from "node:child_process";
import { createHash, randomInt, randomUUID } from "node:crypto";
import {
    closeSync,
    existsSync,
    fsyncSync,
    lstatSync,
    mkdirSync,
    openSync,
    readSync,
    readFileSync,
    readdirSync,
    realpathSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";

import { formatCommand, runCommand } from "./command-runner.mjs";
import {
    assertLocalTransactionRoot,
    assertSafeRepositoryPath,
    atomicWriteJson,
    readJsonFile,
    removeTree,
} from "./safe-filesystem.mjs";

export const PUBLISH_SCHEMA_VERSION = 2;
export const DEFAULT_CHUNK_TARGET_BYTES = 1_250_000_000;
export const MAX_ESTIMATED_PACK_BYTES = 1_500_000_000;
export const MAX_GITHUB_OBJECT_BYTES = 100_000_000;
export const DEFAULT_PUSH_DELAY_MS = 10_000;

const GIT_MAX_BUFFER_BYTES = 128 * 1024 * 1024;
const GIT_PROBE_TIMEOUT_MS = 30_000;
const LOCK_SCHEMA_VERSION = 1;
const LOCK_STALE_AFTER_MS = 15 * 60 * 1_000;

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

/** @param {unknown} value @returns {unknown} */
function canonicalize(value) {
    if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
        Object.entries(value)
            .filter(([, entry]) => entry !== undefined)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => [key, canonicalize(entry)])
    );
}

/** @param {unknown} value */
export function stableSerialize(value) {
    return JSON.stringify(canonicalize(value));
}

/** @param {unknown} value */
export function calculateFingerprint(value) {
    return createHash("sha256").update(stableSerialize(value)).digest("hex");
}

/** @param {string} path */
export function sha256File(path) {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * The artifact fingerprint is embedded in the commit. The complete plan also
 * contains that derived commit ID, so the two hashes must remain separate to
 * avoid a self-referential commit hash.
 *
 * @param {unknown} artifactIdentity
 */
export function calculateArtifactFingerprint(artifactIdentity) {
    return calculateFingerprint({
        kind: "rolling-font-artifact",
        schemaVersion: PUBLISH_SCHEMA_VERSION,
        value: artifactIdentity,
    });
}

export class PublicationError extends Error {
    /**
     * @param {string} message
     * @param {{
     *     category?: string;
     *     cause?: unknown;
     *     cleanupPending?: boolean;
     *     code?: string;
     *     committed?: boolean;
     *     exitCode?: number;
     *     phase?: string;
     * }} [details]
     */
    constructor(message, details = {}) {
        super(
            message,
            details.cause === undefined ? undefined : { cause: details.cause }
        );
        this.name = "PublicationError";
        this.category = details.category ?? "internal";
        this.cleanupPending = details.cleanupPending ?? false;
        this.code = details.code ?? "PUBLISH_INTERNAL";
        this.committed = details.committed ?? false;
        this.exitCode = details.exitCode ?? 1;
        this.phase = details.phase ?? "internal";
    }
}

/** @param {unknown} error */
export function serializePublicationError(error) {
    if (!(error instanceof Error)) {
        return {
            category: "internal",
            cleanupPending: false,
            code: "PUBLISH_NON_ERROR",
            committed: false,
            message: String(error),
            phase: "internal",
        };
    }
    const value = /** @type {Error & Record<string, unknown>} */ (error);
    const serialized = {
        category:
            typeof value["category"] === "string"
                ? value["category"]
                : "internal",
        cleanupPending: value["cleanupPending"] === true,
        code:
            typeof value["code"] === "string"
                ? value["code"]
                : "PUBLISH_UNEXPECTED",
        committed: value["committed"] === true,
        message: value.message,
        name: value.name,
        phase: typeof value["phase"] === "string" ? value["phase"] : "internal",
    };
    if (value.cause !== undefined) {
        Reflect.set(
            serialized,
            "cause",
            serializePublicationError(value.cause)
        );
    }
    if (error instanceof AggregateError) {
        Reflect.set(
            serialized,
            "errors",
            error.errors.map((entry) => serializePublicationError(entry))
        );
    }
    for (const key of [
        "argumentsList",
        "command",
        "cwd",
        "durationMs",
        "exitCode",
        "signal",
        "stderr",
        "stdout",
        "timeoutKind",
    ]) {
        const detail = Reflect.get(value, key);
        if (detail !== undefined) Reflect.set(serialized, key, detail);
    }
    return serialized;
}

/** @param {NodeJS.ProcessEnv} environment */
function sanitizeEnvironment(environment) {
    const result = { ...environment };
    for (const key of Object.keys(result)) {
        if (key.toUpperCase() === "GITHUB_TOKEN") {
            Reflect.deleteProperty(result, key);
        }
    }
    return result;
}

/**
 * @typedef {{
 *     gitDir?: string;
 *     remote?: string;
 *     repoRoot: string;
 *     workTree?: string;
 * }} GitContext
 */

/**
 * @param {GitContext} context
 * @param {NodeJS.ProcessEnv} [additional]
 */
function gitEnvironment(context, additional = {}) {
    const environment = sanitizeEnvironment({ ...process.env, ...additional });
    if (context.gitDir !== undefined) environment["GIT_DIR"] = context.gitDir;
    if (context.workTree !== undefined) {
        environment["GIT_WORK_TREE"] = context.workTree;
    }
    return environment;
}

/**
 * Run bounded Git plumbing with optional stdin. Long network pushes use the
 * asynchronous streaming runner below.
 *
 * @param {GitContext} context
 * @param {readonly string[]} argumentsList
 * @param {{ env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number }} [options]
 */
export function runGitCapture(context, argumentsList, options = {}) {
    const result = spawnSync("git", argumentsList, {
        cwd: context.repoRoot,
        encoding: "utf8",
        env: gitEnvironment(context, options.env),
        input: options.input,
        maxBuffer: GIT_MAX_BUFFER_BYTES,
        shell: false,
        stdio: [
            "pipe",
            "pipe",
            "pipe",
        ],
        timeout: options.timeoutMs ?? GIT_PROBE_TIMEOUT_MS,
        windowsHide: true,
    });
    if (result.error !== undefined) {
        throw new PublicationError(
            `Unable to run ${formatCommand("git", argumentsList)}: ${result.error.message}`,
            {
                category: "prerequisite",
                cause: result.error,
                code: "GIT_START_FAILED",
                exitCode: 4,
                phase: "git",
            }
        );
    }
    if (result.status !== 0) {
        const diagnostic = result.stderr.trim() || result.stdout.trim();
        const error = new PublicationError(
            `${formatCommand("git", argumentsList)} failed${
                diagnostic.length > 0 ? `: ${diagnostic}` : ""
            }`,
            {
                category: "repository",
                code: "GIT_COMMAND_FAILED",
                exitCode: 3,
                phase: "git",
            }
        );
        Reflect.set(error, "argumentsList", [...argumentsList]);
        Reflect.set(error, "command", "git");
        Reflect.set(error, "cwd", context.repoRoot);
        Reflect.set(error, "signal", result.signal);
        Reflect.set(error, "stderr", result.stderr);
        Reflect.set(error, "stdout", result.stdout);
        throw error;
    }
    return result.stdout.trim();
}

/** @param {string} remoteUrl */
export function normalizeRemoteUrl(remoteUrl) {
    const trimmed = remoteUrl.trim().replace(/\.git$/u, "");
    const scpMatch = /^(?:[^@]+@)?github\.com:(?<path>[^/]+\/[^/]+)$/u.exec(
        trimmed
    );
    if (scpMatch?.groups?.["path"] !== undefined) {
        return `https://github.com/${scpMatch.groups["path"]}`;
    }
    const urlMatch =
        /^(?:https?:\/\/|ssh:\/\/git@)github\.com\/(?<path>[^/]+\/[^/]+)$/u.exec(
            trimmed
        );
    if (urlMatch?.groups?.["path"] !== undefined) {
        return `https://github.com/${urlMatch.groups["path"]}`;
    }
    throw new PublicationError(`Unsupported GitHub remote URL: ${remoteUrl}`, {
        category: "repository",
        code: "UNSUPPORTED_REMOTE",
        exitCode: 3,
        phase: "plan",
    });
}

/** @param {string} normalizedRemote */
export function repositorySlugFromRemote(normalizedRemote) {
    const match = /^https:\/\/github\.com\/(?<slug>[^/]+\/[^/]+)$/u.exec(
        normalizedRemote
    );
    if (match?.groups?.["slug"] === undefined) {
        throw new PublicationError(
            `Unable to resolve GitHub repository from ${normalizedRemote}`,
            {
                category: "repository",
                code: "INVALID_REMOTE",
                exitCode: 3,
                phase: "plan",
            }
        );
    }
    return match.groups["slug"];
}

/**
 * @param {GitContext} context
 * @param {string} remote
 * @param {string} ref
 */
export function resolveRemoteRef(context, remote, ref) {
    const output = runGitCapture(context, [
        "ls-remote",
        remote,
        ref,
    ]);
    if (output.length === 0) return null;
    const exact = output
        .split(/\r?\n/u)
        .find((line) => line.endsWith(`\t${ref}`));
    return exact?.split(/\s+/u)[0] ?? null;
}

/** @param {string} repoRoot */
export function assertRepositoryIdentity(repoRoot) {
    const worktreeRoot = runGitCapture({ repoRoot }, [
        "rev-parse",
        "--show-toplevel",
    ]);
    const expected = realpathSync.native(repoRoot);
    const actual = realpathSync.native(worktreeRoot);
    /** @param {string} path */
    const normalize = (path) =>
        process.platform === "win32" ? path.toLowerCase() : path;
    if (normalize(expected) !== normalize(actual)) {
        throw new PublicationError(
            `Updater location ${expected} does not match Git worktree root ${actual}.`,
            {
                category: "repository",
                code: "GIT_ROOT_MISMATCH",
                exitCode: 3,
                phase: "preflight",
            }
        );
    }
    assertLocalTransactionRoot(expected);
    return expected;
}

/** @param {string} root */
function walkFiles(root) {
    /** @type {string[]} */
    const files = [];
    /** @type {string[]} */
    const queue = [root];
    for (let index = 0; index < queue.length; index += 1) {
        const directory = queue[index];
        if (directory === undefined) continue;
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = resolve(directory, entry.name);
            const status = lstatSync(path);
            if (status.isSymbolicLink()) {
                throw new PublicationError(
                    `Generated catalog may not contain links: ${path}`,
                    {
                        category: "verification",
                        code: "CATALOG_LINK",
                        exitCode: 7,
                        phase: "catalog",
                    }
                );
            }
            if (entry.isDirectory()) queue.push(path);
            else if (entry.isFile()) files.push(path);
        }
    }
    return files.sort((left, right) => left.localeCompare(right));
}

/** @param {string} path */
function requireJsonObject(path) {
    const value = readJsonFile(path);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new PublicationError(`Expected a JSON object in ${path}`, {
            category: "verification",
            code: "INVALID_METADATA",
            exitCode: 7,
            phase: "catalog",
        });
    }
    return /** @type {Record<string, unknown>} */ (value);
}

/** @param {string} repoRoot */
export function inspectGeneratedCatalog(repoRoot) {
    const outputRoot = resolve(repoRoot, "fonts", "woff2");
    const indexPath = resolve(outputRoot, "index.json");
    const metadataPath = resolve(outputRoot, "source-metadata.json");
    if (
        !existsSync(outputRoot) ||
        !existsSync(indexPath) ||
        !existsSync(metadataPath)
    ) {
        throw new PublicationError(
            "fonts/woff2 must contain index.json and source-metadata.json.",
            {
                category: "verification",
                code: "CATALOG_MISSING",
                exitCode: 7,
                phase: "catalog",
            }
        );
    }
    const allFiles = walkFiles(outputRoot);
    const fontFiles = allFiles.filter((path) => path.endsWith(".woff2"));
    const unexpectedFile = allFiles.find(
        (path) =>
            !path.endsWith(".woff2") &&
            path !== indexPath &&
            path !== metadataPath
    );
    if (unexpectedFile !== undefined) {
        throw new PublicationError(
            `Unexpected generated catalog file: ${unexpectedFile}`,
            {
                category: "verification",
                code: "UNEXPECTED_CATALOG_FILE",
                exitCode: 7,
                phase: "catalog",
            }
        );
    }
    const index = readJsonFile(indexPath);
    const metadata = requireJsonObject(metadataPath);
    if (!Array.isArray(index)) {
        throw new PublicationError("fonts/woff2/index.json must be an array.", {
            category: "verification",
            code: "INVALID_INDEX",
            exitCode: 7,
            phase: "catalog",
        });
    }
    const outputCount = Reflect.get(metadata, "outputCount");
    const sourceCount = Reflect.get(metadata, "sourceCount");
    if (
        !Number.isSafeInteger(outputCount) ||
        !Number.isSafeInteger(sourceCount) ||
        outputCount !== fontFiles.length ||
        sourceCount !== fontFiles.length ||
        index.length !== fontFiles.length
    ) {
        throw new PublicationError(
            `Catalog counts disagree: ${fontFiles.length} fonts, ${index.length} index entries, metadata source/output ${String(sourceCount)}/${String(outputCount)}.`,
            {
                category: "verification",
                code: "CATALOG_COUNT_MISMATCH",
                exitCode: 7,
                phase: "catalog",
            }
        );
    }
    const headerBuffer = Buffer.allocUnsafe(4);
    for (const path of fontFiles) {
        const descriptor = openSync(path, "r");
        let bytesRead;
        try {
            bytesRead = readSync(descriptor, headerBuffer, 0, 4, 0);
        } finally {
            closeSync(descriptor);
        }
        const header = headerBuffer.subarray(0, bytesRead).toString("ascii");
        if (header !== "wOF2") {
            throw new PublicationError(`Invalid WOFF2 signature: ${path}`, {
                category: "verification",
                code: "INVALID_WOFF2",
                exitCode: 7,
                phase: "catalog",
            });
        }
    }
    const files = allFiles.map((path) =>
        relative(repoRoot, path).split(sep).join("/")
    );
    const totalBytes = allFiles.reduce(
        (sum, path) => sum + statSync(path).size,
        0
    );
    return {
        files,
        fontCount: fontFiles.length,
        indexCount: index.length,
        indexSha256: sha256File(indexPath),
        metadata,
        metadataSha256: sha256File(metadataPath),
        totalBytes,
    };
}

/**
 * @param {string} repoRoot
 * @param {"interactive" | "json"} [mode]
 */
export async function verifyGeneratedCatalog(repoRoot, mode = "interactive") {
    try {
        await runCommand(
            process.execPath,
            [resolve(repoRoot, "scripts", "verify-font-assets.mjs")],
            {
                absoluteTimeoutMs: 30 * 60 * 1_000,
                cwd: repoRoot,
                inactivityTimeoutMs: 5 * 60 * 1_000,
                mode,
            }
        );
    } catch (error) {
        throw new PublicationError(
            `Generated font catalog verification failed: ${
                error instanceof Error ? error.message : String(error)
            }`,
            {
                category: "verification",
                cause: error,
                code: "CATALOG_VERIFIER_FAILED",
                exitCode: 7,
                phase: "catalog",
            }
        );
    }
}

/**
 * @typedef {{ mode: string; objectId: string; path: string; size: number }} StagedObject
 */

/** @param {string} output @param {string} repoRoot */
export function parseStagedObjects(output, repoRoot) {
    return output
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => {
            const match =
                /^(?<mode>\d{6}) (?<objectId>[0-9a-f]{40,64}) 0\t(?<path>.+)$/u.exec(
                    line
                );
            const mode = match?.groups?.["mode"];
            const objectId = match?.groups?.["objectId"];
            const path = match?.groups?.["path"];
            if (
                mode === undefined ||
                objectId === undefined ||
                path === undefined
            ) {
                throw new PublicationError(
                    `Invalid staged Git entry: ${line}`,
                    {
                        code: "INVALID_STAGE_ENTRY",
                        phase: "snapshot",
                    }
                );
            }
            if (/\r|\n|\t/u.test(path)) {
                throw new PublicationError(`Unsafe generated path: ${path}`, {
                    category: "verification",
                    code: "UNSAFE_GENERATED_PATH",
                    exitCode: 7,
                    phase: "snapshot",
                });
            }
            return {
                mode,
                objectId,
                path,
                size: statSync(resolve(repoRoot, path)).size,
            };
        });
}

/** @param {readonly StagedObject[]} objects */
function groupObjectsByBlob(objects) {
    /**
     * @type {Map<
     *     string,
     *     { entries: StagedObject[]; objectId: string; size: number }
     * >}
     */
    const groups = new Map();
    for (const object of objects) {
        const existing = groups.get(object.objectId);
        if (existing === undefined) {
            groups.set(object.objectId, {
                entries: [object],
                objectId: object.objectId,
                size: object.size,
            });
        } else {
            existing.entries.push(object);
        }
    }
    return [...groups.values()].sort((left, right) =>
        (left.entries[0]?.path ?? "").localeCompare(
            right.entries[0]?.path ?? ""
        )
    );
}

/** @param {number} bytes */
export function estimatePackBytes(bytes) {
    return Math.ceil(bytes * 1.02 + 64 * 1024);
}

/**
 * @param {readonly StagedObject[]} objects
 * @param {{ maximumEstimatedBytes?: number; targetBytes?: number }} [options]
 */
export function partitionStagedObjects(objects, options = {}) {
    const targetBytes = options.targetBytes ?? DEFAULT_CHUNK_TARGET_BYTES;
    const maximumEstimatedBytes =
        options.maximumEstimatedBytes ?? MAX_ESTIMATED_PACK_BYTES;
    if (!Number.isSafeInteger(targetBytes) || targetBytes < 1) {
        throw new Error("Chunk target must be a positive safe integer.");
    }
    if (
        !Number.isSafeInteger(maximumEstimatedBytes) ||
        maximumEstimatedBytes < 1
    ) {
        throw new Error(
            "Maximum estimated pack size must be a positive integer."
        );
    }
    const groups = groupObjectsByBlob(objects);
    for (const group of groups) {
        if (group.size > MAX_GITHUB_OBJECT_BYTES) {
            throw new PublicationError(
                `GitHub rejects objects larger than 100 MB: ${group.entries[0]?.path ?? group.objectId}.`,
                {
                    category: "verification",
                    code: "OBJECT_TOO_LARGE",
                    exitCode: 7,
                    phase: "chunking",
                }
            );
        }
    }
    /** @type {(typeof groups)[]} */
    const preliminary = [];
    /** @type {typeof groups} */
    let current = [];
    let currentBytes = 0;
    for (const group of groups) {
        if (current.length > 0 && currentBytes + group.size > targetBytes) {
            preliminary.push(current);
            current = [];
            currentBytes = 0;
        }
        current.push(group);
        currentBytes += group.size;
    }
    if (current.length > 0) preliminary.push(current);

    /** @type {(typeof groups)[]} */
    const bounded = [];
    /**
     * @param {{
     *     entries: StagedObject[];
     *     objectId: string;
     *     size: number;
     * }[]} groupsToSplit
     */
    const split = (groupsToSplit) => {
        const bytes = groupsToSplit.reduce((sum, group) => sum + group.size, 0);
        if (estimatePackBytes(bytes) <= maximumEstimatedBytes) {
            bounded.push(groupsToSplit);
            return;
        }
        if (groupsToSplit.length < 2) {
            throw new PublicationError(
                "A seed chunk exceeds the safe maximum.",
                {
                    category: "verification",
                    code: "CHUNK_TOO_LARGE",
                    exitCode: 7,
                    phase: "chunking",
                }
            );
        }
        const midpoint = Math.ceil(groupsToSplit.length / 2);
        split(groupsToSplit.slice(0, midpoint));
        split(groupsToSplit.slice(midpoint));
    };
    for (const chunk of preliminary) split(chunk);
    return bounded.map((chunk, index) => {
        const entries = chunk.flatMap((group) => group.entries);
        const bytes = chunk.reduce((sum, group) => sum + group.size, 0);
        return {
            bytes,
            entries,
            estimatedPackBytes: estimatePackBytes(bytes),
            number: index + 1,
            objectCount: chunk.length,
            paths: entries.map((entry) => entry.path),
        };
    });
}

/**
 * @param {GitContext} context
 * @param {string} indexFile
 * @param {readonly StagedObject[]} entries
 */
function createTreeFromEntries(context, indexFile, entries) {
    rmSync(indexFile, { force: true });
    runGitCapture(context, ["read-tree", "--empty"], {
        env: { GIT_INDEX_FILE: indexFile },
    });
    const input = entries
        .map((entry) => `${entry.mode} ${entry.objectId}\t${entry.path}\n`)
        .join("");
    runGitCapture(context, ["update-index", "--index-info"], {
        env: { GIT_INDEX_FILE: indexFile },
        input,
    });
    return runGitCapture(context, ["write-tree"], {
        env: { GIT_INDEX_FILE: indexFile },
    });
}

/**
 * @param {GitContext} context
 * @param {string} treeId
 * @param {string} message
 * @param {string} timestamp
 */
function createParentlessCommit(context, treeId, message, timestamp) {
    return runGitCapture(context, ["commit-tree", treeId], {
        env: {
            GIT_AUTHOR_DATE: timestamp,
            GIT_AUTHOR_EMAIL: "20943337+Nick2bad4u@users.noreply.github.com",
            GIT_AUTHOR_NAME: "nerd-fonts-woff2 publisher",
            GIT_COMMITTER_DATE: timestamp,
            GIT_COMMITTER_EMAIL: "20943337+Nick2bad4u@users.noreply.github.com",
            GIT_COMMITTER_NAME: "nerd-fonts-woff2 publisher",
        },
        input: `${message.trim()}\n`,
    });
}

/**
 * Materialize the exact pack Git would build for a parentless seed commit.
 * WOFF2 is already compressed, so disabling Git object reuse and compression
 * gives a conservative, reproducible upper-bound measurement.
 *
 * @param {GitContext} context
 * @param {string} temporaryRoot
 * @param {string} commitId
 * @param {number} number
 */
function measureSeedPack(context, temporaryRoot, commitId, number) {
    const packBase = resolve(
        temporaryRoot,
        `measure-${String(number).padStart(4, "0")}`
    );
    const packHash = runGitCapture(
        context,
        [
            "pack-objects",
            "--compression=0",
            "--no-reuse-delta",
            "--no-reuse-object",
            "--revs",
            "--window=0",
            packBase,
        ],
        { input: `${commitId}\n`, timeoutMs: 2 * 60 * 60 * 1_000 }
    );
    const packFile = `${packBase}-${packHash}.pack`;
    if (!existsSync(packFile)) {
        throw new PublicationError(
            `Git did not create the expected seed pack for chunk ${String(number)}.`,
            {
                category: "verification",
                code: "PACK_MEASUREMENT_MISSING",
                exitCode: 7,
                phase: "chunking",
            }
        );
    }
    const bytes = statSync(packFile).size;
    for (const path of readdirSync(temporaryRoot)) {
        if (path.startsWith(`measure-${String(number).padStart(4, "0")}-`)) {
            rmSync(resolve(temporaryRoot, path), { force: true });
        }
    }
    return bytes;
}

/**
 * @param {GitContext} context
 * @param {{
 *     chunkTargetBytes?: number;
 *     expectedMainCommit?: string | null;
 *     measurePackBytes?: boolean;
 *     remote?: string;
 *     remoteUrl?: string;
 *     repository?: string;
 *     sourceBranch?: string;
 *     sourceCommit: string;
 * }} options
 */
export function buildPublicationPlan(context, options) {
    assertRepositoryIdentity(context.workTree ?? context.repoRoot);
    const remote = options.remote ?? context.remote ?? "origin";
    const sourceBranch = options.sourceBranch ?? "source";
    const remoteUrl =
        options.remoteUrl ??
        normalizeRemoteUrl(
            runGitCapture(context, [
                "remote",
                "get-url",
                remote,
            ])
        );
    const repository =
        options.repository ?? repositorySlugFromRemote(remoteUrl);
    const sourceCommit = runGitCapture(context, [
        "rev-parse",
        `${options.sourceCommit}^{commit}`,
    ]);
    const sourceTree = runGitCapture(context, [
        "rev-parse",
        `${sourceCommit}^{tree}`,
    ]);
    const expectedMainCommit =
        options.expectedMainCommit === undefined
            ? resolveRemoteRef(context, remote, "refs/heads/main")
            : options.expectedMainCommit;
    const workTree = context.workTree ?? context.repoRoot;
    const catalog = inspectGeneratedCatalog(workTree);
    const metadata = catalog.metadata;
    const generatedAt = Reflect.get(metadata, "generatedAt");
    if (
        typeof generatedAt !== "string" ||
        !Number.isFinite(Date.parse(generatedAt))
    ) {
        throw new PublicationError(
            "source-metadata.json must contain a valid generatedAt timestamp.",
            {
                category: "verification",
                code: "INVALID_GENERATED_AT",
                exitCode: 7,
                phase: "catalog",
            }
        );
    }
    const temporaryRoot = resolve(
        workTree,
        "temp",
        "font-publish",
        "objects",
        calculateFingerprint({ expectedMainCommit, sourceCommit }).slice(0, 16)
    );
    assertSafeRepositoryPath(workTree, temporaryRoot);
    removeTree(temporaryRoot);
    mkdirSync(temporaryRoot, { recursive: true });
    const distributionIndex = resolve(temporaryRoot, "distribution.index");
    runGitCapture(context, ["read-tree", sourceCommit], {
        env: { GIT_INDEX_FILE: distributionIndex },
    });
    runGitCapture(
        context,
        [
            "add",
            "--force",
            "--",
            "fonts/woff2",
        ],
        {
            env: { GIT_INDEX_FILE: distributionIndex },
        }
    );
    const distributionTree = runGitCapture(context, ["write-tree"], {
        env: { GIT_INDEX_FILE: distributionIndex },
    });
    const distributionPaths = runGitCapture(context, [
        "ls-tree",
        "-r",
        "--name-only",
        distributionTree,
    ])
        .split(/\r?\n/u)
        .filter(Boolean);
    const forbiddenPath = distributionPaths.find(
        (path) =>
            path === "fonts/original" ||
            path.startsWith("fonts/original/") ||
            path === "node_modules" ||
            path.startsWith("node_modules/") ||
            path === "temp" ||
            path.startsWith("temp/") ||
            /^\.env(?:\.|$)/u.test(path)
    );
    if (forbiddenPath !== undefined) {
        throw new PublicationError(
            `The distribution snapshot contains a prohibited local path: ${forbiddenPath}`,
            {
                category: "verification",
                code: "PROHIBITED_DISTRIBUTION_PATH",
                exitCode: 7,
                phase: "snapshot",
            }
        );
    }
    const fontTree = runGitCapture(context, [
        "rev-parse",
        `${distributionTree}:fonts/woff2`,
    ]);
    const stagedOutput = runGitCapture(
        context,
        [
            "ls-files",
            "--stage",
            "--",
            "fonts/woff2",
        ],
        { env: { GIT_INDEX_FILE: distributionIndex } }
    );
    const stagedObjects = parseStagedObjects(stagedOutput, workTree);
    const catalogPaths = new Set(catalog.files);
    const stagedPaths = new Set(stagedObjects.map((entry) => entry.path));
    if (
        catalogPaths.size !== stagedPaths.size ||
        [...catalogPaths].some((path) => !stagedPaths.has(path))
    ) {
        throw new PublicationError(
            "The temporary distribution index does not match the catalog.",
            {
                category: "verification",
                code: "DISTRIBUTION_TREE_MISMATCH",
                exitCode: 7,
                phase: "snapshot",
            }
        );
    }
    const partitioned = partitionStagedObjects(
        stagedObjects,
        options.chunkTargetBytes === undefined
            ? {}
            : { targetBytes: options.chunkTargetBytes }
    );
    const chunks = partitioned.map((chunk) => {
        const indexFile = resolve(
            temporaryRoot,
            `chunk-${String(chunk.number).padStart(4, "0")}.index`
        );
        const treeId = createTreeFromEntries(context, indexFile, chunk.entries);
        const commitId = createParentlessCommit(
            context,
            treeId,
            `Seed Nerd Fonts catalog chunk ${chunk.number}/${partitioned.length}\n\nSource-Commit: ${sourceCommit}\nFont-Tree: ${fontTree}`,
            generatedAt
        );
        const measuredPackBytes =
            options.measurePackBytes === false
                ? null
                : measureSeedPack(
                      context,
                      temporaryRoot,
                      commitId,
                      chunk.number
                  );
        if (
            measuredPackBytes !== null &&
            measuredPackBytes > MAX_ESTIMATED_PACK_BYTES
        ) {
            throw new PublicationError(
                `Measured seed pack ${String(chunk.number)} is ${String(measuredPackBytes)} bytes, above the ${String(MAX_ESTIMATED_PACK_BYTES)}-byte safety limit. Reduce the chunk target and create a new plan.`,
                {
                    category: "verification",
                    code: "MEASURED_PACK_TOO_LARGE",
                    exitCode: 7,
                    phase: "chunking",
                }
            );
        }
        return {
            bytes: chunk.bytes,
            commitId,
            estimatedPackBytes: chunk.estimatedPackBytes,
            measuredPackBytes,
            number: chunk.number,
            objectCount: chunk.objectCount,
            objects: chunk.entries.map((entry) => ({
                mode: entry.mode,
                objectId: entry.objectId,
                path: entry.path,
                size: entry.size,
            })),
            paths: chunk.paths,
            treeId,
        };
    });
    const artifactIdentity = {
        catalog: {
            fontCount: catalog.fontCount,
            fontTree,
            indexCount: catalog.indexCount,
            indexSha256: catalog.indexSha256,
            metadataSha256: catalog.metadataSha256,
            planFingerprint: Reflect.get(metadata, "planFingerprint"),
            totalBytes: catalog.totalBytes,
            upstreamCommit: Reflect.get(metadata, "commitSha"),
            upstreamManifestSha256: Reflect.get(metadata, "manifestSha256"),
            upstreamRef: Reflect.get(metadata, "upstreamRef"),
            upstreamRepository: Reflect.get(metadata, "upstreamRepo"),
        },
        distributionTree,
        expectedMainCommit,
        remoteUrl,
        repository,
        schemaVersion: PUBLISH_SCHEMA_VERSION,
        sourceBranch,
        sourceCommit,
        sourceTree,
    };
    const artifactFingerprint = calculateArtifactFingerprint(artifactIdentity);
    const commitIdentity = {
        date: generatedAt,
        email: "20943337+Nick2bad4u@users.noreply.github.com",
        name: "nerd-fonts-woff2 publisher",
    };
    const finalCommitMessage = `Publish rolling Nerd Fonts catalog ${String(Reflect.get(metadata, "upstreamRef"))}\n\nSource-Commit: ${sourceCommit}\nUpstream-Commit: ${String(Reflect.get(metadata, "commitSha"))}\nUpstream-Plan-Fingerprint: ${String(Reflect.get(metadata, "planFingerprint"))}\nFont-Tree: ${fontTree}\nPublication-Artifact-Fingerprint: ${artifactFingerprint}`;
    const finalCommit = createParentlessCommit(
        context,
        distributionTree,
        finalCommitMessage,
        generatedAt
    );
    const finalCommitBody = runGitCapture(context, [
        "cat-file",
        "commit",
        finalCommit,
    ]);
    if (/^parent /mu.test(finalCommitBody)) {
        throw new PublicationError(
            "The distribution commit unexpectedly has a parent.",
            {
                category: "verification",
                code: "FINAL_COMMIT_NOT_ORPHAN",
                exitCode: 7,
                phase: "snapshot",
            }
        );
    }
    const payload = {
        artifactFingerprint,
        catalog: artifactIdentity.catalog,
        chunks: chunks.map((chunk) => ({
            ...chunk,
            ref: `refs/heads/upload/font-catalog/${artifactFingerprint}/chunk-${String(chunk.number).padStart(4, "0")}`,
        })),
        createdFromGeneratedAt: generatedAt,
        commitIdentity,
        distributionTree,
        expectedMainCommit,
        finalCommit,
        finalCommitMessage,
        finalRef: `refs/heads/upload/font-catalog/${artifactFingerprint}/final`,
        remote,
        remoteUrl,
        repository,
        schemaVersion: PUBLISH_SCHEMA_VERSION,
        sourceBranch,
        sourceCommit,
        sourceTree,
        transactionNonce: artifactFingerprint.slice(0, 24),
    };
    return {
        ...payload,
        planFingerprint: calculateFingerprint({
            kind: "rolling-font-publication-plan",
            value: payload,
        }),
        status:
            expectedMainCommit === finalCommit ? "already-current" : "planned",
        temporaryRoot,
    };
}

/**
 * @param {string} lockFile
 * @param {string} target
 * @param {{ breakStaleLock?: boolean }} [options]
 */
export async function acquirePublishLock(lockFile, target, options = {}) {
    mkdirSync(dirname(lockFile), { recursive: true });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        let descriptor;
        try {
            descriptor = openSync(lockFile, "wx", 0o600);
        } catch (error) {
            if (
                !(error instanceof Error) ||
                Reflect.get(error, "code") !== "EEXIST"
            ) {
                throw error;
            }
            let existing;
            try {
                existing = readJsonFile(lockFile);
            } catch (readError) {
                const ageMs = Date.now() - statSync(lockFile).mtimeMs;
                if (
                    options.breakStaleLock !== true ||
                    ageMs < LOCK_STALE_AFTER_MS
                ) {
                    throw new PublicationError(
                        `Publication lock is unreadable${
                            ageMs < LOCK_STALE_AFTER_MS
                                ? " and is too recent to break"
                                : "; use --break-stale-lock after verifying no publisher is active"
                        }: ${lockFile}`,
                        {
                            category: "repository",
                            cause: readError,
                            code: "PUBLISH_LOCKED",
                            exitCode: 3,
                            phase: "lock",
                        }
                    );
                }
                removeTree(lockFile);
                continue;
            }
            const pid = Reflect.get(Object(existing), "pid");
            const ownerHostname = Reflect.get(Object(existing), "hostname");
            const valid =
                Reflect.get(Object(existing), "schemaVersion") ===
                    LOCK_SCHEMA_VERSION &&
                typeof ownerHostname === "string" &&
                typeof Reflect.get(Object(existing), "nonce") === "string" &&
                Number.isSafeInteger(pid) &&
                Number(pid) >= 1 &&
                Number.isFinite(
                    Date.parse(
                        String(Reflect.get(Object(existing), "startedAt"))
                    )
                );
            const ageMs = Date.now() - statSync(lockFile).mtimeMs;
            if (!valid) {
                if (
                    options.breakStaleLock !== true ||
                    ageMs < LOCK_STALE_AFTER_MS
                ) {
                    throw new PublicationError(
                        `Publication lock has invalid ownership metadata: ${lockFile}`,
                        {
                            category: "repository",
                            code: "PUBLISH_LOCKED",
                            exitCode: 3,
                            phase: "lock",
                        }
                    );
                }
                removeTree(lockFile);
                continue;
            }
            if (ownerHostname !== hostname()) {
                if (
                    options.breakStaleLock !== true ||
                    ageMs < LOCK_STALE_AFTER_MS
                ) {
                    throw new PublicationError(
                        `Publication lock belongs to host ${String(ownerHostname)} and cannot be verified locally.`,
                        {
                            category: "repository",
                            code: "PUBLISH_LOCKED",
                            exitCode: 3,
                            phase: "lock",
                        }
                    );
                }
                removeTree(lockFile);
                continue;
            }
            let active = false;
            try {
                process.kill(Number(pid), 0);
                active = true;
            } catch (processError) {
                if (
                    processError instanceof Error &&
                    Reflect.get(processError, "code") !== "ESRCH"
                ) {
                    active = true;
                }
            }
            if (active) {
                throw new PublicationError(
                    `Another font publication is active (PID ${String(pid)}).`,
                    {
                        category: "repository",
                        code: "PUBLISH_LOCKED",
                        exitCode: 3,
                        phase: "lock",
                    }
                );
            }
            removeTree(lockFile);
            continue;
        }
        const owner = {
            hostname: hostname(),
            nonce: randomUUID(),
            pid: process.pid,
            schemaVersion: LOCK_SCHEMA_VERSION,
            startedAt: new Date().toISOString(),
            target,
        };
        try {
            writeFileSync(descriptor, `${JSON.stringify(owner, null, 2)}\n`);
            fsyncSync(descriptor);
        } catch (error) {
            closeSync(descriptor);
            removeTree(lockFile);
            throw error;
        }
        let released = false;
        return async () => {
            if (released) return;
            released = true;
            /** @type {unknown[]} */
            const failures = [];
            try {
                closeSync(descriptor);
            } catch (error) {
                failures.push(error);
            }
            try {
                const current = readJsonFile(lockFile);
                if (
                    current === null ||
                    typeof current !== "object" ||
                    Reflect.get(current, "nonce") !== owner.nonce ||
                    Reflect.get(current, "pid") !== owner.pid ||
                    Reflect.get(current, "hostname") !== owner.hostname
                ) {
                    throw new Error("Font publication lock ownership changed.");
                }
                rmSync(lockFile, { force: true });
            } catch (error) {
                failures.push(error);
            }
            if (failures.length > 0) {
                throw new AggregateError(
                    failures,
                    "Unable to release the font publication lock."
                );
            }
        };
    }
    throw new PublicationError("Unable to acquire the publication lock.", {
        category: "repository",
        code: "PUBLISH_LOCKED",
        exitCode: 3,
        phase: "lock",
    });
}

/** @param {number} milliseconds */
function delay(milliseconds) {
    return new Promise((resolvePromise) => {
        setTimeout(resolvePromise, milliseconds);
    });
}

/**
 * Build an explicit ref-scoped push that remains valid when the publication
 * context is a clone created with `--mirror`.
 *
 * @param {string} remote
 * @param {...string} argumentsList
 */
function scopedPushArguments(remote, ...argumentsList) {
    return [
        "-c",
        "remote.origin.mirror=false",
        "push",
        remote,
        ...argumentsList,
    ];
}

/**
 * @param {GitContext} context
 * @param {readonly string[]} argumentsList
 * @param {{ mode?: "interactive" | "json"; phase: string }} options
 */
async function runStreamingGit(context, argumentsList, options) {
    try {
        return await runCommand("git", argumentsList, {
            absoluteTimeoutMs: 2 * 60 * 60 * 1000,
            cwd: context.repoRoot,
            env: gitEnvironment(context),
            inactivityTimeoutMs: 10 * 60 * 1000,
            mode: options.mode ?? "interactive",
        });
    } catch (error) {
        throw new PublicationError(
            `${options.phase} failed: ${
                error instanceof Error ? error.message : String(error)
            }`,
            {
                category: "upload",
                cause: error,
                code: "GIT_PUSH_FAILED",
                exitCode: 6,
                phase: options.phase,
            }
        );
    }
}

/** @param {string} url @param {typeof fetch} fetchImplementation */
async function fetchWithTimeout(url, fetchImplementation) {
    const response = await fetchImplementation(url, {
        headers: { "User-Agent": "nerd-fonts-woff2-publisher" },
        redirect: "follow",
        signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
        throw new Error(`${url} returned HTTP ${response.status}.`);
    }
    return response;
}

/**
 * @param {Record<string, unknown>} plan
 * @param {typeof fetch} fetchImplementation
 */
export async function verifyPublishedSnapshot(
    plan,
    fetchImplementation = fetch
) {
    const repository = String(plan["repository"]);
    const finalCommit = String(plan["finalCommit"]);
    const base = `https://raw.githubusercontent.com/${repository}/${finalCommit}`;
    const metadataResponse = await fetchWithTimeout(
        `${base}/fonts/woff2/source-metadata.json`,
        fetchImplementation
    );
    const catalog = /** @type {Record<string, unknown>} */ (plan["catalog"]);
    const metadataBytes = Buffer.from(await metadataResponse.arrayBuffer());
    if (
        createHash("sha256").update(metadataBytes).digest("hex") !==
        catalog["metadataSha256"]
    ) {
        throw new Error(
            "Published provenance SHA-256 does not match the plan."
        );
    }
    const metadata = /** @type {Record<string, unknown>} */ (
        JSON.parse(metadataBytes.toString("utf8"))
    );
    if (metadata["planFingerprint"] !== catalog["planFingerprint"]) {
        throw new Error(
            "Published provenance does not match the reviewed catalog."
        );
    }
    const indexResponse = await fetchWithTimeout(
        `${base}/fonts/woff2/index.json`,
        fetchImplementation
    );
    const indexBytes = Buffer.from(await indexResponse.arrayBuffer());
    if (
        createHash("sha256").update(indexBytes).digest("hex") !==
        catalog["indexSha256"]
    ) {
        throw new Error("Published index SHA-256 does not match the plan.");
    }
    const index = JSON.parse(indexBytes.toString("utf8"));
    if (!Array.isArray(index) || index.length !== catalog["indexCount"]) {
        throw new Error(
            "Published index count does not match the reviewed catalog."
        );
    }
    const chunks = /** @type {Record<string, unknown>[]} */ (plan["chunks"]);
    const paths = chunks
        .flatMap((chunk) => /** @type {string[]} */ (chunk["paths"]))
        .filter((path) => path.endsWith(".woff2"));
    const samples = [
        paths[0],
        paths[Math.floor(paths.length / 2)],
        paths.at(-1),
    ].filter(
        (path, indexValue, array) =>
            path !== undefined && array.indexOf(path) === indexValue
    );
    for (const path of samples) {
        const response = await fetchWithTimeout(
            `${base}/${String(path)}`,
            fetchImplementation
        );
        const contents = Buffer.from(await response.arrayBuffer());
        if (contents.subarray(0, 4).toString("ascii") !== "wOF2") {
            throw new Error(
                `Published font has an invalid WOFF2 signature: ${String(path)}`
            );
        }
    }
    return { indexCount: index.length, sampleCount: samples.length };
}

/**
 * @param {GitContext} context
 * @param {string} repository
 * @param {string} endpoint
 * @param {Record<string, unknown>} body
 * @param {string} requestFile
 */
async function runGitHubApi(
    context,
    repository,
    endpoint,
    body,
    requestFile
) {
    await atomicWriteJson(requestFile, body);
    /** @type {unknown} */
    let lastError;
    try {
        for (let attempt = 0; attempt < 4; attempt += 1) {
            try {
                const result = await runCommand(
                    "gh",
                    [
                        "api",
                        `repos/${repository}/${endpoint}`,
                        "--method",
                        "POST",
                        "--input",
                        requestFile,
                        "--header",
                        "Accept: application/vnd.github+json",
                        "--header",
                        "X-GitHub-Api-Version: 2026-03-10",
                    ],
                    {
                        absoluteTimeoutMs: 2 * 60 * 1_000,
                        cwd: context.repoRoot,
                        env: githubCliEnvironment(),
                        maxTailBytes: 16 * 1024 * 1024,
                        mode: "capture",
                    }
                );
                return /** @type {Record<string, unknown>} */ (
                    JSON.parse(result.stdout)
                );
            } catch (error) {
                lastError = error;
                const diagnostic =
                    error instanceof Error
                        ? `${error.message}\n${String(Reflect.get(error, "stderr") ?? "")}`
                        : String(error);
                if (
                    attempt >= 3 ||
                    !/(?:HTTP\s+5\d\d|server error)/iu.test(diagnostic)
                ) {
                    break;
                }
                await delay(500 * 2 ** attempt + randomInt(0, 251));
            }
        }
        throw new PublicationError(
            `GitHub Git database request failed for ${endpoint}: ${
                lastError instanceof Error
                    ? lastError.message
                    : String(lastError)
            }`,
            {
                category: "network",
                cause: lastError,
                code: "GITHUB_OBJECT_STAGE_FAILED",
                exitCode: 5,
                phase: "stage-final",
            }
        );
    } finally {
        rmSync(requestFile, { force: true });
    }
}

/**
 * Materialize the reviewed distribution tree and root commit from Git objects
 * already made reachable by `source` and the chunk refs. The temporary final
 * ref lets the subsequent Git push update `main` with an atomic lease without
 * repacking every WOFF2 blob from unrelated parentless chunk commits.
 *
 * @param {Record<string, unknown>} plan
 * @param {GitContext} context
 * @param {string} stateRoot
 */
export async function stageFinalCommitOnGitHub(plan, context, stateRoot) {
    const repository = String(plan["repository"]);
    const finalCommit = String(plan["finalCommit"]);
    const finalRef = String(plan["finalRef"]);
    const objects = /** @type {Record<string, unknown>[]} */ (
        /** @type {Record<string, unknown>[]} */ (plan["chunks"])
            .flatMap((chunk) =>
                /** @type {Record<string, unknown>[]} */ (chunk["objects"])
            )
            .map((entry) => ({
                mode: String(entry["mode"]),
                path: String(entry["path"]),
                sha: String(entry["objectId"]),
                type: "blob",
            }))
    );
    const treeResponse = await runGitHubApi(
        context,
        repository,
        "git/trees",
        {
            base_tree: String(plan["sourceTree"]),
            tree: objects,
        },
        resolve(stateRoot, "github-tree-request.json")
    );
    if (treeResponse["sha"] !== plan["distributionTree"]) {
        throw new PublicationError(
            "GitHub did not reproduce the reviewed distribution tree.",
            {
                category: "verification",
                code: "GITHUB_TREE_MISMATCH",
                exitCode: 7,
                phase: "stage-final",
            }
        );
    }
    const commitIdentity = /** @type {Record<string, unknown>} */ (
        plan["commitIdentity"]
    );
    const commitResponse = await runGitHubApi(
        context,
        repository,
        "git/commits",
        {
            author: commitIdentity,
            committer: commitIdentity,
            message: String(plan["finalCommitMessage"]),
            parents: [],
            tree: String(plan["distributionTree"]),
        },
        resolve(stateRoot, "github-commit-request.json")
    );
    if (commitResponse["sha"] !== finalCommit) {
        throw new PublicationError(
            `GitHub created ${String(commitResponse["sha"])} instead of the reviewed root commit ${finalCommit}.`,
            {
                category: "verification",
                code: "GITHUB_COMMIT_MISMATCH",
                exitCode: 7,
                phase: "stage-final",
            }
        );
    }
    try {
        await runGitHubApi(
            context,
            repository,
            "git/refs",
            { ref: finalRef, sha: finalCommit },
            resolve(stateRoot, "github-ref-request.json")
        );
    } catch (error) {
        if (
            resolveRemoteRef(
                context,
                String(plan["remote"]),
                finalRef
            ) !== finalCommit
        ) {
            throw error;
        }
    }
}

/** @param {unknown} error */
function isMissingRemoteGitObjectError(error) {
    if (
        !(error instanceof PublicationError) ||
        error.code !== "GITHUB_OBJECT_STAGE_FAILED"
    ) {
        return false;
    }
    const cause = error.cause;
    const diagnostic =
        cause instanceof Error
            ? `${cause.message}\n${String(Reflect.get(cause, "stderr") ?? "")}`
            : String(cause);
    return /(?:HTTP\s+422|unprocessable)/iu.test(diagnostic) &&
        /(?:object|sha|tree)/iu.test(diagnostic);
}

/**
 * @param {Record<string, unknown>} plan
 * @param {{
 *     context: GitContext;
 *     breakStaleLock?: boolean;
 *     fetchImplementation?: typeof fetch;
 *     mode?: "interactive" | "json";
 *     onProgress?: (message: string) => void;
 *     onWarning?: (message: string) => void;
 *     preferExistingObjects?: boolean;
 *     pushDelayMs?: number;
 *     sleep?: (milliseconds: number) => Promise<void>;
 *     stageFinalCommit?: (details: {
 *         context: GitContext;
 *         finalCommit: string;
 *         finalRef: string;
 *         plan: Record<string, unknown>;
 *         stateRoot: string;
 *     }) => Promise<void>;
 *     verifyRemote?: boolean;
 * }} options
 */
export async function publishPublicationPlan(plan, options) {
    if (plan["schemaVersion"] !== PUBLISH_SCHEMA_VERSION) {
        throw new PublicationError("Unsupported publication plan schema.", {
            category: "usage",
            code: "INVALID_PLAN_SCHEMA",
            exitCode: 2,
            phase: "validate",
        });
    }
    const context = options.context;
    const workTree = context.workTree ?? context.repoRoot;
    assertRepositoryIdentity(workTree);
    const planFingerprint = String(plan["planFingerprint"]);
    const stateRoot = resolve(
        workTree,
        "temp",
        "font-publish",
        planFingerprint
    );
    const stateFile = resolve(stateRoot, "state.json");
    const lockFile = resolve(workTree, "temp", "font-publish", "publish.lock");
    assertSafeRepositoryPath(workTree, stateRoot);
    const releaseLock = await acquirePublishLock(lockFile, planFingerprint, {
        breakStaleLock: options.breakStaleLock ?? false,
    });
    const progress = options.onProgress ?? (() => {});
    const warning = options.onWarning ?? (() => {});
    const sleep = options.sleep ?? delay;
    const pushDelayMs = options.pushDelayMs ?? DEFAULT_PUSH_DELAY_MS;
    let mainInstalled = false;
    /** @type {unknown} */
    let primaryFailure;
    try {
        mkdirSync(stateRoot, { recursive: true });
        /** @type {Record<string, unknown>} */
        const state = existsSync(stateFile)
            ? /** @type {Record<string, unknown>} */ (readJsonFile(stateFile))
            : {
                  mainInstalled: false,
                  phase: "initialized",
                  planFingerprint,
                  schemaVersion: PUBLISH_SCHEMA_VERSION,
                  uploadedRefs: [],
              };
        if (state["planFingerprint"] !== planFingerprint) {
            throw new PublicationError("Journal belongs to another plan.", {
                category: "repository",
                code: "JOURNAL_MISMATCH",
                exitCode: 3,
                phase: "recovery",
            });
        }
        mainInstalled = state["mainInstalled"] === true;
        const remote = String(plan["remote"]);
        const expectedMainCommit =
            typeof plan["expectedMainCommit"] === "string"
                ? String(plan["expectedMainCommit"])
                : null;
        const currentMain = resolveRemoteRef(
            context,
            remote,
            "refs/heads/main"
        );
        const finalCommit = String(plan["finalCommit"]);
        if (currentMain === finalCommit) {
            mainInstalled = true;
            state["mainInstalled"] = true;
            state["phase"] = "main-installed";
            await atomicWriteJson(stateFile, state);
        } else if (currentMain !== expectedMainCommit) {
            throw new PublicationError(
                `Remote main changed from ${String(expectedMainCommit)} to ${String(currentMain)}.`,
                {
                    category: "repository",
                    code: "LEASE_CONFLICT",
                    exitCode: 3,
                    phase: "lease",
                }
            );
        }

        const chunks = /** @type {Record<string, unknown>[]} */ (
            plan["chunks"]
        );
        const stageFinalCommit =
            options.stageFinalCommit ??
            (async () => stageFinalCommitOnGitHub(plan, context, stateRoot));
        const finalRef = String(plan["finalRef"]);
        let finalStagedCommit = resolveRemoteRef(context, remote, finalRef);
        if (
            finalStagedCommit !== null &&
            finalStagedCommit !== finalCommit
        ) {
            throw new PublicationError(
                `Remote final staging ref has unexpected ownership: ${finalRef}`,
                {
                    category: "repository",
                    code: "FINAL_REF_CONFLICT",
                    exitCode: 3,
                    phase: "stage-final",
                }
            );
        }
        if (finalStagedCommit === finalCommit) {
            progress("Reviewed root commit is already staged remotely.");
        }
        if (
            !mainInstalled &&
            finalStagedCommit === null &&
            (options.preferExistingObjects ?? true)
        ) {
            progress(
                "Checking whether existing remote Git objects can reproduce the reviewed root commit."
            );
            try {
                await stageFinalCommit({
                    context,
                    finalCommit,
                    finalRef,
                    plan,
                    stateRoot,
                });
                finalStagedCommit = resolveRemoteRef(
                    context,
                    remote,
                    finalRef
                );
            } catch (error) {
                if (!isMissingRemoteGitObjectError(error)) throw error;
                progress(
                    "The reviewed tree contains Git objects not yet reachable remotely; seed upload is required."
                );
            }
        }
        if (!mainInstalled && finalStagedCommit === null) {
            let previousPushAt = 0;
            for (const chunk of chunks) {
                const ref = String(chunk["ref"]);
                const commitId = String(chunk["commitId"]);
                const remoteCommit = resolveRemoteRef(context, remote, ref);
                if (remoteCommit === commitId) {
                    progress(
                        `Seed ${String(chunk["number"])} already uploaded.`
                    );
                    continue;
                }
                if (remoteCommit !== null) {
                    throw new PublicationError(
                        `Remote seed ref has unexpected ownership: ${ref}`,
                        {
                            category: "repository",
                            code: "SEED_REF_CONFLICT",
                            exitCode: 3,
                            phase: "seed",
                        }
                    );
                }
                const elapsed = Date.now() - previousPushAt;
                if (previousPushAt > 0 && elapsed < pushDelayMs) {
                    await sleep(pushDelayMs - elapsed);
                }
                progress(
                    `Uploading seed ${String(chunk["number"])}/${chunks.length} (${String(chunk["estimatedPackBytes"])} estimated bytes).`
                );
                await runStreamingGit(
                    context,
                    scopedPushArguments(remote, `${commitId}:${ref}`),
                    {
                        mode: options.mode ?? "interactive",
                        phase: `seed-${String(chunk["number"])}`,
                    }
                );
                previousPushAt = Date.now();
                if (resolveRemoteRef(context, remote, ref) !== commitId) {
                    throw new PublicationError(
                        `Remote did not retain ${ref}.`,
                        {
                            category: "verification",
                            code: "SEED_VERIFY_FAILED",
                            exitCode: 7,
                            phase: "seed-verify",
                        }
                    );
                }
                const uploadedRefs = new Set(
                    Array.isArray(state["uploadedRefs"])
                        ? /** @type {string[]} */ (state["uploadedRefs"])
                        : []
                );
                uploadedRefs.add(ref);
                state["uploadedRefs"] = [...uploadedRefs];
                state["phase"] = "seeding";
                await atomicWriteJson(stateFile, state);
            }
        }

        if (!mainInstalled) {
            if (finalStagedCommit === null) {
                progress(
                    "Materializing the reviewed root commit from seeded Git objects."
                );
                await stageFinalCommit({
                    context,
                    finalCommit,
                    finalRef,
                    plan,
                    stateRoot,
                });
                finalStagedCommit = resolveRemoteRef(
                    context,
                    remote,
                    finalRef
                );
            }
            if (finalStagedCommit !== finalCommit) {
                throw new PublicationError(
                    "Remote final staging ref does not match the reviewed root commit.",
                    {
                        category: "verification",
                        code: "FINAL_REF_VERIFY_FAILED",
                        exitCode: 7,
                        phase: "stage-final",
                    }
                );
            }
            const uploadedRefs = new Set(
                Array.isArray(state["uploadedRefs"])
                    ? /** @type {string[]} */ (state["uploadedRefs"])
                    : []
            );
            uploadedRefs.add(finalRef);
            state["uploadedRefs"] = [...uploadedRefs];
            state["phase"] = "final-staged";
            await atomicWriteJson(stateFile, state);
        }

        if (!mainInstalled) {
            if (
                resolveRemoteRef(context, remote, "refs/heads/main") !==
                expectedMainCommit
            ) {
                throw new PublicationError(
                    "Remote main changed during upload.",
                    {
                        category: "repository",
                        code: "LEASE_CONFLICT",
                        exitCode: 3,
                        phase: "promote",
                    }
                );
            }
            progress("Installing the reviewed orphan snapshot on main.");
            await runStreamingGit(
                context,
                scopedPushArguments(
                    remote,
                    `${finalCommit}:refs/heads/main`,
                    `--force-with-lease=refs/heads/main:${expectedMainCommit ?? ""}`
                ),
                { mode: options.mode ?? "interactive", phase: "promote-main" }
            );
            if (
                resolveRemoteRef(context, remote, "refs/heads/main") !==
                finalCommit
            ) {
                throw new PublicationError(
                    "Remote main did not reach the reviewed commit.",
                    {
                        category: "verification",
                        code: "MAIN_VERIFY_FAILED",
                        exitCode: 7,
                        phase: "promote-verify",
                    }
                );
            }
            mainInstalled = true;
            state["mainInstalled"] = true;
            state["phase"] = "main-installed";
            await atomicWriteJson(stateFile, state);
        }

        if (options.verifyRemote ?? true) {
            progress("Verifying raw GitHub metadata, index, and font samples.");
            try {
                state["remoteVerification"] = await verifyPublishedSnapshot(
                    plan,
                    options.fetchImplementation
                );
            } catch (error) {
                throw new PublicationError(
                    `Published snapshot verification failed: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                    {
                        category: "verification",
                        cause: error,
                        cleanupPending: true,
                        code: "RAW_VERIFY_FAILED",
                        committed: true,
                        exitCode: 7,
                        phase: "raw-verify",
                    }
                );
            }
            state["phase"] = "raw-verified";
            await atomicWriteJson(stateFile, state);
            try {
                const response = await fetchWithTimeout(
                    `https://cdn.jsdelivr.net/gh/${String(plan["repository"])}@main/fonts/woff2/source-metadata.json`,
                    options.fetchImplementation ?? fetch
                );
                const metadata = /** @type {Record<string, unknown>} */ (
                    await response.json()
                );
                const catalog = /** @type {Record<string, unknown>} */ (
                    plan["catalog"]
                );
                if (
                    metadata["planFingerprint"] !== catalog["planFingerprint"]
                ) {
                    warning(
                        "jsDelivr still serves an older @main snapshot; branch caches may take approximately 12 hours to refresh."
                    );
                }
            } catch (error) {
                warning(
                    `Best-effort jsDelivr verification failed: ${
                        error instanceof Error ? error.message : String(error)
                    }`
                );
            }
        }

        const temporaryBranches = [
            ...chunks.map((chunk) => ({
                commitId: String(chunk["commitId"]),
                ref: String(chunk["ref"]),
            })),
            { commitId: finalCommit, ref: finalRef },
        ].flatMap((temporaryRef) => {
            const ref = temporaryRef.ref;
            const expectedCommit = temporaryRef.commitId;
            const remoteCommit = resolveRemoteRef(context, remote, ref);
            if (remoteCommit === null) return [];
            if (remoteCommit !== expectedCommit) {
                throw new PublicationError(
                    `Refusing to delete a temporary ref owned by another transaction: ${ref}`,
                    {
                        category: "repository",
                        cleanupPending: true,
                        code: "SEED_REF_OWNERSHIP_CHANGED",
                        committed: true,
                        exitCode: 3,
                        phase: "seed-cleanup",
                    }
                );
            }
            return [ref.replace(/^refs\/heads\//u, "")];
        });
        if (temporaryBranches.length > 0) {
            progress("Removing temporary remote publication branches.");
            try {
                await runStreamingGit(
                    context,
                    scopedPushArguments(
                        remote,
                        "--delete",
                        ...temporaryBranches
                    ),
                    {
                        mode: options.mode ?? "interactive",
                        phase: "seed-cleanup",
                    }
                );
            } catch (error) {
                throw new PublicationError(
                    "The catalog is published, but seed cleanup failed.",
                    {
                        category: "cleanup",
                        cause: error,
                        cleanupPending: true,
                        code: "SEED_CLEANUP_FAILED",
                        committed: true,
                        exitCode: 9,
                        phase: "seed-cleanup",
                    }
                );
            }
        }
        state["phase"] = "complete";
        await atomicWriteJson(stateFile, state);
        removeTree(stateRoot);
        if (typeof plan["temporaryRoot"] === "string") {
            removeTree(String(plan["temporaryRoot"]));
        }
        return { finalCommit, planFingerprint, status: "published" };
    } catch (error) {
        primaryFailure = error;
        if (mainInstalled && error instanceof Error) {
            Reflect.set(error, "committed", true);
            Reflect.set(error, "cleanupPending", true);
        }
        throw error;
    } finally {
        try {
            await releaseLock();
        } catch (lockError) {
            const wrapped = new PublicationError(
                "Unable to release the font publication lock.",
                {
                    category: "cleanup",
                    cause: lockError,
                    cleanupPending: true,
                    code: "LOCK_RELEASE_FAILED",
                    committed: mainInstalled,
                    exitCode: 9,
                    phase: "lock-release",
                }
            );
            if (primaryFailure !== undefined) {
                throw new AggregateError(
                    [primaryFailure, wrapped],
                    "Font publication and lock release both failed."
                );
            }
            throw wrapped;
        }
    }
}

/** @param {string} repoRoot @param {Record<string, unknown>} plan */
export async function savePublicationPlan(repoRoot, plan) {
    const planRoot = resolve(repoRoot, "temp", "font-publish", "plans");
    const file = resolve(planRoot, `${String(plan["planFingerprint"])}.json`);
    const latest = resolve(planRoot, "latest.json");
    await atomicWriteJson(file, plan);
    await atomicWriteJson(latest, plan);
    return file;
}

/** @param {string} repoRoot */
export function loadLatestPublicationPlan(repoRoot) {
    const path = resolve(
        repoRoot,
        "temp",
        "font-publish",
        "plans",
        "latest.json"
    );
    if (!existsSync(path)) {
        throw new PublicationError("No saved publication plan is available.", {
            category: "usage",
            code: "PLAN_MISSING",
            exitCode: 2,
            phase: "resume",
        });
    }
    return /** @type {Record<string, unknown>} */ (readJsonFile(path));
}
