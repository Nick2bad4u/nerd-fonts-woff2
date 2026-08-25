import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import * as nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";

// eslint-disable-next-line unicorn/prefer-import-meta-properties -- Supported Node range includes versions without import.meta.dirname.
const testDirectory = nodePath.dirname(fileURLToPath(import.meta.url));
const repoRoot = nodePath.resolve(testDirectory, "..");
const transactionUrl = pathToFileURL(
    nodePath.resolve(repoRoot, "scripts", "update-transaction.mjs")
).href;
const updaterUrl = pathToFileURL(
    nodePath.resolve(repoRoot, "scripts", "update-nerd-fonts.mjs")
).href;
const lockHolderFixture = nodePath.resolve(
    testDirectory,
    "fixtures",
    "hold-update-lock.mjs"
);

function runInlineModule(source: string): {
    status: null | number;
    stderr: string;
    stdout: string;
} {
    const result = spawnSync(
        process.execPath,
        [
            "--input-type=module",
            "--eval",
            source,
        ],
        {
            cwd: repoRoot,
            encoding: "utf8",
            maxBuffer: 16 * 1024 * 1024,
            stdio: "pipe",
            windowsHide: true,
        }
    );
    return {
        status: result.status,
        stderr: result.stderr,
        stdout: result.stdout,
    };
}

describe("updater concurrency", () => {
    it("serializes processes and rechecks installed refs after locking", async () => {
        expect.assertions(18);

        const tempParent = nodePath.resolve(repoRoot, "temp");
        await mkdir(tempParent, { recursive: true });
        const lockRoot = await mkdtemp(
            nodePath.resolve(tempParent, "updater-concurrent-")
        );
        const holder = spawn(
            process.execPath,
            [
                lockHolderFixture,
                lockRoot,
                "v3.6.0",
            ],
            {
                cwd: repoRoot,
                stdio: "pipe",
                windowsHide: true,
            }
        );
        onTestFinished(async () => {
            if (holder.exitCode === null && holder.signalCode === null) {
                const exitPromise = once(holder, "exit");
                holder.kill("SIGKILL");
                await exitPromise;
            }
            await rm(lockRoot, { force: true, recursive: true });
        });
        const [readyChunk] = await once(holder.stdout, "data");

        expect(String(readyChunk)).toBe("ready\n");

        const attempts = runInlineModule(`
            import { acquireUpdateLock } from ${JSON.stringify(transactionUrl)};
            const results = {};
            for (const targetRef of ["v3.6.0", "v3.5.0"]) {
                try {
                    const lock = await acquireUpdateLock(${JSON.stringify(lockRoot)}, { targetRef });
                    results[targetRef] = "acquired";
                    await lock.release();
                } catch (error) {
                    results[targetRef] = error.message;
                }
            }
            process.stdout.write(JSON.stringify(results));
        `);
        const attemptOutput = JSON.parse(attempts.stdout) as Record<
            string,
            string
        >;

        expect(attempts.status).toBe(0);
        expect(attempts.stderr).toBe("");
        expect(attemptOutput["v3.6.0"]).toContain("update is active");
        expect(attemptOutput["v3.5.0"]).toContain("update is active");

        const decisions = runInlineModule(`
            import { determineInstalledRefOutcome } from ${JSON.stringify(updaterUrl)};
            let forceDowngrade;
            try {
                determineInstalledRefOutcome("v3.6.0", "v3.5.0", true);
            } catch (error) {
                forceDowngrade = error.message;
            }
            process.stdout.write(JSON.stringify({
                afterLock: determineInstalledRefOutcome("v3.6.0", "v3.5.0", false),
                beforeLock: determineInstalledRefOutcome("v3.4.0", "v3.5.0", false),
                forceDowngrade,
                forcedSame: determineInstalledRefOutcome("v3.5.0", "v3.5.0", true),
                noOp: determineInstalledRefOutcome("v3.5.0", "v3.5.0", false),
                upgrade: determineInstalledRefOutcome("v3.4.0", "v3.5.0", true),
            }));
        `);
        const decisionOutput = JSON.parse(decisions.stdout) as Record<
            string,
            unknown
        >;

        expect(decisions.status).toBe(0);
        expect(decisions.stderr).toBe("");
        expect(decisionOutput["beforeLock"]).toBeNull();
        expect(decisionOutput["afterLock"]).toBe("superseded");
        expect(decisionOutput["noOp"]).toBe("no-op");
        expect(decisionOutput["forcedSame"]).toBeNull();
        expect(decisionOutput["upgrade"]).toBeNull();
        expect(decisionOutput["forceDowngrade"]).toContain(
            "cannot apply older v3.5.0"
        );

        const holderExitPromise = once(holder, "exit");
        holder.stdin?.write("release\n");
        holder.stdin?.end();
        const [holderExitCode] = await holderExitPromise;
        const holderError = holder.stderr?.read();

        expect(holderExitCode).toBe(0);
        expect(holderError === null ? "" : String(holderError)).toBe("");

        const reacquired = runInlineModule(`
            import { acquireUpdateLock } from ${JSON.stringify(transactionUrl)};
            const lock = await acquireUpdateLock(${JSON.stringify(lockRoot)}, {
                targetRef: "v3.5.0",
            });
            await lock.release();
            process.stdout.write(JSON.stringify({ acquired: true }));
        `);

        expect(reacquired.status).toBe(0);
        expect(reacquired.stderr).toBe("");
        expect(JSON.parse(reacquired.stdout)).toStrictEqual({ acquired: true });
    });
});
