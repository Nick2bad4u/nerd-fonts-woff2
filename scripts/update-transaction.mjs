import { randomUUID } from "node:crypto";
import {
    closeSync,
    existsSync,
    fsyncSync,
    mkdirSync,
    openSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, resolve } from "node:path";

import {
    assertSafeRepositoryPath,
    atomicWriteFile,
    atomicWriteJson,
    readJsonFile,
    removeTree,
    renameWithRetry,
} from "./safe-filesystem.mjs";

const LOCK_STALE_AFTER_MS = 15 * 60 * 1_000;
const TRANSACTION_SCHEMA_VERSION = 1;
const LOCK_SCHEMA_VERSION = 1;

/** @typedef {{ afterStep?: (step: string) => Promise<void> | void }} TransactionHooks */

/** @param {TransactionHooks | undefined} hooks @param {string} step */
async function notifyStep(hooks, step) {
    await hooks?.afterStep?.(step);
}

/**
 * @typedef {{
 *     backupOutputs: string;
 *     backupReadme: string;
 *     backupSources: string;
 *     destinationOutputs: string;
 *     destinationSources: string;
 *     readmeFile: string;
 *     repoRoot: string;
 *     stagingOutputs: string;
 *     stagingSources: string;
 *     targetRef: string;
 *     transactionRoot: string;
 * }} TransactionPaths
 */

/**
 * @typedef {{
 *     committed: boolean;
 *     hadOutputs: boolean;
 *     hadReadme: boolean;
 *     hadSources: boolean;
 *     newOutputsInstalled: boolean;
 *     newSourcesInstalled: boolean;
 *     nonce: string;
 *     oldOutputsMoved: boolean;
 *     oldReadmeMoved: boolean;
 *     oldSourcesMoved: boolean;
 *     paths: {
 *         backupOutputs: string;
 *         backupReadme: string;
 *         backupSources: string;
 *         destinationOutputs: string;
 *         destinationSources: string;
 *         readmeFile: string;
 *         stagedReadme: string;
 *         stagingOutputs: string;
 *         stagingSources: string;
 *     };
 *     phase: string;
 *     readmeInstalled: boolean;
 *     schemaVersion: number;
 *     targetRef: string;
 * }} TransactionState
 */

/**
 * @param {string} repoRoot
 * @param {string} transactionRoot
 * @param {string} stagingSources
 * @param {string} stagingOutputs
 * @param {string} destinationSources
 * @param {string} destinationOutputs
 * @param {string} readmeFile
 * @param {string} targetRef
 *
 * @returns {TransactionPaths}
 */
export function createTransactionPaths(
    repoRoot,
    transactionRoot,
    stagingSources,
    stagingOutputs,
    destinationSources,
    destinationOutputs,
    readmeFile,
    targetRef
) {
    const paths = {
        backupOutputs: resolve(transactionRoot, "woff2"),
        backupReadme: resolve(transactionRoot, "README.md"),
        backupSources: resolve(transactionRoot, "original"),
        destinationOutputs,
        destinationSources,
        readmeFile,
        repoRoot,
        stagingOutputs,
        stagingSources,
        targetRef,
        transactionRoot,
    };
    for (const path of Object.values(paths)) {
        if (path === repoRoot || path === targetRef) continue;
        assertSafeRepositoryPath(repoRoot, path);
    }

    return paths;
}

/**
 * @param {string} original
 * @param {string} targetRef
 *
 * @returns {{
 *     content: string;
 *     currentRef: string;
 *     status: "already-current" | "updated";
 * }}
 */
