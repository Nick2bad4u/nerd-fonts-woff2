import { defineConfig } from "vitest/config";

/**
 * Vitest configuration used exclusively by Stryker mutation testing.
 *
 * @remarks
 * This profile intentionally disables file parallelism and forces a single
 * worker to keep mutant execution deterministic and resource-bounded.
 */
const strykerVitestConfig: ReturnType<typeof defineConfig> = defineConfig({
    test: {
        css: false,
        dangerouslyIgnoreUnhandledErrors: false,
        env: {
            NODE_ENV: "test",
        },
        environment: "node",
        exclude: ["test/fixtures/**", "docs/**"],
        expect: {
            poll: { interval: 50, timeout: 15_000 },
            requireAssertions: false,
        },
        fakeTimers: {
            advanceTimeDelta: 20,
            loopLimit: 10_000,
            now: Date.now(),
            shouldAdvanceTime: false,
            shouldClearNativeTimers: true,
        },
        fileParallelism: false,
        globals: true,
        include: ["test/**/*.{test,spec}.ts"],
        isolate: true,
        maxWorkers: 1,
        name: {
            color: "yellow",
            label: "Stryker",
        }, // Custom project name and color for Stryker test runs
        pool: "threads",
        printConsoleTrace: false,
        retry: 0,
        sequence: {
            concurrent: false,
            groupOrder: 0,
            setupFiles: "parallel",
        },
        setupFiles: ["./test/_internal/vitest-setup.ts"],
        slowTestThreshold: 300,
        testTimeout: 15_000,
    },
});

export default strykerVitestConfig;
