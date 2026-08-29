import { createRequire } from "node:module";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    realpathSync,
    statfsSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
    CommandExecutionError,
    formatCommand,
    runCommand,
} from "./command-runner.mjs";
import {
    DEFAULT_CONVERSION_CONCURRENCY,
    DEFAULT_FONT_TIMEOUT_SECONDS,
    DEFAULT_TIMEOUT_RETRIES,
    MAX_TIMEOUT_RETRIES,
    calculateConversionDeadlineMs,
    createConversionPasses,
} from "./font-conversion-policy.mjs";
import {
    compareSemverTags,
    parseSemverTag,
    readLocalSourceMetadata,
    readMetadataFile,
} from "./nerd-fonts-release.mjs";
import { fetchReviewedReleaseIdentity } from "./release-identity.mjs";
import {
    assertLocalTransactionRoot,
    assertSafeRepositoryPath,
    atomicWriteJson,
    removeTree,
} from "./safe-filesystem.mjs";
import {
    ANSI,
    formatDuration,
    renderProgressBar,
    resolveColorEnabled,
    styleText,
} from "./terminal-output.mjs";
import {
    acquireUpdateLock,
    beginUpdateTransaction,
    commitUpdateTransaction,
    createTransactionPaths,
    installTransactionReadme,
    prepareReadmeRelease,
    recoverUpdateTransaction,
    verifyReadmeRelease,
} from "./update-transaction.mjs";

export { renderProgressBar } from "./terminal-output.mjs";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(moduleDirectory, "..");
const GENERATED_PATHS = [
    "README.md",
    "fonts/original",
    "fonts/woff2",
];

/**
 * @typedef {{
 *     allowDirty: boolean;
 *     apply: boolean;
 *     applyAlias: boolean;
 *     asJson: boolean;
 *     breakStaleLock: boolean;
 *     color: boolean | null;
 *     confirm: boolean;
 *     conversionConcurrency: number;
 *     downloadConcurrency: number;
 *     dryRun: boolean;
 *     failedOnly: boolean;
 *     forceRebuild: boolean;
 *     help: boolean;
 *     planFingerprint: string | null;
 *     timeoutSeconds: number;
 *     timeoutRetries: number;
 *     upstreamRef: string | null;
 *     verbose: boolean;
 * }} UpdateOptions
 */

/**
 * @typedef {{
 *     complete: (label: string) => void;
 *     detail: (message: string) => void;
 *     fail: (error: unknown) => void;
 *     start: (label: string) => void;
 * }} ProgressReporter
 */

/**
 * @param {string} value
 * @param {string} optionName
 * @param {number} minimum
 * @param {number} maximum
 */
function parseIntegerOption(value, optionName, minimum, maximum) {
    const integerPattern = minimum === 0 ? /^(?:0|[1-9]\d*)$/v : /^[1-9]\d*$/v;
    if (!integerPattern.test(value)) {
        throw new Error(
            `${optionName} must be an integer from ${minimum} through ${maximum}.`
        );
    }

    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
        throw new Error(
            `${optionName} must be an integer from ${minimum} through ${maximum}.`
        );
    }

    return parsed;
}

/**
 * @param {readonly string[]} argumentsList
 *
 * @returns {UpdateOptions}
 */
