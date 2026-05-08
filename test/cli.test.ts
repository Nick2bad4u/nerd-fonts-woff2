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

/** Writes a fake converter that exits with code 1 (failure). */
function writeFailingConverter(root: string): string {
    const script = nodePath.join(root, "fail-converter.mjs");
    writeFileSync(
        script,
        String.raw`process.stderr.write("conversion failed\n"); process.exit(1);`
    );
    return script;
}

/** Writes a fake .ttf font file (4 bytes, for testing). */
function writeFakeFont(dir: string, name: string): string {
    const fontPath = nodePath.join(dir, name);
    writeFileSync(fontPath, "fake");
    return fontPath;
}

/**
 * Writes a fake converter that produces an output file WITHOUT WOFF2 magic
 * bytes.
 */
function writeInvalidWoff2Converter(root: string): string {
    const script = nodePath.join(root, "invalid-woff2-converter.mjs");
    writeFileSync(
        script,
        [
            'import { writeFileSync } from "node:fs";',
            "const input = process.argv.at(-1);",
            String.raw`const output = input.replace(/\.(ttf|otf)$/iu, ".woff2");`,
            'writeFileSync(output, "NOT_WOFF2_CONTENT");',
        ].join("\n")
    );
    return script;
}

/** Writes a fake converter that exits 0 but produces NO output file. */
function writeNoOutputConverter(root: string): string {
    const script = nodePath.join(root, "no-output-converter.mjs");
    writeFileSync(script, "process.exit(0);");
    return script;
}

/**
 * Writes a fake converter script that produces valid WOFF2 output (prepends the
 * magic bytes 0x77 0x4F 0x46 0x32 before the source content).
 */
function writeValidWoff2Converter(root: string): string {
    const script = nodePath.join(root, "fake-converter.mjs");
    writeFileSync(
        script,
        [
            'import { readFileSync, writeFileSync } from "node:fs";',
            "const input = process.argv.at(-1);",
            'if (typeof input !== "string" || input.length === 0) {',
            "  process.exit(1);",
            "}",
            String.raw`const output = input.replace(/\.(ttf|otf)$/iu, ".woff2");`,
            "const MAGIC = Buffer.from([0x77, 0x4f, 0x46, 0x32]);",
            "const data = readFileSync(input);",
            "writeFileSync(output, Buffer.concat([MAGIC, data]));",
        ].join("\n")
    );
    return script;
}

