/** Deterministic IPC fixture for the conversion-process pool tests. */

if (typeof process.send !== "function") {
    throw new Error("Mock conversion worker requires an IPC channel.");
}

process.send({ moduleMs: 0, type: "ready" });

process.on("message", (message) => {
    if (typeof message !== "object" || message === null) return;
    const type = Reflect.get(message, "type");
    if (type === "shutdown") process.exit(0);
    if (type !== "convert") return;

    const jobId = Reflect.get(message, "jobId");
    const sourcePath = Reflect.get(message, "sourcePath");
    if (!Number.isInteger(jobId) || typeof sourcePath !== "string") return;

    if (sourcePath === "hang") return;
    if (sourcePath === "crash") process.exit(17);

    const timings = {
        convertMs: 10.24,
        readMs: 0.8075,
        taskMs: 11.7034,
        writeMs: 0.6559,
    };
    if (sourcePath === "fail") {
        process.send?.({
            error: "fixture conversion failure",
            jobId,
            ok: false,
            timings,
            type: "result",
        });
        return;
    }

    if (sourcePath === "malformed") {
        process.send?.({ jobId, ok: true, timings, type: "result" });
        return;
    }

    const sendSuccess = () => {
        process.send?.({
            jobId,
            ok: true,
            sizeBytes: sourcePath.length,
            timings,
            type: "result",
        });
    };
    if (sourcePath.startsWith("delay-")) {
        setTimeout(sendSuccess, 25);
    } else {
        sendSuccess();
    }
});

process.once("disconnect", () => {
    process.exit(0);
});