export function prepareReadmeRelease(original, targetRef) {
    const matches = [
        ...original.matchAll(/Nerd Fonts (v\d+\.\d+\.\d+)/gv),
        ...original.matchAll(
            /ryanoasis\/nerd-fonts\/releases\/(?:download|tag)\/(v\d+\.\d+\.\d+)/gv
        ),
    ];
    const refs = new Set(
        matches
            .map((match) => match[1])
            .filter((value) => typeof value === "string")
    );
    if (refs.size === 0) {
        throw new Error(
            "README.md does not contain a recognized Nerd Fonts release marker."
        );
    }

    if (refs.size !== 1) {
        throw new Error(
            `README.md contains inconsistent Nerd Fonts release markers: ${[
                ...refs,
            ].join(", ")}`
        );
    }

    const currentRef = [...refs][0];
    if (typeof currentRef !== "string") {
        throw new Error("Unable to resolve the README Nerd Fonts release.");
    }

    if (currentRef === targetRef) {
        return { content: original, currentRef, status: "already-current" };
    }

    return {
        content: original
            .replaceAll(
                /Nerd Fonts v\d+\.\d+\.\d+/gv,
                `Nerd Fonts ${targetRef}`
            )
            .replaceAll(
                /(ryanoasis\/nerd-fonts\/releases\/(?:download|tag)\/)v\d+\.\d+\.\d+/gv,
                `$1${targetRef}`
            ),
        currentRef,
        status: "updated",
    };
}

/** @param {string} contents @param {string} targetRef */
export function verifyReadmeRelease(contents, targetRef) {
    const prepared = prepareReadmeRelease(contents, targetRef);
    if (prepared.status !== "already-current") {
        throw new Error(`README.md does not reference ${targetRef}.`);
    }
}

/** @param {TransactionPaths} paths */
function transactionStateFile(paths) {
    return resolve(paths.transactionRoot, "promotion-state.json");
}

/** @param {TransactionPaths} paths @param {TransactionState} state */
async function writeState(paths, state) {
    await atomicWriteJson(transactionStateFile(paths), state);
}

/**
 * @param {TransactionPaths} paths
 * @param {string} readmeContent
 * @param {TransactionHooks} [hooks]
 *
 * @returns {Promise<TransactionState>}
 */
export async function beginUpdateTransaction(paths, readmeContent, hooks) {
    if (
        !existsSync(paths.stagingSources) ||
        !existsSync(paths.stagingOutputs)
    ) {
        throw new Error("Staged source and output trees must both exist.");
    }

    if (existsSync(paths.transactionRoot)) {
        throw new Error(
            `An update transaction already exists: ${paths.transactionRoot}`
        );
    }

    mkdirSync(paths.transactionRoot, { recursive: true });
    const nonce = randomUUID();
    const stagedReadme = resolve(
        dirname(paths.readmeFile),
        `.README.md.${nonce}.tmp`
    );
    assertSafeRepositoryPath(paths.repoRoot, stagedReadme);
    /** @type {TransactionState} */
    const state = {
        committed: false,
        hadOutputs: existsSync(paths.destinationOutputs),
        hadReadme: existsSync(paths.readmeFile),
        hadSources: existsSync(paths.destinationSources),
        newOutputsInstalled: false,
        newSourcesInstalled: false,
        nonce,
        oldOutputsMoved: false,
        oldReadmeMoved: false,
        oldSourcesMoved: false,
        paths: {
            backupOutputs: paths.backupOutputs,
            backupReadme: paths.backupReadme,
            backupSources: paths.backupSources,
            destinationOutputs: paths.destinationOutputs,
            destinationSources: paths.destinationSources,
            readmeFile: paths.readmeFile,
            stagedReadme,
            stagingOutputs: paths.stagingOutputs,
            stagingSources: paths.stagingSources,
        },
        phase: "initialized",
        readmeInstalled: false,
        schemaVersion: TRANSACTION_SCHEMA_VERSION,
        targetRef: paths.targetRef,
    };
    await writeState(paths, state);
    await notifyStep(hooks, "journal-created");
    await atomicWriteFile(stagedReadme, readmeContent);
    state.phase = "readme-staged";
    await writeState(paths, state);
    await notifyStep(hooks, "readme-staged");

    if (state.hadSources === true) {
        await renameWithRetry(paths.destinationSources, paths.backupSources);
        state.oldSourcesMoved = true;
        state.phase = "sources-backed-up";
        await writeState(paths, state);
        await notifyStep(hooks, "sources-backed-up");
    }

    if (state.hadOutputs === true) {
        await renameWithRetry(paths.destinationOutputs, paths.backupOutputs);
        state.oldOutputsMoved = true;
        state.phase = "outputs-backed-up";
        await writeState(paths, state);
        await notifyStep(hooks, "outputs-backed-up");
    }

    if (state.hadReadme === true) {
        await renameWithRetry(paths.readmeFile, paths.backupReadme);
        state.oldReadmeMoved = true;
        state.phase = "readme-backed-up";
        await writeState(paths, state);
        await notifyStep(hooks, "readme-backed-up");
    }

    mkdirSync(dirname(paths.destinationSources), { recursive: true });
    await renameWithRetry(paths.stagingSources, paths.destinationSources);
    state.newSourcesInstalled = true;
    state.phase = "sources-installed";
    await writeState(paths, state);
    await notifyStep(hooks, "sources-installed");

    await renameWithRetry(paths.stagingOutputs, paths.destinationOutputs);
    state.newOutputsInstalled = true;
    state.phase = "outputs-installed";
    await writeState(paths, state);
    await notifyStep(hooks, "outputs-installed");
    return state;
}

