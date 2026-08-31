#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { isMainModule } from "./nerd-fonts-release.mjs";
import {
    buildPublicationPlan,
    loadLatestPublicationPlan,
    PublicationError,
    publishPublicationPlan,
    resolveRemoteRef,
    runGitCapture,
    savePublicationPlan,
    serializePublicationError,
    verifyGeneratedCatalog,
} from "./rolling-publish-core.mjs";
import {
    ANSI,
    formatBytes,
    resolveColorEnabled,
    styleText,
} from "./terminal-output.mjs";

// eslint-disable-next-line unicorn/prefer-import-meta-properties -- Keep the supported Node range explicit.
const moduleFilePath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(moduleFilePath), "..");
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

/** @param {NodeJS.WritableStream} [stdout] */
function printHelp(stdout = process.stdout) {
    stdout.write("Publish the rolling latest Nerd Fonts snapshot.\n\n");
    stdout.write("Plan only (default):\n");
    stdout.write("  npm run fonts:publish:latest\n\n");
    stdout.write("Apply a reviewed plan:\n");
    stdout.write(
        "  npm run -- fonts:publish:latest -- --apply --confirm --plan-fingerprint <sha256>\n\n"
    );
    stdout.write("Options:\n");
    stdout.write("  --apply                       Upload and replace main\n");
    stdout.write("  --confirm                     Confirm remote mutation\n");
    stdout.write("  --plan-fingerprint <sha256>   Required reviewed plan\n");
    stdout.write("  --resume                      Resume the saved plan\n");
    stdout.write(
        "  --break-stale-lock            Break an old unverifiable lock\n"
    );
    stdout.write(
        "  --json                        One JSON document on stdout\n"
    );
    stdout.write("  --verbose                     Detailed stderr progress\n");
    stdout.write("  --color / --no-color          ANSI output control\n");
    stdout.write("  --help                        Show this help\n");
}

/** @param {string[]} argumentsList */
export function parsePublishArguments(argumentsList) {
    /**
     * @type {{
     *     apply: boolean;
     *     breakStaleLock: boolean;
     *     color: boolean | null;
     *     confirm: boolean;
     *     help: boolean;
     *     json: boolean;
     *     planFingerprint: string | null;
     *     resume: boolean;
     *     verbose: boolean;
     * }}
     */
    const options = {
        apply: false,
        breakStaleLock: false,
        color: null,
        confirm: false,
        help: false,
        json: false,
        planFingerprint: null,
        resume: false,
        verbose: false,
    };
    const seen = new Set();
    /** @param {string} name @param {string | undefined} value */
    const scalar = (name, value) => {
        if (seen.has(name)) throw new Error(`Duplicate option: ${name}`);
        seen.add(name);
        if (value === undefined || value.length === 0) {
            throw new Error(`${name} requires a value.`);
        }
        return value;
    };
    for (let index = 0; index < argumentsList.length; index += 1) {
        const token = argumentsList[index];
        if (token === "--") {
            if (index !== argumentsList.length - 1) {
                throw new Error("Unexpected arguments after --.");
            }
            break;
        }
        const equals = token?.indexOf("=") ?? -1;
        const name = equals > 0 ? token?.slice(0, equals) : token;
        const inlineValue = equals > 0 ? token?.slice(equals + 1) : undefined;
        switch (name) {
            case "--apply":
            case "--break-stale-lock":
            case "--confirm":
            case "--help":
            case "--json":
            case "--resume":
            case "--verbose": {
                if (inlineValue !== undefined) {
                    throw new Error(`${String(name)} does not accept a value.`);
                }
                if (seen.has(name)) {
                    throw new Error(`Duplicate option: ${String(name)}`);
                }
                seen.add(name);
                const property =
                    name === "--break-stale-lock"
                        ? "breakStaleLock"
                        : name.slice(2);
                Reflect.set(options, property, true);
                if (name === "--resume") {
                    options.apply = true;
                    options.confirm = true;
                }
                break;
            }
            case "--color":
            case "--no-color":
                if (inlineValue !== undefined) {
                    throw new Error(`${String(name)} does not accept a value.`);
                }
                if (seen.has("color"))
                    throw new Error("Duplicate color option.");
                seen.add("color");
                options.color = name === "--color";
                break;
            case "--plan-fingerprint": {
                const value = scalar(
                    name,
                    inlineValue ?? argumentsList[(index += 1)]
                );
                if (!SHA256_PATTERN.test(value)) {
                    throw new Error(
                        "--plan-fingerprint must be a lowercase SHA-256 value."
                    );
                }
                options.planFingerprint = value;
                break;
            }
            default:
                throw new Error(`Unknown option: ${String(token)}`);
        }
    }
    if (
        options.apply &&
        !options.resume &&
        (!options.confirm || options.planFingerprint === null)
    ) {
        throw new Error(
            "Publishing requires --apply, --confirm, and --plan-fingerprint <sha256>."
        );
    }
    if (
        !options.apply &&
        (options.breakStaleLock ||
            options.confirm ||
            options.planFingerprint !== null)
    ) {
        throw new Error(
            "Confirmation and fingerprints are valid only with --apply."
        );
    }
    return options;
}

