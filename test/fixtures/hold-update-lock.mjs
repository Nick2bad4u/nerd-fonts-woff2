import { acquireUpdateLock } from "../../scripts/update-transaction.mjs";

const [repoRoot, targetRef] = process.argv.slice(2);

if (repoRoot === undefined || targetRef === undefined) {
    process.stderr.write("Expected repository root and target ref.\n");
    process.exitCode = 2;
} else {
    let lock;
    try {
        lock = await acquireUpdateLock(repoRoot, { targetRef });
        process.stdout.write("ready\n");
        process.stdin.resume();
        await new Promise((resolvePromise) => {
            process.stdin.once("data", resolvePromise);
        });
        await lock.release();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
    }
}
