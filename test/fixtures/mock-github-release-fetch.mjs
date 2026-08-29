import { createHash } from "node:crypto";

const archiveSha256 = "a".repeat(64);
const manifestText = `${archiveSha256}  Test.tar.xz\n`;
const manifestSha256 = createHash("sha256").update(manifestText).digest("hex");
const timestamp = "2026-08-21T00:00:00Z";

globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/releases/tags/v3.5.1")) {
        return Response.json({
            assets: [
                {
                    browser_download_url:
                        "https://downloads.example/Test.tar.xz",
                    created_at: timestamp,
                    digest: `sha256:${archiveSha256}`,
                    id: 101,
                    name: "Test.tar.xz",
                    size: 123,
                    updated_at: timestamp,
                },
                {
                    browser_download_url:
                        "https://downloads.example/SHA-256.txt",
                    created_at: timestamp,
                    digest: `sha256:${manifestSha256}`,
                    id: 102,
                    name: "SHA-256.txt",
                    size: Buffer.byteLength(manifestText),
                    updated_at: timestamp,
                },
            ],
            id: 100,
            published_at: timestamp,
            tag_name: "v3.5.1",
        });
    }
    if (url === "https://downloads.example/SHA-256.txt") {
        return new Response(manifestText);
    }
    if (url.endsWith("/git/ref/tags/v3.5.1")) {
        return Response.json({
            object: {
                sha: "b".repeat(40),
                type: "commit",
            },
        });
    }

    return new Response("Not found", { status: 404 });
};
