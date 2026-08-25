#!/usr/bin/env node

import { fileURLToPath } from "node:url";

import { isMainModule } from "./nerd-fonts-release.mjs";
import { runCli } from "./nerd-fonts-updater.mjs";

export {
    createProgressReporter,
    determineInstalledRefOutcome,
    main,
    parseUpdateOptions,
    renderProgressBar,
    runCli,
    serializeError,
    UpdaterError,
} from "./nerd-fonts-updater.mjs";

const moduleFilePath = fileURLToPath(import.meta.url);
if (isMainModule(process.argv[1], moduleFilePath)) {
    await runCli();
}
