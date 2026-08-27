import { spawn } from "node:child_process";

const DEFAULT_TAIL_BYTES = 1024 * 1024;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Node clamps overflowing timer delays to one millisecond. Conversion deadlines
 * can legitimately exceed that limit, so schedule them in bounded segments
 * against one fixed wall-clock deadline.
 *
 * @param {() => void} callback
 * @param {number} delayMs
 *
 * @returns {{ clear: () => void }}
 */
function createDeadlineTimer(callback, delayMs) {
    const deadlineMs = Date.now() + delayMs;
    /** @type {NodeJS.Timeout | undefined} */
    let timer;

    function scheduleNextSegment() {
        const remainingMs = deadlineMs - Date.now();
        if (remainingMs <= 0) {
            callback();
            return;
        }
        timer = setTimeout(
            scheduleNextSegment,
            Math.min(remainingMs, MAX_TIMER_DELAY_MS)
        );
        timer.unref();
    }

    scheduleNextSegment();
    return {
        clear() {
            if (timer !== undefined) clearTimeout(timer);
        },
    };
}

/**
 * @param {string} value
 *
 * @returns {string}
 */
export function quoteCommandArgument(value) {
    if (/^[\w./:=@+,\-]+$/u.test(value)) return value;
    return `"${value.replaceAll('"', '\\"')}"`;
}

/**
 * @param {string} command
 * @param {readonly string[]} argumentsList
 *
 * @returns {string}
 */
export function formatCommand(command, argumentsList) {
    return [command, ...argumentsList].map(quoteCommandArgument).join(" ");
}

export class CommandExecutionError extends Error {
    /**
     * @param {string} message
     * @param {{
     *     absoluteTimeoutMs?: number | undefined;
     *     argumentsList: readonly string[];
     *     cause?: unknown;
     *     command: string;
     *     cwd: string;
     *     durationMs: number;
     *     exitCode: number | null;
     *     signal: NodeJS.Signals | null;
     *     stderr: string;
     *     stdout: string;
     *     timeoutKind?: "absolute" | "inactivity" | undefined;
     * }} details
     */
    constructor(message, details) {
        super(
            message,
            details.cause === undefined ? undefined : { cause: details.cause }
        );
        this.name = "CommandExecutionError";
        this.absoluteTimeoutMs = details.absoluteTimeoutMs;
        this.argumentsList = [...details.argumentsList];
        this.command = details.command;
        this.cwd = details.cwd;
        this.durationMs = details.durationMs;
        this.exitCode = details.exitCode;
        this.signal = details.signal;
        this.stderr = details.stderr;
        this.stdout = details.stdout;
        this.timeoutKind = details.timeoutKind;
    }
}

/** @param {Buffer} current @param {Buffer} chunk @param {number} maximum */
function appendTail(current, chunk, maximum) {
    const combined = Buffer.concat([current, chunk]);
    return combined.length <= maximum
        ? combined
        : combined.subarray(combined.length - maximum);
}

/**
 * GitHub credentials are consumed only by the updater's in-process API client.
 * Local tool children do not need them and must not inherit them.
 *
 * @param {NodeJS.ProcessEnv | undefined} environment
 *
 * @returns {NodeJS.ProcessEnv}
 */
function createChildEnvironment(environment) {
    const sanitized = { ...(environment ?? process.env) };
    for (const name of Object.keys(sanitized)) {
        if (name.toUpperCase() === "GITHUB_TOKEN") {
            Reflect.deleteProperty(sanitized, name);
        }
    }

    return sanitized;
}

/**
 * @param {import("node:child_process").ChildProcess} child
 * @param {boolean} force
 *
 * @returns {Promise<void>}
 */
async function terminateProcessTree(child, force) {
    if (child.pid === undefined) return;

    if (process.platform === "win32") {
        await new Promise((resolvePromise) => {
            const argumentsList = [
                "/PID",
                String(child.pid),
                "/T",
            ];
            if (force) argumentsList.push("/F");
            const killer = spawn("taskkill.exe", argumentsList, {
                env: createChildEnvironment(undefined),
                shell: false,
                stdio: "ignore",
                windowsHide: true,
            });
            killer.once("error", () => resolvePromise(undefined));
            killer.once("exit", () => resolvePromise(undefined));
        });
        return;
    }

    try {
        process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
    } catch {
        child.kill(force ? "SIGKILL" : "SIGTERM");
    }
}

/**
 * Run a child without accumulating its complete output. In JSON mode both child
 * streams are forwarded to stderr so the parent owns stdout.
 *
 * @param {string} command
 * @param {readonly string[]} argumentsList
 * @param {{
 *     absoluteTimeoutMs?: number;
 *     cwd: string;
 *     env?: NodeJS.ProcessEnv;
 *     inactivityTimeoutMs?: number;
 *     killGraceMs?: number;
 *     maxTailBytes?: number;
 *     mode?: "capture" | "interactive" | "json";
 *     stderr?: NodeJS.WritableStream;
 *     stdout?: NodeJS.WritableStream;
 * }} options
 *
 * @returns {Promise<{
 *     durationMs: number;
 *     exitCode: number;
 *     signal: NodeJS.Signals | null;
 *     stderr: string;
 *     stdout: string;
 * }>}
 */
