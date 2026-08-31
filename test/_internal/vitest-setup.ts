/**
 * Vitest global setup for nerd-fonts-woff2 tests.
 *
 * This file is referenced by `vite.config.ts#test.setupFiles`. All mock state
 * is automatically restored between tests by `restoreMocks: true`.
 */

import { mkdirSync } from "node:fs";

// A clean source checkout must create its ignored repository-local test fixture root explicitly.
// eslint-disable-next-line unicorn/no-top-level-side-effects -- Vitest setup must materialize the shared fixture root before test modules load.
mkdirSync(new URL("../../temp/", import.meta.url), { recursive: true });

// Label the process for easier identification during test runs.
process.title = "vitest:nerd-fonts-woff2";

export const isVitestSetupLoaded = true;
