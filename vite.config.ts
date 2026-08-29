import { coverageConfigDefaults, defineConfig } from "vitest/config";

const vitestConfig: ReturnType<typeof defineConfig> = defineConfig({
    test: {
        coverage: {
            clean: true,
            exclude: [
                "**/*.d.ts",
                "**/*.config.*",
                "**/*.{test,spec}.ts",
                "**/*types*.ts",
                "**/dist/**",
                "**/node_modules/**",
                "**/temp/**",
                "scripts/**",
                ...coverageConfigDefaults.exclude,
            ],
            include: ["src/**/*.ts"],
            provider: "v8",
            reporter: [
                "text",
                "json",
                "lcov",
                "html",
            ],
            reportsDirectory: "./coverage",
            thresholds: {
                branches: 60,
                functions: 65,
                lines: 65,
                statements: 65,
            },
        },
        environment: "node",
        exclude: [
            "test/fixtures/**",
            "dist/**",
            "node_modules/**",
        ],
        globals: false,
        include: ["test/**/*.{test,spec}.ts"],
        maxWorkers: 4,
        pool: "threads",
        restoreMocks: true,
        setupFiles: ["./test/_internal/vitest-setup.ts"],
        slowTestThreshold: 5000,
    },
});

export default vitestConfig;
