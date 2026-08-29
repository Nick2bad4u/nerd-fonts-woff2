/**
 * Reusable, process-isolated font conversion pool.
 *
 * Each child loads the native converter once and processes jobs sequentially. A
 * timed-out, disconnected, or crashed child is retired without stopping the
 * remaining pool; the next queued job receives a replacement process.
 */

import { fork } from "node:child_process";
import { performance } from "node:perf_hooks";

/**
 * @typedef {{
 *     convertMs: number;
 *     readMs: number;
 *     taskMs: number;
 *     writeMs: number;
 * }} WorkerPhaseTimings
 */

/**
 * @typedef {{
 *     convertMs: number | null;
 *     moduleMs: number;
 *     overheadMs: number | null;
 *     queueMs: number;
 *     readMs: number | null;
 *     totalMs: number;
 *     workerId: number;
 *     workerMs: number;
 *     workerReused: boolean;
 *     writeMs: number | null;
 * }} ConversionTimings
 */

/**
 * @typedef {{
 *     error?: string;
 *     ok: boolean;
 *     sizeBytes?: number;
 *     timings: ConversionTimings;
 * }} ConversionResult
 */

/**
 * @typedef {{
 *     assignedAt: number;
 *     enqueuedAt: number;
 *     outputPath: string;
 *     resolve: (result: ConversionResult) => void;
 *     sourcePath: string;
 *     timer: ReturnType<typeof setTimeout> | null;
 *     workerReused: boolean;
 * }} ConversionJob
 */

/**
 * @typedef {{
 *     child: import("node:child_process").ChildProcess;
 *     createdAt: number;
 *     currentJob: ConversionJob | null;
 *     id: number;
 *     jobsCompleted: number;
 *     moduleMs: number;
 *     ready: boolean;
 *     retired: boolean;
 *     workerMs: number;
 * }} ConversionWorker
 */

/**
 * @param {unknown} value
 *
 * @returns {value is number}
 */
function isNonnegativeFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * @param {unknown} value
 *
 * @returns {value is WorkerPhaseTimings}
 */
function isWorkerPhaseTimings(value) {
    if (typeof value !== "object" || value === null) return false;
    return (
        isNonnegativeFiniteNumber(Reflect.get(value, "convertMs")) &&
        isNonnegativeFiniteNumber(Reflect.get(value, "readMs")) &&
        isNonnegativeFiniteNumber(Reflect.get(value, "taskMs")) &&
        isNonnegativeFiniteNumber(Reflect.get(value, "writeMs"))
    );
}

/**
 * @param {unknown} value
 *
 * @returns {string}
 */
function describeError(value) {
    return value instanceof Error ? value.message : String(value);
}

/**
 * @param {ConversionWorker} worker
 * @param {ConversionJob} job
 * @param {WorkerPhaseTimings | null} phases
 * @param {number} endedAt
 *
 * @returns {ConversionTimings}
 */
function createTimings(worker, job, phases, endedAt) {
    const queueMs = Math.max(0, job.assignedAt - job.enqueuedAt);
    const workerMs = job.workerReused ? 0 : worker.workerMs;
    const moduleMs = job.workerReused ? 0 : worker.moduleMs;
    const totalMs = Math.max(0, endedAt - job.enqueuedAt);
    const phaseTotal =
        phases === null
            ? null
            : phases.readMs + phases.convertMs + phases.writeMs;
    const overheadMs =
        phaseTotal === null
            ? null
            : Math.max(0, totalMs - queueMs - workerMs - moduleMs - phaseTotal);

    return {
        convertMs: phases?.convertMs ?? null,
        moduleMs,
        overheadMs,
        queueMs,
        readMs: phases?.readMs ?? null,
        totalMs,
        workerId: worker.id,
        workerMs,
        workerReused: job.workerReused,
        writeMs: phases?.writeMs ?? null,
    };
}

