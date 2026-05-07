#!/usr/bin/env node

import { fileURLToPath } from "node:url";

import { printHelp, renderHelpText } from "./cli-help.js";
import {
    deleteRunWithRetry,
    listReposForOwner,
    listRuns,
    resolveAuthenticatedLogin,
    resolveRepo,
    runGh,
} from "./cli-gh.js";
import {
    getCreatedAtEpoch,
    printDryRunWorkflowSummary,
    printSummaryDetails,
    printTextSummary,
    printVerboseRuns,
    sortRuns,
} from "./cli-output.js";
import {
    createProgressBar,
    createStyler,
    shouldShowProgress,
    shouldUseColor,
    shouldUseUnicode,
} from "./cli-styling.js";
import {
    type ColorMode,
    type ErrorCategory,
    type ParsedOptions,
    type RunSummary,
    type Styler,
    type UnicodeMode,
    type WorkflowRun,
    VALID_STATUSES,
} from "./cli-types.js";

function parseArguments(args: string[]): ParsedOptions {
    const parsed: ParsedOptions = {};

    for (let index = 0; index < args.length; index += 1) {
        const token = args[index];

        if (!token?.startsWith("--")) {
            continue;
        }

        const [rawKey, inlineValue] = token.slice(2).split("=", 2);
        const key = (rawKey ?? "").trim();

        if (
            key === "dry-run" ||
            key === "confirm" ||
            key === "yes" ||
            key === "verbose" ||
            key === "quiet" ||
            key === "all-statuses" ||
            key === "fail-fast" ||
            key === "help" ||
            key === "json" ||
            key === "summary" ||
            key === "no-color" ||
            key === "no-unicode" ||
            key === "no-progress" ||
            key === "ci" ||
            key === "all-repos"
        ) {
            parsed[key] = true;
            continue;
        }

        const nextToken = args[index + 1];
        const value =
            inlineValue ??
            (nextToken && !nextToken.startsWith("--") ? nextToken : "");

        if (
            inlineValue === undefined &&
            nextToken &&
            !nextToken.startsWith("--")
        ) {
            index += 1;
        }

        if (
            key === "status" ||
            key === "exclude-workflow" ||
            key === "exclude-branch" ||
            key === "repos"
        ) {
            const existing = parsed[key];
            const bucket = Array.isArray(existing) ? existing : [];
            bucket.push(value);
            parsed[key] = bucket;
            continue;
        }

        parsed[key] = value;
    }

    return parsed;
}

function emitError(
    message: string,
    category: ErrorCategory,
    asJson: boolean,
    styler?: Styler
): number {
    if (asJson) {
        console.error(
            JSON.stringify(
                {
                    error: {
                        category,
                        message,
                    },
                },
                null,
                2
            )
        );
        return 1;
    }

    const rendered = styler
        ? styler.error(`Error: ${message}`)
        : `Error: ${message}`;
    console.error(rendered);
    return 1;
}

function isValidRepoSlug(value: string): boolean {
    return /^[^\s/]+\/[^\s/]+$/u.test(value);
}

function collectStringListOption(
    options: ParsedOptions,
    key: string
): string[] {
    const rawValues = options[key];
    if (Array.isArray(rawValues)) {
        return rawValues
            .flatMap((value) => value.split(","))
            .map((value) => value.trim())
            .filter((value) => value.length > 0);
    }

    if (typeof rawValues === "string") {
        return rawValues
            .split(",")
            .map((value) => value.trim())
            .filter((value) => value.length > 0);
    }

    return [];
}

type ProcessRepositoryParams = {
    beforeDays: number | undefined;
    ciMode: boolean;
    dryRun: boolean;
    excludedBranchNames: Set<string>;
    excludedWorkflowNames: Set<string>;
    failFast: boolean;
    jsonOutput: boolean;
    limit: number;
    maxDelete: number | undefined;
    maxFailures: number | undefined;
    maxRetries: number;
    noProgress: boolean;
    order: "oldest" | "newest" | "none";
    options: ParsedOptions;
    quiet: boolean;
    repoIndex: number;
    repoTotal: number;
    resolvedRepo: string;
    retryDelayMs: number;
    statuses: string[];
    styler: Styler;
    summaryMode: boolean;
    unicodeTables: boolean;
    verbose: boolean;
};