export function parseUpdateOptions(argumentsList) {
    /** @type {UpdateOptions} */
    const parsed = {
        allowDirty: false,
        apply: false,
        applyAlias: false,
        asJson: false,
        breakStaleLock: false,
        color: null,
        confirm: false,
        conversionConcurrency: DEFAULT_CONVERSION_CONCURRENCY,
        downloadConcurrency: 4,
        dryRun: false,
        failedOnly: false,
        forceRebuild: false,
        help: false,
        planFingerprint: null,
        timeoutRetries: DEFAULT_TIMEOUT_RETRIES,
        timeoutSeconds: DEFAULT_FONT_TIMEOUT_SECONDS,
        upstreamRef: null,
        verbose: false,
    };
    const seenScalarOptions = new Set();
    const flagOptions = new Set([
        "--allow-dirty",
        "--apply",
        "--break-stale-lock",
        "--color",
        "--confirm",
        "--convert",
        "--dry-run",
        "--failed-only",
        "--force-rebuild",
        "--help",
        "--json",
        "--no-color",
        "--verbose",
        "-h",
    ]);
    const scalarOptions = new Set([
        "--concurrency",
        "--download-concurrency",
        "--plan-fingerprint",
        "--ref",
        "--timeout",
        "--timeout-retries",
    ]);

    for (let index = 0; index < argumentsList.length; index += 1) {
        const rawArgument = argumentsList[index];
        if (rawArgument === undefined) continue;
        if (rawArgument === "--") {
            if (
                index === 0 &&
                process.env["npm_lifecycle_event"] === "fonts:update"
            ) {
                continue;
            }
            if (index !== argumentsList.length - 1) {
                throw new Error(
                    `Unexpected positional argument: ${String(argumentsList[index + 1])}`
                );
            }

            break;
        }

        const equalsIndex = rawArgument.indexOf("=");
        const argument =
            equalsIndex > 0 ? rawArgument.slice(0, equalsIndex) : rawArgument;
        let inlineValue =
            equalsIndex > 0 ? rawArgument.slice(equalsIndex + 1) : null;
        if (flagOptions.has(argument) && inlineValue !== null) {
            throw new Error(`${argument} does not accept a value.`);
        }

        if (argument === "--allow-dirty") {
            parsed.allowDirty = true;
            continue;
        }
        if (argument === "--apply") {
            parsed.apply = true;
            continue;
        }
        if (argument === "--break-stale-lock") {
            parsed.breakStaleLock = true;
            continue;
        }
        if (argument === "--confirm") {
            parsed.confirm = true;
            continue;
        }
        if (argument === "--color") {
            if (parsed.color === false) {
                throw new Error("--color and --no-color cannot be combined.");
            }
            parsed.color = true;
            continue;
        }
        if (argument === "--convert") {
            parsed.applyAlias = true;
            continue;
        }
        if (argument === "--dry-run") {
            parsed.dryRun = true;
            continue;
        }
        if (argument === "--force-rebuild") {
            parsed.forceRebuild = true;
            continue;
        }
        if (argument === "--failed-only") {
            parsed.failedOnly = true;
            continue;
        }
        if (argument === "--help" || argument === "-h") {
            parsed.help = true;
            continue;
        }
        if (argument === "--json") {
            parsed.asJson = true;
            continue;
        }
        if (argument === "--no-color") {
            if (parsed.color === true) {
                throw new Error("--color and --no-color cannot be combined.");
            }
            parsed.color = false;
            continue;
        }
        if (argument === "--verbose") {
            parsed.verbose = true;
            continue;
        }

        if (!scalarOptions.has(argument)) {
            throw new Error(`Unknown option: ${rawArgument}`);
        }
        if (seenScalarOptions.has(argument)) {
            throw new Error(`${argument} cannot be specified more than once.`);
        }
        seenScalarOptions.add(argument);
        if (inlineValue === null) {
            inlineValue = argumentsList[index + 1] ?? null;
            index += 1;
        }
        if (inlineValue === null || inlineValue.trim().length === 0) {
            throw new Error(`${argument} requires a non-empty value.`);
        }

        const value = inlineValue.trim();
        if (argument === "--concurrency") {
            parsed.conversionConcurrency = parseIntegerOption(
                value,
                argument,
                1,
                32
            );
        } else if (argument === "--download-concurrency") {
            parsed.downloadConcurrency = parseIntegerOption(
                value,
                argument,
                1,
                8
            );
        } else if (argument === "--plan-fingerprint") {
            parsed.planFingerprint = value.toLowerCase();
        } else if (argument === "--ref") {
            parsed.upstreamRef = value;
        } else if (argument === "--timeout-retries") {
            parsed.timeoutRetries = parseIntegerOption(
                value,
                argument,
                0,
                MAX_TIMEOUT_RETRIES
            );
        } else {
            parsed.timeoutSeconds = parseIntegerOption(
                value,
                argument,
                1,
                86_400
            );
        }
    }

    if (parsed.apply && parsed.applyAlias) {
        throw new Error("--apply and --convert cannot be combined.");
    }
    parsed.apply ||= parsed.applyAlias;
    if (
        parsed.upstreamRef !== null &&
        parseSemverTag(parsed.upstreamRef) === null
    ) {
        throw new Error("--ref must look like v1.2.3.");
    }
    if (
        parsed.planFingerprint !== null &&
        !/^[\da-f]{64}$/v.test(parsed.planFingerprint)
    ) {
        throw new Error("--plan-fingerprint must be a SHA-256 digest.");
    }
    if (parsed.apply && !parsed.dryRun && !parsed.confirm) {
        throw new Error(
            "Applying a font update requires --apply and --confirm."
        );
    }
    if (parsed.apply && !parsed.dryRun && parsed.planFingerprint === null) {
        throw new Error(
            "Applying a font update requires --plan-fingerprint from a reviewed plan."
        );
    }
    if (parsed.forceRebuild && !parsed.apply) {
        throw new Error("--force-rebuild requires --apply.");
    }
    if (parsed.failedOnly && !parsed.apply) {
        throw new Error("--failed-only requires --apply.");
    }
    if (parsed.failedOnly && parsed.forceRebuild) {
        throw new Error(
            "--failed-only and --force-rebuild cannot be combined."
        );
    }
    if (parsed.breakStaleLock && !parsed.apply) {
        throw new Error("--break-stale-lock requires --apply.");
    }

    return parsed;
}

/** @param {unknown} error */
function describeError(error) {
    return error instanceof Error ? error.message : String(error);
}

/**
 * @param {boolean} enabled
 * @param {number} totalStages
 * @param {boolean} [useColor]
 * @param {(message: string) => void} [write]
 * @param {() => number} [now]
 *
 * @returns {ProgressReporter}
 */
export function createProgressReporter(
    enabled,
    totalStages,
    useColor = false,
    write = (message) => process.stderr.write(message),
    now = Date.now
) {
    if (!Number.isInteger(totalStages) || totalStages < 1) {
        throw new Error("Progress requires at least one stage.");
    }
    const startedAt = now();
    let currentStage = 0;
    let stageStartedAt = startedAt;
    /** @param {number} timestamp */
    const elapsedPrefix = (timestamp) =>
        styleText(
            useColor,
            ANSI.dim,
            `[update +${formatDuration(timestamp - startedAt)}]`
        );

    return {
        complete(label) {
            if (!enabled) return;
            const timestamp = now();
            write(
                `${elapsedPrefix(timestamp)} ${styleText(
                    useColor,
                    ANSI.cyan,
                    renderProgressBar(currentStage, totalStages)
                )} ${styleText(useColor, ANSI.dim, `stage ${currentStage}/${totalStages}`)} ${styleText(
                    useColor,
                    [ANSI.bold, ANSI.green],
                    "DONE"
                )} ${styleText(useColor, ANSI.bold, label)} ${styleText(
                    useColor,
                    ANSI.dim,
                    `(${formatDuration(timestamp - stageStartedAt)})`
                )}\n`
            );
        },
        detail(message) {
            if (!enabled) return;
            const timestamp = now();
            write(
                `${elapsedPrefix(timestamp)} ${styleText(
                    useColor,
                    ANSI.cyan,
                    `[stage ${currentStage}/${totalStages}]`
                )} ${message}\n`
            );
        },
        fail(error) {
            if (!enabled) return;
            const timestamp = now();
            write(
                `${elapsedPrefix(timestamp)} ${styleText(
                    useColor,
                    ANSI.red,
                    renderProgressBar(
                        Math.max(0, currentStage - 1),
                        totalStages
                    )
                )} ${styleText(useColor, ANSI.dim, `stage ${currentStage}/${totalStages}`)} ${styleText(
                    useColor,
                    [ANSI.bold, ANSI.red],
                    "FAIL"
                )} ${describeError(error)}\n`
            );
        },
        start(label) {
            currentStage += 1;
            if (currentStage > totalStages) {
                throw new Error("Progress reported more stages than expected.");
            }
            if (!enabled) return;
            stageStartedAt = now();
            write(
                `${elapsedPrefix(stageStartedAt)} ${styleText(
                    useColor,
                    ANSI.cyan,
                    renderProgressBar(currentStage - 1, totalStages)
                )} ${styleText(useColor, ANSI.dim, `stage ${currentStage}/${totalStages}`)} ${styleText(
                    useColor,
                    [ANSI.bold, ANSI.magenta],
                    "START"
                )} ${styleText(useColor, ANSI.bold, label)}\n`
            );
        },
    };
}

