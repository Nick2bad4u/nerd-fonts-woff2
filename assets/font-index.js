const searchInput = /** @type {HTMLInputElement} */ (
    document.getElementById("search")
);
const versionInput = /** @type {HTMLInputElement} */ (
    document.getElementById("version")
);
const statusNode = /** @type {HTMLParagraphElement} */ (
    document.getElementById("status")
);
const resultsNode = /** @type {HTMLElement} */ (
    document.getElementById("results")
);
const familyLinksNode = /** @type {HTMLElement} */ (
    document.getElementById("family_links")
);
const statFamiliesNode = /** @type {HTMLElement} */ (
    document.getElementById("stat_families")
);
const statFilesNode = /** @type {HTMLElement} */ (
    document.getElementById("stat_files")
);
const statVersionNode = /** @type {HTMLElement} */ (
    document.getElementById("stat_version")
);

/**
 * @param {string} value
 *
 * @returns {string}
 */
function slugify(value) {
    return value
        .toLowerCase()
        .replaceAll(/[^a-z0-9]+/gu, "-")
        .replaceAll(/^-+|-+$/gu, "")
        .slice(0, 120);
}

/**
 * @param {string} version
 * @param {number} familyCount
 * @param {number} fileCount
 *
 * @returns {void}
 */
function renderStats(version, familyCount, fileCount) {
    statFamiliesNode.textContent = `Families: ${familyCount.toLocaleString()}`;
    statFilesNode.textContent = `Files: ${fileCount.toLocaleString()}`;
    statVersionNode.textContent = `Version: ${version}`;
}

/**
 * @param {readonly [
 *     string,
 *     {
 *         family: string;
 *         fileName: string;
 *         outputPath: string;
 *         converted: boolean;
 *     }[],
 * ][]} groups
 *
 * @returns {void}
 */
function renderFamilyLinks(groups) {
    familyLinksNode.replaceChildren();

    for (const [family, familyEntries] of groups) {
        const item = document.createElement("li");
        const link = document.createElement("a");
        link.href = `#family-${slugify(family)}`;
        link.textContent = `${family} (${familyEntries.length})`;
        item.append(link);
        familyLinksNode.append(item);
    }
}

/**
 * @type {{
 *     family: string;
 *     fileName: string;
 *     outputPath: string;
 *     converted: boolean;
 * }[]}
 */
let entries = [];

/**
 * @param {string} outputPath
 * @param {string} family
 * @param {string} fileName
 *
 * @returns {string}
 */
function toRelativePath(outputPath, family, fileName) {
    const normalized = outputPath.replaceAll("\\", "/");
    const marker = "/fonts/woff2/";
    const markerIndex = normalized.indexOf(marker);
    if (markerIndex >= 0) {
        return normalized.slice(markerIndex + 1);
    }

    return `fonts/woff2/${family}/${fileName}`;
}

/**
 * @param {string} version
 * @param {string} relativePath
 *
 * @returns {string}
 */
function toCdnUrl(version, relativePath) {
    return `https://cdn.jsdelivr.net/gh/Nick2bad4u/nerd-fonts-woff2@${version}/${relativePath}`;
}

function render() {
    const query = searchInput.value.trim().toLowerCase();
    const version = versionInput.value.trim() || "main";
    const filtered = entries.filter((entry) => {
        const haystack = `${entry.family} ${entry.fileName}`.toLowerCase();
        return query.length === 0 || haystack.includes(query);
    });

    const grouped = new Map();
    for (const entry of filtered) {
        const existing = grouped.get(entry.family) ?? [];
        existing.push(entry);
        grouped.set(entry.family, existing);
    }

    resultsNode.replaceChildren();

    if (filtered.length === 0) {
        renderStats(version, 0, 0);
        familyLinksNode.replaceChildren();
        statusNode.textContent = "No matching fonts found.";
        return;
    }

    statusNode.textContent = `Showing ${filtered.length.toLocaleString()} files across ${grouped.size.toLocaleString()} families.`;

    const sortedGroups = [...grouped.entries()].sort((a, b) =>
        a[0].localeCompare(b[0])
    );

    renderStats(version, sortedGroups.length, filtered.length);
    renderFamilyLinks(sortedGroups);

    for (const [family, familyEntries] of sortedGroups) {
        const details = document.createElement("details");
        details.className = "family";
        details.id = `family-${slugify(family)}`;
        details.open = query.length > 0;

        const summary = document.createElement("summary");
        summary.textContent = `${family} (${familyEntries.length})`;
        details.append(summary);

        const files = document.createElement("div");
        files.className = "files";

        for (const entry of familyEntries.toSorted(
            (
                /** @type {{ fileName: string }} */ a,
                /** @type {{ fileName: string }} */ b
            ) => a.fileName.localeCompare(b.fileName)
        )) {
            const relativePath = toRelativePath(
                entry.outputPath,
                entry.family,
                entry.fileName
            );
            const cdnUrl = toCdnUrl(version, relativePath);

            const row = document.createElement("article");
            row.className = "file";

            const fileName = document.createElement("div");
            fileName.className = "file-name";
            fileName.textContent = entry.fileName;
            row.append(fileName);

            const cdnLink = document.createElement("a");
            cdnLink.href = cdnUrl;
            cdnLink.textContent = `CDN: ${cdnUrl}`;
            cdnLink.target = "_blank";
            cdnLink.rel = "noopener noreferrer";
            row.append(cdnLink);

            const repoLink = document.createElement("a");
            repoLink.href = `./${relativePath}`;
            repoLink.textContent = `Repo file: ${relativePath}`;
            repoLink.target = "_blank";
            repoLink.rel = "noopener noreferrer";
            row.append(repoLink);

            files.append(row);
        }

        details.append(files);
        resultsNode.append(details);
    }
}

async function loadIndex() {
    try {
        const response = await fetch("./fonts/woff2/index.json", {
            cache: "no-store",
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const parsed = await response.json();
        if (!Array.isArray(parsed)) {
            throw new TypeError("index.json root is not an array");
        }

        entries = parsed
            .filter((entry) => typeof entry === "object" && entry !== null)
            .map((entry) => ({
                converted: Boolean(entry.converted),
                family: String(entry.family ?? "unknown"),
                fileName: String(entry.fileName ?? ""),
                outputPath: String(entry.outputPath ?? ""),
            }))
            .filter(
                (entry) =>
                    entry.fileName.length > 0 && entry.outputPath.length > 0
            );

        render();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        statusNode.textContent = `Failed to load fonts/woff2/index.json: ${message}`;
    }
}

searchInput.addEventListener("input", () => {
    render();
});

versionInput.addEventListener("input", () => {
    render();
});

loadIndex();