function processRepository(
    params: ProcessRepositoryParams
): RunSummary | number {
    const {
        beforeDays,
        ciMode,
        dryRun,
        excludedBranchNames,
        excludedWorkflowNames,
        failFast,
        jsonOutput,
        limit,
        maxDelete,
        maxFailures,
        maxRetries,
        noProgress,
        options,
        order,
        quiet,
        repoIndex,
        repoTotal,
        resolvedRepo,
        retryDelayMs,
        statuses,
        styler,
        summaryMode,
        unicodeTables,
        verbose,
    } = params;

    if (!jsonOutput && !quiet && repoTotal > 1) {
        if (repoIndex > 0) {
            console.log("");
        }
        console.log(
            styler.heading(
                `Repository ${repoIndex + 1}/${repoTotal}: ${resolvedRepo}`
            )
        );
    }

    const repoStartedAt = Date.now();
    const allRuns: WorkflowRun[] = [];
    const expectedFetchTotal = Math.max(1, statuses.length * limit);
    const showProgress = shouldShowProgress(
        jsonOutput,
        quiet,
        verbose,
        noProgress,
        ciMode
    );
    const fetchProgress = createProgressBar(
        "Fetching runs",
        expectedFetchTotal,
        styler,
        showProgress
    );

    try {
        for (const [index, status] of statuses.entries()) {
            const beforeCount = allRuns.length;
            const runs = listRuns(
                resolvedRepo,
                status,
                options,
                (fetchedInStatus, detail) => {
                    fetchProgress.update(
                        beforeCount + fetchedInStatus,
                        `s=${index + 1}/${statuses.length} ${status} ${detail} runs=${beforeCount + fetchedInStatus}`
                    );
                }
            );

            allRuns.push(...runs);
            fetchProgress.update(
                allRuns.length,
                `s=${index + 1}/${statuses.length} ${status} done runs=${allRuns.length}`
            );
        }
        fetchProgress.done();
    } catch (error) {
        fetchProgress.done();
        const message = error instanceof Error ? error.message : String(error);
        return emitError(
            `failed to list runs for ${resolvedRepo}: ${message}`,
            "gh_cli_error",
            jsonOutput,
            styler
        );
    }

    const uniqueById = new Map<number, WorkflowRun>();
    for (const run of allRuns) {
        uniqueById.set(run.databaseId, run);
    }

    const dedupedRuns = Array.from(uniqueById.values());
    const orderedRuns = sortRuns(dedupedRuns, order);

    let skippedByExclusion = 0;
    const includedRuns = orderedRuns.filter((run) => {
        const workflowName = run.workflowName?.toLowerCase();
        const branchName = run.headBranch?.toLowerCase();

        const excludedByWorkflow =
            typeof workflowName === "string" &&
            excludedWorkflowNames.has(workflowName);
        const excludedByBranch =
            typeof branchName === "string" &&
            excludedBranchNames.has(branchName);

        if (excludedByWorkflow || excludedByBranch) {
            skippedByExclusion += 1;
            return false;
        }

        return true;
    });

    let skippedByAge = 0;
    const now = Date.now();
    const ageCutoffEpoch =
        typeof beforeDays === "number"
            ? now - beforeDays * 24 * 60 * 60 * 1000
            : undefined;
    const runsToProcess =
        typeof ageCutoffEpoch === "number"
            ? includedRuns.filter((run) => {
                  const createdEpoch = getCreatedAtEpoch(run);
                  const include = Number.isFinite(createdEpoch)
                      ? createdEpoch <= ageCutoffEpoch
                      : true;
                  if (!include) {
                      skippedByAge += 1;
                  }
                  return include;
              })
            : includedRuns;

    const candidates =
        Number.isFinite(maxDelete) && maxDelete !== undefined
            ? runsToProcess.slice(0, maxDelete)
            : runsToProcess;

    if (verbose && !jsonOutput && !quiet) {
        printVerboseRuns(candidates, styler, unicodeTables);
    }

    let deleted = 0;
    const failedIds: number[] = [];
    let attempted = 0;

    if (!jsonOutput && !quiet) {
        console.log(
            styler.info(
                `Planned deletions: ${candidates.length} (from ${allRuns.length} fetched runs, ${dedupedRuns.length} unique).`
            )
        );
    }

    const deleteProgress = createProgressBar(
        "Deleting runs",
        candidates.length,
        styler,
        showProgress && !dryRun
    );

    if (!dryRun) {
        for (const run of candidates) {
            attempted += 1;

            const result = deleteRunWithRetry(
                resolvedRepo,
                run.databaseId,
                maxRetries,
                retryDelayMs,
                (attemptNumber, totalAttempts) => {
                    deleteProgress.update(
                        attempted - 1,
                        `id=${run.databaseId} a=${attemptNumber}/${totalAttempts} d=${deleted} f=${failedIds.length}`
                    );
                }
            );

            if (result.ok) {
                deleted += 1;
            } else {
                failedIds.push(run.databaseId);
                if (verbose && !jsonOutput) {
                    console.error(
                        `Delete failed for run ${run.databaseId} after ${result.attempts} attempt(s): ${result.error ?? "unknown"}`
                    );
                }

                if (failFast) {
                    break;
                }

                if (
                    typeof maxFailures === "number" &&
                    failedIds.length >= maxFailures
                ) {
                    break;
                }
            }

            deleteProgress.update(
                attempted,
                `d=${deleted} f=${failedIds.length}`
            );
        }

        deleteProgress.done();
    }

    const summary: RunSummary = {
        attempted,
        deleted,
        dryRun,
        durationMs: Date.now() - repoStartedAt,
        failed: failedIds.length,
        failedIds,
        matched: runsToProcess.length,
        planned: candidates.length,
        repo: resolvedRepo,
        skippedByExclusion,
        statuses,
        skippedByAge,
    };

    if (!jsonOutput) {
        if (!quiet) {
            printTextSummary(summary, styler, unicodeTables);
            if (dryRun) {
                printDryRunWorkflowSummary(candidates, styler, unicodeTables);
            }
            if (summaryMode) {
                printSummaryDetails(
                    runsToProcess,
                    candidates,
                    styler,
                    unicodeTables
                );
            }
        }

        if (dryRun && !quiet) {
            console.log(styler.ok("Dry run complete: no deletions performed."));
        }
    }

    return summary;
}