export class UpdaterError extends Error {
    /**
     * @param {string} message
     * @param {{
     *     category: string;
     *     cause?: unknown;
     *     cleanupPending?: boolean;
     *     committed?: boolean;
     *     exitCode: number;
     *     phase: string;
     * }} details
     */
    constructor(message, details) {
        super(
            message,
            details.cause === undefined ? undefined : { cause: details.cause }
        );
        this.name = "UpdaterError";
        this.category = details.category;
        this.cleanupPending = details.cleanupPending ?? false;
        this.committed = details.committed ?? false;
        this.exitCode = details.exitCode;
        this.phase = details.phase;
    }
}

/**
 * @param {unknown} error
 * @param {string} category
 * @param {number} exitCode
 * @param {string} phase
 */
function categorize(error, category, exitCode, phase) {
    if (error instanceof UpdaterError) return error;
    return new UpdaterError(describeError(error), {
        category,
        cause: error,
        cleanupPending: Reflect.get(Object(error), "cleanupPending") === true,
        committed: Reflect.get(Object(error), "committed") === true,
        exitCode,
        phase,
    });
}

/**
 * Decide whether an installed release makes an apply unnecessary. This helper
 * is intentionally independent from planning so callers must invoke it only
 * after acquiring the update lock and re-reading canonical metadata.
 *
 * @param {string | null} currentRef
 * @param {string} targetRef
 * @param {boolean} forceRebuild
 *
 * @returns {"no-op" | "superseded" | null}
 */
export function determineInstalledRefOutcome(
    currentRef,
    targetRef,
    forceRebuild
) {
    if (currentRef === null) return null;
    const comparison = compareSemverTags(targetRef, currentRef);
    if (comparison < 0) {
        if (forceRebuild) {
            throw new Error(
                `--force-rebuild only permits rebuilding ${currentRef}; it cannot apply older ${targetRef}.`
            );
        }

        return "superseded";
    }
    if (comparison === 0 && !forceRebuild) return "no-op";
    return null;
}

/**
 * @template T
 *
 * @param {ProgressReporter} progress
 * @param {string} label
 * @param {() => Promise<T> | T} work
 * @param {string | ((result: T) => string)} [successLabel]
 */
async function runProgressStage(progress, label, work, successLabel = label) {
    progress.start(label);
    try {
        const result = await work();
        progress.complete(
            typeof successLabel === "function"
                ? successLabel(result)
                : successLabel
        );
        return result;
    } catch (error) {
        progress.fail(error);
        throw error;
    }
}

/** @param {string} directory */
function measureDirectoryBytes(directory) {
    if (!existsSync(directory)) return 0;
    let total = 0;
    const queue = [directory];
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const current = queue[cursor];
        if (current === undefined) continue;
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            const absolutePath = join(current, entry.name);
            if (entry.isDirectory()) queue.push(absolutePath);
            else if (entry.isFile()) total += statSync(absolutePath).size;
        }
    }
    return total;
}

/** @param {string} repoRoot @param {number} compressedBytes */
function inspectDiskCapacity(repoRoot, compressedBytes) {
    const currentAssetBytes =
        measureDirectoryBytes(resolve(repoRoot, "fonts", "original")) +
        measureDirectoryBytes(resolve(repoRoot, "fonts", "woff2"));
    const estimatedWorkingBytes = Math.ceil(
        Math.max(currentAssetBytes * 1.25, compressedBytes * 20)
    );
    const fileSystem = statfsSync(repoRoot, { bigint: true });
    const availableBytes = Number(fileSystem.bavail * fileSystem.bsize);
    return {
        availableBytes,
        currentAssetBytes,
        estimatedWorkingBytes,
        ready: availableBytes >= estimatedWorkingBytes,
    };
}

/** @param {string} repoRoot */
async function verifyRepositoryRoot(repoRoot) {
    assertLocalTransactionRoot(repoRoot);
    const checked = await runCommand("git", ["rev-parse", "--show-toplevel"], {
        absoluteTimeoutMs: 30_000,
        cwd: repoRoot,
        mode: "capture",
    });
    const gitRoot = realpathSync.native(checked.stdout.trim());
    const expectedRoot = realpathSync.native(repoRoot);
    const equal =
        process.platform === "win32"
            ? gitRoot.toLowerCase() === expectedRoot.toLowerCase()
            : gitRoot === expectedRoot;
    if (!equal) {
        throw new Error(
            `Updater repository root mismatch: expected ${expectedRoot}, Git reported ${gitRoot}.`
        );
    }
    return expectedRoot;
}

/** @param {string} repoRoot */
async function inspectPrerequisites(repoRoot) {
    /** @param {string} command @param {readonly string[]} argumentsList */
    const probe = async (command, argumentsList) => {
        try {
            const result = await runCommand(command, argumentsList, {
                absoluteTimeoutMs: 30_000,
                cwd: repoRoot,
                mode: "capture",
            });
            return { ready: true, value: result.stdout.trim() };
        } catch (error) {
            return { error: describeError(error), ready: false, value: null };
        }
    };
    const [git, tar] = await Promise.all([
        probe("git", ["--version"]),
        probe("tar", ["--version"]),
    ]);
    let converter;
    try {
        const require = createRequire(import.meta.url);
        converter = { ready: true, value: require.resolve("ttf2woff2") };
    } catch (error) {
        converter = {
            error: describeError(error),
            ready: false,
            value: null,
        };
    }
    return {
        git,
        ready: git.ready && tar.ready && converter.ready,
        tar,
        ttf2woff2: converter,
    };
}

/** @param {string} directory */
function findFirstFont(directory) {
    if (!existsSync(directory)) return null;
    const queue = [directory];
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const current = queue[cursor];
        if (current === undefined) continue;
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            const absolutePath = join(current, entry.name);
            if (entry.isDirectory()) queue.push(absolutePath);
            else if (entry.isFile() && /\.(?:otf|ttf)$/iv.test(entry.name)) {
                return absolutePath;
            }
        }
    }
    return null;
}

