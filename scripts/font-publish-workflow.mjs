#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { runCommand } from "./command-runner.mjs";
import { isMainModule } from "./nerd-fonts-release.mjs";
import {
    buildPublicationPlan,
    PublicationError,
    runGitCapture,
    savePublicationPlan,
    serializePublicationError,
} from "./rolling-publish-core.mjs";
import { ANSI, resolveColorEnabled, styleText } from "./terminal-output.mjs";

// eslint-disable-next-line unicorn/prefer-import-meta-properties -- Keep the supported Node range explicit.
const moduleFilePath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(moduleFilePath), "..");
const updaterPath = resolve(
    repoRoot,
    "scripts",
    "nerd-fonts-update-workflow.mjs"
);
const publisherPath = resolve(repoRoot, "scripts", "publish-latest-fonts.mjs");

function printHelp() {
    process.stdout.write(
        "Refresh, verify, commit, and publish the rolling Nerd Fonts catalog.\n\n"
    );
    process.stdout.write("  npm run fonts:refresh:latest\n");
    process.stdout.write("  npm run fonts:publish:resume\n\n");
    process.stdout.write("Options:\n");
    process.stdout.write(
        "  --resume              Resume a reviewed publication\n"
    );
    process.stdout.write("  --verbose             Show child progress\n");
    process.stdout.write("  --color / --no-color  ANSI output control\n");
    process.stdout.write("  --help                Show help\n");
}

/** @param {string[]} argumentsList */
export function parseRefreshArguments(argumentsList) {
    /**
     * @type {{
     *     color: boolean | null;
     *     help: boolean;
     *     resume: boolean;
     *     verbose: boolean;
     * }}
     */
    const options = {
        color: null,
        help: false,
        resume: false,
        verbose: false,
    };
    const seen = new Set();
    for (const token of argumentsList) {
        if (token === "--color" || token === "--no-color") {
            if (seen.has("color")) throw new Error("Duplicate color option.");
            seen.add("color");
            options.color = token === "--color";
            continue;
        }
        const property = Reflect.get(
            { "--help": "help", "--resume": "resume", "--verbose": "verbose" },
            token
        );
        if (typeof property !== "string") {
            throw new Error(`Unknown option: ${token}`);
        }
        if (seen.has(token)) throw new Error(`Duplicate option: ${token}`);
        seen.add(token);
        Reflect.set(options, property, true);
    }
    return options;
}

/**
 * @param {readonly string[]} argumentsList @param {"capture" | "interactive" |
 *   "json"} mode
 */
async function runNodeScript(argumentsList, mode = "interactive") {
    return runCommand(process.execPath, argumentsList, {
        absoluteTimeoutMs: 12 * 60 * 60 * 1000,
        cwd: repoRoot,
        inactivityTimeoutMs: 20 * 60 * 1000,
        maxTailBytes: 32 * 1024 * 1024,
        mode,
    });
}

/** @param {string} name */
async function runNpmScript(name) {
    const npmCli = process.env["npm_execpath"];
    if (npmCli === undefined) {
        throw new PublicationError(
            `npm_execpath is unavailable while running ${name}. Invoke this workflow through npm.`,
            {
                category: "prerequisite",
                code: "NPM_CLI_MISSING",
                exitCode: 4,
                phase: "quality-gates",
            }
        );
    }
    return runCommand(
        process.execPath,
        [
            npmCli,
            "run",
            name,
        ],
        {
            absoluteTimeoutMs: 60 * 60 * 1000,
            cwd: repoRoot,
            inactivityTimeoutMs: 10 * 60 * 1000,
            mode: "interactive",
        }
    );
}

