import { createHash } from "node:crypto";

import {
    parseChecksumManifest,
    parseSemverTag,
    UPSTREAM_REPOSITORY,
} from "./nerd-fonts-release.mjs";

const API_VERSION = "2026-03-10";
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_RATE_LIMIT_WAIT_MS = 120_000;

/** @param {number} milliseconds */
function delay(milliseconds) {
    return new Promise((resolvePromise) => {
        setTimeout(resolvePromise, milliseconds);
    });
}

/** @param {unknown} value @param {string} description */
function requireObject(value, description) {
    if (typeof value !== "object" || value === null) {
        throw new Error(`GitHub returned invalid ${description}.`);
    }

    return value;
}

/** @param {unknown} value @param {string} description */
function requireString(value, description) {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`GitHub returned an invalid ${description}.`);
    }

    return value;
}

/** @param {unknown} value @param {string} description */
function requireSafeInteger(value, description) {
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
        throw new Error(`GitHub returned an invalid ${description}.`);
    }

    return Number(value);
}

/**
 * @param {Headers} headers
 * @param {number} now
 *
 * @returns {number | null}
 */
function rateLimitDelay(headers, now) {
    const retryAfter = headers.get("retry-after");
    if (retryAfter !== null) {
        const seconds = Number(retryAfter);
        if (Number.isFinite(seconds) && seconds >= 0) {
            return Math.ceil(seconds * 1_000);
        }

        const date = Date.parse(retryAfter);
        if (Number.isFinite(date)) return Math.max(0, date - now);
    }

    if (headers.get("x-ratelimit-remaining") === "0") {
        const resetSeconds = Number(headers.get("x-ratelimit-reset"));
        if (Number.isFinite(resetSeconds)) {
            return Math.max(0, resetSeconds * 1_000 - now);
        }
    }

    return null;
}

/**
 * @param {string} url
 * @param {{
 *     attempts?: number;
 *     authenticated?: boolean;
 *     fetchImplementation?: typeof fetch;
 *     random?: () => number;
 *     requestTimeoutMs?: number;
 *     sleep?: (milliseconds: number) => Promise<void>;
 * }} [options]
 *
 * @returns {Promise<Response>}
 */
export async function fetchWithGitHubRetries(url, options = {}) {
    const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
    const fetchImplementation = options.fetchImplementation ?? fetch;
    const random = options.random ?? Math.random;
    const sleep = options.sleep ?? delay;
    const headers = {
        Accept: "application/vnd.github+json",
        "User-Agent": "nerd-fonts-woff2-updater",
        "X-GitHub-Api-Version": API_VERSION,
    };
    const githubToken = process.env["GITHUB_TOKEN"];
    if (options.authenticated !== false && githubToken) {
        Reflect.set(headers, "Authorization", `Bearer ${githubToken}`);
    }

    /** @type {unknown} */
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        let response;
        try {
            response = await fetchImplementation(url, {
                headers,
                redirect: "follow",
                signal: AbortSignal.timeout(
                    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
                ),
            });
        } catch (error) {
            lastError = error;
            if (attempt === attempts) break;
            await sleep(
                Math.round(500 * 2 ** (attempt - 1) * (0.5 + random()))
            );
            continue;
        }

        if (response.ok) return response;
        const requestId = response.headers.get("x-github-request-id");
        let responseText = "";
        if (response.status === 403) {
            try {
                responseText = await response.text();
            } catch {
                // Header-based rate-limit detection is still available.
            }
        }
        const rateLimited =
            response.status === 429 ||
            (response.status === 403 &&
                (response.headers.has("retry-after") ||
                    response.headers.get("x-ratelimit-remaining") === "0" ||
                    /(?:abuse|rate limit)/iv.test(responseText)));
        const transient = response.status >= 500;
        const retryDelay = rateLimitDelay(response.headers, Date.now());
        if (response.status !== 403) {
            try {
                await response.body?.cancel();
            } catch {
                // The response is already unusable; continue with the HTTP error.
            }
        }

        if ((!rateLimited && !transient) || attempt === attempts) {
            throw new Error(
                `GitHub request failed: HTTP ${response.status}${
                    requestId === null ? "" : ` (request ${requestId})`
                } for ${url}`
            );
        }

        if (rateLimited && retryDelay !== null) {
            if (retryDelay > MAX_RATE_LIMIT_WAIT_MS) {
                const resetAt = new Date(Date.now() + retryDelay).toISOString();
                throw new Error(
                    `GitHub rate limit will not reset until ${resetAt}${
                        requestId === null ? "" : ` (request ${requestId})`
                    }.`
                );
            }

            await sleep(retryDelay);
        } else {
            await sleep(
                Math.round(500 * 2 ** (attempt - 1) * (0.5 + random()))
            );
        }
    }

    throw new Error(
        `GitHub request failed after ${attempts} attempts: ${url}`,
        {
            cause: lastError,
        }
    );
}