/** @param {string} repoRoot */
async function smokeTestConverter(repoRoot) {
    const sourceFont = findFirstFont(resolve(repoRoot, "fonts", "original"));
    if (sourceFont === null) {
        throw new Error(
            "No canonical source font is available for converter smoke testing."
        );
    }
    const require = createRequire(import.meta.url);
    const modulePath = require.resolve("ttf2woff2");
    const converterModule = await import(pathToFileURL(modulePath).href);
    const converter = Reflect.get(converterModule, "default");
    if (typeof converter !== "function") {
        throw new Error(
            "ttf2woff2 does not expose its expected default function."
        );
    }
    const output = Reflect.apply(converter, undefined, [
        readFileSync(sourceFont),
    ]);
    if (
        !Buffer.isBuffer(output) ||
        output.length < 4 ||
        output.toString("ascii", 0, 4) !== "wOF2"
    ) {
        throw new Error(
            "ttf2woff2 produced an invalid WOFF2 smoke-test result."
        );
    }
}

/** @param {string} repoRoot */
async function smokeTestTar(repoRoot) {
    const smokeRoot = mkdtempSync(resolve(repoRoot, "temp", "tar-xz-smoke-"));
    try {
        const source = resolve(smokeRoot, "probe.txt");
        const archive = resolve(smokeRoot, "probe.tar.xz");
        const extracted = resolve(smokeRoot, "extracted");
        writeFileSync(source, "ok", "utf8");
        await runCommand(
            "tar",
            [
                "-cJf",
                archive,
                "-C",
                smokeRoot,
                "probe.txt",
            ],
            { absoluteTimeoutMs: 30_000, cwd: repoRoot, mode: "capture" }
        );
        const listing = await runCommand("tar", ["-tf", archive], {
            absoluteTimeoutMs: 30_000,
            cwd: repoRoot,
            mode: "capture",
        });
        if (!listing.stdout.split(/\r?\n/v).includes("probe.txt")) {
            throw new Error(
                "tar could not list the generated .tar.xz fixture."
            );
        }
        mkdirSync(extracted, { recursive: true });
        await runCommand(
            "tar",
            [
                "-xf",
                archive,
                "-C",
                extracted,
            ],
            {
                absoluteTimeoutMs: 30_000,
                cwd: repoRoot,
                mode: "capture",
            }
        );
        if (readFileSync(resolve(extracted, "probe.txt"), "utf8") !== "ok") {
            throw new Error(
                "tar could not extract the generated .tar.xz fixture."
            );
        }
    } finally {
        removeTree(smokeRoot);
    }
}

/** @param {string} repoRoot */
async function inspectDirtyGeneratedPaths(repoRoot) {
    const status = await runCommand(
        "git",
        [
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
            "--",
            ...GENERATED_PATHS,
        ],
        { absoluteTimeoutMs: 30_000, cwd: repoRoot, mode: "capture" }
    );
    return status.stdout
        .split(/\r?\n/v)
        .map((line) => line.trimEnd())
        .filter(Boolean);
}

/**
 * @param {ProgressReporter} progress
 * @param {string} command
 * @param {readonly string[]} argumentsList
 * @param {string} cwd
 * @param {"interactive" | "json"} mode
 * @param {{ absoluteTimeoutMs: number; inactivityTimeoutMs?: number }} timeouts
 */
async function runTrackedCommand(
    progress,
    command,
    argumentsList,
    cwd,
    mode,
    timeouts
) {
    progress.detail(`Running: ${formatCommand(command, argumentsList)}`);
    const startedAt = Date.now();
    try {
        const result = await runCommand(command, argumentsList, {
            ...timeouts,
            cwd,
            mode,
        });
        progress.detail(
            `Command completed in ${formatDuration(Date.now() - startedAt)}.`
        );
        return result;
    } catch (error) {
        progress.detail(
            `Command failed after ${formatDuration(Date.now() - startedAt)}.`
        );
        throw error;
    }
}

/** @param {unknown} error @returns {Record<string, unknown>} */
export function serializeError(error) {
    /** @param {unknown} value @returns {Record<string, unknown> | string} */
    const serializeCause = (value) => {
        if (!(value instanceof Error)) return String(value);
        return serializeError(value);
    };
    /** @type {(Record<string, unknown> | string)[]} */
    const errors =
        error instanceof AggregateError
            ? [...error.errors].map(serializeCause)
            : [];
    const cause = error instanceof Error ? error.cause : undefined;
    const command =
        error instanceof CommandExecutionError
            ? {
                  absoluteTimeoutMs: error.absoluteTimeoutMs ?? null,
                  arguments: error.argumentsList,
                  command: error.command,
                  cwd: error.cwd,
                  durationMs: error.durationMs,
                  exitCode: error.exitCode,
                  signal: error.signal,
                  stderr: error.stderr,
                  stdout: error.stdout,
                  timeoutKind: error.timeoutKind ?? null,
              }
            : null;
    const relevantPaths = new Set();
    if (error instanceof Error) {
        for (const property of [
            "path",
            "dest",
            "source",
            "destination",
        ]) {
            const value = Reflect.get(error, property);
            if (typeof value === "string") relevantPaths.add(value);
        }
        const explicitPaths = Reflect.get(error, "paths");
        if (Array.isArray(explicitPaths)) {
            for (const path of explicitPaths) {
                if (typeof path === "string") relevantPaths.add(path);
            }
        }
    }
    return {
        category: error instanceof UpdaterError ? error.category : "unexpected",
        causes: [
            ...(cause === undefined ? [] : [serializeCause(cause)]),
            ...errors,
        ],
        cleanupPending:
            error instanceof UpdaterError && error.cleanupPending === true,
        code: error instanceof UpdaterError ? error.exitCode : 1,
        command,
        committed: error instanceof UpdaterError && error.committed === true,
        message: describeError(error),
        paths: [...relevantPaths],
        phase: error instanceof UpdaterError ? error.phase : "unexpected",
    };
}

