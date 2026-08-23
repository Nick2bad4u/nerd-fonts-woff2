#!/usr/bin/env node

import { fileURLToPath } from "node:url";

import {
    compareSemverTags,
    fetchLatestUpstreamTag,
    isMainModule,
    readLocalSourceMetadata,
    UPSTREAM_REPO,
} from "./nerd-fonts-release.mjs";

/**
 * @param {readonly string[]} argumentsList
 *
 * @returns {{ asJson: boolean; failOnUpdate: boolean }}
 */
export function parseCheckOptions(argumentsList) {
    const allowed = new Set(["--fail-on-update", "--json"]);
    const unknown = argumentsList.filter((argument) => !allowed.has(argument));
    if (unknown.length > 0) {
        throw new Error(`Unknown option: ${unknown[0]}`);
    }

    return {
        asJson: argumentsList.includes("--json"),
        failOnUpdate: argumentsList.includes("--fail-on-update"),
    };
}

/**
 * @param {readonly string[]} argumentsList
 * @param {string} repoRoot
 *
 * @returns {void}
 */
export function main(
    argumentsList = process.argv.slice(2),
    repoRoot = process.cwd()
) {
    const { asJson, failOnUpdate } = parseCheckOptions(argumentsList);
    const local = readLocalSourceMetadata(repoRoot);
    const latestTag = fetchLatestUpstreamTag();
    const localRef =
        local !== null && typeof local.metadata.upstreamRef === "string"
            ? local.metadata.upstreamRef
            : null;
    const updateAvailable =
        localRef === null ? true : compareSemverTags(localRef, latestTag) < 0;

    const result = {
        latestTag,
        localRef,
        metadataFile: local?.file ?? null,
        updateAvailable,
        upstreamRepo: UPSTREAM_REPO,
    };

    if (asJson) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
        process.stdout.write(`Upstream latest Nerd Fonts tag: ${latestTag}\n`);
        process.stdout.write(
            `Local generated source ref: ${localRef ?? "(missing provenance)"}\n`
        );
        process.stdout.write(
            `Update available: ${updateAvailable ? "yes" : "no"}\n`
        );
        process.stdout.write(
            `Metadata file: ${local?.file ?? "(not found)"}\n`
        );
    }

    if (updateAvailable && failOnUpdate) {
        process.exitCode = 2;
    }
}

const moduleFilePath = fileURLToPath(import.meta.url);
if (isMainModule(process.argv[1], moduleFilePath)) {
    try {
        main();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Error: ${message}\n`);
        process.exitCode = 1;
    }
}