export function runCommand(command, argumentsList, options) {
    const startedAt = Date.now();
    const maxTailBytes = options.maxTailBytes ?? DEFAULT_TAIL_BYTES;
    const mode = options.mode ?? "interactive";
    const outputStream = options.stdout ?? process.stdout;
    const errorStream = options.stderr ?? process.stderr;

    return new Promise((resolvePromise, rejectPromise) => {
        const child = spawn(command, argumentsList, {
            cwd: options.cwd,
            detached: process.platform !== "win32",
            env: createChildEnvironment(options.env),
            shell: false,
            stdio: [
                "ignore",
                "pipe",
                "pipe",
            ],
            windowsHide: true,
        });
        let settled = false;
        let stdoutTail = Buffer.alloc(0);
        let stderrTail = Buffer.alloc(0);
        /** @type {{ clear: () => void } | undefined} */
        let absoluteTimer;
        /** @type {{ clear: () => void } | undefined} */
        let inactivityTimer;
        /** @type {"absolute" | "inactivity" | undefined} */
        let timeoutKind;
        /** @type {Promise<void> | undefined} */
        let timeoutCleanup;

        function clearTimers() {
            absoluteTimer?.clear();
            inactivityTimer?.clear();
        }

        function resetInactivityTimer() {
            if (options.inactivityTimeoutMs === undefined) return;
            inactivityTimer?.clear();
            inactivityTimer = createDeadlineTimer(() => {
                void beginTimeout("inactivity");
            }, options.inactivityTimeoutMs);
        }

        /** @param {"absolute" | "inactivity"} kind */
        function beginTimeout(kind) {
            if (settled || timeoutKind !== undefined) return;
            timeoutKind = kind;
            timeoutCleanup = (async () => {
                await terminateProcessTree(child, false);
                await new Promise((resolvePromise) => {
                    setTimeout(resolvePromise, options.killGraceMs ?? 5_000);
                });
                await terminateProcessTree(child, true);
            })();
        }

        child.stdout?.on("data", (value) => {
            const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
            stdoutTail = appendTail(stdoutTail, chunk, maxTailBytes);
            resetInactivityTimer();
            if (mode === "interactive") outputStream.write(chunk);
            else if (mode === "json") errorStream.write(chunk);
        });
        child.stderr?.on("data", (value) => {
            const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
            stderrTail = appendTail(stderrTail, chunk, maxTailBytes);
            resetInactivityTimer();
            if (mode !== "capture") errorStream.write(chunk);
        });

        child.once("error", (cause) => {
            if (settled) return;
            settled = true;
            clearTimers();
            const durationMs = Date.now() - startedAt;
            rejectPromise(
                new CommandExecutionError(
                    `Unable to start ${formatCommand(command, argumentsList)}: ${cause.message}`,
                    {
                        argumentsList,
                        cause,
                        command,
                        cwd: options.cwd,
                        durationMs,
                        exitCode: null,
                        signal: null,
                        stderr: stderrTail.toString("utf8"),
                        stdout: stdoutTail.toString("utf8"),
                    }
                )
            );
        });

        child.once("close", (exitCode, signal) => {
            if (settled) return;
            settled = true;
            clearTimers();
            void finishClose(exitCode, signal);
        });

        /**
         * @param {number | null} exitCode
         * @param {NodeJS.Signals | null} signal
         */
        async function finishClose(exitCode, signal) {
            await timeoutCleanup;
            const durationMs = Date.now() - startedAt;
            const stdout = stdoutTail.toString("utf8");
            const stderr = stderrTail.toString("utf8");
            if (exitCode === 0 && timeoutKind === undefined) {
                resolvePromise({
                    durationMs,
                    exitCode,
                    signal,
                    stderr,
                    stdout,
                });
                return;
            }

            const timeoutDescription =
                timeoutKind === undefined
                    ? "failed"
                    : `timed out (${timeoutKind})`;
            const diagnostic = stderr.trim() || stdout.trim();
            rejectPromise(
                new CommandExecutionError(
                    `${formatCommand(command, argumentsList)} ${timeoutDescription}${
                        diagnostic.length > 0 ? `: ${diagnostic}` : ""
                    }`,
                    {
                        absoluteTimeoutMs: options.absoluteTimeoutMs,
                        argumentsList,
                        command,
                        cwd: options.cwd,
                        durationMs,
                        exitCode,
                        signal,
                        stderr,
                        stdout,
                        timeoutKind,
                    }
                )
            );
        }

        if (options.absoluteTimeoutMs !== undefined) {
            absoluteTimer = createDeadlineTimer(() => {
                void beginTimeout("absolute");
            }, options.absoluteTimeoutMs);
        }
        resetInactivityTimer();
    });
}
