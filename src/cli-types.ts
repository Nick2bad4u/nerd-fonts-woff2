/** The category of a CLI error, used for structured JSON error output. */
export type ErrorCategory =
    | "dependency_error"
    | "runtime_error"
    | "validation_error";

/**
 * A single entry in the generated font asset index file. Each entry describes
 * one planned or converted font file.
 */
export type FontIndexEntry = {
    converted: boolean;
    family: string;
    fileName: string;
    outputPath: string;
    sizeBytes: null | number;
    sourcePath: string;
};

/** The CLI execution mode — `plan` previews work, `convert` writes output files. */
export type Mode = "convert" | "plan";

/**
 * A parsed representation of CLI arguments. Keys are flag names (without `--`),
 * values are booleans, strings, or lists.
 */
export type ParsedOptions = Record<
    string,
    boolean | readonly string[] | string
>;

/**
 * Describes a single font file that has been discovered and is ready to
 * convert.
 */
export type PlannedFontFile = {
    relativeInputPath: string;
    relativeOutputPath: string;
    sourcePath: string;
    sourceRoot: string;
};

/** A summary of the completed CLI run, written to stdout (text or JSON). */
export type RunSummary = {
    converted: number;
    dryRun: boolean;
    durationMs: number;
    failed: number;
    failures: readonly string[];
    indexFile?: string;
    mode: Mode;
    outDir: string;
    planned: number;
    skipped: number;
    tempDir: string;
};
