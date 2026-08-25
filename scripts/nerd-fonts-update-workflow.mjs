#!/usr/bin/env node

import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule, parseSemverTag } from "./nerd-fonts-release.mjs";
import {
    main as runUpdater,
    parseUpdateOptions,
    serializeError,
} from "./nerd-fonts-updater.mjs";
import { calculatePlanFingerprint } from "./release-identity.mjs";
import {
    assertSafeRepositoryPath,
    atomicWriteJson,
    readJsonFile,
} from "./safe-filesystem.mjs";

const moduleFilePath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(moduleFilePath), "..");
const defaultPlanFile = resolve(
    repoRoot,
    "temp",
    "nerd-fonts-update",
    "reviewed-plan.json"
);
const PLAN_FILE_SCHEMA_VERSION = 1;
const EMPTY_FINGERPRINT = "0".repeat(64);

/** @typedef {"apply" | "guided" | "review"} WorkflowMode */

export class ReviewedUpdateWorkflowError extends Error {
    /**
     * @param {string} message
     * @param {number} [exitCode]
     */
    constructor(message, exitCode = 2) {
        super(message);
        this.name = "ReviewedUpdateWorkflowError";
        this.exitCode = exitCode;
    }
}

/**
 * @param {unknown} value
 *
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {readonly string[]} argumentsList
 *
 * @returns {{ argumentsList: string[]; planFile: string }}
 */
function extractPlanFile(argumentsList) {
    /** @type {string[]} */
    const forwardedArguments = [];
    let planFile = defaultPlanFile;
    let planFileSeen = false;

    for (let index = 0; index < argumentsList.length; index += 1) {
        const rawArgument = argumentsList[index];
        if (rawArgument === undefined) continue;
        if (rawArgument === "--") {
            forwardedArguments.push(...argumentsList.slice(index));
            break;
        }
        const equalsIndex = rawArgument.indexOf("=");
        const argument =
            equalsIndex > 0 ? rawArgument.slice(0, equalsIndex) : rawArgument;
        if (argument !== "--plan-file") {
            forwardedArguments.push(rawArgument);
            continue;
        }
        if (planFileSeen) {
            throw new ReviewedUpdateWorkflowError(
                "--plan-file cannot be specified more than once."
            );
        }
        planFileSeen = true;
        let value =
            equalsIndex > 0 ? rawArgument.slice(equalsIndex + 1) : undefined;
        if (value === undefined) {
            value = argumentsList[index + 1];
            index += 1;
        }
        if (typeof value !== "string" || value.trim().length === 0) {
            throw new ReviewedUpdateWorkflowError(
                "--plan-file requires a non-empty repository-relative path."
            );
        }
        planFile = resolve(repoRoot, value.trim());
    }

    return {
        argumentsList: forwardedArguments,
        planFile: assertSafeRepositoryPath(repoRoot, planFile),
    };
}

/**
 * @param {readonly string[]} argumentsList
 *
 * @returns {{
 *     applyArguments: string[];
 *     help: boolean;
 *     mode: WorkflowMode;
 *     planArguments: string[];
 *     planFile: string;
 * }}
 */