/** @param {string[]} argumentsList */
export async function runRefreshWorkflow(
    argumentsList = process.argv.slice(2)
) {
    const options = parseRefreshArguments(argumentsList);
    if (options.help) {
        printHelp();
        return { status: "help" };
    }
    const color = resolveColorEnabled(options.color, process.stderr);
    const context = { repoRoot };
    if (options.resume) {
        await runNodeScript([
            publisherPath,
            "--resume",
            "--verbose",
        ]);
        return { status: "resumed" };
    }
    const branch = runGitCapture(context, ["branch", "--show-current"]);
    if (branch !== "source") {
        throw new PublicationError(
            `The guided refresh must run from source, not ${branch || "detached HEAD"}.`,
            {
                category: "repository",
                code: "WRONG_BRANCH",
                exitCode: 3,
                phase: "preflight",
            }
        );
    }
    const beforeStatus = runGitCapture(context, [
        "status",
        "--porcelain",
        "--untracked-files=no",
    ]);
    if (beforeStatus.length > 0) {
        throw new PublicationError(
            "Commit tracked source changes before starting a catalog refresh.",
            {
                category: "repository",
                code: "DIRTY_SOURCE",
                exitCode: 3,
                phase: "preflight",
            }
        );
    }
    process.stderr.write(
        `${styleText(color, ANSI.cyan, "[refresh]")} Running the reviewed upstream update workflow.\n`
    );
    await runNodeScript([
        updaterPath,
        "guided",
        "--",
        "--verbose",
        ...(options.color === false ? ["--no-color"] : []),
    ]);
    for (const gate of [
        "build",
        "typecheck",
        "lint",
        "test",
        "fonts:verify",
    ]) {
        process.stderr.write(
            `${styleText(color, ANSI.cyan, "[refresh]")} Running npm run ${gate}.\n`
        );
        await runNpmScript(gate);
    }
    const afterStatus = runGitCapture(context, [
        "status",
        "--porcelain",
        "--untracked-files=no",
    ]);
    if (afterStatus.length > 0) {
        const changedPaths = afterStatus
            .split(/\r?\n/u)
            .filter(Boolean)
            .map((line) => line.slice(3));
        if (changedPaths.some((path) => path !== "README.md")) {
            throw new PublicationError(
                `The updater changed unexpected tracked paths:\n${afterStatus}`,
                {
                    category: "repository",
                    code: "UNEXPECTED_SOURCE_CHANGES",
                    exitCode: 3,
                    phase: "source-commit",
                }
            );
        }
        const metadata = JSON.parse(
            readFileSync(
                resolve(repoRoot, "fonts", "woff2", "source-metadata.json"),
                "utf8"
            )
        );
        runGitCapture(context, [
            "add",
            "--",
            "README.md",
        ]);
        runGitCapture(context, [
            "commit",
            "-m",
            `🧹 [chore] (fonts) Refresh catalog to Nerd Fonts ${String(metadata.upstreamRef)}`,
        ]);
    }
    const sourceCommit = runGitCapture(context, ["rev-parse", "HEAD"]);
    const plan = buildPublicationPlan(context, { sourceCommit });
    await savePublicationPlan(repoRoot, plan);
    const fingerprint = String(plan["planFingerprint"]);
    process.stdout.write(
        `\nPublication fingerprint: ${styleText(color, ANSI.green, fingerprint)}\n`
    );
    const readline = createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    let confirmation;
    try {
        confirmation = (
            await readline.question(
                "Type the complete publication fingerprint to push source and publish main, or press Enter to cancel: "
            )
        ).trim();
    } finally {
        readline.close();
    }
    if (confirmation.length === 0) return { status: "cancelled" };
    if (confirmation !== fingerprint) {
        throw new PublicationError(
            "Publication fingerprint confirmation did not match.",
            {
                category: "usage",
                code: "CONFIRMATION_MISMATCH",
                exitCode: 2,
                phase: "confirm",
            }
        );
    }
    await runCommand(
        "git",
        [
            "push",
            "origin",
            `HEAD:refs/heads/source`,
        ],
        {
            absoluteTimeoutMs: 30 * 60 * 1000,
            cwd: repoRoot,
            inactivityTimeoutMs: 5 * 60 * 1000,
            mode: "interactive",
        }
    );
    runGitCapture(context, [
        "fetch",
        "origin",
        "source",
    ]);
    await runNodeScript([
        publisherPath,
        "--apply",
        "--confirm",
        "--plan-fingerprint",
        fingerprint,
        "--verbose",
        ...(options.color === false ? ["--no-color"] : []),
    ]);
    return { fingerprint, status: "published" };
}

export async function main(argumentsList = process.argv.slice(2)) {
    try {
        await runRefreshWorkflow(argumentsList);
    } catch (error) {
        process.stderr.write(
            `Rolling refresh failed: ${
                error instanceof Error ? error.message : String(error)
            }\n`
        );
        if (process.env["FONT_PUBLISH_DEBUG"] === "1") {
            process.stderr.write(
                `${JSON.stringify(serializePublicationError(error))}\n`
            );
        }
        process.exitCode =
            error instanceof PublicationError ? error.exitCode : 1;
    }
}

if (isMainModule(process.argv[1], moduleFilePath)) {
    await main();
}
