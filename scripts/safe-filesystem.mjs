import {
    closeSync,
    existsSync,
    fsyncSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export const RECURSIVE_REMOVAL_OPTIONS = Object.freeze({
    force: true,
    maxRetries: 6,
    recursive: true,
    retryDelay: 200,
});

const TRANSIENT_RENAME_CODES = new Set([
    "EACCES",
    "EBUSY",
    "EPERM",
]);

/** @param {number} milliseconds */
function delay(milliseconds) {
    return new Promise((resolvePromise) => {
        setTimeout(resolvePromise, milliseconds);
    });
}

/**
 * @param {string} path
 *
 * @returns {void}
 */
export function removeTree(path) {
    rmSync(path, RECURSIVE_REMOVAL_OPTIONS);
}

/**
 * @param {string} source
 * @param {string} destination
 * @param {{
 *     attempts?: number;
 *     baseDelayMs?: number;
 *     rename?: (source: string, destination: string) => void;
 *     sleep?: (milliseconds: number) => Promise<void>;
 * }} [options]
 *
 * @returns {Promise<void>}
 */
export async function renameWithRetry(source, destination, options = {}) {
    const attempts = options.attempts ?? 7;
    const baseDelayMs = options.baseDelayMs ?? 100;
    const rename = options.rename ?? renameSync;
    const sleep = options.sleep ?? delay;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            rename(source, destination);
            return;
        } catch (error) {
            const code =
                error instanceof Error ? Reflect.get(error, "code") : null;
            if (
                typeof code !== "string" ||
                !TRANSIENT_RENAME_CODES.has(code) ||
                attempt === attempts
            ) {
                throw error;
            }

            await sleep(Math.min(baseDelayMs * 2 ** (attempt - 1), 2_000));
        }
    }
}

/**
 * Atomically replace a file with a flushed sibling temporary file.
 *
 * @param {string} filePath
 * @param {string | NodeJS.ArrayBufferView} contents
 * @param {{ mode?: number }} [options]
 *
 * @returns {Promise<void>}
 */
export async function atomicWriteFile(filePath, contents, options = {}) {
    mkdirSync(dirname(filePath), { recursive: true });
    const temporaryFile = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor;
    try {
        descriptor = openSync(temporaryFile, "wx", options.mode ?? 0o600);
        writeFileSync(descriptor, contents);
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
        await renameWithRetry(temporaryFile, filePath);
    } catch (error) {
        if (typeof descriptor === "number") {
            try {
                closeSync(descriptor);
            } catch {
                // Preserve the primary write failure.
            }
        }

        rmSync(temporaryFile, { force: true });
        throw error;
    }
}

/**
 * @param {string} filePath
 * @param {unknown} value
 *
 * @returns {Promise<void>}
 */
export async function atomicWriteJson(filePath, value) {
    await atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * @param {string} path
 *
 * @returns {unknown}
 */
export function readJsonFile(path) {
    return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Reject UNC and Win32 device paths for transactions that depend on local,
 * same-volume rename semantics.
 *
 * @param {string} path
 *
 * @returns {void}
 */
export function assertLocalTransactionRoot(path) {
    if (
        process.platform === "win32" &&
        (/^\\\\(?:\?|\.)\\/v.test(path) || /^\\\\[^\\]/v.test(path))
    ) {
        throw new Error(
            `Nerd Fonts updates require a local non-UNC repository: ${path}`
        );
    }
}

/**
 * Realpath-aware containment check for destructive updater paths. Existing
 * symlink/junction components below the repository root are rejected.
 *
 * @param {string} repoRoot
 * @param {string} targetPath
 * @param {{ allowRoot?: boolean; rejectLinks?: boolean }} [options]
 *
 * @returns {string}
 */
export function assertSafeRepositoryPath(repoRoot, targetPath, options = {}) {
    const root = realpathSync.native(resolve(repoRoot));
    const target = resolve(targetPath);
    const lexicalRelative = relative(resolve(repoRoot), target);
    const allowRoot = options.allowRoot ?? false;
    const lexicallyInside =
        (allowRoot && lexicalRelative.length === 0) ||
        (lexicalRelative.length > 0 &&
            lexicalRelative !== ".." &&
            !lexicalRelative.startsWith(`..\\`) &&
            !lexicalRelative.startsWith("../") &&
            !isAbsolute(lexicalRelative));
    if (!lexicallyInside) {
        throw new Error(`Refusing path outside repository: ${target}`);
    }

    let existingAncestor = target;
    while (!existsSync(existingAncestor)) {
        const parent = dirname(existingAncestor);
        if (parent === existingAncestor) {
            throw new Error(`Unable to resolve repository path: ${target}`);
        }

        existingAncestor = parent;
    }

    const ancestorRealPath = realpathSync.native(existingAncestor);
    const realRelative = relative(root, ancestorRealPath);
    const realInside =
        realRelative.length === 0 ||
        (realRelative !== ".." &&
            !realRelative.startsWith(`..\\`) &&
            !realRelative.startsWith("../") &&
            !isAbsolute(realRelative));
    if (!realInside) {
        throw new Error(
            `Refusing repository path through an external link: ${target}`
        );
    }

    if (options.rejectLinks ?? true) {
        let current = resolve(repoRoot);
        const segments = lexicalRelative.split(/[\\/]/u).filter(Boolean);
        for (const segment of segments) {
            current = resolve(current, segment);
            if (!existsSync(current)) break;
            if (lstatSync(current).isSymbolicLink()) {
                throw new Error(
                    `Refusing destructive path through a symlink or junction: ${current}`
                );
            }
        }
    }

    return target;
}