export function parseWorkflowArguments(argumentsList) {
    const rawMode = argumentsList[0];
    if (rawMode === "--help" || rawMode === "-h" || rawMode === undefined) {
        return {
            applyArguments: [],
            help: true,
            mode: "guided",
            planArguments: [],
            planFile: defaultPlanFile,
        };
    }
    if (rawMode !== "review" && rawMode !== "apply" && rawMode !== "guided") {
        throw new ReviewedUpdateWorkflowError(
            `Unknown workflow command: ${rawMode}`
        );
    }

    const npmLifecycleEvent = process.env["npm_lifecycle_event"];
    const modeArguments =
        argumentsList[1] === "--" &&
        npmLifecycleEvent === `fonts:update:${rawMode}`
            ? argumentsList.slice(2)
            : argumentsList.slice(1);
    const extracted = extractPlanFile(modeArguments);
    const argumentsWithoutTerminator =
        extracted.argumentsList.at(-1) === "--"
            ? extracted.argumentsList.slice(0, -1)
            : extracted.argumentsList;
    const reservedOptions = new Set([
        "--apply",
        "--convert",
        "--dry-run",
        "--json",
        "--plan-fingerprint",
    ]);
    for (const rawArgument of argumentsWithoutTerminator) {
        const optionName = rawArgument.split("=", 1)[0];
        if (optionName !== undefined && reservedOptions.has(optionName)) {
            throw new ReviewedUpdateWorkflowError(
                `${optionName} is managed by the reviewed-update workflow.`
            );
        }
    }

    const confirmationCount = argumentsWithoutTerminator.filter(
        (argument) => argument === "--confirm"
    ).length;
    if (rawMode === "apply" && confirmationCount !== 1) {
        throw new ReviewedUpdateWorkflowError(
            "Applying a saved reviewed plan requires exactly one --confirm flag."
        );
    }
    if (rawMode !== "apply" && confirmationCount > 0) {
        throw new ReviewedUpdateWorkflowError(
            `${rawMode} does not accept --confirm; guided mode prompts for the exact fingerprint.`
        );
    }

    const updaterArguments = argumentsWithoutTerminator.filter(
        (argument) => argument !== "--confirm"
    );
    const parsed = parseUpdateOptions(
        rawMode === "review"
            ? updaterArguments
            : [
                  ...updaterArguments,
                  "--apply",
                  "--confirm",
                  "--plan-fingerprint",
                  EMPTY_FINGERPRINT,
              ]
    );
    if (parsed.help) {
        return {
            applyArguments: [],
            help: true,
            mode: rawMode,
            planArguments: [],
            planFile: extracted.planFile,
        };
    }
    if (
        rawMode === "review" &&
        (parsed.allowDirty || parsed.breakStaleLock || parsed.forceRebuild)
    ) {
        throw new ReviewedUpdateWorkflowError(
            "Review mode does not accept apply-only override flags."
        );
    }

    /** @type {string[]} */
    const planArguments = [];
    if (parsed.upstreamRef !== null) {
        planArguments.push("--ref", parsed.upstreamRef);
    }
    planArguments.push(
        "--download-concurrency",
        String(parsed.downloadConcurrency),
        "--timeout",
        String(parsed.timeoutSeconds)
    );
    if (parsed.conversionConcurrency !== null) {
        planArguments.push(
            "--concurrency",
            String(parsed.conversionConcurrency)
        );
    }
    if (parsed.verbose) planArguments.push("--verbose");
    if (parsed.color === true) planArguments.push("--color");
    if (parsed.color === false) planArguments.push("--no-color");

    const applyArguments = [
        ...planArguments,
        "--apply",
        "--confirm",
    ];
    if (parsed.allowDirty) applyArguments.push("--allow-dirty");
    if (parsed.breakStaleLock) applyArguments.push("--break-stale-lock");
    if (parsed.forceRebuild) applyArguments.push("--force-rebuild");

    return {
        applyArguments,
        help: false,
        mode: rawMode,
        planArguments,
        planFile: extracted.planFile,
    };
}

/**
 * @param {unknown} value
 *
 * @returns {Record<string, unknown>}
 */
