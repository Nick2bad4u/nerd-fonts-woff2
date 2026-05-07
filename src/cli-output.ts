import { formatTable } from "./cli-styling.js";
import type { RunSummary, Styler, WorkflowRun } from "./cli-types.js";

export function getCreatedAtEpoch(run: WorkflowRun): number {
    if (typeof run.createdAt !== "string" || run.createdAt.length === 0) {
        return Number.NaN;
    }

    return Date.parse(run.createdAt);
}

export function sortRuns(
    runs: WorkflowRun[],
    order: "oldest" | "newest" | "none"
): WorkflowRun[] {
    if (order === "none") {
        return runs;
    }

    return [...runs].sort((left, right) => {
        const leftEpoch = getCreatedAtEpoch(left);
        const rightEpoch = getCreatedAtEpoch(right);

        if (Number.isNaN(leftEpoch) && Number.isNaN(rightEpoch)) {
            return left.databaseId - right.databaseId;
        }

        if (Number.isNaN(leftEpoch)) {
            return 1;
        }

        if (Number.isNaN(rightEpoch)) {
            return -1;
        }

        return order === "oldest"
            ? leftEpoch - rightEpoch
            : rightEpoch - leftEpoch;
    });
}

function toWorkflowName(run: WorkflowRun): string {
    const value = run.workflowName?.trim();
    return typeof value === "string" && value.length > 0
        ? value
        : "(unknown workflow)";
}

function toBranchName(run: WorkflowRun): string {
    const value = run.headBranch?.trim();
    return typeof value === "string" && value.length > 0
        ? value
        : "(no branch)";
}

function toStatusLabel(run: WorkflowRun): string {
    const status = run.status?.trim() || "unknown";
    const conclusion = run.conclusion?.trim();
    return conclusion ? `${status}/${conclusion}` : status;
}

function collectCounts(
    runs: WorkflowRun[],
    selector: (run: WorkflowRun) => string
): Array<[name: string, count: number]> {
    const counts = new Map<string, number>();

    for (const run of runs) {
        const key = selector(run);
        const current = counts.get(key) ?? 0;
        counts.set(key, current + 1);
    }

    return Array.from(counts.entries()).sort((left, right) => {
        if (right[1] !== left[1]) {
            return right[1] - left[1];
        }
        return left[0].localeCompare(right[0]);
    });
}

export function printDryRunWorkflowSummary(
    runs: WorkflowRun[],
    styler: Styler,
    useUnicode: boolean
): void {
    console.log("");
    console.log(styler.heading("Planned deletions by workflow"));

    const counts = collectCounts(runs, toWorkflowName);
    if (counts.length === 0) {
        console.log(
            styler.muted("No workflow runs matched the current filters.")
        );
        return;
    }

    console.log(
        formatTable(
            [styler.strong("Workflow"), styler.strong("Planned deletions")],
            counts.map(([workflow, count]) => [workflow, styler.count(count)]),
            useUnicode
        )
    );
}

export function printSummaryDetails(
    runsToProcess: WorkflowRun[],
    candidates: WorkflowRun[],
    styler: Styler,
    useUnicode: boolean
): void {
    console.log("");
    console.log(styler.heading("Summary details"));

    const statusCounts = collectCounts(runsToProcess, toStatusLabel);
    const branchCounts = collectCounts(runsToProcess, toBranchName).slice(
        0,
        10
    );

    console.log(styler.info("By status"));
    console.log(
        formatTable(
            [styler.strong("Status"), styler.strong("Count")],
            statusCounts.map(([status, count]) => [
                styler.status(status),
                styler.count(count),
            ]),
            useUnicode
        )
    );

    console.log("");
    console.log(styler.info("Top branches"));
    console.log(
        formatTable(
            [styler.strong("Branch"), styler.strong("Count")],
            branchCounts.map(([branch, count]) => [
                branch,
                styler.count(count),
            ]),
            useUnicode
        )
    );

    if (candidates.length < runsToProcess.length) {
        console.log(
            styler.warn(
                `Limited by --max-delete: ${candidates.length} of ${runsToProcess.length} matched runs are planned.`
            )
        );
    }
}

export function printVerboseRuns(
    runs: WorkflowRun[],
    styler: Styler,
    useUnicode: boolean
): void {
    const rows = runs.slice(0, 50).map((run) => [
        styler.strong(String(run.databaseId)),
        styler.status(toStatusLabel(run)),
        toWorkflowName(run),
        toBranchName(run),
        run.createdAt ?? "",
    ]);

    console.log("");
    console.log(styler.heading("Run details (first 50)"));
    console.log(
        formatTable(
            [
                styler.strong("Run ID"),
                styler.strong("Status"),
                styler.strong("Workflow"),
                styler.strong("Branch"),
                styler.strong("Created"),
            ],
            rows,
            useUnicode
        )
    );

    if (runs.length > 50) {
        console.log(styler.muted(`... and ${runs.length - 50} more`));
    }
}

export function printTextSummary(
    summary: RunSummary,
    styler: Styler,
    useUnicode: boolean
): void {
    const styledStatuses = summary.statuses.map((status) =>
        styler.status(status)
    );

    console.log(styler.heading("Cleanup summary"));
    console.log(
        formatTable(
            [styler.strong("Metric"), styler.strong("Value")],
            [
                [styler.info("Repository"), styler.strong(summary.repo)],
                [
                    styler.info("Statuses"),
                    styledStatuses.join(styler.muted(", ")),
                ],
                [
                    styler.info("Matched runs"),
                    styler.strong(styler.count(summary.matched)),
                ],
                [
                    styler.info("Planned deletions"),
                    styler.strong(styler.count(summary.planned)),
                ],
                [
                    styler.warn("Skipped by exclusion filters"),
                    summary.skippedByExclusion > 0
                        ? styler.warn(String(summary.skippedByExclusion))
                        : styler.muted(String(summary.skippedByExclusion)),
                ],
                [
                    styler.warn("Skipped by age filter"),
                    summary.skippedByAge > 0
                        ? styler.warn(String(summary.skippedByAge))
                        : styler.muted(String(summary.skippedByAge)),
                ],
            ],
            useUnicode
        )
    );

    if (!summary.dryRun) {
        console.log("");
        console.log(styler.info("Deletion results"));
        console.log(
            formatTable(
                [styler.strong("Metric"), styler.strong("Value")],
                [
                    [
                        styler.info("Attempted deletions"),
                        styler.strong(String(summary.attempted)),
                    ],
                    [
                        styler.ok("Deleted"),
                        summary.deleted > 0
                            ? styler.ok(String(summary.deleted))
                            : styler.muted(String(summary.deleted)),
                    ],
                    [
                        styler.error("Failed"),
                        summary.failed > 0
                            ? styler.error(String(summary.failed))
                            : styler.ok(String(summary.failed)),
                    ],
                ],
                useUnicode
            )
        );

        if (summary.failedIds.length > 0) {
            console.log(
                `Failed IDs (first 50): ${summary.failedIds.slice(0, 50).join(", ")}`
            );
        }
    }
}