/** @param {TransactionPaths} paths @param {TransactionHooks} [hooks] */
export async function installTransactionReadme(paths, hooks) {
    const state = readTransactionState(paths);
    const stagedReadme = state.paths.stagedReadme;
    if (!existsSync(stagedReadme)) {
        throw new Error("The staged README is missing from the transaction.");
    }

    assertSafeRepositoryPath(paths.repoRoot, stagedReadme);
    await renameWithRetry(stagedReadme, paths.readmeFile);
    state.readmeInstalled = true;
    state.phase = "readme-installed";
    await writeState(paths, state);
    await notifyStep(hooks, "readme-installed");
}

/** @param {TransactionPaths} paths */
export function readTransactionState(paths, allowTargetMismatch = false) {
    const stateFile = transactionStateFile(paths);
    let value;
    try {
        value = readJsonFile(stateFile);
    } catch (error) {
        throw new Error(`Invalid promotion state: ${stateFile}`, {
            cause: error,
        });
    }

    if (
        typeof value !== "object" ||
        value === null ||
        Reflect.get(value, "schemaVersion") !== TRANSACTION_SCHEMA_VERSION ||
        typeof Reflect.get(value, "nonce") !== "string" ||
        (!allowTargetMismatch &&
            Reflect.get(value, "targetRef") !== paths.targetRef)
    ) {
        throw new Error(`Invalid promotion state: ${stateFile}`);
    }

    const state = /** @type {TransactionState} */ (value);
    if (typeof state.paths !== "object" || state.paths === null) {
        throw new Error(`Invalid promotion paths: ${stateFile}`);
    }
    /** @param {string} left @param {string} right */
    const pathEquals = (left, right) =>
        process.platform === "win32"
            ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
            : resolve(left) === resolve(right);
    /** @type {[unknown, string][]} */
    const canonicalPathPairs = [
        [state.paths.backupOutputs, paths.backupOutputs],
        [state.paths.backupReadme, paths.backupReadme],
        [state.paths.backupSources, paths.backupSources],
        [state.paths.destinationOutputs, paths.destinationOutputs],
        [state.paths.destinationSources, paths.destinationSources],
        [state.paths.readmeFile, paths.readmeFile],
    ];
    for (const [recorded, expected] of canonicalPathPairs) {
        if (typeof recorded !== "string" || !pathEquals(recorded, expected)) {
            throw new Error(
                `Promotion state contains unexpected paths: ${stateFile}`
            );
        }
    }
    if (!allowTargetMismatch) {
        /** @type {[unknown, string][]} */
        const stagingPathPairs = [
            [state.paths.stagingOutputs, paths.stagingOutputs],
            [state.paths.stagingSources, paths.stagingSources],
        ];
        for (const [recorded, expected] of stagingPathPairs) {
            if (
                typeof recorded !== "string" ||
                !pathEquals(recorded, expected)
            ) {
                throw new Error(
                    `Promotion state contains unexpected staging paths: ${stateFile}`
                );
            }
        }
    }
    const expectedReadmeName = `.README.md.${state.nonce}.tmp`;
    if (
        typeof state.paths.stagedReadme !== "string" ||
        !pathEquals(
            dirname(state.paths.stagedReadme),
            dirname(paths.readmeFile)
        ) ||
        basename(state.paths.stagedReadme) !== expectedReadmeName
    ) {
        throw new Error(
            `Promotion state contains an unsafe staged README path: ${stateFile}`
        );
    }
    assertSafeRepositoryPath(paths.repoRoot, state.paths.stagedReadme);
    return state;
}

