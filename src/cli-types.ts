export type ParsedOptions = Record<string, string | boolean | string[]>;

export type ErrorCategory =
    | "validation_error"
    | "dependency_error"
    | "runtime_error";

export type Mode = "plan" | "convert";

export type PlannedFontFile = {
    relativeInputPath: string;
    relativeOutputPath: string;
    sourcePath: string;
    sourceRoot: string;
};

export type FontIndexEntry = {
    converted: boolean;
    family: string;
    fileName: string;
    outputPath: string;
    sizeBytes: number | null;
    sourcePath: string;
};

export type RunSummary = {
    converted: number;
    dryRun: boolean;
    durationMs: number;
    failed: number;
    failures: string[];
    indexFile?: string;
    mode: Mode;
    outDir: string;
    planned: number;
    skipped: number;
    tempDir: string;
};
