import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// eslint-disable-next-line unicorn/prefer-import-meta-properties -- Node support lint rejects import.meta.dirname for the configured range.
const testDirectory = nodePath.dirname(fileURLToPath(import.meta.url));
const repoRoot = nodePath.resolve(testDirectory, "..");

function runScript(
    scriptName: string,
    argumentsList: readonly string[] = []
): { status: null | number; stderr: string; stdout: string } {
    const result = spawnSync(
        process.execPath,
        [nodePath.resolve(repoRoot, "scripts", scriptName), ...argumentsList],
        { cwd: repoRoot, encoding: "utf8", stdio: "pipe" }
    );

    return {
        status: result.status,
        stderr: result.stderr,
        stdout: result.stdout,
    };
}

describe("font maintenance script safety", () => {
    it("documents the safe update plan and explicit apply gates", () => {
        expect.assertions(4);

        const result = runScript("update-nerd-fonts.mjs", ["--help"]);

        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain("npm run fonts:update");
        expect(result.stdout).toContain("--convert --confirm");
    });

    it("rejects update application without confirmation before network work", () => {
        expect.assertions(3);

        const result = runScript("update-nerd-fonts.mjs", [
            "--ref",
            "v3.5.1",
            "--convert",
        ]);

        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(
            "requires both --convert and --confirm"
        );
    });

    it("rejects a source replacement without confirmation", () => {
        expect.assertions(3);

        const result = runScript("download-nerd-fonts-sources.mjs", [
            "--ref",
            "v3.5.1",
        ]);

        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("Add --confirm, or use --dry-run");
    });

    it("restricts custom download destinations to temp", () => {
        expect.assertions(3);

        const result = runScript("download-nerd-fonts-sources.mjs", [
            "--ref",
            "v3.5.1",
            "--output-dir",
            "src",
            "--confirm",
        ]);

        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(
            "custom --output-dir must be a child of the repository temp directory"
        );
    });

    it("rejects bulk conversion without confirmation", () => {
        expect.assertions(3);

        const result = runScript("bulk-convert-fonts.mjs", ["--convert"]);

        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(
            "requires both --convert and --confirm"
        );
    });

    it("rejects source files that map to one WOFF2 output", () => {
        expect.assertions(3);

        const fixtureRoot = mkdtempSync(
            nodePath.resolve(repoRoot, "temp", "font-collision-")
        );
        const sourceRoot = nodePath.resolve(fixtureRoot, "sources", "Family");
        const outputRoot = nodePath.resolve(fixtureRoot, "outputs");
        mkdirSync(sourceRoot, { recursive: true });
        writeFileSync(nodePath.resolve(sourceRoot, "SameName.ttf"), "");
        writeFileSync(nodePath.resolve(sourceRoot, "SameName.otf"), "");

        try {
            const result = runScript("bulk-convert-fonts.mjs", [
                "--source-dir",
                nodePath.resolve(fixtureRoot, "sources"),
                "--output-dir",
                outputRoot,
                "--dry-run",
            ]);

            expect(result.status).toBe(1);
            expect(result.stdout).toBe("");
            expect(result.stderr).toContain(
                "Sources map to the same WOFF2 output"
            );
        } finally {
            rmSync(fixtureRoot, { force: true, recursive: true });
        }
    });

    it("rejects repository traversal in public verification paths", () => {
        expect.assertions(3);

        const result = runScript("verify-font-assets.mjs", [
            "--public-output-dir",
            "../outside",
        ]);

        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(
            "Public index path must be repository-relative"
        );
    });

    it("rejects an asset directory outside the repository", () => {
        expect.assertions(3);

        const result = runScript("bulk-convert-fonts.mjs", [
            "--source-dir",
            "..",
            "--dry-run",
        ]);

        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("Refusing path outside repository");
    });

    it("rejects unknown update-check options before querying upstream", () => {
        expect.assertions(3);

        const result = runScript("check-nerd-fonts-updates.mjs", [
            "--unexpected",
        ]);

        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("Unknown option: --unexpected");
    });
});