/** @param {unknown} result */
function writeJsonResult(result) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function printHelp() {
    process.stdout.write(
        "Safely update the complete Nerd Fonts WOFF2 asset set.\n\n"
    );
    process.stdout.write("Plan the latest release (default):\n");
    process.stdout.write("  npm run fonts:update\n\n");
    process.stdout.write("Apply the reviewed plan:\n");
    process.stdout.write(
        "  npm run -- fonts:update -- --ref <vX.Y.Z> --apply --confirm --plan-fingerprint <sha256>\n\n"
    );
    process.stdout.write("Resume a failed reviewed conversion:\n");
    process.stdout.write("  npm run fonts:update:resume\n\n");
    process.stdout.write("Options:\n");
    process.stdout.write(
        "  --ref <tag>                 Target tag (default latest)\n"
    );
    process.stdout.write(
        "  --apply --confirm           Apply the reviewed full update\n"
    );
    process.stdout.write(
        "  --convert                   Deprecated alias for --apply\n"
    );
    process.stdout.write(
        "  --plan-fingerprint <sha>    Required reviewed artifact identity\n"
    );
    process.stdout.write(
        "  --force-rebuild             Rebuild an already installed same ref\n"
    );
    process.stdout.write(
        "  --allow-dirty               Permit replacing dirty generated paths\n"
    );
    process.stdout.write(
        "  --break-stale-lock          Break an old malformed update lock\n"
    );
    process.stdout.write(
        "  --dry-run                   Force non-mutating plan mode\n"
    );
    process.stdout.write(
        "  --download-concurrency <n>  1-8 downloads (default 4)\n"
    );
    process.stdout.write(
        `  --concurrency <n>           1-32 conversion workers (default ${DEFAULT_CONVERSION_CONCURRENCY})\n`
    );
    process.stdout.write(
        `  --timeout <seconds>         Per-font timeout (default ${DEFAULT_FONT_TIMEOUT_SECONDS})\n`
    );
    process.stdout.write(
        `  --timeout-retries <n>       0-${MAX_TIMEOUT_RETRIES} lower-concurrency timeout retries (default ${DEFAULT_TIMEOUT_RETRIES})\n`
    );
    process.stdout.write(
        "  --failed-only               Reuse validated staging and redo missing/failed fonts\n"
    );
    process.stdout.write(
        "  --json                      Emit exactly one JSON result\n"
    );
    process.stdout.write(
        "  --verbose                   Show stages, commands, and timings\n"
    );
    process.stdout.write(
        "  --color / --no-color        Force or disable ANSI styling\n"
    );
}

/**
 * @param {UpdateOptions} options @param {string} repoRoot @param
 *   {ProgressReporter} progress
 */
async function createPlan(options, repoRoot, progress) {
    const resolved = await runProgressStage(
        progress,
        "Resolve release identity, prerequisites, provenance, and disk capacity",
        async () => {
            const [release, prerequisites] = await Promise.all([
                fetchReviewedReleaseIdentity(options.upstreamRef),
                inspectPrerequisites(repoRoot),
            ]);
            const local = readLocalSourceMetadata(repoRoot);
            const currentRef =
                local !== null && typeof local.metadata.upstreamRef === "string"
                    ? local.metadata.upstreamRef
                    : null;
            const disk = inspectDiskCapacity(repoRoot, release.compressedBytes);
            const comparison =
                currentRef === null
                    ? 1
                    : compareSemverTags(release.targetRef, currentRef);
            const plan = {
                archiveCount: release.archiveCount,
                applyCommand:
                    `npm run -- fonts:update -- --ref ${release.targetRef} ` +
                    `--apply --confirm --plan-fingerprint ${release.planFingerprint}`,
                compressedBytes: release.compressedBytes,
                currentRef,
                disk,
                identity: release.identity,
                metadataFile: local?.file ?? null,
                mode: "plan",
                ok: true,
                planFingerprint: release.planFingerprint,
                prerequisites,
                publishedAt: release.publishedAt,
                releaseUrl: release.releaseUrl,
                status: "planned",
                targetRef: release.targetRef,
                updateAvailable: comparison > 0,
            };
            return { plan, release };
        },
        ({ release }) =>
            `Reviewed ${release.targetRef}: ${release.archiveCount} archives; fingerprint ${release.planFingerprint}`
    );
    return resolved.plan;
}

/**
 * @param {UpdateOptions} options @param {string} repoRoot @param
 *   {ProgressReporter} progress
 */