/**
 * @param {string[]} argumentsList
 * @param {{
 *     stderr?: NodeJS.WritableStream;
 *     stdout?: NodeJS.WritableStream;
 * }} [io]
 */
export async function main(argumentsList = process.argv.slice(2), io = {}) {
    const stdout = io.stdout ?? process.stdout;
    const stderr = io.stderr ?? process.stderr;
    let options;
    try {
        options = parsePublishArguments(argumentsList);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const serialized = serializePublicationError(
            new PublicationError(message, {
                category: "usage",
                cause: error,
                code: "INVALID_ARGUMENTS",
                exitCode: 2,
                phase: "arguments",
            })
        );
        if (argumentsList.includes("--json")) {
            stdout.write(
                `${JSON.stringify({ error: serialized, status: "failed" })}\n`
            );
        } else {
            stderr.write(`${message}\n`);
        }
        process.exitCode = 2;
        return;
    }
    if (options.help) {
        if (options.json)
            stdout.write(`${JSON.stringify({ status: "help" })}\n`);
        else printHelp(stdout);
        return;
    }
    const color = resolveColorEnabled(
        options.color,
        /** @type {{ isTTY?: boolean }} */ (stderr)
    );
    const context = { remote: "origin", repoRoot };
    try {
        let plan;
        if (options.resume) {
            plan = loadLatestPublicationPlan(repoRoot);
            options.planFingerprint = String(plan["planFingerprint"]);
            const branch = runGitCapture(context, ["branch", "--show-current"]);
            const status = runGitCapture(context, [
                "status",
                "--porcelain",
                "--untracked-files=no",
            ]);
            if (branch !== "source" || status.length > 0) {
                throw new PublicationError(
                    "Resume requires a clean source checkout.",
                    {
                        category: "repository",
                        code: "RESUME_SOURCE_INVALID",
                        exitCode: 3,
                        phase: "resume",
                    }
                );
            }
            await verifyGeneratedCatalog(
                repoRoot,
                options.json ? "json" : "interactive"
            );
            const rebuiltPlan = buildPublicationPlan(context, {
                expectedMainCommit:
                    typeof plan["expectedMainCommit"] === "string"
                        ? String(plan["expectedMainCommit"])
                        : null,
                sourceCommit: String(plan["sourceCommit"]),
            });
            if (rebuiltPlan.planFingerprint !== plan["planFingerprint"]) {
                throw new PublicationError(
                    "The saved source commit or catalog no longer reproduces the reviewed publication.",
                    {
                        category: "repository",
                        code: "RESUME_PLAN_CHANGED",
                        exitCode: 3,
                        phase: "resume",
                    }
                );
            }
            plan = rebuiltPlan;
            await savePublicationPlan(repoRoot, plan);
        } else {
            const branch = runGitCapture(context, ["branch", "--show-current"]);
            if (branch !== "source") {
                throw new PublicationError(
                    `Font publication must run from source; current branch is ${branch || "detached"}.`,
                    {
                        category: "repository",
                        code: "WRONG_BRANCH",
                        exitCode: 3,
                        phase: "preflight",
                    }
                );
            }
            const status = runGitCapture(context, [
                "status",
                "--porcelain",
                "--untracked-files=no",
            ]);
            if (status.length > 0) {
                throw new PublicationError(
                    "Tracked source changes must be committed first.",
                    {
                        category: "repository",
                        code: "DIRTY_SOURCE",
                        exitCode: 3,
                        phase: "preflight",
                    }
                );
            }
            const sourceCommit = runGitCapture(context, ["rev-parse", "HEAD"]);
            const remoteSource = resolveRemoteRef(
                context,
                "origin",
                "refs/heads/source"
            );
            if (sourceCommit !== remoteSource) {
                throw new PublicationError(
                    "source must exactly match origin/source before publication.",
                    {
                        category: "repository",
                        code: "SOURCE_NOT_PUSHED",
                        exitCode: 3,
                        phase: "preflight",
                    }
                );
            }
            await verifyGeneratedCatalog(
                repoRoot,
                options.json ? "json" : "interactive"
            );
            plan = buildPublicationPlan(context, { sourceCommit });
            await savePublicationPlan(repoRoot, plan);
        }
        if (!options.apply) {
            const applyCommand = `npm run -- fonts:publish:latest -- --apply --confirm --plan-fingerprint ${String(plan["planFingerprint"])}`;
            if (options.json) {
                stdout.write(
                    `${JSON.stringify({ applyCommand, plan, status: "planned" })}\n`
                );
            } else {
                const catalog = /** @type {Record<string, unknown>} */ (
                    plan["catalog"]
                );
                stdout.write(
                    `${styleText(color, [ANSI.bold, ANSI.cyan], "Rolling Nerd Fonts publication plan")}\n`
                );
                stdout.write(`Source:       ${String(plan["sourceCommit"])}\n`);
                stdout.write(
                    `Current main: ${plan["expectedMainCommit"] === null ? "<missing>" : String(plan["expectedMainCommit"])}\n`
                );
                stdout.write(`New main:     ${String(plan["finalCommit"])}\n`);
                stdout.write(
                    `Catalog:      ${String(catalog["fontCount"])} fonts, ${formatBytes(Number(catalog["totalBytes"]))}\n`
                );
                stdout.write(
                    `Seed chunks:  ${String(/** @type {unknown[]} */ (plan["chunks"]).length)}\n`
                );
                stdout.write(
                    `Fingerprint:  ${styleText(color, ANSI.green, String(plan["planFingerprint"]))}\n\n${applyCommand}\n`
                );
            }
            return;
        }
        if (options.planFingerprint !== plan["planFingerprint"]) {
            throw new PublicationError(
                `Reviewed plan fingerprint changed: expected ${String(options.planFingerprint)}, received ${String(plan["planFingerprint"])}.`,
                {
                    category: "usage",
                    code: "PLAN_FINGERPRINT_MISMATCH",
                    exitCode: 2,
                    phase: "validate",
                }
            );
        }
        const result = await publishPublicationPlan(plan, {
            breakStaleLock: options.breakStaleLock,
            context,
            mode: options.json ? "json" : "interactive",
            onProgress: (message) => {
                if (options.verbose || !options.json) {
                    stderr.write(
                        `${styleText(color, ANSI.cyan, "[publish]")} ${message}\n`
                    );
                }
            },
            onWarning: (message) => {
                stderr.write(
                    `${styleText(color, ANSI.yellow, "warning:")} ${message}\n`
                );
            },
        });
        if (options.json) stdout.write(`${JSON.stringify(result)}\n`);
        else {
            stdout.write(
                `${styleText(color, [ANSI.bold, ANSI.green], "Published rolling main successfully.")}\nCommit: ${String(result.finalCommit)}\n`
            );
        }
    } catch (error) {
        const serialized = serializePublicationError(error);
        const exitCode =
            error instanceof PublicationError
                ? error.exitCode
                : Number(Reflect.get(Object(error), "exitCode")) || 1;
        if (options.json) {
            stdout.write(
                `${JSON.stringify({ error: serialized, status: "failed" })}\n`
            );
        } else {
            stderr.write(
                `${styleText(color, ANSI.red, "Font publication failed:")} ${
                    error instanceof Error ? error.message : String(error)
                }\n`
            );
        }
        process.exitCode = exitCode;
    }
}

if (isMainModule(process.argv[1], moduleFilePath)) {
    await main();
}