export function validateReviewedPlan(value) {
    if (!isRecord(value)) {
        throw new ReviewedUpdateWorkflowError(
            "The reviewed plan is not a JSON object."
        );
    }
    const plan = Reflect.get(value, "plan");
    const schemaVersion = Reflect.get(value, "schemaVersion");
    const reviewedAt = Reflect.get(value, "reviewedAt");
    if (schemaVersion !== PLAN_FILE_SCHEMA_VERSION) {
        throw new ReviewedUpdateWorkflowError(
            `Unsupported reviewed-plan schema: ${String(schemaVersion)}`
        );
    }
    if (
        typeof reviewedAt !== "string" ||
        Number.isNaN(Date.parse(reviewedAt))
    ) {
        throw new ReviewedUpdateWorkflowError(
            "The reviewed plan has an invalid reviewedAt timestamp."
        );
    }
    if (!isRecord(plan)) {
        throw new ReviewedUpdateWorkflowError(
            "The reviewed plan does not contain a plan result."
        );
    }

    const identity = Reflect.get(plan, "identity");
    const fingerprint = Reflect.get(plan, "planFingerprint");
    const targetRef = Reflect.get(plan, "targetRef");
    const archiveCount = Reflect.get(plan, "archiveCount");
    const archives = isRecord(identity)
        ? Reflect.get(identity, "archives")
        : undefined;
    const identityRef = isRecord(identity)
        ? Reflect.get(identity, "upstreamRef")
        : undefined;
    const manifest = isRecord(identity)
        ? Reflect.get(identity, "checksumManifest")
        : undefined;
    const manifestSha256 = isRecord(manifest)
        ? Reflect.get(manifest, "manifestSha256")
        : undefined;

    if (
        Reflect.get(plan, "ok") !== true ||
        Reflect.get(plan, "mode") !== "plan" ||
        Reflect.get(plan, "status") !== "planned"
    ) {
        throw new ReviewedUpdateWorkflowError(
            "The saved result is not a successful update plan."
        );
    }
    if (
        typeof targetRef !== "string" ||
        parseSemverTag(targetRef) === null ||
        identityRef !== targetRef
    ) {
        throw new ReviewedUpdateWorkflowError(
            "The reviewed plan has inconsistent target references."
        );
    }
    if (
        typeof fingerprint !== "string" ||
        !/^[\da-f]{64}$/v.test(fingerprint)
    ) {
        throw new ReviewedUpdateWorkflowError(
            "The reviewed plan has an invalid SHA-256 fingerprint."
        );
    }
    if (!Array.isArray(archives) || archives.length !== archiveCount) {
        throw new ReviewedUpdateWorkflowError(
            "The reviewed plan archive count is inconsistent."
        );
    }
    if (
        typeof manifestSha256 !== "string" ||
        !/^[\da-f]{64}$/v.test(manifestSha256)
    ) {
        throw new ReviewedUpdateWorkflowError(
            "The reviewed plan has an invalid checksum-manifest digest."
        );
    }
    const calculatedFingerprint = calculatePlanFingerprint(identity);
    if (calculatedFingerprint !== fingerprint) {
        throw new ReviewedUpdateWorkflowError(
            `The saved reviewed plan was modified: expected ${fingerprint}, calculated ${calculatedFingerprint}.`
        );
    }

    return plan;
}

/** @param {Record<string, unknown>} plan */
function validatePlanResult(plan) {
    return validateReviewedPlan({
        plan,
        reviewedAt: new Date(0).toISOString(),
        schemaVersion: PLAN_FILE_SCHEMA_VERSION,
    });
}

/** @param {string} fingerprint */
async function promptForFingerprint(fingerprint) {
    if (!stdin.isTTY || !stdout.isTTY) {
        throw new ReviewedUpdateWorkflowError(
            "Guided mode requires an interactive terminal. Use fonts:update:review followed by fonts:update:apply -- --confirm for automation."
        );
    }
    const interface_ = createInterface({ input: stdin, output: stdout });
    try {
        return (
            await interface_.question(
                `\nType the complete plan fingerprint to apply, or press Enter to stop:\n${fingerprint}\n> `
            )
        )
            .trim()
            .toLowerCase();
    } finally {
        interface_.close();
    }
}

function printWorkflowHelp() {
    process.stdout.write(
        `Review and apply a fingerprinted Nerd Fonts update.\n\n` +
            `Commands:\n` +
            `  npm run -- fonts:update:review -- --ref <vX.Y.Z>\n` +
            `  npm run -- fonts:update:apply -- --confirm\n` +
            `  npm run fonts:update:guided\n\n` +
            `The reviewed plan is saved to:\n  ${defaultPlanFile}\n\n` +
            `Common options:\n` +
            `  --ref <tag>                 Target tag (review/guided)\n` +
            `  --plan-file <path>          Repository-local reviewed-plan file\n` +
            `  --download-concurrency <n>  1-8 downloads\n` +
            `  --concurrency <n>           1-32 conversion workers\n` +
            `  --timeout <seconds>         Per-font timeout\n` +
            `  --verbose                   Detailed progress and timings\n` +
            `  --color / --no-color        Force or disable ANSI output\n` +
            `  --allow-dirty               Apply-only dirty-path override\n` +
            `  --force-rebuild             Apply-only same-ref rebuild\n` +
            `  --break-stale-lock          Apply-only malformed-lock recovery\n`
    );
}

/**
 * @param {readonly string[]} argumentsList
 * @param {{
 *     now?: () => Date;
 *     prompt?: (fingerprint: string) => Promise<string>;
 *     readPlan?: (path: string) => unknown;
 *     runUpdater?: typeof runUpdater;
 *     write?: (message: string) => void;
 *     writePlan?: (path: string, value: unknown) => Promise<void>;
 * }} [adapters]
 */