export class FontConversionProcessPool {
    /** @type {boolean} */
    #closed = false;
    /** @type {ConversionWorker[]} */
    #idleWorkers = [];
    /** @type {number} */
    #nextWorkerId = 1;
    /** @type {ConversionJob[]} */
    #queue = [];
    /** @type {number} */
    #size;
    /** @type {number} */
    #timeoutMs;
    /** @type {Set<Promise<void>>} */
    #terminations = new Set();
    /** @type {URL} */
    #workerUrl;
    /** @type {Set<ConversionWorker>} */
    #workers = new Set();

    /**
     * @param {{ size: number; timeoutMs: number; workerUrl: URL }} options
     */
    constructor({ size, timeoutMs, workerUrl }) {
        if (!Number.isInteger(size) || size < 1 || size > 32) {
            throw new Error(
                "Worker-pool size must be an integer from 1 through 32."
            );
        }

        if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
            throw new Error(
                "Worker timeout must be a positive number of milliseconds."
            );
        }

        if (!(workerUrl instanceof URL)) {
            throw new TypeError("workerUrl must be a URL.");
        }

        this.#size = size;
        this.#timeoutMs = timeoutMs;
        this.#workerUrl = workerUrl;
    }

    /**
     * Queue one conversion. Conversion failures resolve with `ok: false` so a
     * single bad font does not reject or stop the rest of the catalog.
     *
     * @param {string} sourcePath
     * @param {string} outputPath
     *
     * @returns {Promise<ConversionResult>}
     */
    convert(sourcePath, outputPath) {
        if (this.#closed) {
            return Promise.resolve({
                error: "Font conversion worker pool is closed.",
                ok: false,
                timings: {
                    convertMs: null,
                    moduleMs: 0,
                    overheadMs: null,
                    queueMs: 0,
                    readMs: null,
                    totalMs: 0,
                    workerId: 0,
                    workerMs: 0,
                    workerReused: false,
                    writeMs: null,
                },
            });
        }

        return new Promise((resolvePromise) => {
            this.#queue.push({
                assignedAt: 0,
                enqueuedAt: performance.now(),
                outputPath,
                resolve: resolvePromise,
                sourcePath,
                timer: null,
                workerReused: false,
            });
            this.#drain();
        });
    }

    /**
     * Stop every child and fail any jobs still queued or active. Normal callers
     * invoke this after awaiting all conversions, making shutdown graceful.
     *
     * @returns {Promise<void>}
     */
    async close() {
        if (this.#closed) {
            await Promise.allSettled(this.#terminations);
            return;
        }

        this.#closed = true;
        const endedAt = performance.now();
        for (const job of this.#queue.splice(0)) {
            job.resolve({
                error: "Font conversion worker pool closed before the job started.",
                ok: false,
                timings: {
                    convertMs: null,
                    moduleMs: 0,
                    overheadMs: null,
                    queueMs: Math.max(0, endedAt - job.enqueuedAt),
                    readMs: null,
                    totalMs: Math.max(0, endedAt - job.enqueuedAt),
                    workerId: 0,
                    workerMs: 0,
                    workerReused: false,
                    writeMs: null,
                },
            });
        }

        const shutdowns = [];
        for (const worker of [...this.#workers]) {
            worker.retired = true;
            this.#workers.delete(worker);
            this.#removeIdleWorker(worker);
            if (worker.currentJob !== null) {
                this.#resolveJob(worker, {
                    error: "Font conversion worker pool closed during the job.",
                    ok: false,
                    phases: null,
                });
            }

            shutdowns.push(this.#terminateWorker(worker, true));
        }

        await Promise.allSettled(shutdowns);
        await Promise.allSettled(this.#terminations);
    }

    /** @returns {void} */
    #drain() {
        if (this.#closed) return;

        while (this.#queue.length > 0) {
            let worker = this.#idleWorkers.shift();
            if (worker === undefined && this.#workers.size < this.#size) {
                worker = this.#spawnWorker();
            }

            if (worker === undefined) return;
            const job = this.#queue.shift();
            if (job === undefined) return;
            this.#assign(worker, job);
        }
    }

    /**
     * @param {ConversionWorker} worker
     * @param {ConversionJob} job
     *
     * @returns {void}
     */
    #assign(worker, job) {
        job.assignedAt =
            worker.jobsCompleted === 0 && !worker.ready
                ? worker.createdAt
                : performance.now();
        job.workerReused = worker.jobsCompleted > 0;
        worker.currentJob = job;
        job.timer = setTimeout(() => {
            const suggestedTimeoutSeconds = Math.min(
                86_400,
                Math.ceil(this.#timeoutMs / 1000) + 600
            );
            this.#retireWorker(
                worker,
                [
                    `timed out after ${this.#timeoutMs / 1000}s`,
                    `source: ${job.sourcePath}`,
                    `Try --timeout=${suggestedTimeoutSeconds} and/or a lower --concurrency value.`,
                ].join(". "),
                true
            );
        }, this.#timeoutMs);

        if (worker.ready) this.#dispatch(worker);
    }

    /**
     * @param {ConversionWorker} worker
     *
     * @returns {void}
     */
    #dispatch(worker) {
        const job = worker.currentJob;
        if (job === null || worker.retired) return;

        try {
            worker.child.send({
                jobId: worker.jobsCompleted + 1,
                outputPath: job.outputPath,
                sourcePath: job.sourcePath,
                type: "convert",
            });
        } catch (error) {
            this.#retireWorker(
                worker,
                `failed to dispatch conversion: ${describeError(error)}`,
                true
            );
        }
    }

    /** @returns {ConversionWorker} */
    #spawnWorker() {
        const createdAt = performance.now();
        const child = fork(this.#workerUrl, [], {
            execArgv: [],
            serialization: "json",
            stdio: [
                "ignore",
                "inherit",
                "inherit",
                "ipc",
            ],
        });
        /** @type {ConversionWorker} */
        const worker = {
            child,
            createdAt,
            currentJob: null,
            id: this.#nextWorkerId,
            jobsCompleted: 0,
            moduleMs: 0,
            ready: false,
            retired: false,
            workerMs: 0,
        };
        this.#nextWorkerId += 1;
        this.#workers.add(worker);

        child.on("message", (message) => {
            this.#handleMessage(worker, message);
        });
        child.once("error", (error) => {
            this.#retireWorker(
                worker,
                `worker process error: ${describeError(error)}`,
                true
            );
        });
        child.once("disconnect", () => {
            this.#retireWorker(worker, "worker IPC channel disconnected", true);
        });
        child.once("exit", (code, signal) => {
            const reason =
                signal === null
                    ? `worker exited with code ${String(code)}`
                    : `worker exited after signal ${signal}`;
            this.#retireWorker(worker, reason, false);
        });

        return worker;
    }

    /**
     * @param {ConversionWorker} worker
     * @param {unknown} message
     *
     * @returns {void}
     */
    #handleMessage(worker, message) {
        if (worker.retired || typeof message !== "object" || message === null) {
            return;
        }

        const type = Reflect.get(message, "type");
        if (type === "ready") {
            if (worker.ready) {
                this.#retireWorker(
                    worker,
                    "worker sent more than one ready message",
                    true
                );
                return;
            }

            const moduleMs = Reflect.get(message, "moduleMs");
            if (!isNonnegativeFiniteNumber(moduleMs)) {
                this.#retireWorker(
                    worker,
                    "worker sent invalid module-load timing",
                    true
                );
                return;
            }

            const startupMs = Math.max(0, performance.now() - worker.createdAt);
            worker.moduleMs = moduleMs;
            worker.workerMs = Math.max(0, startupMs - moduleMs);
            worker.ready = true;
            this.#dispatch(worker);
            return;
        }

        if (type !== "result" || worker.currentJob === null) {
            this.#retireWorker(
                worker,
                "worker sent an unexpected protocol message",
                true
            );
            return;
        }

        const expectedJobId = worker.jobsCompleted + 1;
        const jobId = Reflect.get(message, "jobId");
        const ok = Reflect.get(message, "ok");
        const phases = Reflect.get(message, "timings");
        const sizeBytes = Reflect.get(message, "sizeBytes");
        const error = Reflect.get(message, "error");
        if (
            jobId !== expectedJobId ||
            typeof ok !== "boolean" ||
            !isWorkerPhaseTimings(phases) ||
            (sizeBytes !== undefined &&
                !isNonnegativeFiniteNumber(sizeBytes)) ||
            (error !== undefined && typeof error !== "string") ||
            (ok && (typeof sizeBytes !== "number" || error !== undefined)) ||
            (!ok && (typeof error !== "string" || sizeBytes !== undefined))
        ) {
            this.#retireWorker(
                worker,
                "worker sent an invalid conversion result",
                true
            );
            return;
        }

        this.#resolveJob(worker, {
            ...(typeof error === "string" ? { error } : {}),
            ok,
            phases,
            ...(typeof sizeBytes === "number" ? { sizeBytes } : {}),
        });
        worker.jobsCompleted += 1;
        if (!this.#closed && !worker.retired) {
            this.#idleWorkers.push(worker);
            this.#drain();
        }
    }

    /**
     * @param {ConversionWorker} worker
     * @param {{
     *     error?: string;
     *     ok: boolean;
     *     phases: WorkerPhaseTimings | null;
     *     sizeBytes?: number;
     * }} result
     *
     * @returns {void}
     */
    #resolveJob(worker, result) {
        const job = worker.currentJob;
        if (job === null) return;
        worker.currentJob = null;
        if (job.timer !== null) clearTimeout(job.timer);
        const endedAt = performance.now();
        job.resolve({
            ...(result.error === undefined ? {} : { error: result.error }),
            ok: result.ok,
            ...(result.sizeBytes === undefined
                ? {}
                : { sizeBytes: result.sizeBytes }),
            timings: createTimings(worker, job, result.phases, endedAt),
        });
    }

    /**
     * @param {ConversionWorker} worker
     * @param {string} error
     * @param {boolean} terminate
     *
     * @returns {void}
     */
    #retireWorker(worker, error, terminate) {
        if (worker.retired) return;
        worker.retired = true;
        this.#workers.delete(worker);
        this.#removeIdleWorker(worker);
        this.#resolveJob(worker, { error, ok: false, phases: null });
        if (terminate) {
            this.#trackTermination(this.#terminateWorker(worker, false));
        }

        this.#drain();
    }

    /**
     * @param {ConversionWorker} worker
     *
     * @returns {void}
     */
    #removeIdleWorker(worker) {
        const index = this.#idleWorkers.indexOf(worker);
        if (index >= 0) this.#idleWorkers.splice(index, 1);
    }

    /**
     * @param {Promise<void>} termination
     *
     * @returns {void}
     */
    #trackTermination(termination) {
        this.#terminations.add(termination);
        void termination.finally(() => {
            this.#terminations.delete(termination);
        });
    }

    /**
     * @param {ConversionWorker} worker
     * @param {boolean} graceful
     *
     * @returns {Promise<void>}
     */
    #terminateWorker(worker, graceful) {
        return new Promise((resolvePromise) => {
            if (
                worker.child.exitCode !== null ||
                worker.child.signalCode !== null
            ) {
                resolvePromise();
                return;
            }

            let settled = false;
            const forceTimer = setTimeout(
                () => {
                    worker.child.kill();
                },
                graceful ? 1000 : 0
            );
            const settle = () => {
                if (settled) return;
                settled = true;
                clearTimeout(forceTimer);
                resolvePromise();
            };
            worker.child.once("exit", settle);
            worker.child.once("close", settle);

            if (graceful && worker.child.connected) {
                try {
                    worker.child.send({ type: "shutdown" }, (error) => {
                        if (error !== null) worker.child.kill();
                    });
                } catch {
                    worker.child.kill();
                }
            }
        });
    }
}
