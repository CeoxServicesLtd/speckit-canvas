import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { prepareRelease } from "./release-install.mjs";

const execFileAsync = promisify(execFile);
const CURRENT_VERSION = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8")).version;
const RELEASE_API = "https://api.github.com/repos/CeoxServicesLtd/speckit-canvas/releases/latest";
const CHECK_INTERVAL = 60 * 60 * 1000;

function stableVersion(value) {
    if (typeof value !== "string") return null;
    const match = /^v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
    return match?.[1] ?? null;
}

export function isNewerVersion(candidate, current) {
    const next = stableVersion(candidate);
    const previous = stableVersion(current);
    if (!next || !previous) throw new Error("Expected a stable semantic version.");
    const a = next.split(".").map(BigInt);
    const b = previous.split(".").map(BigInt);
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return a[i] > b[i];
    }
    return false;
}

async function runCopilot(args) {
    try {
        const { stdout } = await execFileAsync("copilot", args, {
            timeout: 120000,
            maxBuffer: 1024 * 1024,
            windowsHide: true,
        });
        return stdout;
    } catch (error) {
        throw new Error(`Copilot plugin command failed: ${String(error.stderr || error.message).trim().slice(0, 2000)}`);
    }
}

export function createUpdater({
    allowUpdate = false,
    currentVersion = CURRENT_VERSION,
    fetchRelease = fetch,
    run = runCopilot,
    prepare = prepareRelease,
    now = Date.now,
} = {}) {
    let result = null;
    let checking = null;
    let updating = false;
    let installedVersion = null;

    async function check(force = false) {
        if (checking) return checking;
        if (!force && result && now() - result.checkedAt < CHECK_INTERVAL) return status();
        checking = (async () => {
            const response = await fetchRelease(RELEASE_API, {
                headers: { Accept: "application/vnd.github+json", "User-Agent": "speckit-canvas" },
                signal: AbortSignal.timeout(10000),
                redirect: "error",
            });
            let latestVersion = null;
            let releaseId = null;
            let releaseTag = null;
            let publishedAt = null;
            if (response.status !== 404) {
                if (!response.ok) throw new Error(`Release check failed (GitHub HTTP ${response.status}). Try again later.`);
                const release = await response.json();
                if (release.draft !== false || release.prerelease !== false ||
                    !Number.isSafeInteger(release.id) || !release.published_at || !Number.isFinite(Date.parse(release.published_at))) {
                    throw new Error("GitHub did not return a stable published release.");
                }
                if (!stableVersion(release.tag_name)) throw new Error("The latest release tag is not a stable semantic version.");
                latestVersion = release.tag_name.replace(/^v/, "");
                releaseId = release.id;
                releaseTag = release.tag_name;
                publishedAt = release.published_at;
            }
            result = { latestVersion, releaseId, releaseTag, publishedAt, checkedAt: now() };
            return status();
        })();
        try {
            return await checking;
        } finally {
            checking = null;
        }
    }

    function status() {
        return {
            currentVersion,
            ...result,
            available: Boolean(result?.latestVersion && isNewerVersion(result.latestVersion, installedVersion || currentVersion)),
            canUpdate: allowUpdate,
            updating,
            restartRequired: Boolean(installedVersion),
            installedVersion,
        };
    }

    async function installedPlugins() {
        const plugins = JSON.parse(await run(["plugin", "list", "--json"]));
        if (!Array.isArray(plugins)) throw new Error("Copilot returned an invalid plugin list.");
        return plugins.filter((plugin) => plugin.name === "speckit-canvas" && plugin.source === "installed");
    }

    async function installedPlugin() {
        const matches = (await installedPlugins()).filter((plugin) => plugin.enabled === true);
        if (matches.length !== 1 || !["", "ceox-speckit"].includes(matches[0].marketplace ?? "")) {
            throw new Error("A single enabled managed speckit-canvas installation from ceox-speckit or a direct installation is required.");
        }
        return matches[0];
    }

    async function update({ confirmed, version } = {}) {
        if (!allowUpdate) throw new Error("Updates are disabled in the standalone development server. Update the managed plugin in Copilot.");
        if (confirmed !== true) throw new Error("Confirm the update before installing.");
        if (updating) throw new Error("An update is already in progress.");
        if (!result?.latestVersion || version !== result.latestVersion) throw new Error("Check for updates and confirm the displayed version first.");
        const confirmedRelease = result;
        updating = true;
        try {
            const latest = await check(true);
            if (!latest.available || latest.latestVersion !== version || latest.releaseId !== confirmedRelease.releaseId ||
                latest.releaseTag !== confirmedRelease.releaseTag || latest.publishedAt !== confirmedRelease.publishedAt) {
                throw new Error("The available release changed. Check again before confirming.");
            }
            const plugin = await installedPlugin();
            const release = await prepare({ tag: latest.releaseTag, version });
            try {
                await run(["plugin", "install", release.path]);
                const direct = (await installedPlugins()).filter((entry) => !entry.marketplace && entry.enabled === true);
                if (direct.length !== 1 || direct[0].version !== version) {
                    throw new Error("The installed plugin does not exactly match the confirmed published release.");
                }
            } catch (error) {
                if (plugin.marketplace) {
                    try {
                        await run(["plugin", "disable", "speckit-canvas"]);
                    } catch (rollbackError) {
                        throw new Error(`${error.message} Also could not disable the unsuccessful direct install: ${rollbackError.message}`);
                    }
                }
                throw error;
            }
            if (plugin.marketplace === "ceox-speckit") {
                try {
                    await run(["plugin", "disable", "speckit-canvas@ceox-speckit"]);
                } catch (error) {
                    try {
                        await run(["plugin", "disable", "speckit-canvas"]);
                    } catch (rollbackError) {
                        throw new Error(`Release installed, but could not disable the marketplace copy: ${error.message}. Could not disable the direct copy either: ${rollbackError.message}`);
                    }
                    throw new Error(`Release installed but left disabled because the marketplace copy could not be disabled: ${error.message}`);
                }
            }
            installedVersion = version;
        } finally {
            updating = false;
        }
        return status();
    }

    return { check, update };
}