/** @param {unknown} value @returns {unknown} */
function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(
        Object.keys(value)
            .sort((left, right) => left.localeCompare(right))
            .map((key) => [key, canonicalize(Reflect.get(value, key))])
    );
}

/** @param {unknown} value */
export function canonicalJson(value) {
    return JSON.stringify(canonicalize(value));
}

/** @param {unknown} identity */
export function calculatePlanFingerprint(identity) {
    return createHash("sha256").update(canonicalJson(identity)).digest("hex");
}

/**
 * @param {string} url
 * @param {Parameters<typeof fetchWithGitHubRetries>[1]} [options]
 */
async function fetchJson(url, options) {
    return (await fetchWithGitHubRetries(url, options)).json();
}

/**
 * @param {string} upstreamRef
 * @param {Parameters<typeof fetchWithGitHubRetries>[1]} [options]
 *
 * @returns {Promise<string>}
 */
async function resolveTagCommit(upstreamRef, options) {
    let object = requireObject(
        await fetchJson(
            `https://api.github.com/repos/${UPSTREAM_REPOSITORY}/git/ref/tags/${upstreamRef}`,
            options
        ),
        "tag reference"
    );
    object = requireObject(Reflect.get(object, "object"), "tag object");
    for (let depth = 0; depth < 5; depth += 1) {
        const type = requireString(Reflect.get(object, "type"), "tag type");
        const sha = requireString(Reflect.get(object, "sha"), "tag SHA");
        if (type === "commit") {
            if (!/^[\da-f]{40}$/v.test(sha)) {
                throw new Error(
                    `GitHub returned an invalid commit SHA: ${sha}`
                );
            }

            return sha;
        }

        if (type !== "tag") {
            throw new Error(`Unsupported Git tag object type: ${type}`);
        }

        const objectUrl = requireString(
            Reflect.get(object, "url"),
            "annotated tag URL"
        );
        const tag = requireObject(
            await fetchJson(objectUrl, options),
            "annotated tag"
        );
        object = requireObject(
            Reflect.get(tag, "object"),
            "annotated tag object"
        );
    }

    throw new Error(
        `Too many annotated tag levels while resolving ${upstreamRef}.`
    );
}

/** @param {unknown} value */
function releaseAsset(value) {
    const asset = requireObject(value, "release asset");
    const name = requireString(Reflect.get(asset, "name"), "asset name");
    const digestValue = Reflect.get(asset, "digest");
    const digest = typeof digestValue === "string" ? digestValue : null;
    if (digest !== null && !/^sha256:[\da-f]{64}$/v.test(digest)) {
        throw new Error(`GitHub returned an invalid digest for ${name}.`);
    }

    return {
        createdAt: requireString(
            Reflect.get(asset, "created_at"),
            `${name} creation timestamp`
        ),
        digest,
        downloadUrl: requireString(
            Reflect.get(asset, "browser_download_url"),
            `${name} download URL`
        ),
        id: requireSafeInteger(Reflect.get(asset, "id"), `${name} asset ID`),
        name,
        size: requireSafeInteger(
            Reflect.get(asset, "size"),
            `${name} asset size`
        ),
        updatedAt: requireString(
            Reflect.get(asset, "updated_at"),
            `${name} update timestamp`
        ),
    };
}

