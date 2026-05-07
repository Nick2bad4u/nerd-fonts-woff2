import { stripVTControlCharacters } from "node:util";

import type { ColorMode, Styler, UnicodeMode } from "./cli-types.js";

export function createStyler(useColor: boolean): Styler {
    const apply = (code: string, text: string): string =>
        useColor ? `\u001b[${code}m${text}\u001b[0m` : text;

    const status = (text: string): string => {
        const normalized = text.toLowerCase();
        if (
            normalized.includes("failure") ||
            normalized.includes("timed_out")
        ) {
            return apply("31", text);
        }
        if (normalized.includes("cancelled") || normalized.includes("stale")) {
            return apply("33", text);
        }
        if (normalized.includes("success")) {
            return apply("32", text);
        }
        if (
            normalized.includes("in_progress") ||
            normalized.includes("queued")
        ) {
            return apply("36", text);
        }
        return apply("90", text);
    };

    return {
        heading: (text) => apply("1;36", text),
        strong: (text) => apply("1", text),
        info: (text) => apply("36", text),
        muted: (text) => apply("90", text),
        ok: (text) => apply("32", text),
        warn: (text) => apply("33", text),
        error: (text) => apply("31", text),
        status,
        count: (value) => {
            if (value === 0) return apply("90", String(value));
            if (value > 0) return apply("1;36", String(value));
            return String(value);
        },
        flag: (text) => apply("38;5;51", text),
        arg: (text) => apply("38;5;221", text),
    };
}

function visibleLength(value: string): number {
    return stripVTControlCharacters(value).length;
}

function padVisible(value: string, width: number): string {
    const difference = width - visibleLength(value);
    return difference > 0 ? `${value}${" ".repeat(difference)}` : value;
}

export function shouldUseColor(mode: ColorMode, asJson: boolean): boolean {
    if (asJson) {
        return false;
    }

    if (mode === "always") {
        return true;
    }

    if (mode === "never") {
        return false;
    }

    if (process.env["NO_COLOR"] !== undefined) {
        return false;
    }

    const forced = process.env["FORCE_COLOR"];
    if (typeof forced === "string") {
        return forced !== "0";
    }

    return process.stdout.isTTY;
}

export function shouldUseUnicode(mode: UnicodeMode, asJson: boolean): boolean {
    if (asJson) {
        return false;
    }

    if (mode === "always") {
        return true;
    }

    if (mode === "never") {
        return false;
    }

    const term = process.env["TERM"];
    if (term === "dumb") {
        return false;
    }

    return process.stdout.isTTY;
}

export function formatTable(
    headers: string[],
    rows: string[][],
    useUnicode: boolean
): string {
    const widths = headers.map((header, column) =>
        Math.max(
            visibleLength(header),
            ...rows.map((row) => visibleLength(row[column] ?? ""))
        )
    );

    const style = useUnicode
        ? {
              tl: "┌",
              tr: "┐",
              bl: "└",
              br: "┘",
              h: "─",
              v: "│",
              j: "┼",
              tt: "┬",
              bt: "┴",
              lt: "├",
              rt: "┤",
          }
        : {
              tl: "+",
              tr: "+",
              bl: "+",
              br: "+",
              h: "-",
              v: "|",
              j: "+",
              tt: "+",
              bt: "+",
              lt: "+",
              rt: "+",
          };

    const horizontal = widths.map((width) => style.h.repeat(width + 2));
    const top = `${style.tl}${horizontal.join(style.tt)}${style.tr}`;
    const middle = `${style.lt}${horizontal.join(style.j)}${style.rt}`;
    const bottom = `${style.bl}${horizontal.join(style.bt)}${style.br}`;

    const cellSep = ` ${style.v} `;
    const renderRow = (cells: string[]): string =>
        `${style.v} ${cells
            .map((cell, index) => padVisible(cell, widths[index] ?? 0))
            .join(cellSep)} ${style.v}`;

    const lines = [
        top,
        renderRow(headers),
        middle,
        ...rows.map((row) => renderRow(row)),
        bottom,
    ];

    return lines.join("\n");
}

export function shouldShowProgress(
    asJson: boolean,
    quiet: boolean,
    verbose: boolean,
    noProgress: boolean,
    ciMode: boolean
): boolean {
    return (
        !asJson &&
        !quiet &&
        !verbose &&
        !noProgress &&
        !ciMode &&
        process.stdout.isTTY
    );
}

export type ProgressState = {
    done: () => void;
    update: (completed: number, suffix?: string) => void;
};

function computeSuffixText(budget: number | undefined, suffix: string): string {
    if (typeof budget !== "number") return suffix;
    if (budget <= 0) return "";
    return suffix.length <= budget
        ? suffix
        : `${suffix.slice(0, Math.max(0, budget - 1))}\u2026`;
}

export function createProgressBar(
    title: string,
    total: number,
    styler: Styler,
    enabled: boolean
): ProgressState {
    if (!enabled || total <= 0) {
        return {
            done: () => {},
            update: () => {},
        };
    }

    const width = 24;
    const totalSafe = Math.max(1, total);

    const render = (completed: number, suffix = ""): void => {
        const clamped = Math.min(Math.max(completed, 0), totalSafe);
        const percent = Math.floor((clamped / totalSafe) * 100);
        const filled = Math.round((clamped / totalSafe) * width);
        const bar = `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
        const progressText = `${clamped}/${totalSafe}`;
        const plainPrefix = `${title} [${bar}] ${progressText} ${percent}%`;
        const terminalWidth = process.stdout.columns;
        const suffixBudget =
            typeof terminalWidth === "number" && terminalWidth > 0
                ? Math.max(0, terminalWidth - plainPrefix.length - 1)
                : undefined;

        const suffixText = computeSuffixText(suffixBudget, suffix);
        const percentStr = `${percent}%`;
        const suffixPart =
            suffixText.length > 0 ? ` ${styler.muted(suffixText)}` : "";
        const line = `${styler.info(title)} ${styler.muted("[")}${styler.ok(bar)}${styler.muted("]")} ${styler.strong(progressText)} ${styler.muted(percentStr)}${suffixPart}`;
        process.stdout.write(`\r\u001b[2K${line}`);
    };

    render(0);

    return {
        update: (completed, suffix = "") => {
            render(completed, suffix);
        },
        done: () => {
            render(totalSafe);
            process.stdout.write("\n");
        },
    };
}
