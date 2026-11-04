import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { prepareRelease } from "../release-install.mjs";

const exec = promisify(execFile);
const git = (args) => exec("git", args, { windowsHide: true });

async function fixture(t) {
    const root = await mkdtemp(join(tmpdir(), "speckit-release-install-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const repository = join(root, "origin");
    const cacheRoot = join(root, "cache");
    await git(["init", "--quiet", "--initial-branch=main", repository]);
    const extension = join(repository, "extensions", "speckit-canvas");
    await mkdir(extension, { recursive: true });
    const writeVersion = async (version) => {
        await writeFile(join(repository, "plugin.json"), JSON.stringify({ name: "speckit-canvas", version, extensions: "extensions" }));
        await writeFile(join(extension, "package.json"), JSON.stringify({ name: "speckit-canvas", version }));
        await git(["-C", repository, "add", "."]);
        await git(["-C", repository, "-c", "user.name=Release Test", "-c", "user.email=release@example.invalid",
            "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", version]);
    };
    await writeVersion("1.3.0");
    await git(["-C", repository, "-c", "tag.gpgsign=false", "tag", "v1.3.0"]);
    await git(["-C", repository, "-c", "user.name=Release Test", "-c", "user.email=release@example.invalid",
        "-c", "tag.gpgsign=false", "tag", "-a", "1.3.0", "-m", "Published release"]);
    await writeVersion("9.0.0");
    const calls = [];
    return {
        cacheRoot,
        git: async (args) => {
            calls.push(args);
            return git(args.map((arg) => arg === "https://github.com/CeoxServicesLtd/speckit-canvas.git" ? repository : arg));
        },
        calls,
    };
}

test("release checkout fetches only the published tag even when main is ahead", async (t) => {
    const options = await fixture(t);
    for (const tag of ["v1.3.0", "1.3.0"]) {
        const release = await prepareRelease({ tag, version: "1.3.0" }, options);
        const manifest = JSON.parse(await readFile(join(release.path, "plugin.json"), "utf-8"));
        assert.equal(manifest.version, "1.3.0");
        const { stdout } = await git(["-C", release.path, "symbolic-ref", "-q", "HEAD"]).catch((error) => {
            assert.equal(error.code, 1, "checkout must be detached, not tracking a branch");
            return { stdout: "" };
        });
        assert.equal(stdout, "");
        const fetch = options.calls.find((args) => args.includes(`refs/tags/${tag}`));
        assert.ok(fetch);
        assert.ok(!options.calls.some((args) => args.includes("main") || args.includes("clone") || args.includes("pull")));
    }
});

test("missing tags and version mismatches fail without using main and clean incomplete downloads", async (t) => {
    const options = await fixture(t);
    await assert.rejects(prepareRelease({ tag: "v1.4.0", version: "1.4.0" }, options));
    assert.deepEqual(await readdir(options.cacheRoot), []);
    const originalGit = options.git;
    await assert.rejects(prepareRelease({ tag: "v1.4.0", version: "1.4.0" }, {
        ...options,
        git: (args) => originalGit(args.map((arg) => arg === "refs/tags/v1.4.0" ? "refs/tags/v1.3.0" : arg)),
    }), /manifests do not match/);
    assert.deepEqual(await readdir(options.cacheRoot), []);
});

test("invalid or unconfirmed tags are rejected before invoking git", async () => {
    for (const input of [
        { tag: "main", version: "1.3.0" },
        { tag: "v1.3.0", version: "1.4.0" },
        { tag: "v1.3.0-beta.1", version: "1.3.0-beta.1" },
        { tag: "--upload-pack=bad", version: "1.3.0" },
    ]) {
        await assert.rejects(prepareRelease(input, { git: () => assert.fail("git must not run") }), /matching stable/);
    }
});
