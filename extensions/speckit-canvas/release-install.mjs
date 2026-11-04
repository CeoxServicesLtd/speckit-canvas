import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REPOSITORY = "https://github.com/CeoxServicesLtd/speckit-canvas.git";

export async function prepareRelease({ tag, version }, {
    cacheRoot = join(process.env.COPILOT_HOME || join(homedir(), ".copilot"), "release-cache", "speckit-canvas"),
    git = async (args) => {
        try {
            return await execFileAsync("git", args, { timeout: 120000, maxBuffer: 1024 * 1024, windowsHide: true });
        } catch (error) {
            throw new Error(`Could not download the published release: ${String(error.stderr || error.message).trim().slice(0, 2000)}`);
        }
    },
} = {}) {
    if (!/^v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(tag) ||
        tag.replace(/^v/, "") !== version) {
        throw new Error("A matching stable published release tag and version are required.");
    }
    await mkdir(cacheRoot, { recursive: true });
    const directory = await mkdtemp(join(cacheRoot, "release-"));
    // Keep a consistent basename so Copilot replaces the same direct-install cache.
    const path = join(directory, "speckit-canvas");
    const cleanup = () => rm(directory, { recursive: true, force: true });
    try {
        await git(["init", "--quiet", path]);
        await git(["-C", path, "fetch", "--quiet", "--depth", "1", "--no-tags", REPOSITORY, `refs/tags/${tag}`]);
        await git(["-C", path, "-c", `core.hooksPath=${join(directory, "no-hooks")}`, "checkout", "--quiet", "--detach", "FETCH_HEAD"]);
        const plugin = JSON.parse(await readFile(join(path, "plugin.json"), "utf-8"));
        const extension = JSON.parse(await readFile(join(path, "extensions", "speckit-canvas", "package.json"), "utf-8"));
        if (plugin.name !== "speckit-canvas" || plugin.version !== version ||
            plugin.extensions !== "extensions" || extension.name !== plugin.name || extension.version !== version) {
            throw new Error("The published release's plugin manifests do not match its tag. Nothing was installed.");
        }
        return { path };
    } catch (error) {
        await cleanup();
        throw error;
    }
}
