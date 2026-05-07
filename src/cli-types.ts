export type WorkflowRun = {
    databaseId: number;
    status?: string;
    conclusion?: string;
    workflowName?: string;
    headBranch?: string;
    event?: string;
    createdAt?: string;
    displayTitle?: string;
    url?: string;
};

export type ParsedOptions = Record<string, string | boolean | string[]>;

export type ColorMode = "auto" | "always" | "never";
export type UnicodeMode = "auto" | "always" | "never";

export type GhResponse = {
    stdout: string;
    stderr: string;
    status: number;
};

export type ErrorCategory =
    | "validation_error"
    | "auth_error"
    | "gh_cli_error"
    | "runtime_error";

export type DeleteResult = {
    attempts: number;
    error?: string;
    ok: boolean;
};

export type RunSummary = {
    attempted: number;
    deleted: number;
    dryRun: boolean;
    durationMs: number;
    failed: number;
    failedIds: number[];
    matched: number;
    repo: string;
    planned: number;
    skippedByExclusion: number;
    statuses: string[];
    skippedByAge: number;
};

export type Styler = {
    heading: (text: string) => string;
    strong: (text: string) => string;
    info: (text: string) => string;
    muted: (text: string) => string;
    ok: (text: string) => string;
    warn: (text: string) => string;
    error: (text: string) => string;
    status: (text: string) => string;
    count: (value: number) => string;
    flag: (text: string) => string;
    arg: (text: string) => string;
};

export const VALID_STATUSES = new Set([
    "queued",
    "completed",
    "in_progress",
    "requested",
    "waiting",
    "pending",
    "action_required",
    "cancelled",
    "failure",
    "neutral",
    "skipped",
    "stale",
    "startup_failure",
    "success",
    "timed_out",
]);
