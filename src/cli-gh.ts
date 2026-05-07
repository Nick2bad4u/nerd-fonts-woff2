import { spawnSync } from "node:child_process";

import type {
    DeleteResult,
    GhResponse,
    ParsedOptions,
    WorkflowRun,
} from "./cli-types.js";

export function runGh(args: string[], capture = true): GhResponse {
    const result = spawnSync("gh", args, {
        encoding: "utf8",
        stdio: capture ? "pipe" : "inherit",
    });

    return {
        stdout: result.stdout,
        stderr: result.stderr,
        status: result.status ?? 1,
    };
}

export function resolveRepo(
    optionRepo: string | undefined
): string | undefined {
    if (typeof optionRepo === "string" && optionRepo.length > 0) {
        return optionRepo;
    }

    const response = runGh([
        "repo",
        "view",
        "--json",
        "nameWithOwner",
        "--jq",
        ".nameWithOwner",
    ]);

    if (response.status !== 0) {
        return undefined;
    }

    const resolved = response.stdout.trim();
    return resolved.length > 0 ? resolved : undefined;
}

export function resolveAuthenticatedLogin(): string | undefined {
    const response = runGh([
        "api",
        "user",
        "--jq",
        ".login",
    ]);

    if (response.status !== 0) {
        return undefined;
    }

    const login = response.stdout.trim();
    return login.length > 0 ? login : undefined;
}

export function listReposForOwner(owner: string): string[] {
    const response = runGh([
        "repo",
        "list",
        owner,
        "--limit",
        "1000",
        "--json",
        "nameWithOwner",
    ]);

    if (response.status !== 0) {
        throw new Error(
            response.stderr || `failed to list repositories for ${owner}`
        );
    }

    const parsed: unknown = JSON.parse(response.stdout || "[]");
    if (!Array.isArray(parsed)) {
        return [];
    }

    return parsed
        .filter((entry) => entry && typeof entry === "object")
        .map((entry) => (entry as { nameWithOwner?: string }).nameWithOwner)
        .filter(
            (name): name is string =>
                typeof name === "string" && name.length > 0
        );
}

type ListRunsProgressCallback = (
    fetchedInStatus: number,
    detail: string
) => void;

function listRunsViaGhRunList(
    repo: string,
    status: string,
    options: ParsedOptions,
    onProgress?: ListRunsProgressCallback
): WorkflowRun[] {
    const args = [
        "run",
        "list",
        "--repo",
        repo,
        "--status",
        status,
        "--limit",
        String(options["limit"] ?? "500"),
        "--json",
        "databaseId,status,conclusion,workflowName,headBranch,event,createdAt,displayTitle,url",
    ];

    const mappings: Array<[keyof ParsedOptions, string]> = [
        ["workflow", "--workflow"],
        ["branch", "--branch"],
        ["event", "--event"],
        ["user", "--user"],
        ["commit", "--commit"],
        ["created", "--created"],
    ];

    for (const [key, flag] of mappings) {
        const value = options[key];
        if (typeof value === "string" && value.length > 0) {
            args.push(flag, value);
        }
    }

    const response = runGh(args);
    if (response.status !== 0) {
        throw new Error(
            response.stderr || `gh run list failed for status ${status}`
        );
    }

    const parsed: unknown = JSON.parse(response.stdout || "[]");
    if (!Array.isArray(parsed)) {
        return [];
    }

    const runs = parsed
        .filter((entry) => entry && typeof entry === "object")
        .map((entry) => entry as WorkflowRun);

    onProgress?.(runs.length, "legacy-list");
    return runs;
}