async function applyUpdate(options, repoRoot, progress) {
    const provisionalRef = options.upstreamRef ?? "latest";
    const transactionRoot = resolve(
        repoRoot,
        "temp",
        "nerd-fonts-update",
        "promotion-transaction"
    );
    const destinationSources = resolve(repoRoot, "fonts", "original");
    const destinationOutputs = resolve(repoRoot, "fonts", "woff2");
    const readmeFile = resolve(repoRoot, "README.md");
    const recoveryPaths = createTransactionPaths(
        repoRoot,
        transactionRoot,
        resolve(repoRoot, "temp", "nerd-fonts-update", "recovery-sources"),
        resolve(repoRoot, "temp", "nerd-fonts-update", "recovery-outputs"),
        destinationSources,
        destinationOutputs,
        readmeFile,
        provisionalRef
    );
    /**
     * @type {{ lockFile: string; release: () => Promise<void> } | undefined}
     */
    let lock;
    /** @type {unknown} */
    let primaryError;
    /** @type {Record<string, unknown> | undefined} */
    let finalResult;
    let transactionAttempted = false;

    try {
        const prepared = await runProgressStage(
            progress,
            "Acquire the update lock and revalidate local and reviewed state",
            async () => {
                try {
                    lock = await acquireUpdateLock(repoRoot, {
                        breakStaleLock: options.breakStaleLock,
                        targetRef: provisionalRef,
                    });
                } catch (error) {
                    throw categorize(error, "repository-state", 3, "lock");
                }
                progress.detail(`Acquired exclusive lock ${lock.lockFile}.`);
                try {
                    const recovery =
                        await recoverUpdateTransaction(recoveryPaths);
                    if (recovery !== "none") {
                        progress.detail(`Recovered transaction (${recovery}).`);
                    }
                } catch (error) {
                    throw categorize(error, "recovery", 9, "recovery");
                }

                const local = readLocalSourceMetadata(repoRoot);
                const currentRef =
                    local !== null &&
                    typeof local.metadata.upstreamRef === "string"
                        ? local.metadata.upstreamRef
                        : null;
                /** @param {string} targetRef */
                const evaluateInstalledRef = (targetRef) => {
                    let status;
                    try {
                        status = determineInstalledRefOutcome(
                            currentRef,
                            targetRef,
                            options.forceRebuild
                        );
                    } catch (error) {
                        throw categorize(
                            error,
                            "repository-state",
                            3,
                            "local-state"
                        );
                    }

                    return status === null
                        ? undefined
                        : {
                              currentRef,
                              mode: "apply",
                              ok: true,
                              planFingerprint: options.planFingerprint,
                              status,
                              targetRef,
                          };
                };

                if (options.upstreamRef !== null) {
                    const earlyResult = evaluateInstalledRef(
                        options.upstreamRef
                    );
                    if (earlyResult !== undefined) {
                        return { currentRef, earlyResult };
                    }
                }

                const preliminaryDisk = inspectDiskCapacity(repoRoot, 0);
                if (!preliminaryDisk.ready) {
                    throw categorize(
                        new Error(
                            `Insufficient free space: estimated ${preliminaryDisk.estimatedWorkingBytes} bytes, available ${preliminaryDisk.availableBytes} bytes.`
                        ),
                        "repository-state",
                        3,
                        "disk-capacity"
                    );
                }

                const dirtyPaths = await inspectDirtyGeneratedPaths(repoRoot);
                if (dirtyPaths.length > 0 && !options.allowDirty) {
                    throw categorize(
                        new Error(
                            `Generated paths contain uncommitted changes:\n${dirtyPaths.join("\n")}\nCommit them or pass --allow-dirty.`
                        ),
                        "repository-state",
                        3,
                        "dirty-worktree"
                    );
                }

                const prerequisites = await inspectPrerequisites(repoRoot);
                if (!prerequisites.ready) {
                    throw categorize(
                        new Error(
                            `Apply prerequisites are unavailable: ${JSON.stringify(prerequisites)}`
                        ),
                        "prerequisite",
                        4,
                        "prerequisites"
                    );
                }
                try {
                    await smokeTestTar(repoRoot);
                    await smokeTestConverter(repoRoot);
                } catch (error) {
                    throw categorize(
                        error,
                        "prerequisite",
                        4,
                        "capability-smoke-test"
                    );
                }

                /**
                 * @type {Awaited<
                 *     ReturnType<typeof fetchReviewedReleaseIdentity>
                 * >}
                 */
                let release;
                try {
                    release = await fetchReviewedReleaseIdentity(
                        options.upstreamRef
                    );
                } catch (error) {
                    throw categorize(error, "network", 5, "release-identity");
                }
                if (release.planFingerprint !== options.planFingerprint) {
                    throw categorize(
                        new Error(
                            `Reviewed plan fingerprint changed: expected ${options.planFingerprint}, received ${release.planFingerprint}. Run plan mode again and review the new identity.`
                        ),
                        "reviewed-plan",
                        5,
                        "release-identity"
                    );
                }

                const earlyResult = evaluateInstalledRef(release.targetRef);
                if (earlyResult !== undefined) {
                    return { currentRef, earlyResult };
                }

                const disk = inspectDiskCapacity(
                    repoRoot,
                    release.compressedBytes
                );
                if (!disk.ready) {
                    throw categorize(
                        new Error(
                            `Insufficient free space: estimated ${disk.estimatedWorkingBytes} bytes, available ${disk.availableBytes} bytes.`
                        ),
                        "repository-state",
                        3,
                        "disk-capacity"
                    );
                }
                let readme;
                try {
                    readme = prepareReadmeRelease(
                        readFileSync(readmeFile, "utf8"),
                        release.targetRef
                    );
                } catch (error) {
                    throw categorize(error, "transaction", 8, "readme-plan");
                }
                return { currentRef, disk, prerequisites, readme, release };
            },
            "Acquired the lock and revalidated local state and artifact identity"
        );

        if (prepared.earlyResult !== undefined) {
            finalResult = prepared.earlyResult;
            return finalResult;
        }
        const { currentRef, disk, prerequisites, readme, release } = prepared;
        if (
            disk === undefined ||
            prerequisites === undefined ||
            readme === undefined ||
            release === undefined
        ) {
            throw new Error(
                "Updater state revalidation returned incomplete data."
            );
        }
        const targetRef = release.targetRef;
        const updateRoot = resolve(
            repoRoot,
            "temp",
            "nerd-fonts-update",
            targetRef
        );
        const stagingSources = resolve(updateRoot, "sources");
        const stagingOutputs = resolve(updateRoot, "woff2");
        for (const path of [
            updateRoot,
            stagingSources,
            stagingOutputs,
        ]) {
            assertSafeRepositoryPath(repoRoot, path);
        }
        const childMode = options.asJson ? "json" : "interactive";

        if (options.failedOnly) {
            await runProgressStage(
                progress,
                "Validate the resumable staged catalog",
                async () => {
                    if (
                        !existsSync(stagingSources) ||
                        !statSync(stagingSources).isDirectory() ||
                        !existsSync(stagingOutputs) ||
                        !statSync(stagingOutputs).isDirectory()
                    ) {
                        throw categorize(
                            new Error(
                                `No resumable staging exists for ${targetRef}. Run a normal reviewed apply first.`
                            ),
                            "repository-state",
                            3,
                            "staging-resume"
                        );
                    }
                },
                `Found resumable sources and WOFF2 outputs for ${targetRef}`
            );
        } else {
            await runProgressStage(
                progress,
                `Download and extract ${release.archiveCount} reviewed archives`,
                async () => {
                    removeTree(stagingSources);
                    removeTree(stagingOutputs);
                    try {
                        await runTrackedCommand(
                            progress,
                            process.execPath,
                            [
                                resolve(
                                    moduleDirectory,
                                    "download-nerd-fonts-sources.mjs"
                                ),
                                "--ref",
                                targetRef,
                                "--output-dir",
                                stagingSources,
                                "--concurrency",
                                String(options.downloadConcurrency),
                                "--expected-commit-sha",
                                release.identity.commitSha,
                                "--expected-manifest-sha256",
                                release.identity.checksumManifest
                                    .manifestSha256,
                                "--plan-fingerprint",
                                release.planFingerprint,
                                "--confirm",
                            ],
                            repoRoot,
                            childMode,
                            {
                                absoluteTimeoutMs: 2 * 60 * 60 * 1_000,
                                inactivityTimeoutMs: 10 * 60 * 1_000,
                            }
                        );
                    } catch (error) {
                        throw categorize(error, "conversion", 6, "download");
                    }
                },
                `Prepared ${release.archiveCount} release archives in staging`
            );
        }

        const sourceMetadata = readMetadataFile(
            resolve(stagingSources, ".source-metadata.json")
        );
        if (
            sourceMetadata === null ||
            !Number.isSafeInteger(sourceMetadata.sourceCount) ||
            Number(sourceMetadata.sourceCount) < 1 ||
            sourceMetadata.archiveCount !== release.archiveCount ||
            sourceMetadata.commitSha !== release.identity.commitSha ||
            sourceMetadata.manifestSha256 !==
                release.identity.checksumManifest.manifestSha256 ||
            sourceMetadata.planFingerprint !== release.planFingerprint ||
            sourceMetadata.upstreamRef !== targetRef
        ) {
            throw categorize(
                new Error(
                    "Staged source metadata does not match the reviewed release identity."
                ),
                "verification",
                7,
                "staged-metadata"
            );
        }
        const sourceCount = Number(sourceMetadata.sourceCount);
        await runProgressStage(
            progress,
            options.failedOnly
                ? "Redo failed or missing staged WOFF2 conversions"
                : "Convert the staged source catalog to WOFF2",
            async () => {
                if (!options.failedOnly) removeTree(stagingOutputs);
                const failureReport = resolve(
                    updateRoot,
                    "conversion-failures.json"
                );
                const convertArguments = [
                    resolve(moduleDirectory, "bulk-convert-fonts.mjs"),
                    "--source-dir",
                    stagingSources,
                    "--output-dir",
                    stagingOutputs,
                    "--public-source-dir",
                    "fonts/original",
                    "--public-output-dir",
                    "fonts/woff2",
                    "--timeout",
                    String(options.timeoutSeconds),
                    "--timeout-retries",
                    String(options.timeoutRetries),
                    "--concurrency",
                    String(options.conversionConcurrency),
                    "--failure-report",
                    failureReport,
                    "--convert",
                    "--confirm",
                ];
                convertArguments.push(
                    options.failedOnly ? "--failed-only" : "--force"
                );
                if (options.verbose) convertArguments.push("--verbose");
                if (options.color === true) convertArguments.push("--color");
                else if (options.color === false)
                    convertArguments.push("--no-color");
                const conversionPasses = createConversionPasses(
                    options.conversionConcurrency,
                    options.timeoutSeconds,
                    options.timeoutRetries
                );
                const absoluteTimeoutMs = calculateConversionDeadlineMs(
                    sourceCount,
                    conversionPasses
                );
                const finalPassTimeoutSeconds =
                    conversionPasses.at(-1)?.timeoutSeconds ??
                    options.timeoutSeconds;
                try {
                    await runTrackedCommand(
                        progress,
                        process.execPath,
                        convertArguments,
                        repoRoot,
                        childMode,
                        {
                            absoluteTimeoutMs,
                            inactivityTimeoutMs: Math.max(
                                10 * 60 * 1_000,
                                finalPassTimeoutSeconds * 2 * 1_000 + 120_000
                            ),
                        }
                    );
                } catch (error) {
                    throw categorize(error, "conversion", 6, "conversion");
                }
            },
            options.failedOnly
                ? `Completed and reindexed all ${sourceCount} staged source fonts`
                : `Converted ${sourceCount} staged source fonts`
        );

        const indexValue = await runProgressStage(
            progress,
            "Generate provenance and verify the staged asset trees",
            async () => {
                let index;
                try {
                    index = JSON.parse(
                        readFileSync(
                            resolve(stagingOutputs, "index.json"),
                            "utf8"
                        )
                    );
                } catch (error) {
                    throw categorize(error, "verification", 7, "staged-index");
                }
                if (!Array.isArray(index)) {
                    throw categorize(
                        new Error("Staged WOFF2 index is invalid."),
                        "verification",
                        7,
                        "staged-index"
                    );
                }
                const stagedMetadataFile = resolve(
                    stagingOutputs,
                    "source-metadata.json"
                );
                await atomicWriteJson(stagedMetadataFile, {
                    ...sourceMetadata,
                    generatedAt: new Date().toISOString(),
                    outputCount: index.length,
                    planFingerprint: release.planFingerprint,
                });
                try {
                    await runTrackedCommand(
                        progress,
                        process.execPath,
                        [
                            resolve(moduleDirectory, "verify-font-assets.mjs"),
                            "--source-dir",
                            stagingSources,
                            "--output-dir",
                            stagingOutputs,
                            "--metadata-file",
                            stagedMetadataFile,
                            "--public-source-dir",
                            "fonts/original",
                            "--public-output-dir",
                            "fonts/woff2",
                            "--require-metadata",
                        ],
                        repoRoot,
                        childMode,
                        {
                            absoluteTimeoutMs: 30 * 60 * 1_000,
                            inactivityTimeoutMs: 5 * 60 * 1_000,
                        }
                    );
                } catch (error) {
                    throw categorize(
                        error,
                        "verification",
                        7,
                        "staged-verification"
                    );
                }
                return index;
            },
            (index) =>
                `Verified ${sourceCount} sources and ${index.length} WOFF2 outputs in staging`
        );

        const transactionPaths = createTransactionPaths(
            repoRoot,
            transactionRoot,
            stagingSources,
            stagingOutputs,
            destinationSources,
            destinationOutputs,
            readmeFile,
            targetRef
        );
        transactionAttempted = true;
        await runProgressStage(
            progress,
            "Promote the verified trees with README rollback state",
            async () => {
                try {
                    await beginUpdateTransaction(
                        transactionPaths,
                        readme.content
                    );
                } catch (error) {
                    throw categorize(error, "transaction", 8, "promotion");
                }
            },
            "Promoted verified trees with rollback backups retained"
        );

        await runProgressStage(
            progress,
            "Verify the promoted canonical asset trees",
            async () => {
                try {
                    await runTrackedCommand(
                        progress,
                        process.execPath,
                        [
                            resolve(moduleDirectory, "verify-font-assets.mjs"),
                            "--require-metadata",
                        ],
                        repoRoot,
                        childMode,
                        {
                            absoluteTimeoutMs: 30 * 60 * 1_000,
                            inactivityTimeoutMs: 5 * 60 * 1_000,
                        }
                    );
                } catch (error) {
                    throw categorize(
                        error,
                        "verification",
                        7,
                        "canonical-verification"
                    );
                }
            },
            "Verified the promoted canonical asset trees"
        );

        await runProgressStage(
            progress,
            "Install and verify README release provenance",
            async () => {
                try {
                    await installTransactionReadme(transactionPaths);
                    verifyReadmeRelease(
                        readFileSync(readmeFile, "utf8"),
                        targetRef
                    );
                } catch (error) {
                    throw categorize(error, "transaction", 8, "readme-install");
                }
            },
            `README ${readme.status === "updated" ? "updated" : "already current"}`
        );

        await runProgressStage(
            progress,
            "Commit the transaction and clean staging",
            async () => {
                try {
                    await commitUpdateTransaction(transactionPaths);
                    transactionAttempted = false;
                    removeTree(updateRoot);
                } catch (error) {
                    const committed =
                        Reflect.get(Object(error), "committed") === true;
                    throw categorize(
                        error,
                        committed ? "cleanup" : "transaction",
                        committed ? 9 : 8,
                        committed ? "committed-cleanup" : "commit"
                    );
                }
            },
            "Committed README and assets and removed successful staging"
        );

        finalResult = {
            archiveCount: release.archiveCount,
            conversionConcurrency: options.conversionConcurrency,
            currentRef,
            disk,
            failedOnly: options.failedOnly,
            metadataFile: resolve(destinationOutputs, "source-metadata.json"),
            mode: "apply",
            ok: true,
            outputCount: indexValue.length,
            planFingerprint: release.planFingerprint,
            prerequisites,
            readmeStatus: readme.status,
            sourceCount,
            status: "updated",
            targetRef,
            timeoutRetries: options.timeoutRetries,
            timeoutSeconds: options.timeoutSeconds,
        };
        return finalResult;
    } catch (error) {
        primaryError = error;
        if (
            transactionAttempted &&
            Reflect.get(Object(error), "committed") !== true
        ) {
            try {
                const recovery = await recoverUpdateTransaction(recoveryPaths);
                progress.detail(
                    `Rolled back update transaction (${recovery}).`
                );
                transactionAttempted = false;
            } catch (recoveryError) {
                primaryError = categorize(
                    new AggregateError(
                        [error, recoveryError],
                        "The update failed and automatic rollback was incomplete."
                    ),
                    "recovery",
                    9,
                    "rollback"
                );
            }
        }
    } finally {
        const acquiredLock = lock;
        if (acquiredLock !== undefined) {
            try {
                await acquiredLock.release();
                progress.detail("Released the exclusive update lock.");
            } catch (releaseError) {
                const categorizedRelease = categorize(
                    releaseError,
                    "recovery",
                    9,
                    "lock-release"
                );
                if (finalResult?.["status"] === "updated") {
                    categorizedRelease.committed = true;
                    categorizedRelease.cleanupPending = true;
                }
                primaryError =
                    primaryError === undefined
                        ? categorizedRelease
                        : categorize(
                              new AggregateError(
                                  [primaryError, categorizedRelease],
                                  "The update failed and the lock could not be released."
                              ),
                              "recovery",
                              9,
                              "lock-release"
                          );
            }
        }
        if (primaryError !== undefined) throw primaryError;
    }

    if (finalResult === undefined) {
        throw new Error("The updater completed without a result.");
    }
    return finalResult;
}