export async function runReviewedUpdateWorkflow(argumentsList, adapters = {}) {
    const parsed = parseWorkflowArguments(argumentsList);
    if (parsed.help) {
        printWorkflowHelp();
        return { ok: true, status: "help" };
    }

    const now = adapters.now ?? (() => new Date());
    const prompt = adapters.prompt ?? promptForFingerprint;
    const readPlan = adapters.readPlan ?? readJsonFile;
    const run = adapters.runUpdater ?? runUpdater;
    const write =
        adapters.write ?? ((message) => process.stdout.write(message));
    const writePlan = adapters.writePlan ?? atomicWriteJson;

    /** @type {Record<string, unknown>} */
    let plan;
    if (parsed.mode === "review" || parsed.mode === "guided") {
        const result = await run(parsed.planArguments, repoRoot);
        plan = validatePlanResult(result);
        await writePlan(parsed.planFile, {
            plan,
            reviewedAt: now().toISOString(),
            schemaVersion: PLAN_FILE_SCHEMA_VERSION,
        });
        const manifest = Reflect.get(
            /** @type {Record<string, unknown>} */ (
                Reflect.get(plan, "identity")
            ),
            "checksumManifest"
        );
        write(
            `\nReviewed plan saved to ${parsed.planFile}\n` +
                `  Target:              ${String(Reflect.get(plan, "targetRef"))}\n` +
                `  Plan fingerprint:    ${String(Reflect.get(plan, "planFingerprint"))}\n` +
                `  Manifest SHA-256:     ${String(
                    isRecord(manifest)
                        ? Reflect.get(manifest, "manifestSha256")
                        : "unknown"
                )}\n`
        );
        if (parsed.mode === "review") {
            write(
                `\nWhen ready, apply this saved identity with:\n  npm run -- fonts:update:apply -- --confirm\n`
            );
            return { ok: true, plan, status: "reviewed" };
        }
        if (
            Reflect.get(plan, "updateAvailable") !== true &&
            !parsed.applyArguments.includes("--force-rebuild")
        ) {
            write("\nNo update is required; nothing will be applied.\n");
            return { ok: true, plan, status: "no-op" };
        }
    } else {
        if (!existsSync(parsed.planFile) && adapters.readPlan === undefined) {
            throw new ReviewedUpdateWorkflowError(
                `No reviewed plan exists at ${parsed.planFile}. Run npm run fonts:update:review first.`
            );
        }
        plan = validateReviewedPlan(readPlan(parsed.planFile));
    }

    const fingerprint = String(Reflect.get(plan, "planFingerprint"));
    const targetRef = String(Reflect.get(plan, "targetRef"));
    if (parsed.mode === "guided") {
        const answer = await prompt(fingerprint);
        if (answer.length === 0) {
            write("\nApply cancelled. The reviewed plan remains saved.\n");
            return { ok: true, plan, status: "reviewed" };
        }
        if (answer !== fingerprint) {
            throw new ReviewedUpdateWorkflowError(
                "The entered fingerprint does not match the reviewed plan. Nothing was applied."
            );
        }
    }

    const requestedRef = parseUpdateOptions(parsed.planArguments).upstreamRef;
    if (requestedRef !== null && requestedRef !== targetRef) {
        throw new ReviewedUpdateWorkflowError(
            `The requested ref ${requestedRef} does not match the saved plan for ${targetRef}.`
        );
    }
    const applyArguments = [
        ...parsed.applyArguments.filter(
            (argument, index, allArguments) =>
                argument !== "--ref" && allArguments[index - 1] !== "--ref"
        ),
        "--ref",
        targetRef,
        "--plan-fingerprint",
        fingerprint,
    ];
    return run(applyArguments, repoRoot);
}

/** @param {readonly string[]} [argumentsList] */
export async function runWorkflowCli(argumentsList = process.argv.slice(2)) {
    try {
        await runReviewedUpdateWorkflow(argumentsList);
        return 0;
    } catch (error) {
        const serialized = serializeError(error);
        process.stderr.write(
            `Error: ${error instanceof Error ? error.message : String(error)}\n`
        );
        if (Array.isArray(serialized["causes"])) {
            process.stderr.write(
                `Details: ${JSON.stringify(serialized, null, 2)}\n`
            );
        }
        const reflectedExitCode = isRecord(error)
            ? Reflect.get(error, "exitCode")
            : undefined;
        const exitCode =
            typeof reflectedExitCode === "number" &&
            Number.isInteger(reflectedExitCode)
                ? reflectedExitCode
                : 1;
        process.exitCode = exitCode;
        return exitCode;
    }
}

if (isMainModule(process.argv[1], moduleFilePath)) {
    await runWorkflowCli();
}