function printJsonSummaries(
    repoSummaries: RunSummary[],
    dryRun: boolean,
    startedAt: number
): void {
    if (repoSummaries.length === 1) {
        console.log(JSON.stringify(repoSummaries[0], null, 2));
        return;
    }

    const aggregate = {
        attempted: repoSummaries.reduce(
            (accumulator, summary) => accumulator + summary.attempted,
            0
        ),
        deleted: repoSummaries.reduce(
            (accumulator, summary) => accumulator + summary.deleted,
            0
        ),
        dryRun,
        durationMs: Date.now() - startedAt,
        failed: repoSummaries.reduce(
            (accumulator, summary) => accumulator + summary.failed,
            0
        ),
        matched: repoSummaries.reduce(
            (accumulator, summary) => accumulator + summary.matched,
            0
        ),
        planned: repoSummaries.reduce(
            (accumulator, summary) => accumulator + summary.planned,
            0
        ),
        repoCount: repoSummaries.length,
    };

    console.log(
        JSON.stringify(
            {
                aggregate,
                repos: repoSummaries,
            },
            null,
            2
        )
    );
}

type ExecutionConfig = {
    beforeDays: number | undefined;
    ciMode: boolean;
    dryRun: boolean;
    excludedBranchNames: Set<string>;
    excludedWorkflowNames: Set<string>;
    failFast: boolean;
    jsonOutput: boolean;
    limit: number;
    maxDelete: number | undefined;
    maxFailures: number | undefined;
    maxRetries: number;
    noProgress: boolean;
    options: ParsedOptions;
    order: "oldest" | "newest" | "none";
    quiet: boolean;
    retryDelayMs: number;
    statuses: string[];
    styler: Styler;
    summaryMode: boolean;
    targetRepos: string[];
    unicodeTables: boolean;
    verbose: boolean;
};