/**
 * @param {readonly string[]} [argumentsList]
 * @param {string} [repoRoot]
 */
export async function main(
    argumentsList = process.argv.slice(2),
    repoRoot = defaultRepoRoot
) {
    const options = parseUpdateOptions(argumentsList);
    if (options.help) {
        printHelp();
        return { mode: "help", ok: true, status: "help" };
    }
    if (options.applyAlias) {
        process.stderr.write(
            "Warning: --convert is deprecated for the updater; use --apply.\n"
        );
    }
    let verifiedRoot;
    try {
        verifiedRoot = await verifyRepositoryRoot(resolve(repoRoot));
    } catch (error) {
        throw categorize(error, "repository-state", 3, "repository-root");
    }
    const applying = options.apply && !options.dryRun;
    const progress = createProgressReporter(
        options.verbose,
        applying ? 8 : 1,
        resolveColorEnabled(options.color, process.stderr)
    );
    let result;
    if (applying) {
        result = await applyUpdate(options, verifiedRoot, progress);
    } else {
        try {
            result = await createPlan(options, verifiedRoot, progress);
        } catch (error) {
            throw categorize(error, "network", 5, "plan");
        }
    }
    /** @type {Record<string, unknown>} */
    const printableResult = result;
    if (options.asJson) {
        writeJsonResult(result);
    } else if (printableResult["status"] === "planned") {
        process.stdout.write("Nerd Fonts update plan\n");
        process.stdout.write(
            `  Current generated ref: ${printableResult["currentRef"] ?? "unknown"}\n`
        );
        process.stdout.write(
            `  Target release:        ${String(printableResult["targetRef"])}\n`
        );
        process.stdout.write(
            `  Release archives:      ${String(printableResult["archiveCount"])}\n`
        );
        process.stdout.write(
            `  Plan fingerprint:      ${String(printableResult["planFingerprint"])}\n`
        );
        process.stdout.write(
            `  Release:               ${String(printableResult["releaseUrl"])}\n\n`
        );
        process.stdout.write(
            "No files were changed. Apply exactly this reviewed plan:\n"
        );
        process.stdout.write(`  ${String(printableResult["applyCommand"])}\n`);
    } else if (printableResult["status"] === "updated") {
        process.stdout.write(
            `\nNerd Fonts ${String(printableResult["targetRef"])} update completed.\n`
        );
        process.stdout.write(
            `  Source fonts: ${String(printableResult["sourceCount"])}\n`
        );
        process.stdout.write(
            `  WOFF2 files:  ${String(printableResult["outputCount"])}\n`
        );
        process.stdout.write(
            `  Fingerprint:  ${String(printableResult["planFingerprint"])}\n`
        );
    } else {
        process.stdout.write(
            `Nerd Fonts update ${String(printableResult["status"])}: installed ${String(printableResult["currentRef"])}, requested ${String(printableResult["targetRef"])}.\n`
        );
    }
    return result;
}

/** @param {readonly string[]} [argumentsList] */
export async function runCli(argumentsList = process.argv.slice(2)) {
    try {
        await main(argumentsList);
        return 0;
    } catch (error) {
        const categorizedError =
            error instanceof UpdaterError
                ? error
                : categorize(error, "usage", 2, "arguments");
        if (argumentsList.includes("--json")) {
            writeJsonResult({
                error: serializeError(categorizedError),
                mode:
                    argumentsList.includes("--apply") ||
                    argumentsList.includes("--convert")
                        ? "apply"
                        : "plan",
                ok: false,
                status: "failed",
            });
        } else {
            process.stderr.write(`Error: ${categorizedError.message}\n`);
            const serialized = serializeError(categorizedError);
            const causes = serialized["causes"];
            if (Array.isArray(causes) && causes.length > 0) {
                process.stderr.write(
                    `Details: ${JSON.stringify(causes, null, 2)}\n`
                );
            }
        }
        process.exitCode = categorizedError.exitCode;
        return categorizedError.exitCode;
    }
}