/**
 * @param {string | null} requestedRef
 * @param {Parameters<typeof fetchWithGitHubRetries>[1]} [options]
 */
export async function fetchReviewedReleaseIdentity(requestedRef, options = {}) {
    const releaseUrl =
        requestedRef === null
            ? `https://api.github.com/repos/${UPSTREAM_REPOSITORY}/releases/latest`
            : `https://api.github.com/repos/${UPSTREAM_REPOSITORY}/releases/tags/${requestedRef}`;
    const release = requireObject(
        await fetchJson(releaseUrl, options),
        "release data"
    );
    const upstreamRef = requireString(
        Reflect.get(release, "tag_name"),
        "release tag"
    );
    if (parseSemverTag(upstreamRef) === null) {
        throw new Error(
            `GitHub returned a non-semantic release tag: ${upstreamRef}`
        );
    }

    if (requestedRef !== null && upstreamRef !== requestedRef) {
        throw new Error(
            `GitHub returned ${upstreamRef} while resolving ${requestedRef}.`
        );
    }

    const rawAssets = Reflect.get(release, "assets");
    if (!Array.isArray(rawAssets)) {
        throw new Error(
            `GitHub returned no release assets for ${upstreamRef}.`
        );
    }

    const assets = rawAssets.map(releaseAsset);
    const checksumAsset = assets.find((asset) => asset.name === "SHA-256.txt");
    const archives = assets
        .filter((asset) => asset.name.endsWith(".tar.xz"))
        .sort((left, right) => left.name.localeCompare(right.name));
    if (checksumAsset === undefined || archives.length === 0) {
        throw new Error(
            `${upstreamRef} does not expose .tar.xz assets and SHA-256.txt.`
        );
    }

    const manifestResponse = await fetchWithGitHubRetries(
        checksumAsset.downloadUrl,
        { ...options, authenticated: false }
    );
    const manifestText = await manifestResponse.text();
    const manifestSha256 = createHash("sha256")
        .update(manifestText)
        .digest("hex");
    if (
        checksumAsset.digest !== null &&
        checksumAsset.digest !== `sha256:${manifestSha256}`
    ) {
        throw new Error("SHA-256.txt does not match its GitHub asset digest.");
    }

    const manifest = parseChecksumManifest(manifestText);
    const reviewedArchives = archives.map((asset) => {
        const expectedSha256 = manifest.get(asset.name);
        if (expectedSha256 === undefined) {
            throw new Error(`SHA-256.txt does not contain ${asset.name}.`);
        }

        if (
            asset.digest !== null &&
            asset.digest !== `sha256:${expectedSha256}`
        ) {
            throw new Error(
                `${asset.name} GitHub digest disagrees with SHA-256.txt.`
            );
        }

        const { downloadUrl: _downloadUrl, ...identityAsset } = asset;
        return { ...identityAsset, manifestSha256: expectedSha256 };
    });
    const commitSha = await resolveTagCommit(upstreamRef, options);
    const identity = {
        archives: reviewedArchives,
        checksumManifest: {
            createdAt: checksumAsset.createdAt,
            digest: checksumAsset.digest,
            id: checksumAsset.id,
            manifestSha256,
            name: checksumAsset.name,
            size: checksumAsset.size,
            updatedAt: checksumAsset.updatedAt,
        },
        commitSha,
        publishedAt: requireString(
            Reflect.get(release, "published_at"),
            "release publication timestamp"
        ),
        releaseId: requireSafeInteger(Reflect.get(release, "id"), "release ID"),
        schemaVersion: 1,
        upstreamRef,
        upstreamRepository: UPSTREAM_REPOSITORY,
    };
    const planFingerprint = calculatePlanFingerprint(identity);
    return {
        archiveCount: reviewedArchives.length,
        compressedBytes: reviewedArchives.reduce(
            (total, asset) => total + asset.size,
            0
        ),
        identity,
        manifestText,
        planFingerprint,
        publishedAt: identity.publishedAt,
        releaseUrl: `https://github.com/${UPSTREAM_REPOSITORY}/releases/tag/${upstreamRef}`,
        targetRef: upstreamRef,
    };
}