describe("cli main", () => {
    // ─── Flag validation ──────────────────────────────────────────────────────

    it("returns 0 for --help", async () => {
        expect.assertions(1);

        vi.spyOn(process.stdout, "write").mockReturnValue(true);
        vi.spyOn(process.stderr, "write").mockReturnValue(true);

        const code = await main(["--help"]);

        expect(code).toBe(0);
    });

    it("returns 1 when no source directory is provided", async () => {
        expect.assertions(1);

        vi.spyOn(process.stdout, "write").mockReturnValue(true);
        vi.spyOn(process.stderr, "write").mockReturnValue(true);

        const code = await main([]);

        expect(code).toBe(1);
    });

    it("returns 1 for invalid --max-files", async () => {
        expect.assertions(1);

        vi.spyOn(process.stdout, "write").mockReturnValue(true);
        vi.spyOn(process.stderr, "write").mockReturnValue(true);

        const root = createFixtureRoot();
        const sourceDir = nodePath.join(root, "fonts");
        mkdirSync(sourceDir, { recursive: true });

        try {
            const code = await main([
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

    it("returns 1 when --convert is used without --confirm", async () => {
        expect.assertions(1);

        vi.spyOn(process.stdout, "write").mockReturnValue(true);
        vi.spyOn(process.stderr, "write").mockReturnValue(true);

        const root = createFixtureRoot();
        const sourceDir = nodePath.join(root, "fonts");
        mkdirSync(sourceDir, { recursive: true });

        try {
            const code = await main([
                "--source-dir",
                sourceDir,
                "--convert",
            ]);

            expect(code).toBe(1);
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("returns 1 for invalid --concurrency", async () => {
        expect.assertions(1);

        vi.spyOn(process.stdout, "write").mockReturnValue(true);
        vi.spyOn(process.stderr, "write").mockReturnValue(true);

        const root = createFixtureRoot();
        const sourceDir = nodePath.join(root, "fonts");
        mkdirSync(sourceDir, { recursive: true });

        try {
            const code = await main([
                "--source-dir",
                sourceDir,
                "--concurrency",
                "0",
            ]);

            expect(code).toBe(1);
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("returns 1 for invalid --timeout", async () => {
        expect.assertions(1);

        vi.spyOn(process.stdout, "write").mockReturnValue(true);
        vi.spyOn(process.stderr, "write").mockReturnValue(true);

        const root = createFixtureRoot();
        const sourceDir = nodePath.join(root, "fonts");
        mkdirSync(sourceDir, { recursive: true });

        try {
            const code = await main([
                "--source-dir",
                sourceDir,
                "--timeout",
                "abc",
            ]);

            expect(code).toBe(1);
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("returns 1 for unsupported --include-ext value", async () => {
        expect.assertions(1);

        vi.spyOn(process.stdout, "write").mockReturnValue(true);
        vi.spyOn(process.stderr, "write").mockReturnValue(true);

        const root = createFixtureRoot();
        const sourceDir = nodePath.join(root, "fonts");
        mkdirSync(sourceDir, { recursive: true });

        try {
            const code = await main([
                "--source-dir",
                sourceDir,
                "--include-ext",
                "woff",
            ]);

            expect(code).toBe(1);
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("returns 1 when source directory does not exist", async () => {
        expect.assertions(1);

        vi.spyOn(process.stdout, "write").mockReturnValue(true);
        vi.spyOn(process.stderr, "write").mockReturnValue(true);

        const code = await main([
            "--source-dir",
            "/nonexistent/path/that/does/not/exist",
        ]);

        expect(code).toBe(1);
    });

    it("returns 1 for empty --converter value (via manifest)", async () => {
        expect.assertions(1);

        vi.spyOn(process.stdout, "write").mockReturnValue(true);
        vi.spyOn(process.stderr, "write").mockReturnValue(true);

        const root = createFixtureRoot();
        const sourceDir = nodePath.join(root, "fonts");
        mkdirSync(sourceDir, { recursive: true });

        const manifestFile = nodePath.join(root, "manifest.json");
        writeFileSync(
            manifestFile,
            JSON.stringify({
                // Whitespace-only converter in manifest is stored as-is and triggers error
                converter: "   ",
                sourceDirs: [sourceDir],
            })
        );

        try {
            const code = await main(["--manifest", manifestFile]);

            expect(code).toBe(1);
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    // ─── Plan mode ────────────────────────────────────────────────────────────

    it("returns 0 for plan mode with no fonts", async () => {
        expect.assertions(1);

        vi.spyOn(process.stdout, "write").mockReturnValue(true);
        vi.spyOn(process.stderr, "write").mockReturnValue(true);

        const root = createFixtureRoot();
        const sourceDir = nodePath.join(root, "fonts");
        mkdirSync(sourceDir, { recursive: true });

        try {
            const code = await main(["--source-dir", sourceDir]);

            expect(code).toBe(0);
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("returns 0 for dry-run plan with discovered fonts", async () => {
        expect.assertions(1);

        vi.spyOn(process.stdout, "write").mockReturnValue(true);
        vi.spyOn(process.stderr, "write").mockReturnValue(true);

        const root = createFixtureRoot();
        const sourceDir = nodePath.join(root, "fonts", "JetBrainsMono");
        mkdirSync(sourceDir, { recursive: true });
        writeFakeFont(sourceDir, "JetBrainsMonoNerdFont-Regular.ttf");

        try {
            const code = await main([
                "--source-dir",
                nodePath.join(root, "fonts"),
                "--dry-run",
            ]);

            expect(code).toBe(0);
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("returns 0 for plan with --json output", async () => {
        expect.assertions(2);

        const stdoutLines: string[] = [];
        vi.spyOn(process.stdout, "write").mockImplementation((data) => {
            stdoutLines.push(String(data));
            return true;
        });
        vi.spyOn(process.stderr, "write").mockReturnValue(true);

        const root = createFixtureRoot();
        const sourceDir = nodePath.join(root, "fonts", "TestFamily");
        mkdirSync(sourceDir, { recursive: true });
        writeFakeFont(sourceDir, "TestFamily-Regular.ttf");

        try {
            const code = await main([
                "--source-dir",
                nodePath.join(root, "fonts"),
                "--json",
            ]);

            expect(code).toBe(0);

            const combined = stdoutLines.join("");
            const parsed = JSON.parse(combined) as {
                mode: string;
                planned: number;
            };

            expect(parsed.mode).toBe("plan");
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("emits JSON error to stderr for validation errors with --json", async () => {
        expect.assertions(2);

        const stderrLines: string[] = [];
        vi.spyOn(process.stdout, "write").mockReturnValue(true);
        vi.spyOn(process.stderr, "write").mockImplementation((data) => {
            stderrLines.push(String(data));
            return true;
        });

        const code = await main(["--json"]);

        expect(code).toBe(1);

        const combined = stderrLines.join("");
        const parsed = JSON.parse(combined) as { error: { category: string } };

        expect(parsed.error.category).toBe("validation_error");
    });

    it("returns 0 for plan with --verbose lists planned files", async () => {
        expect.assertions(2);

        const stdoutLines: string[] = [];
        vi.spyOn(process.stdout, "write").mockImplementation((data) => {
            stdoutLines.push(String(data));
            return true;
        });
        vi.spyOn(process.stderr, "write").mockReturnValue(true);

        const root = createFixtureRoot();
        const sourceDir = nodePath.join(root, "fonts", "Verbose");
        mkdirSync(sourceDir, { recursive: true });
        writeFakeFont(sourceDir, "Verbose-Regular.ttf");

        try {
            const code = await main([
                "--source-dir",
                nodePath.join(root, "fonts"),
                "--verbose",
            ]);

            expect(code).toBe(0);

            const combined = stdoutLines.join("");

            expect(combined).toContain("Verbose-Regular.ttf");
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("returns 0 for plan with --debug prints debug info", async () => {
        expect.assertions(2);

        const stdoutLines: string[] = [];
        vi.spyOn(process.stdout, "write").mockImplementation((data) => {
            stdoutLines.push(String(data));
            return true;
        });
        vi.spyOn(process.stderr, "write").mockReturnValue(true);

        const root = createFixtureRoot();
        const sourceDir = nodePath.join(root, "fonts", "DebugFamily");
        mkdirSync(sourceDir, { recursive: true });
        writeFakeFont(sourceDir, "DebugFamily-Regular.ttf");

        try {
            const code = await main([
                "--source-dir",
                nodePath.join(root, "fonts"),
                "--debug",
            ]);

            expect(code).toBe(0);

            const combined = stdoutLines.join("");

            expect(combined).toContain("[debug]");
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("--debug shows default timeout of 60000 ms", async () => {
        expect.assertions(2);

        const stdoutLines: string[] = [];
        vi.spyOn(process.stdout, "write").mockImplementation((data) => {
            stdoutLines.push(String(data));
            return true;
        });
        vi.spyOn(process.stderr, "write").mockReturnValue(true);

        const root = createFixtureRoot();
        const sourceDir = nodePath.join(root, "fonts", "DefaultTimeout");
        mkdirSync(sourceDir, { recursive: true });
        writeFakeFont(sourceDir, "DefaultTimeout-Regular.ttf");

        try {
            const code = await main([
                "--source-dir",
                nodePath.join(root, "fonts"),
                "--debug",
            ]);

            expect(code).toBe(0);
            expect(stdoutLines.join("")).toContain("60000 ms");
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("plan mode does not write default index file", async () => {
        expect.assertions(2);

        vi.spyOn(process.stdout, "write").mockReturnValue(true);
        vi.spyOn(process.stderr, "write").mockReturnValue(true);

        const root = createFixtureRoot();
        const sourceDir = nodePath.join(root, "fonts", "PlanIndex");
        const outDir = nodePath.join(root, "out");
        mkdirSync(sourceDir, { recursive: true });
        writeFakeFont(sourceDir, "PlanIndex-Regular.ttf");

        const expectedIndex = nodePath.join(outDir, "index.json");

        try {
            const code = await main([
                "--source-dir",
                nodePath.join(root, "fonts"),
                "--out-dir",
                outDir,
            ]);

            expect(code).toBe(0);
            expect(existsSync(expectedIndex)).toBeFalsy();
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("--max-files limits number of planned files", async () => {
        expect.assertions(2);

        const stdoutLines: string[] = [];
        vi.spyOn(process.stdout, "write").mockImplementation((data) => {
            stdoutLines.push(String(data));
            return true;
        });
        vi.spyOn(process.stderr, "write").mockReturnValue(true);

        const root = createFixtureRoot();
        const sourceDir = nodePath.join(root, "fonts", "Multi");
        mkdirSync(sourceDir, { recursive: true });
        writeFakeFont(sourceDir, "Multi-Bold.ttf");
        writeFakeFont(sourceDir, "Multi-Light.ttf");
        writeFakeFont(sourceDir, "Multi-Regular.ttf");

        try {
            const code = await main([
                "--source-dir",
                nodePath.join(root, "fonts"),
                "--max-files",
                "1",
                "--json",
            ]);

            expect(code).toBe(0);

            const parsed = JSON.parse(stdoutLines.join("")) as {
                planned: number;
            };

            expect(parsed.planned).toBe(1);
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    // ─── Conversion ───────────────────────────────────────────────────────────

    it("converts a font when using a custom converter command", async () => {
        expect.assertions(5);

        vi.spyOn(process.stdout, "write").mockReturnValue(true);
        vi.spyOn(process.stderr, "write").mockReturnValue(true);

        const root = createFixtureRoot();
        const sourceDir = nodePath.join(root, "fonts", "FiraCode");
        const outDir = nodePath.join(root, "out");
        const tempDir = nodePath.join(root, "temp");
        const indexFile = nodePath.join(root, "index", "fonts.json");
        mkdirSync(sourceDir, { recursive: true });
        writeFakeFont(sourceDir, "FiraCodeNerdFont-Regular.ttf");

        const fakeConverter = writeValidWoff2Converter(root);

        try {
            const code = await main([
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

    it("convert mode writes default index file at out-dir root", async () => {
        expect.assertions(3);

        vi.spyOn(process.stdout, "write").mockReturnValue(true);
        vi.spyOn(process.stderr, "write").mockReturnValue(true);

        const root = createFixtureRoot();
        const sourceDir = nodePath.join(root, "fonts", "DefaultIndex");
        const outDir = nodePath.join(root, "out");
        const tempDir = nodePath.join(root, "temp");
        mkdirSync(sourceDir, { recursive: true });
        writeFakeFont(sourceDir, "DefaultIndex-Regular.ttf");

        const fakeConverter = writeValidWoff2Converter(root);
        const expectedIndex = nodePath.join(outDir, "index.json");

        try {
            const code = await main([
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
            ]);

            expect(code).toBe(0);
            expect(existsSync(expectedIndex)).toBeTruthy();
            expect(readFileSync(expectedIndex, "utf8")).toContain(
                "DefaultIndex-Regular.woff2"
            );
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("converts with --yes as alias for --confirm", async () => {
        expect.assertions(1);

        vi.spyOn(process.stdout, "write").mockReturnValue(true);
        vi.spyOn(process.stderr, "write").mockReturnValue(true);

        const root = createFixtureRoot();
        const sourceDir = nodePath.join(root, "fonts", "Alias");
        const outDir = nodePath.join(root, "out");
        const tempDir = nodePath.join(root, "temp");
        mkdirSync(sourceDir, { recursive: true });
        writeFakeFont(sourceDir, "Alias-Regular.ttf");

        const fakeConverter = writeValidWoff2Converter(root);

        try {
            const code = await main([
                "--source-dir",
                nodePath.join(root, "fonts"),
                "--convert",
                "--yes",
                "--converter",
                process.execPath,
                "--converter-arg",
                fakeConverter,
                "--out-dir",
                outDir,
                "--temp-dir",
                tempDir,
            ]);

            expect(code).toBe(0);
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("converts with --concurrency 2", async () => {
        expect.assertions(1);

        vi.spyOn(process.stdout, "write").mockReturnValue(true);
        vi.spyOn(process.stderr, "write").mockReturnValue(true);

        const root = createFixtureRoot();
        const sourceDir = nodePath.join(root, "fonts", "Concurrent");
        const outDir = nodePath.join(root, "out");
        const tempDir = nodePath.join(root, "temp");
        mkdirSync(sourceDir, { recursive: true });
        writeFakeFont(sourceDir, "Concurrent-Bold.ttf");
        writeFakeFont(sourceDir, "Concurrent-Regular.ttf");

        const fakeConverter = writeValidWoff2Converter(root);

        try {
            const code = await main([
                "--source-dir",
                nodePath.join(root, "fonts"),
                "--convert",
                "--confirm",
                "--concurrency",
                "2",
                "--converter",
                process.execPath,
                "--converter-arg",
                fakeConverter,
                "--out-dir",
                outDir,
                "--temp-dir",
                tempDir,
            ]);

            expect(code).toBe(0);
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("converts with --timeout set", async () => {
        expect.assertions(1);

        vi.spyOn(process.stdout, "write").mockReturnValue(true);
        vi.spyOn(process.stderr, "write").mockReturnValue(true);

        const root = createFixtureRoot();
        const sourceDir = nodePath.join(root, "fonts", "Timeout");
        const outDir = nodePath.join(root, "out");
        const tempDir = nodePath.join(root, "temp");
        mkdirSync(sourceDir, { recursive: true });
        writeFakeFont(sourceDir, "Timeout-Regular.ttf");

        const fakeConverter = writeValidWoff2Converter(root);

        try {
            const code = await main([
                "--source-dir",
                nodePath.join(root, "fonts"),
                "--convert",
                "--confirm",
                "--timeout",
                "10000",
                "--converter",
                process.execPath,
                "--converter-arg",
                fakeConverter,
                "--out-dir",
                outDir,
                "--temp-dir",
                tempDir,
            ]);

            expect(code).toBe(0);
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("converts with --verbose shows per-file progress", async () => {
        expect.assertions(2);

        const stdoutLines: string[] = [];
        vi.spyOn(process.stdout, "write").mockImplementation((data) => {
            stdoutLines.push(String(data));
            return true;
        });
        vi.spyOn(process.stderr, "write").mockReturnValue(true);

        const root = createFixtureRoot();
        const sourceDir = nodePath.join(root, "fonts", "VerboseConvert");
        const outDir = nodePath.join(root, "out");
        const tempDir = nodePath.join(root, "temp");
        mkdirSync(sourceDir, { recursive: true });
        writeFakeFont(sourceDir, "VerboseConvert-Regular.ttf");

        const fakeConverter = writeValidWoff2Converter(root);

        try {
            const code = await main([
                "--source-dir",
                nodePath.join(root, "fonts"),
                "--convert",
                "--confirm",
                "--verbose",
                "--converter",
                process.execPath,
                "--converter-arg",
                fakeConverter,
                "--out-dir",
                outDir,
                "--temp-dir",
                tempDir,
            ]);

            expect(code).toBe(0);

            const combined = stdoutLines.join("");

            expect(combined).toContain("VerboseConvert-Regular.ttf");
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("converts with --debug shows debug info", async () => {
        expect.assertions(2);

        const stdoutLines: string[] = [];
        vi.spyOn(process.stdout, "write").mockImplementation((data) => {
            stdoutLines.push(String(data));
            return true;
        });
        vi.spyOn(process.stderr, "write").mockReturnValue(true);

        const root = createFixtureRoot();
        const sourceDir = nodePath.join(root, "fonts", "DebugConvert");
        const outDir = nodePath.join(root, "out");
        const tempDir = nodePath.join(root, "temp");
        mkdirSync(sourceDir, { recursive: true });
        writeFakeFont(sourceDir, "DebugConvert-Regular.ttf");

        const fakeConverter = writeValidWoff2Converter(root);

        try {
            const code = await main([
                "--source-dir",
                nodePath.join(root, "fonts"),
                "--convert",
                "--confirm",
                "--debug",
                "--converter",
                process.execPath,
                "--converter-arg",
                fakeConverter,
                "--out-dir",
                outDir,
                "--temp-dir",
                tempDir,
            ]);

            expect(code).toBe(0);

            const combined = stdoutLines.join("");

            expect(combined).toContain("[debug]");
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("returns 2 when the converter exits non-zero", async () => {
        expect.assertions(1);

        vi.spyOn(process.stdout, "write").mockReturnValue(true);
        vi.spyOn(process.stderr, "write").mockReturnValue(true);

        const root = createFixtureRoot();
        const sourceDir = nodePath.join(root, "fonts", "Failing");
        const outDir = nodePath.join(root, "out");
        const tempDir = nodePath.join(root, "temp");
        mkdirSync(sourceDir, { recursive: true });
        writeFakeFont(sourceDir, "Failing-Regular.ttf");

        const failingConverter = writeFailingConverter(root);

        try {
            const code = await main([
                "--source-dir",
                nodePath.join(root, "fonts"),
                "--convert",
                "--confirm",
                "--converter",
                process.execPath,
                "--converter-arg",
                failingConverter,
                "--out-dir",
                outDir,
                "--temp-dir",
                tempDir,
            ]);

            expect(code).toBe(2);
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("returns 2 when the converter produces no output file", async () => {
        expect.assertions(1);

        vi.spyOn(process.stdout, "write").mockReturnValue(true);
        vi.spyOn(process.stderr, "write").mockReturnValue(true);

        const root = createFixtureRoot();
        const sourceDir = nodePath.join(root, "fonts", "NoOutput");
        const outDir = nodePath.join(root, "out");
        const tempDir = nodePath.join(root, "temp");
        mkdirSync(sourceDir, { recursive: true });
        writeFakeFont(sourceDir, "NoOutput-Regular.ttf");

        const noOutputConverter = writeNoOutputConverter(root);

        try {
            const code = await main([
                "--source-dir",
                nodePath.join(root, "fonts"),
                "--convert",
                "--confirm",
                "--converter",
                process.execPath,
                "--converter-arg",
                noOutputConverter,
                "--out-dir",
                outDir,
                "--temp-dir",
                tempDir,
            ]);

            expect(code).toBe(2);
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("returns 2 when the converter produces an invalid WOFF2 file", async () => {
        expect.assertions(1);

        vi.spyOn(process.stdout, "write").mockReturnValue(true);
        vi.spyOn(process.stderr, "write").mockReturnValue(true);

        const root = createFixtureRoot();
        const sourceDir = nodePath.join(root, "fonts", "BadWoff2");
        const outDir = nodePath.join(root, "out");
        const tempDir = nodePath.join(root, "temp");
        mkdirSync(sourceDir, { recursive: true });
        writeFakeFont(sourceDir, "BadWoff2-Regular.ttf");

        const invalidWoff2Converter = writeInvalidWoff2Converter(root);

        try {
            const code = await main([
                "--source-dir",
                nodePath.join(root, "fonts"),
                "--convert",
                "--confirm",
                "--converter",
                process.execPath,
                "--converter-arg",
                invalidWoff2Converter,
                "--out-dir",
                outDir,
                "--temp-dir",
                tempDir,
            ]);

            expect(code).toBe(2);
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("--fail-fast stops on first failure", async () => {
        expect.assertions(2);

        const stdoutLines: string[] = [];
        vi.spyOn(process.stdout, "write").mockImplementation((data) => {
            stdoutLines.push(String(data));
            return true;
        });
        vi.spyOn(process.stderr, "write").mockReturnValue(true);

        const root = createFixtureRoot();
        const sourceDir = nodePath.join(root, "fonts", "FailFast");
        const outDir = nodePath.join(root, "out");
        const tempDir = nodePath.join(root, "temp");
        mkdirSync(sourceDir, { recursive: true });
        writeFakeFont(sourceDir, "FailFast-Bold.ttf");
        writeFakeFont(sourceDir, "FailFast-Regular.ttf");

        const failingConverter = writeFailingConverter(root);

        try {
            const code = await main([
                "--source-dir",
                nodePath.join(root, "fonts"),
                "--convert",
                "--confirm",
                "--fail-fast",
                "--converter",
                process.execPath,
                "--converter-arg",
                failingConverter,
                "--out-dir",
                outDir,
                "--temp-dir",
                tempDir,
                "--json",
            ]);

            expect(code).toBe(2);

            const parsed = JSON.parse(stdoutLines.join("")) as {
                failed: number;
            };

            // Fail-fast: stops after first failure, so failed count is 1
            expect(parsed.failed).toBe(1);
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("--verbose shows failure list in summary", async () => {
        expect.assertions(2);

        const stdoutLines: string[] = [];
        vi.spyOn(process.stdout, "write").mockImplementation((data) => {
            stdoutLines.push(String(data));
            return true;
        });
        vi.spyOn(process.stderr, "write").mockReturnValue(true);

        const root = createFixtureRoot();
        const sourceDir = nodePath.join(root, "fonts", "VerboseFail");
        const outDir = nodePath.join(root, "out");
        const tempDir = nodePath.join(root, "temp");
        mkdirSync(sourceDir, { recursive: true });
        writeFakeFont(sourceDir, "VerboseFail-Regular.ttf");

        const failingConverter = writeFailingConverter(root);

        try {
            const code = await main([
                "--source-dir",
                nodePath.join(root, "fonts"),
                "--convert",
                "--confirm",
                "--verbose",
                "--converter",
                process.execPath,
                "--converter-arg",
                failingConverter,
                "--out-dir",
                outDir,
                "--temp-dir",
                tempDir,
            ]);

            expect(code).toBe(2);

            const combined = stdoutLines.join("");

            expect(combined).toContain("Failures:");
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("--dry-run with --convert skips conversion and returns 0", async () => {
        expect.assertions(1);

        vi.spyOn(process.stdout, "write").mockReturnValue(true);
        vi.spyOn(process.stderr, "write").mockReturnValue(true);

        const root = createFixtureRoot();
        const sourceDir = nodePath.join(root, "fonts", "DryRun");
        mkdirSync(sourceDir, { recursive: true });
        writeFakeFont(sourceDir, "DryRun-Regular.ttf");

        try {
            const code = await main([
                "--source-dir",
                nodePath.join(root, "fonts"),
                "--convert",
                "--confirm",
                "--dry-run",
            ]);

            expect(code).toBe(0);
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("--json output for successful conversion contains correct shape", async () => {
        expect.assertions(3);

        const stdoutLines: string[] = [];
        vi.spyOn(process.stdout, "write").mockImplementation((data) => {
            stdoutLines.push(String(data));
            return true;
        });
        vi.spyOn(process.stderr, "write").mockReturnValue(true);

        const root = createFixtureRoot();
        const sourceDir = nodePath.join(root, "fonts", "JsonOut");
        const outDir = nodePath.join(root, "out");
        const tempDir = nodePath.join(root, "temp");
        mkdirSync(sourceDir, { recursive: true });
        writeFakeFont(sourceDir, "JsonOut-Regular.ttf");

        const fakeConverter = writeValidWoff2Converter(root);

        try {
            const code = await main([
                "--source-dir",
                nodePath.join(root, "fonts"),
                "--convert",
                "--confirm",
                "--json",
                "--converter",
                process.execPath,
                "--converter-arg",
                fakeConverter,
                "--out-dir",
                outDir,
                "--temp-dir",
                tempDir,
            ]);

            expect(code).toBe(0);

            const parsed = JSON.parse(stdoutLines.join("")) as {
                converted: number;
                failed: number;
                mode: string;
            };

            expect(parsed.mode).toBe("convert");
            expect(parsed.converted).toBe(1);
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    // ─── Manifest ─────────────────────────────────────────────────────────────

    it("loads a valid manifest file", async () => {
        expect.assertions(1);

        vi.spyOn(process.stdout, "write").mockReturnValue(true);
        vi.spyOn(process.stderr, "write").mockReturnValue(true);

        const root = createFixtureRoot();
        const sourceDir = nodePath.join(root, "fonts", "Manifest");
        mkdirSync(sourceDir, { recursive: true });
        writeFakeFont(sourceDir, "Manifest-Regular.ttf");

        const manifestFile = nodePath.join(root, "manifest.json");
        writeFileSync(
            manifestFile,
            JSON.stringify({
                sourceDirs: [nodePath.join(root, "fonts")],
            })
        );

        try {
            const code = await main(["--manifest", manifestFile]);

            expect(code).toBe(0);
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("returns 1 when --manifest file does not exist", async () => {
        expect.assertions(1);

        vi.spyOn(process.stdout, "write").mockReturnValue(true);
        vi.spyOn(process.stderr, "write").mockReturnValue(true);

        const code = await main(["--manifest", "/nonexistent/manifest.json"]);

        expect(code).toBe(1);
    });

    it("returns 1 when --manifest is not valid JSON", async () => {
        expect.assertions(1);

        vi.spyOn(process.stdout, "write").mockReturnValue(true);
        vi.spyOn(process.stderr, "write").mockReturnValue(true);

        const root = createFixtureRoot();
        const badManifest = nodePath.join(root, "bad.json");
        writeFileSync(badManifest, "not json at all {{{");

        try {
            const code = await main(["--manifest", badManifest]);

            expect(code).toBe(1);
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("returns 1 when --manifest root is not an object", async () => {
        expect.assertions(1);

        vi.spyOn(process.stdout, "write").mockReturnValue(true);
        vi.spyOn(process.stderr, "write").mockReturnValue(true);

        const root = createFixtureRoot();
        const badManifest = nodePath.join(root, "array.json");
        writeFileSync(
            badManifest,
            JSON.stringify([
                1,
                2,
                3,
            ])
        );

        try {
            const code = await main(["--manifest", badManifest]);

            expect(code).toBe(1);
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("manifest with all fields loads and converts correctly", async () => {
        expect.assertions(1);

        vi.spyOn(process.stdout, "write").mockReturnValue(true);
        vi.spyOn(process.stderr, "write").mockReturnValue(true);

        const root = createFixtureRoot();
        const sourceDir = nodePath.join(root, "fonts", "FullManifest");
        const outDir = nodePath.join(root, "out");
        const tempDir = nodePath.join(root, "temp");
        mkdirSync(sourceDir, { recursive: true });
        writeFakeFont(sourceDir, "FullManifest-Regular.ttf");

        const fakeConverter = writeValidWoff2Converter(root);
        const manifestFile = nodePath.join(root, "manifest.json");
        writeFileSync(
            manifestFile,
            JSON.stringify({
                converter: process.execPath,
                converterArgs: [fakeConverter],
                includeExts: ["ttf"],
                maxFiles: 10,
                outDir,
                sourceDirs: [nodePath.join(root, "fonts")],
                tempDir,
            })
        );

        try {
            const code = await main([
                "--manifest",
                manifestFile,
                "--convert",
                "--confirm",
            ]);

            expect(code).toBe(0);
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("--converter-arg is repeatable and accumulates extra args", async () => {
        expect.assertions(1);

        vi.spyOn(process.stdout, "write").mockReturnValue(true);
        vi.spyOn(process.stderr, "write").mockReturnValue(true);

        const root = createFixtureRoot();
        const sourceDir = nodePath.join(root, "fonts", "ArgTest");
        const outDir = nodePath.join(root, "out");
        const tempDir = nodePath.join(root, "temp");
        mkdirSync(sourceDir, { recursive: true });
        writeFakeFont(sourceDir, "ArgTest-Regular.ttf");

        const fakeConverter = writeValidWoff2Converter(root);

        try {
            const code = await main([
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
            ]);

            expect(code).toBe(0);
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });
});