function buildExecutionConfig(
    options: ParsedOptions
): ExecutionConfig | number {
    const jsonOutput = options["json"] === true;
    const ciMode = options["ci"] === true;
    const noProgress = options["no-progress"] === true;

    let colorOption = "auto";
    if (ciMode || options["no-color"] === true) {
        colorOption = "never";
    } else if (
        typeof options["color"] === "string" &&
        options["color"].length > 0
    ) {
        colorOption = options["color"].trim().toLowerCase();
    }

    const validColorOption =
        colorOption === "auto" ||
        colorOption === "always" ||
        colorOption === "never";

    const colorMode = (validColorOption ? colorOption : "auto") as ColorMode;
    const styler = createStyler(shouldUseColor(colorMode, jsonOutput));

    if (options["help"] === true) {
        console.log(renderHelpText(styler));
        return 0;
    }

    if (!validColorOption) {
        return emitError(
            "--color must be one of: auto, always, never.",
            "validation_error",
            jsonOutput,
            styler
        );
    }

    const dryRun = options["dry-run"] === true;
    const confirm = options["confirm"] === true || options["yes"] === true;
    const verbose = options["verbose"] === true;
    const summaryMode = options["summary"] === true;
    const quiet = options["quiet"] === true;
    const failFast = options["fail-fast"] === true;

    let unicodeOption = "auto";
    if (ciMode || options["no-unicode"] === true) {
        unicodeOption = "never";
    } else if (
        typeof options["unicode"] === "string" &&
        options["unicode"].length > 0
    ) {
        unicodeOption = options["unicode"].trim().toLowerCase();
    }

    if (
        unicodeOption !== "auto" &&
        unicodeOption !== "always" &&
        unicodeOption !== "never"
    ) {
        return emitError(
            "--unicode must be one of: auto, always, never.",
            "validation_error",
            jsonOutput,
            styler
        );
    }

    const unicodeMode = unicodeOption as UnicodeMode;
    const unicodeTables = shouldUseUnicode(unicodeMode, jsonOutput);

    if (!dryRun && !confirm) {
        return emitError(
            "Safety stop: pass --confirm to perform deletion, or use --dry-run to preview.",
            "validation_error",
            jsonOutput,
            styler
        );
    }

    const allStatuses = options["all-statuses"] === true;

    const excludedWorkflowNames = new Set(
        collectStringListOption(options, "exclude-workflow").map((value) =>
            value.toLowerCase()
        )
    );
    const excludedBranchNames = new Set(
        collectStringListOption(options, "exclude-branch").map((value) =>
            value.toLowerCase()
        )
    );

    let rawStatusValues: string[];
    if (allStatuses) {
        rawStatusValues = [Array.from(VALID_STATUSES).join(",")];
    } else if (Array.isArray(options["status"])) {
        rawStatusValues = options["status"];
    } else if (typeof options["status"] === "string") {
        rawStatusValues = [options["status"]];
    } else {
        rawStatusValues = ["failure,cancelled"];
    }

    const statuses = rawStatusValues
        .flatMap((part) => part.split(","))
        .map((part) => part.trim())
        .filter(Boolean);

    if (statuses.length === 0) {
        return emitError(
            "at least one --status value is required.",
            "validation_error",
            jsonOutput,
            styler
        );
    }

    const invalidStatuses = statuses.filter(
        (status) => !VALID_STATUSES.has(status)
    );
    if (invalidStatuses.length > 0) {
        return emitError(
            `invalid statuses: ${invalidStatuses.join(", ")}. Valid values: ${Array.from(VALID_STATUSES).join(", ")}`,
            "validation_error",
            jsonOutput,
            styler
        );
    }

    const limit = Number.parseInt(String(options["limit"] ?? "500"), 10);
    if (!Number.isFinite(limit) || limit < 1) {
        return emitError(
            "--limit must be a positive integer.",
            "validation_error",
            jsonOutput,
            styler
        );
    }

    const maxDeleteOption = options["max-delete"];
    const maxDelete =
        typeof maxDeleteOption === "string"
            ? Number.parseInt(maxDeleteOption, 10)
            : undefined;
    if (
        maxDeleteOption !== undefined &&
        (typeof maxDelete !== "number" ||
            !Number.isFinite(maxDelete) ||
            maxDelete < 1)
    ) {
        return emitError(
            "--max-delete must be a positive integer.",
            "validation_error",
            jsonOutput,
            styler
        );
    }

    const beforeDaysOption = options["before-days"];
    const beforeDays =
        typeof beforeDaysOption === "string"
            ? Number.parseInt(beforeDaysOption, 10)
            : undefined;
    if (
        beforeDaysOption !== undefined &&
        (typeof beforeDays !== "number" ||
            !Number.isFinite(beforeDays) ||
            beforeDays < 0)
    ) {
        return emitError(
            "--before-days must be a non-negative integer.",
            "validation_error",
            jsonOutput,
            styler
        );
    }

    const maxRetriesOption = options["max-retries"];
    const maxRetries =
        typeof maxRetriesOption === "string"
            ? Number.parseInt(maxRetriesOption, 10)
            : 2;
    if (!Number.isFinite(maxRetries) || maxRetries < 0) {
        return emitError(
            "--max-retries must be a non-negative integer.",
            "validation_error",
            jsonOutput,
            styler
        );
    }

    const retryDelayOption = options["retry-delay-ms"];
    const retryDelayMs =
        typeof retryDelayOption === "string"
            ? Number.parseInt(retryDelayOption, 10)
            : 200;
    if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) {
        return emitError(
            "--retry-delay-ms must be a non-negative integer.",
            "validation_error",
            jsonOutput,
            styler
        );
    }

    const maxFailuresOption = options["max-failures"];
    const maxFailures =
        typeof maxFailuresOption === "string"
            ? Number.parseInt(maxFailuresOption, 10)
            : undefined;
    if (
        maxFailuresOption !== undefined &&
        (typeof maxFailures !== "number" ||
            !Number.isFinite(maxFailures) ||
            maxFailures < 1)
    ) {
        return emitError(
            "--max-failures must be a positive integer.",
            "validation_error",
            jsonOutput,
            styler
        );
    }

    const orderOption = options["order"];
    const order =
        typeof orderOption === "string" && orderOption.length > 0
            ? orderOption.toLowerCase()
            : "oldest";
    if (order !== "oldest" && order !== "newest" && order !== "none") {
        return emitError(
            "--order must be one of: oldest, newest, none.",
            "validation_error",
            jsonOutput,
            styler
        );
    }

    const repoOption =
        typeof options["repo"] === "string"
            ? options["repo"].trim()
            : undefined;
    const reposOption = collectStringListOption(options, "repos");
    const allReposMode = options["all-repos"] === true;
    const ownerOption =
        typeof options["owner"] === "string" &&
        options["owner"].trim().length > 0
            ? options["owner"].trim()
            : undefined;

    if (
        allReposMode &&
        (typeof repoOption === "string" || reposOption.length > 0)
    ) {
        return emitError(
            "--all-repos cannot be combined with --repo or --repos.",
            "validation_error",
            jsonOutput,
            styler
        );
    }

    const authResult = runGh(["auth", "status"]);
    if (authResult.status !== 0) {
        return emitError(
            "gh CLI is not authenticated. Run: gh auth login",
            "auth_error",
            jsonOutput,
            styler
        );
    }

    let targetRepos: string[] = [];

    if (allReposMode) {
        const owner = ownerOption ?? resolveAuthenticatedLogin();
        if (typeof owner !== "string" || owner.length === 0) {
            return emitError(
                "unable to resolve authenticated user for --all-repos. Pass --owner <login>.",
                "validation_error",
                jsonOutput,
                styler
            );
        }

        try {
            targetRepos = listReposForOwner(owner);
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            return emitError(
                `failed to list repositories: ${message}`,
                "gh_cli_error",
                jsonOutput,
                styler
            );
        }

        if (targetRepos.length === 0) {
            return emitError(
                `no repositories found for ${owner}.`,
                "validation_error",
                jsonOutput,
                styler
            );
        }
    } else {
        if (typeof repoOption === "string" && repoOption.length > 0) {
            targetRepos.push(repoOption);
        }

        targetRepos.push(...reposOption);

        if (targetRepos.length === 0) {
            const resolved = resolveRepo(undefined);
            if (typeof resolved !== "string" || resolved.length === 0) {
                if (!jsonOutput) {
                    console.log(printHelp());
                }
                return emitError(
                    "unable to resolve repository. Provide --repo <owner/name> / --repos <owner/name,..> or run inside a GitHub repository.",
                    "validation_error",
                    jsonOutput,
                    styler
                );
            }

            targetRepos = [resolved];
        }
    }

    targetRepos = Array.from(new Set(targetRepos));

    const invalidRepoValues = targetRepos.filter(
        (repo) => !isValidRepoSlug(repo)
    );
    if (invalidRepoValues.length > 0) {
        return emitError(
            `invalid repository values: ${invalidRepoValues.join(", ")}. Use owner/name format.`,
            "validation_error",
            jsonOutput,
            styler
        );
    }

    options["limit"] = String(limit);

    return {
        beforeDays,
        ciMode,
        dryRun,
        excludedBranchNames,
        excludedWorkflowNames,
        failFast,
        jsonOutput,
        limit,
        maxDelete,
        maxFailures,
        maxRetries,
        noProgress,
        options,
        order,
        quiet,
        retryDelayMs,
        statuses,
        styler,
        summaryMode,
        targetRepos,
        unicodeTables,
        verbose,
    };
}