/** @param {TransactionPaths} paths @param {TransactionHooks} [hooks] */
async function cleanupCommittedTransaction(paths, hooks) {
    /** @type {unknown[]} */
    const failures = [];
    /** @type {[string, string][]} */
    const cleanupOperations = [
        ["remove source backup", paths.backupSources],
        ["remove output backup", paths.backupOutputs],
        ["remove README backup", paths.backupReadme],
    ];
    for (const [operation, path] of cleanupOperations) {
        try {
            removeTree(path);
            await notifyStep(hooks, operation);
        } catch (error) {
            failures.push(
                new Error(`${operation} failed for ${path}`, { cause: error })
            );
        }
    }

    if (failures.length > 0) {
        const aggregate = new AggregateError(
            failures,
            "The update committed, but transaction cleanup is incomplete."
        );
        Reflect.set(aggregate, "committed", true);
        Reflect.set(aggregate, "cleanupPending", true);
        throw aggregate;
    }

    removeTree(transactionStateFile(paths));
    await notifyStep(hooks, "remove transaction journal");
    removeTree(paths.transactionRoot);
    await notifyStep(hooks, "remove transaction root");
}

/** @param {TransactionPaths} paths @param {TransactionHooks} [hooks] */
export async function commitUpdateTransaction(paths, hooks) {
    const state = readTransactionState(paths);
    state.committed = true;
    state.phase = "committed";
    await writeState(paths, state);
    try {
        await notifyStep(hooks, "commit-state-written");
        await cleanupCommittedTransaction(paths, hooks);
    } catch (error) {
        Reflect.set(Object(error), "committed", true);
        Reflect.set(Object(error), "cleanupPending", true);
        throw error;
    }
}

/**
 * @param {TransactionPaths} paths
 *
 * @returns {Promise<"completed" | "none" | "restored">}
 */
export async function recoverUpdateTransaction(paths) {
    if (!existsSync(paths.transactionRoot)) return "none";
    const stateFile = transactionStateFile(paths);
    if (!existsSync(stateFile)) {
        if (
            !existsSync(paths.backupSources) &&
            !existsSync(paths.backupOutputs) &&
            !existsSync(paths.backupReadme)
        ) {
            removeTree(paths.transactionRoot);
            return "completed";
        }

        throw new Error(
            `Promotion backup exists without transaction state: ${paths.transactionRoot}`
        );
    }

    const state = readTransactionState(paths, true);
    if (Reflect.get(state, "committed") === true) {
        await cleanupCommittedTransaction(paths);
        return "completed";
    }

    /** @type {unknown[]} */
    const failures = [];
    /**
     * @param {string} label
     * @param {string} destination
     * @param {string} backup
     * @param {unknown} hadOriginal
     * @param {unknown} moved
     */
    const restore = async (label, destination, backup, hadOriginal, moved) => {
        try {
            if (existsSync(backup)) {
                removeTree(destination);
                await renameWithRetry(backup, destination);
            } else if (moved === true) {
                throw new Error(
                    `${label} backup is missing after it was recorded as moved: ${backup}`
                );
            } else if (hadOriginal !== true) {
                removeTree(destination);
            } else if (!existsSync(destination)) {
                throw new Error(
                    `${label} is missing from both canonical and backup paths.`
                );
            }
        } catch (error) {
            failures.push(
                new Error(`Restore ${label} failed for ${destination}`, {
                    cause: error,
                })
            );
        }
    };

    await restore(
        "WOFF2 outputs",
        paths.destinationOutputs,
        paths.backupOutputs,
        Reflect.get(state, "hadOutputs"),
        Reflect.get(state, "oldOutputsMoved")
    );
    await restore(
        "source fonts",
        paths.destinationSources,
        paths.backupSources,
        Reflect.get(state, "hadSources"),
        Reflect.get(state, "oldSourcesMoved")
    );
    await restore(
        "README",
        paths.readmeFile,
        paths.backupReadme,
        Reflect.get(state, "hadReadme"),
        Reflect.get(state, "oldReadmeMoved")
    );

    const stagedReadme = state.paths.stagedReadme;
    if (stagedReadme.length > 0) {
        try {
            removeTree(stagedReadme);
        } catch (error) {
            failures.push(
                new Error(`Remove staged README failed for ${stagedReadme}`, {
                    cause: error,
                })
            );
        }
    }

    if (failures.length > 0) {
        throw new AggregateError(
            failures,
            "Automatic update transaction recovery was incomplete."
        );
    }

    removeTree(stateFile);
    removeTree(paths.transactionRoot);
    return "restored";
}

