import assert from "node:assert/strict";
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

test("main returns 1 for invalid --repo format", () => {
    const code = withSilentConsole(() =>
        main([
            "--repo",
            "invalid-repo",
            "--dry-run",
        ])
    );
    assert.equal(code, 1);
});

test("main returns 1 for invalid status", () => {
    const code = withSilentConsole(() =>
        main([
            "--repo",
            "owner/repo",
            "--status",
            "not-real-status",
        ])
    );

    assert.equal(code, 1);
});

test("main returns 1 for invalid limit", () => {
    const code = withSilentConsole(() =>
        main([
            "--repo",
            "owner/repo",
            "--limit",
            "0",
        ])
    );
    assert.equal(code, 1);
});

test("main returns 1 for missing confirm when not dry-run", () => {
    const code = withSilentConsole(() => main([]));
    assert.equal(code, 1);
});

test("main returns 0 for --help", () => {
    const code = withSilentConsole(() => main(["--help"]));
    assert.equal(code, 0);
});

test("main returns 1 for invalid before-days", () => {
    const code = withSilentConsole(() =>
        main([
            "--before-days",
            "-1",
            "--dry-run",
        ])
    );
    assert.equal(code, 1);
});

test("main returns 1 for invalid max-retries", () => {
    const code = withSilentConsole(() =>
        main([
            "--max-retries",
            "-1",
            "--dry-run",
        ])
    );
    assert.equal(code, 1);
});

test("main returns 1 for invalid retry-delay-ms", () => {
    const code = withSilentConsole(() =>
        main([
            "--retry-delay-ms",
            "-1",
            "--dry-run",
        ])
    );
    assert.equal(code, 1);
});

test("main returns 1 for invalid max-failures", () => {
    const code = withSilentConsole(() =>
        main([
            "--max-failures",
            "0",
            "--dry-run",
        ])
    );
    assert.equal(code, 1);
});

test("main returns 1 for invalid order", () => {
    const code = withSilentConsole(() =>
        main([
            "--order",
            "sideways",
            "--dry-run",
        ])
    );
    assert.equal(code, 1);
});

test("main returns 1 for invalid color mode", () => {
    const code = withSilentConsole(() =>
        main([
            "--color",
            "rainbow",
            "--dry-run",
        ])
    );
    assert.equal(code, 1);
});

test("main returns 1 for invalid unicode mode", () => {
    const code = withSilentConsole(() =>
        main([
            "--unicode",
            "emoji",
            "--dry-run",
        ])
    );
    assert.equal(code, 1);
});

test("main returns 1 when --all-repos is combined with --repo", () => {
    const code = withSilentConsole(() =>
        main([
            "--all-repos",
            "--repo",
            "owner/repo",
            "--dry-run",
        ])
    );
    assert.equal(code, 1);
});