export function main(argv: string[]): number {
    const startedAt = Date.now();
    const options = parseArguments(argv);
    const built = buildExecutionConfig(options);
    if (typeof built === "number") {
        return built;
    }

    const {
        beforeDays,
        ciMode,
        dryRun,
        excludedBranchNames,
        excludedWorkflowNames,
        failFast,
        jsonOutput,
        limit,
        maxDelete,
        maxFailures,
        maxRetries,
        noProgress,
        options: normalizedOptions,
        order,
        quiet,
        retryDelayMs,
        statuses,
        styler,
        summaryMode,
        targetRepos,
        unicodeTables,
        verbose,
    } = built;

    const repoSummaries: RunSummary[] = [];

    for (const [repoIndex, resolvedRepo] of targetRepos.entries()) {
        const result = processRepository({
            beforeDays,
            ciMode,
            dryRun,
            excludedBranchNames,
            excludedWorkflowNames,
            failFast,
            jsonOutput,
            limit,
            maxDelete,
            maxFailures,
            maxRetries,
            noProgress,
            options: normalizedOptions,
            order,
            quiet,
            repoIndex,
            repoTotal: targetRepos.length,
            resolvedRepo,
            retryDelayMs,
            statuses,
            styler,
            summaryMode,
            unicodeTables,
            verbose,
        });

        if (typeof result === "number") {
            return result;
        }

        repoSummaries.push(result);
    }

    if (jsonOutput) {
        printJsonSummaries(repoSummaries, dryRun, startedAt);
    }

    const hasFailures = repoSummaries.some((summary) => summary.failed > 0);
    return hasFailures ? 2 : 0;
}

const isDirectExecution =
    typeof process.argv[1] === "string" &&
    fileURLToPath(import.meta.url) === process.argv[1];

export function runCli(): void {
    process.exitCode = main(process.argv.slice(2));
}

if (isDirectExecution) {
    runCli();
}
