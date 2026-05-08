const searchInput = /** @type {HTMLInputElement} */ (
    document.getElementById("search")
);
const versionInput = /** @type {HTMLInputElement} */ (
    document.getElementById("version")
);
const styleFilterInput = /** @type {HTMLSelectElement} */ (
    document.getElementById("style_filter")
);
const variantFilterInput = /** @type {HTMLSelectElement} */ (
    document.getElementById("variant_filter")
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
const linkModalNode = /** @type {HTMLElement} */ (
    document.getElementById("link_modal")
);
const closeLinkModalButton = /** @type {HTMLButtonElement} */ (
    document.getElementById("close_link_modal")
);
const linkItemsNode = /** @type {HTMLElement} */ (
    document.getElementById("link_items")
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
    statFamiliesNode.textContent = `🧬 Families: ${familyCount.toLocaleString()}`;
    statFilesNode.textContent = `📦 Files: ${fileCount.toLocaleString()}`;
    statVersionNode.textContent = `🏷️ Version: ${version}`;
}

/**
 * @param {string} text
 *
 * @returns {Promise<void>}
 */
async function copyText(text) {
    await navigator.clipboard.writeText(text);
}

/**
 * @returns {void}
 */
function closeLinkModal() {
    linkModalNode.dataset["open"] = "false";
    linkItemsNode.replaceChildren();
}

/**
 * @param {{
 *     iconClass: string;
 *     label: string;
 *     logo: string;
 *     url: string;
 * }[]} links
 * @param {string} fileName
 * @param {HTMLElement} triggerButton
 *
 * @returns {void}
 */
function openLinkModal(links, fileName, triggerButton) {
    linkItemsNode.replaceChildren();

    for (const linkDef of links) {
        const item = document.createElement("article");
        item.className = "link-item";

        const left = document.createElement("div");
        left.className = "link-item-left";

        const logo = document.createElement("span");
        logo.className = "cdn-logo";
        logo.classList.add("nf", linkDef.iconClass);
        logo.setAttribute("aria-hidden", "true");
        logo.title = linkDef.label;
        left.append(logo);

        const label = document.createElement("div");
        label.className = "link-item-label";
        const labelName = document.createElement("span");
        labelName.className = "link-item-name";
        labelName.textContent = linkDef.label;

        const labelCode = document.createElement("span");
        labelCode.className = "link-item-code";
        labelCode.textContent = linkDef.logo;

        label.append(labelName, labelCode);
        label.title = linkDef.url;
        left.append(label);
        item.append(left);

        const actions = document.createElement("div");
        actions.className = "file-actions";

        const openButton = document.createElement("a");
        openButton.className = "btn";
        openButton.href = linkDef.url;
        openButton.target = "_blank";
        openButton.rel = "noopener noreferrer";
        openButton.textContent = "↗ Open";
        openButton.title = linkDef.url;
        actions.append(openButton);

        const copyButton = document.createElement("button");
        copyButton.type = "button";
        copyButton.className = "btn btn-primary";
        copyButton.textContent = "📋 Copy";
        copyButton.title = linkDef.url;
        copyButton.addEventListener("click", () => {
            copyText(linkDef.url)
                .then(() => {
                    copyButton.textContent = "✅ Copied";
                    setTimeout(() => {
                        copyButton.textContent = "📋 Copy";
                    }, 1200);
                })
                .catch(() => {
                    copyButton.textContent = "⚠️ Failed";
                });
        });
        actions.append(copyButton);

        item.append(actions);
        linkItemsNode.append(item);
    }

    const triggerBounds = triggerButton.getBoundingClientRect();
    const popupWidth = 520;
    const popupHeight = 420;
    const viewportPadding = 8;
    const computedLeft = Math.min(
        Math.max(triggerBounds.left, viewportPadding),
        globalThis.innerWidth - popupWidth - viewportPadding
    );
    const canOpenBelow =
        triggerBounds.bottom + 8 + popupHeight <=
        globalThis.innerHeight - viewportPadding;
    const preferredTop = canOpenBelow
        ? triggerBounds.bottom + 8
        : triggerBounds.top - popupHeight - 8;
    const computedTop = Math.max(viewportPadding, preferredTop);

    linkModalNode.style.left = `${computedLeft}px`;
    linkModalNode.style.top = `${computedTop}px`;
    linkModalNode.dataset["open"] = "true";
    const titleNode = document.getElementById("link_modal_title");
    if (titleNode instanceof HTMLElement) {
        titleNode.textContent = `🔗 CDN links for ${fileName}`;
    }
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

/**
 * @param {string} version
 * @param {string} relativePath
 *
 * @returns {{
 *     iconClass: string;
 *     label: string;
 *     logo: string;
 *     url: string;
 * }[]}
 */
function buildPopularLinks(version, relativePath) {
    return [
        {
            iconClass: "nf-md-cloud_outline",
            label: "jsDelivr (GitHub)",
            logo: "JS",
            url: toCdnUrl(version, relativePath),
        },
        {
            iconClass: "nf-fa-github",
            label: "Raw GitHub",
            logo: "GH",
            url: `https://raw.githubusercontent.com/Nick2bad4u/nerd-fonts-woff2/${version}/${relativePath}`,
        },
        {
            iconClass: "nf-dev-npm",
            label: "jsDelivr (npm)",
            logo: "NPM",
            url: `https://cdn.jsdelivr.net/npm/nerd-font-woff2@${version}/${relativePath}`,
        },
        {
            iconClass: "nf-md-package_variant",
            label: "unpkg (npm)",
            logo: "U",
            url: `https://unpkg.com/nerd-font-woff2@${version}/${relativePath}`,
        },
        {
            iconClass: "nf-fa-bolt",
            label: "Raw Githack",
            logo: "GK",
            url: `https://rawcdn.githack.com/Nick2bad4u/nerd-fonts-woff2/${version}/${relativePath}`,
        },
    ];
}

/**
 * @param {string} fileName
 *
 * @returns {"bold" | "bold-italic" | "italic" | "regular"}
 */
function classifyStyle(fileName) {
    const lowered = fileName.toLowerCase();
    const hasBold = lowered.includes("bold");
    const hasItalic = lowered.includes("italic") || lowered.includes("oblique");

    if (hasBold && hasItalic) {
        return "bold-italic";
    }

    if (hasBold) {
        return "bold";
    }

    if (hasItalic) {
        return "italic";
    }

    return "regular";
}

/**
 * @param {string} fileName
 *
 * @returns {"mono" | "propo" | "regular"}
 */
function classifyVariant(fileName) {
    const lowered = fileName.toLowerCase();
    if (lowered.includes("mono")) {
        return "mono";
    }

    if (lowered.includes("propo")) {
        return "propo";
    }

    return "regular";
}

/**
 * @param {{
 *     family: string;
 *     fileName: string;
 *     outputPath: string;
 *     converted: boolean;
 * }} entry
 * @param {string} styleFilter
 * @param {string} variantFilter
 *
 * @returns {boolean}
 */
function matchesFilters(entry, styleFilter, variantFilter) {
    const style = classifyStyle(entry.fileName);
    const variant = classifyVariant(entry.fileName);
    const styleOk = styleFilter === "all" || styleFilter === style;
    const variantOk = variantFilter === "all" || variantFilter === variant;
    return styleOk && variantOk;
}

function render() {
    const query = searchInput.value.trim().toLowerCase();
    const version = versionInput.value.trim() || "main";
    const styleFilter = styleFilterInput.value;
    const variantFilter = variantFilterInput.value;
    const filtered = entries.filter((entry) => {
        const haystack = `${entry.family} ${entry.fileName}`.toLowerCase();
        const queryOk = query.length === 0 || haystack.includes(query);
        return queryOk && matchesFilters(entry, styleFilter, variantFilter);
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
            const cdnLinks = buildPopularLinks(version, relativePath);

            const row = document.createElement("article");
            row.className = "file";

            const fileTop = document.createElement("div");
            fileTop.className = "file-top";

            const fileName = document.createElement("div");
            fileName.className = "file-name";
            fileName.textContent = entry.fileName;
            fileTop.append(fileName);

            const fileBadges = document.createElement("div");
            fileBadges.className = "file-badges";

            const styleBadge = document.createElement("span");
            styleBadge.className = "badge";
            styleBadge.textContent = classifyStyle(entry.fileName);
            fileBadges.append(styleBadge);

            const variantBadge = document.createElement("span");
            variantBadge.className = "badge";
            variantBadge.textContent = classifyVariant(entry.fileName);
            fileBadges.append(variantBadge);

            fileTop.append(fileBadges);
            row.append(fileTop);

            const actions = document.createElement("div");
            actions.className = "file-actions";

            const openLinksButton = document.createElement("button");
            openLinksButton.type = "button";
            openLinksButton.className = "btn btn-primary";
            openLinksButton.textContent = "🔗 Copy CDN links";
            openLinksButton.addEventListener("click", () => {
                openLinkModal(cdnLinks, entry.fileName, openLinksButton);
            });
            actions.append(openLinksButton);

            const repoLink = document.createElement("a");
            repoLink.href = `./${relativePath}`;
            repoLink.className = "btn";
            repoLink.textContent = "📁 Open repo file";
            repoLink.target = "_blank";
            repoLink.rel = "noopener noreferrer";
            actions.append(repoLink);

            const originalFamilyLink = document.createElement("a");
            originalFamilyLink.href = `https://github.com/ryanoasis/nerd-fonts/tree/master/patched-fonts/${encodeURIComponent(entry.family)}`;
            originalFamilyLink.className = "btn";
            originalFamilyLink.textContent = "🧷 Nerd Fonts source";
            originalFamilyLink.target = "_blank";
            originalFamilyLink.rel = "noopener noreferrer";
            actions.append(originalFamilyLink);

            row.append(actions);

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

styleFilterInput.addEventListener("change", () => {
    render();
});

variantFilterInput.addEventListener("change", () => {
    render();
});

closeLinkModalButton.addEventListener("click", () => {
    closeLinkModal();
});

linkModalNode.addEventListener("click", (event) => {
    if (event.target === linkModalNode) {
        closeLinkModal();
    }
});

document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && linkModalNode.dataset["open"] === "true") {
        closeLinkModal();
    }
});

document.addEventListener("mousedown", (event) => {
    if (linkModalNode.dataset["open"] !== "true") {
        return;
    }

    const target = event.target;
    if (!(target instanceof Node)) {
        return;
    }

    if (!linkModalNode.contains(target)) {
        closeLinkModal();
    }
});

// Ensure this file is treated as an ES module by static analyzers.
const moduleUrl = import.meta.url;
if (moduleUrl.length === 0) {
    statusNode.textContent = "";
}

await loadIndex();