export function listRuns(
    repo: string,
    status: string,
    options: ParsedOptions,
    onProgress?: ListRunsProgressCallback
): WorkflowRun[] {
    const workflowValue = options["workflow"];
    if (typeof workflowValue === "string" && workflowValue.length > 0) {
        return listRunsViaGhRunList(repo, status, options, onProgress);
    }

    const limit = Number.parseInt(String(options["limit"] ?? "500"), 10);
    const pageSize = 100;
    const allRuns: WorkflowRun[] = [];

    const queryMappings: Array<[keyof ParsedOptions, string]> = [
        ["branch", "branch"],
        ["event", "event"],
        ["user", "actor"],
        ["commit", "head_sha"],
        ["created", "created"],
    ];

    for (let page = 1; allRuns.length < limit; page += 1) {
        const remaining = limit - allRuns.length;
        const perPage = Math.min(pageSize, remaining);
        const args = [
            "api",
            "-X",
            "GET",
            `/repos/${repo}/actions/runs`,
            "-f",
            `status=${status}`,
            "-f",
            `per_page=${perPage}`,
            "-f",
            `page=${page}`,
        ];

        for (const [key, queryKey] of queryMappings) {
            const value = options[key];
            if (typeof value === "string" && value.length > 0) {
                args.push("-f", `${queryKey}=${value}`);
            }
        }

        const response = runGh(args);
        if (response.status !== 0) {
            throw new Error(
                response.stderr || `gh api run list failed for status ${status}`
            );
        }

        const parsed: unknown = JSON.parse(response.stdout || "{}");
        const workflowRuns =
            parsed &&
            typeof parsed === "object" &&
            Array.isArray(
                (parsed as { workflow_runs?: unknown[] }).workflow_runs
            )
                ? (parsed as { workflow_runs: unknown[] }).workflow_runs
                : [];

        const mappedRuns = workflowRuns
            .filter((entry) => entry && typeof entry === "object")
            .map((entry) => {
                const run = entry as {
                    id?: number;
                    status?: string;
                    conclusion?: string;
                    name?: string;
                    workflow_name?: string;
                    head_branch?: string;
                    event?: string;
                    created_at?: string;
                    display_title?: string;
                    html_url?: string;
                };

                return {
                    createdAt: run.created_at,
                    conclusion: run.conclusion,
                    databaseId: run.id ?? 0,
                    displayTitle: run.display_title,
                    event: run.event,
                    headBranch: run.head_branch,
                    status: run.status,
                    url: run.html_url,
                    workflowName: run.workflow_name ?? run.name,
                } as WorkflowRun;
            })
            .filter((run) => run.databaseId > 0);

        allRuns.push(...mappedRuns);
        onProgress?.(allRuns.length, `p=${page}`);

        if (mappedRuns.length < perPage) {
            break;
        }
    }

    return allRuns.slice(0, limit);
}

function waitMs(milliseconds: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function isRetryableDeleteError(stderr: string): boolean {
    const retryPattern =
        /timed out|timeout|rate limit|temporar|unavailable|internal server error|502|503|504|connection reset/iu;
    return retryPattern.test(stderr);
}

export function deleteRunWithRetry(
    repo: string,
    runId: number,
    maxRetries: number,
    baseDelayMs: number,
    onAttempt?: (attempt: number, totalAttempts: number) => void
): DeleteResult {
    const endpoint = `/repos/${repo}/actions/runs/${runId}`;
    let lastError = "";
    const totalAttempts = maxRetries + 1;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        onAttempt?.(attempt + 1, totalAttempts);
        const response = runGh([
            "api",
            "-X",
            "DELETE",
            endpoint,
        ]);
        if (response.status === 0) {
            return { attempts: attempt + 1, ok: true };
        }

        lastError =
            response.stderr ||
            `gh api delete failed with status ${response.status}`;
        const shouldRetry =
            attempt < maxRetries && isRetryableDeleteError(lastError);

        if (!shouldRetry) {
            return { attempts: attempt + 1, error: lastError, ok: false };
        }

        waitMs(baseDelayMs * 2 ** attempt);
    }

    return {
        attempts: maxRetries + 1,
        error: lastError || "unknown delete error",
        ok: false,
    };
}