/**
 * @param {string} repoRoot
 * @param {{ breakStaleLock?: boolean; targetRef: string }} options
 *
 * @returns {Promise<{ lockFile: string; release: () => Promise<void> }>}
 */
export async function acquireUpdateLock(repoRoot, options) {
    const lockFile = resolve(
        repoRoot,
        "temp",
        "nerd-fonts-update",
        "update.lock"
    );
    assertSafeRepositoryPath(repoRoot, lockFile);
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
                    throw new Error(
                        `Update lock is unreadable${
                            ageMs < LOCK_STALE_AFTER_MS
                                ? " and is too recent to break"
                                : "; use --break-stale-lock after verifying no updater is active"
                        }: ${lockFile}`,
                        { cause: readError }
                    );
                }

                removeTree(lockFile);
                continue;
            }

            const pid =
                typeof existing === "object" && existing !== null
                    ? Reflect.get(existing, "pid")
                    : null;
            const validLock =
                typeof existing === "object" &&
                existing !== null &&
                Reflect.get(existing, "schemaVersion") ===
                    LOCK_SCHEMA_VERSION &&
                typeof Reflect.get(existing, "hostname") === "string" &&
                typeof Reflect.get(existing, "nonce") === "string" &&
                typeof Reflect.get(existing, "startedAt") === "string" &&
                Number.isFinite(
                    Date.parse(String(Reflect.get(existing, "startedAt")))
                ) &&
                typeof Reflect.get(existing, "targetRef") === "string" &&
                Number.isSafeInteger(pid) &&
                Number(pid) >= 1;
            if (!validLock) {
                const ageMs = Date.now() - statSync(lockFile).mtimeMs;
                if (
                    options.breakStaleLock !== true ||
                    ageMs < LOCK_STALE_AFTER_MS
                ) {
                    throw new Error(
                        `Update lock does not contain valid ownership metadata: ${lockFile}`
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
                throw new Error(
                    `Another Nerd Fonts update is active (PID ${String(pid)}).`
                );
            }

            removeTree(lockFile);
            continue;
        }

        if (typeof descriptor !== "number") {
            throw new Error(`Failed to create update lock: ${lockFile}`);
        }

        const owner = {
            hostname: hostname(),
            nonce: randomUUID(),
            pid: process.pid,
            schemaVersion: LOCK_SCHEMA_VERSION,
            startedAt: new Date().toISOString(),
            targetRef: options.targetRef,
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
        return {
            lockFile,
            async release() {
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
                        typeof current !== "object" ||
                        current === null ||
                        Reflect.get(current, "schemaVersion") !==
                            LOCK_SCHEMA_VERSION ||
                        Reflect.get(current, "nonce") !== owner.nonce ||
                        Reflect.get(current, "pid") !== owner.pid ||
                        Reflect.get(current, "hostname") !== owner.hostname
                    ) {
                        throw new Error(
                            `Update lock ownership changed before release: ${lockFile}`
                        );
                    }

                    removeTree(lockFile);
                } catch (error) {
                    failures.push(error);
                }

                if (failures.length > 0) {
                    throw new AggregateError(
                        failures,
                        "Unable to release the Nerd Fonts update lock."
                    );
                }
            },
        };
    }

    throw new Error(`Unable to acquire update lock after retries: ${lockFile}`);
}
