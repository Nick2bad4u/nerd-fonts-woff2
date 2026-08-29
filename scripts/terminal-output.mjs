/** Dependency-free ANSI and durable terminal-output helpers. */

export const ANSI = Object.freeze({
    bold: "\u001B[1m",
    cyan: "\u001B[36m",
    dim: "\u001B[2m",
    green: "\u001B[32m",
    magenta: "\u001B[35m",
    red: "\u001B[31m",
    reset: "\u001B[0m",
    yellow: "\u001B[33m",
});

/**
 * @param {number} milliseconds
 *
 * @returns {string}
 */
export function formatDuration(milliseconds) {
    const bounded = Math.max(0, milliseconds);
    if (bounded < 1000) {
        const rounded = Math.round(bounded * 10) / 10;
        return `${rounded}ms`;
    }
    if (bounded < 60_000) return `${(bounded / 1000).toFixed(1)}s`;

    const totalSeconds = Math.floor(bounded / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return hours > 0
        ? `${hours}h ${minutes}m ${seconds}s`
        : `${minutes}m ${seconds}s`;
}

/**
 * @param {number | null | undefined} bytes
 *
 * @returns {string}
 */
export function formatBytes(bytes) {
    if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
        return "unknown size";
    }

    const units = [
        "B",
        "KiB",
        "MiB",
        "GiB",
    ];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }

    return `${value < 10 && unitIndex > 0 ? value.toFixed(1) : value.toFixed(0)} ${units[unitIndex]}`;
}

/**
 * @param {number} completed
 * @param {number} total
 * @param {number} [width]
 *
 * @returns {string}
 */
export function renderProgressBar(completed, total, width = 16) {
    if (!Number.isInteger(total) || total < 1) {
        throw new Error("Progress requires at least one item.");
    }

    if (!Number.isInteger(width) || width < 1) {
        throw new Error("Progress-bar width must be a positive integer.");
    }

    const boundedCompleted = Math.min(total, Math.max(0, completed));
    const filled = Math.round((boundedCompleted / total) * width);
    return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

/**
 * Honor an explicit flag first, then terminal capability and the NO_COLOR
 * convention for automatic mode.
 *
 * @param {boolean | null} setting
 * @param {{ isTTY?: boolean }} stream
 *
 * @returns {boolean}
 */
export function resolveColorEnabled(setting, stream) {
    if (setting !== null) return setting;
    return stream.isTTY === true && !Object.hasOwn(process.env, "NO_COLOR");
}

/**
 * @param {boolean} enabled
 * @param {string | readonly string[]} codes
 * @param {string} text
 *
 * @returns {string}
 */
export function styleText(enabled, codes, text) {
    if (!enabled) return text;
    const prefix = Array.isArray(codes) ? codes.join("") : codes;
    return `${prefix}${text}${ANSI.reset}`;
}
