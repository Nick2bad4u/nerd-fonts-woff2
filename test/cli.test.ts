import assert from "node:assert/strict";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { describe, expect, it, vi } from "vitest";

import { main } from "../src/cli.js";

function createFixtureRoot(): string {
    return mkdtempSync(nodePath.join(tmpdir(), "nerd-font-woff2-test-"));
}

describe("cli main", () => {
    it("returns 0 for --help", () => {
        expect.assertions(1);

        vi.spyOn(process.stdout, "write").mockReturnValue(true);
        vi.spyOn(process.stderr, "write").mockReturnValue(true);

        const code = main(["--help"]);

        expect(code).toBe(0);
    });

    it("returns 1 when no source directory is provided", () => {
        expect.assertions(1);

        vi.spyOn(process.stdout, "write").mockReturnValue(true);
        vi.spyOn(process.stderr, "write").mockReturnValue(true);

        const code = main([]);

        expect(code).toBe(1);
    });

    it("returns 1 for invalid --max-files", () => {
        expect.assertions(1);

        vi.spyOn(process.stdout, "write").mockReturnValue(true);
        vi.spyOn(process.stderr, "write").mockReturnValue(true);

        const root = createFixtureRoot();
        const sourceDir = nodePath.join(root, "fonts");
        mkdirSync(sourceDir, { recursive: true });

        try {
            const code = main([
                "--source-dir",
                sourceDir,
                "--max-files",
                "0",
            ]);

            expect(code).toBe(1);
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("returns 1 when --convert is used without --confirm", () => {
        expect.assertions(1);

        vi.spyOn(process.stdout, "write").mockReturnValue(true);
        vi.spyOn(process.stderr, "write").mockReturnValue(true);

        const root = createFixtureRoot();
        const sourceDir = nodePath.join(root, "fonts");
        mkdirSync(sourceDir, { recursive: true });

        try {
            const code = main([
                "--source-dir",
                sourceDir,
                "--convert",
            ]);

            expect(code).toBe(1);
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("returns 0 for dry-run plan with discovered fonts", () => {
        expect.assertions(1);

        vi.spyOn(process.stdout, "write").mockReturnValue(true);
        vi.spyOn(process.stderr, "write").mockReturnValue(true);

        const root = createFixtureRoot();
        const sourceDir = nodePath.join(root, "fonts", "JetBrainsMono");
        mkdirSync(sourceDir, { recursive: true });
        writeFileSync(
            nodePath.join(sourceDir, "JetBrainsMonoNerdFont-Regular.ttf"),
            "fake"
        );

        try {
            const code = main([
                "--source-dir",
                nodePath.join(root, "fonts"),
                "--dry-run",
            ]);

            expect(code).toBe(0);
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("converts a font when using a custom converter command", () => {
        expect.assertions(5);

        vi.spyOn(process.stdout, "write").mockReturnValue(true);
        vi.spyOn(process.stderr, "write").mockReturnValue(true);

        const root = createFixtureRoot();
        const sourceDir = nodePath.join(root, "fonts", "FiraCode");
        const outDir = nodePath.join(root, "out");
        const tempDir = nodePath.join(root, "temp");
        const indexFile = nodePath.join(root, "index", "fonts.json");
        mkdirSync(sourceDir, { recursive: true });
        writeFileSync(
            nodePath.join(sourceDir, "FiraCodeNerdFont-Regular.ttf"),
            "fake"
        );

        const fakeConverter = nodePath.join(root, "fake-converter.mjs");
        writeFileSync(
            fakeConverter,
            [
                'import { copyFileSync } from "node:fs";',
                "const input = process.argv.at(-1);",
                'if (typeof input !== "string" || input.length === 0) {',
                "  process.exit(1);",
                "}",
                String.raw`const output = input.replace(/\.(ttf|otf)$/iu, ".woff2");`,
                "copyFileSync(input, output);",
            ].join("\n")
        );

        try {
            const code = main([
                "--source-dir",
                nodePath.join(root, "fonts"),
                "--convert",
                "--confirm",
                "--converter",
                process.execPath,
                "--converter-arg",
                fakeConverter,
                "--out-dir",
                outDir,
                "--temp-dir",
                tempDir,
                "--index-file",
                indexFile,
            ]);

            expect(code).toBe(0);

            const indexContent = readFileSync(indexFile, "utf8");

            expect(indexContent).toContain("FiraCodeNerdFont-Regular.woff2");

            const parsedIndex = JSON.parse(indexContent) as {
                outputPath: string;
            }[];

            expect(parsedIndex).toHaveLength(1);

            const [firstEntry] = parsedIndex;
            assert.ok(firstEntry);

            expect(firstEntry).toBeDefined();
            expect(existsSync(firstEntry.outputPath)).toBeTruthy();
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });
});
