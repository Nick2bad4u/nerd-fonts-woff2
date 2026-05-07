import assert from "node:assert/strict";
import {
    mkdtempSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
    existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { main } from "../src/cli.js";

function withSilentConsole<T>(callback: () => T): T {
    const originalLog = console.log;
    const originalError = console.error;

    console.log = () => {};
    console.error = () => {};

    try {
        return callback();
    } finally {
        console.log = originalLog;
        console.error = originalError;
    }
}

function createFixtureRoot(): string {
    return mkdtempSync(join(tmpdir(), "nerd-font-woff2-test-"));
}

test("main returns 0 for --help", () => {
    const code = withSilentConsole(() => main(["--help"]));
    assert.equal(code, 0);
});

test("main returns 1 when no source directory is provided", () => {
    const code = withSilentConsole(() => main([]));
    assert.equal(code, 1);
});

test("main returns 1 for invalid --max-files", () => {
    const root = createFixtureRoot();
    const sourceDir = join(root, "fonts");
    mkdirSync(sourceDir, { recursive: true });

    try {
        const code = withSilentConsole(() =>
            main([
                "--source-dir",
                sourceDir,
                "--max-files",
                "0",
            ])
        );
        assert.equal(code, 1);
    } finally {
        rmSync(root, { force: true, recursive: true });
    }
});

test("main returns 1 when --convert is used without --confirm", () => {
    const root = createFixtureRoot();
    const sourceDir = join(root, "fonts");
    mkdirSync(sourceDir, { recursive: true });

    try {
        const code = withSilentConsole(() =>
            main([
                "--source-dir",
                sourceDir,
                "--convert",
            ])
        );
        assert.equal(code, 1);
    } finally {
        rmSync(root, { force: true, recursive: true });
    }
});

test("main returns 0 for dry-run plan with discovered fonts", () => {
    const root = createFixtureRoot();
    const sourceDir = join(root, "fonts", "JetBrainsMono");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "JetBrainsMonoNerdFont-Regular.ttf"), "fake");

    try {
        const code = withSilentConsole(() =>
            main([
                "--source-dir",
                join(root, "fonts"),
                "--dry-run",
            ])
        );
        assert.equal(code, 0);
    } finally {
        rmSync(root, { force: true, recursive: true });
    }
});

test("main converts a font when using a custom converter command", () => {
    const root = createFixtureRoot();
    const sourceDir = join(root, "fonts", "FiraCode");
    const outDir = join(root, "out");
    const tempDir = join(root, "temp");
    const indexFile = join(root, "index", "fonts.json");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "FiraCodeNerdFont-Regular.ttf"), "fake");

    const fakeConverter = join(root, "fake-converter.mjs");
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
        const code = withSilentConsole(() =>
            main([
                "--source-dir",
                join(root, "fonts"),
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
            ])
        );

        assert.equal(code, 0);

        const indexContent = readFileSync(indexFile, "utf8");
        assert.ok(indexContent.includes("FiraCodeNerdFont-Regular.woff2"));

        const parsedIndex = JSON.parse(indexContent) as Array<{
            outputPath: string;
        }>;
        assert.equal(parsedIndex.length, 1);
        const [firstEntry] = parsedIndex;
        assert.ok(firstEntry);
        assert.ok(existsSync(firstEntry.outputPath));
    } finally {
        rmSync(root, { force: true, recursive: true });
    }
});
