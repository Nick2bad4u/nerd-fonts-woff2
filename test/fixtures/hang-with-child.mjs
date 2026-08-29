import { spawn } from "node:child_process";

const descendant = spawn(
    process.execPath,
    ["--eval", "setInterval(() => undefined, 1000)"],
    {
        stdio: "ignore",
        windowsHide: true,
    }
);

process.stdout.write(String(descendant.pid));
setInterval(() => undefined, 1_000);
