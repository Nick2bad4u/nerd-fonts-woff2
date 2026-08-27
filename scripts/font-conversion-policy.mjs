/**
 * Shared defaults and retry scheduling for the quality-11 WOFF2 converter.
 *
 * Keep these values in one module so the updater's parent-process watchdog and
 * the bulk converter always describe and enforce the same workload.
 */

export const DEFAULT_CONVERSION_CONCURRENCY = 4;
export const DEFAULT_FONT_TIMEOUT_SECONDS = 1200;
export const DEFAULT_TIMEOUT_RETRIES = 2;
export const FAILURE_DETAIL_LIMIT = 20;
export const MAX_FONT_TIMEOUT_SECONDS = 86_400;
export const MAX_TIMEOUT_RETRIES = 2;

const RETRY_TIMEOUT_INCREMENT_SECONDS = 600;

/**
 * @typedef {{
 *     concurrency: number;
 *     number: number;
 *     timeoutSeconds: number;
 * }} ConversionPass
 */

/**
 * Build the primary conversion pass plus progressively more conservative
 * timeout-only retry passes.
 *
 * @param {number} concurrency
 * @param {number} timeoutSeconds
 * @param {number} timeoutRetries
 *
 * @returns {ConversionPass[]}
 */
export function createConversionPasses(
    concurrency,
    timeoutSeconds,
    timeoutRetries
) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
        throw new Error(
            "Conversion concurrency must be an integer from 1 through 32."
        );
    }
    if (
        !Number.isInteger(timeoutSeconds) ||
        timeoutSeconds < 1 ||
        timeoutSeconds > MAX_FONT_TIMEOUT_SECONDS
    ) {
        throw new Error(
            `Font timeout must be an integer from 1 through ${MAX_FONT_TIMEOUT_SECONDS}.`
        );
    }
    if (
        !Number.isInteger(timeoutRetries) ||
        timeoutRetries < 0 ||
        timeoutRetries > MAX_TIMEOUT_RETRIES
    ) {
        throw new Error(
            `Timeout retries must be an integer from 0 through ${MAX_TIMEOUT_RETRIES}.`
        );
    }

    /** @type {ConversionPass[]} */
    const passes = [];
    for (let retry = 0; retry <= timeoutRetries; retry += 1) {
        const passConcurrency =
            retry === 0
                ? concurrency
                : retry === 1
                  ? Math.max(1, Math.ceil(concurrency / 2))
                  : 1;
        passes.push({
            concurrency: passConcurrency,
            number: retry + 1,
            timeoutSeconds: Math.min(
                MAX_FONT_TIMEOUT_SECONDS,
                timeoutSeconds + retry * RETRY_TIMEOUT_INCREMENT_SECONDS
            ),
        });
    }

    return passes;
}

/**
 * Calculate a deliberately conservative parent-process deadline that permits
 * every font to consume every configured pass deadline.
 *
 * @param {number} sourceCount
 * @param {readonly ConversionPass[]} passes
 *
 * @returns {number}
 */
export function calculateConversionDeadlineMs(sourceCount, passes) {
    if (!Number.isSafeInteger(sourceCount) || sourceCount < 1) {
        throw new Error("Source count must be a positive safe integer.");
    }
    if (passes.length === 0) {
        throw new Error("At least one conversion pass is required.");
    }

    const workloadMs = passes.reduce(
        (total, pass) =>
            total +
            Math.ceil(sourceCount / pass.concurrency) *
                pass.timeoutSeconds *
                1000,
        0
    );
    return workloadMs + 15 * 60 * 1000;
}

/**
 * @param {string} message
 *
 * @returns {boolean}
 */
export function isFontTimeoutMessage(message) {
    return /timed out after \d+(?:\.\d+)?s\b/iv.test(message);
}

/**
 * Keep ordinary failures final while selecting only timeout failures for the
 * next, more conservative pass.
 *
 * @template {{ sourcePath: string; timedOut: boolean }} T
 *
 * @param {readonly T[]} failures
 * @param {boolean} retryAvailable
 *
 * @returns {{ finalFailures: T[]; retrySources: string[] }}
 */
export function partitionConversionFailures(failures, retryAvailable) {
    /** @type {T[]} */
    const finalFailures = [];
    /** @type {string[]} */
    const retrySources = [];

    for (const failure of failures) {
        if (failure.timedOut && retryAvailable) {
            retrySources.push(failure.sourcePath);
        } else {
            finalFailures.push(failure);
        }
    }

    return { finalFailures, retrySources };
}
