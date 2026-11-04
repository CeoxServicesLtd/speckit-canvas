import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createUpdater, isNewerVersion } from "../updates.mjs";
import { startServer, stopServer } from "../server.mjs";

const releaseResponse = (tag_name = "v1.3.0", extra = {}) => ({
    ok: true, status: 200, json: async () => ({
        tag_name, id: 13, published_at: "2026-11-04T12:00:00Z", draft: false, prerelease: false, ...extra,
    }),
});

function fixture(options = {}) {
    const calls = [];
    let version = "1.2.0";
    let direct = false;
    let marketplaceEnabled = true;
    const updater = createUpdater({
        allowUpdate: true,
        currentVersion: version,
        fetchRelease: async () => releaseResponse(),
        prepare: async ({ tag, version }) => {
            assert.equal(tag, "v1.3.0");
            assert.equal(version, "1.3.0");
            return { path: "release-pinned-checkout", cleanup: async () => {} };
        },
        run: async (args) => {
            calls.push(args);
            if (args[1] === "list") return JSON.stringify([
                { name: "speckit-canvas", marketplace: "ceox-speckit", source: "installed", version: "1.2.0", enabled: marketplaceEnabled },
                ...(direct ? [{ name: "speckit-canvas", marketplace: "", source: "installed", version, enabled: true }] : []),
            ]);
            if (args[1] === "install") { version = "1.3.0"; direct = true; }
            if (args[1] === "disable") marketplaceEnabled = false;
            return "";
        },
        ...options,
    });
    return { updater, calls };
}

test("stable release versions compare numerically, not lexically", () => {
    assert.equal(isNewerVersion("v1.10.0", "1.9.9"), true);
    assert.equal(isNewerVersion("2.0.0", "1.99.99"), true);
    assert.equal(isNewerVersion("1.2.0+build.2", "1.2.0"), false);
    assert.equal(isNewerVersion("1.1.9", "1.2.0"), false);
    for (const invalid of ["1.3.0-beta.1", "01.3.0", "1.3", null, "v1.3.0; echo bad"]) {
        assert.throws(() => isNewerVersion(invalid, "1.2.0"));
    }
});

test("checks are cached, deduplicated and refreshed manually or after an hour", async () => {
    let clock = 0;
    let requests = 0;
    const { updater, calls } = fixture({
        now: () => clock,
        fetchRelease: async (url, options) => {
            requests++;
            assert.equal(url, "https://api.github.com/repos/CeoxServicesLtd/speckit-canvas/releases/latest");
            assert.equal(options.redirect, "error");
            assert.ok(options.signal instanceof AbortSignal);
            return releaseResponse();
        },
    });
    const [first, second] = await Promise.all([updater.check(), updater.check()]);
    assert.deepEqual(first, second);
    assert.equal(first.available, true);
    assert.equal(requests, 1);
    await updater.check();
    assert.equal(requests, 1);
    await updater.check(true);
    assert.equal(requests, 2);
    clock = 3600000;
    await updater.check();
    assert.equal(requests, 3);
    assert.equal(calls.length, 0, "checking never invokes a plugin command");
});

test("equal/older releases and no published releases do not offer updates", async () => {
    for (const response of [releaseResponse("1.2.0"), releaseResponse("1.1.9"), { status: 404 }]) {
        const { updater } = fixture({ fetchRelease: async () => response });
        assert.equal((await updater.check()).available, false);
    }
});

test("invalid releases, network errors and rate limits surface and can recover", async () => {
    for (const bad of [
        async () => ({ ok: false, status: 403 }),
        async () => releaseResponse("v1.3.0", { prerelease: true }),
        async () => releaseResponse("v1.3.0", { draft: true }),
        async () => releaseResponse("v1.3.0", { published_at: null }),
        async () => releaseResponse("v1.3.0", { id: undefined }),
        async () => releaseResponse("release-latest"),
        async () => { throw new Error("offline"); },
    ]) {
        let fail = true;
        const { updater } = fixture({ fetchRelease: (...args) => fail ? bad(...args) : releaseResponse() });
        await assert.rejects(updater.check());
        fail = false;
        assert.equal((await updater.check()).available, true);
    }
});

test("installation requires a successful check and explicit matching confirmation", async () => {
    const { updater, calls } = fixture();
    await assert.rejects(updater.update({ confirmed: true, version: "1.3.0" }), /Check for updates/);
    await updater.check();
    for (const input of [{}, { confirmed: false, version: "1.3.0" }, { confirmed: "true", version: "1.3.0" }]) {
        await assert.rejects(updater.update(input), /Confirm/);
    }
    await assert.rejects(updater.update({ confirmed: true, version: "1.4.0" }), /displayed version/);
    assert.equal(calls.length, 0);
});

test("marketplace migration installs only the confirmed release and disables the old copy", async () => {
    const { updater, calls } = fixture();
    await updater.check();
    const result = await updater.update({ confirmed: true, version: "1.3.0" });
    assert.deepEqual(calls, [
        ["plugin", "list", "--json"],
        ["plugin", "install", "release-pinned-checkout"],
        ["plugin", "list", "--json"],
        ["plugin", "disable", "speckit-canvas@ceox-speckit"],
    ]);
    assert.equal(result.installedVersion, "1.3.0");
    assert.equal(result.restartRequired, true);
    assert.equal(result.available, false);
    assert.equal(result.updating, false);
});

test("direct installation rejects a newer, unpublished installed version", async () => {
    const calls = [];
    let version = "1.2.0";
    const { updater } = fixture({ run: async (args) => {
        calls.push(args);
        if (args[1] === "list") return JSON.stringify([{ name: "speckit-canvas", source: "installed", marketplace: "", version, enabled: true }]);
        version = "1.4.0";
    } });
    await updater.check();
    await assert.rejects(updater.update({ confirmed: true, version: "1.3.0" }), /exactly match/);
    assert.deepEqual(calls[1], ["plugin", "install", "release-pinned-checkout"]);
    assert.equal(calls.length, 3);
});

test("direct release installation never refreshes a marketplace or follows a default branch", async () => {
    const calls = [];
    let version = "1.2.0";
    const { updater } = fixture({ run: async (args) => {
        calls.push(args);
        if (args[1] === "list") return JSON.stringify([{ name: "speckit-canvas", source: "installed", version, enabled: true }]);
        if (args[1] === "install") version = "1.3.0";
        else assert.fail("Only a local release install is allowed.");
    } });
    await updater.check();
    assert.equal((await updater.update({ confirmed: true, version: "1.3.0" })).installedVersion, "1.3.0");
    assert.deepEqual(calls, [
        ["plugin", "list", "--json"], ["plugin", "install", "release-pinned-checkout"], ["plugin", "list", "--json"],
    ]);
});

test("development mode checks releases but never runs update commands", async () => {
    const { updater, calls } = fixture({ allowUpdate: false });
    assert.equal((await updater.check()).canUpdate, false);
    await assert.rejects(updater.update({ confirmed: true, version: "1.3.0" }), /disabled/);
    assert.equal(calls.length, 0);
});

test("changed releases require new confirmation", async () => {
    let tag = "v1.3.0";
    const { updater, calls } = fixture({ fetchRelease: async () => releaseResponse(tag) });
    await updater.check();
    tag = "v1.4.0";
    await assert.rejects(updater.update({ confirmed: true, version: "1.3.0" }), /release changed/);
    assert.equal(calls.length, 0);
});

test("replaced or unpublished releases cannot be installed using an earlier confirmation", async () => {
    for (const response of [
        releaseResponse("v1.3.0", { id: 14 }),
        releaseResponse("1.3.0"),
        releaseResponse("v1.3.0", { published_at: "2026-11-04T13:00:00Z" }),
        { status: 404 },
    ]) {
        let changed = false;
        const { updater, calls } = fixture({
            fetchRelease: async () => changed ? response : releaseResponse(),
            prepare: async () => assert.fail("An unconfirmed release must not be downloaded."),
        });
        await updater.check();
        changed = true;
        await assert.rejects(updater.update({ confirmed: true, version: "1.3.0" }), /release changed/);
        assert.equal(calls.length, 0);
    }
});

test("download failures leave the original installation alone without a branch fallback", async () => {
    const { updater, calls } = fixture({ prepare: async () => { throw new Error("Release tag unavailable"); } });
    await updater.check();
    await assert.rejects(updater.update({ confirmed: true, version: "1.3.0" }), /tag unavailable/);
    assert.deepEqual(calls, [["plugin", "list", "--json"]]);
    assert.equal((await updater.check()).restartRequired, false);
});

test("migration failures disable the new direct copy rather than leave duplicate canvases", async () => {
    for (const failure of ["install", "verify", "disable-marketplace", "disable-both"]) {
        const calls = [];
        let installed = false;
        const { updater } = fixture({ run: async (args) => {
            calls.push(args);
            if (args[1] === "list") return JSON.stringify([
                { name: "speckit-canvas", marketplace: "ceox-speckit", source: "installed", version: "1.2.0", enabled: true },
                ...(installed ? [{
                    name: "speckit-canvas", marketplace: "", source: "installed",
                    version: failure === "verify" ? "9.0.0" : "1.3.0", enabled: true,
                }] : []),
            ]);
            if (args[1] === "install") {
                if (failure === "install") throw new Error("Install failed");
                installed = true;
            }
            if (args[1] === "disable") {
                if (args[2].includes("@") || failure === "disable-both") throw new Error("Disable failed");
            }
        } });
        await updater.check();
        await assert.rejects(updater.update({ confirmed: true, version: "1.3.0" }),
            failure === "install" ? /Install failed/ : failure === "verify" ? /exactly match/ :
                failure === "disable-both" ? /Could not disable the direct copy either/ : /left disabled/);
        assert.deepEqual(calls.at(-1), ["plugin", "disable", "speckit-canvas"]);
        assert.equal((await updater.check()).restartRequired, false);
    }
});

test("ambiguous, external and unsupported installations are rejected", async () => {
    const plugin = { name: "speckit-canvas", marketplace: "ceox-speckit", source: "installed", enabled: true };
    for (const plugins of [[], [plugin, plugin], [{ ...plugin, source: "external" }], [{ ...plugin, marketplace: "untrusted" }]]) {
        const calls = [];
        const { updater } = fixture({ run: async (args) => { calls.push(args); return JSON.stringify(plugins); } });
        await updater.check();
        await assert.rejects(updater.update({ confirmed: true, version: "1.3.0" }), /single enabled managed/);
        assert.equal(calls.length, 1);
    }
});

test("command failures and stale installed versions are not reported as success", async () => {
    for (const fail of [true, false]) {
        const { updater } = fixture({ run: async (args) => {
            if (args[1] === "list") return JSON.stringify([{
                name: "speckit-canvas", source: "installed", version: "1.2.0", enabled: true,
            }]);
            if (fail) throw new Error("command failed");
        } });
        await updater.check();
        await assert.rejects(updater.update({ confirmed: true, version: "1.3.0" }), fail ? /command failed/ : /exactly match/);
        assert.equal((await updater.check()).restartRequired, false);
        assert.equal((await updater.check()).updating, false);
    }
});

test("concurrent update attempts cannot run duplicate commands", async () => {
    let unblock;
    const { updater } = fixture({ run: async () => new Promise((resolve) => { unblock = resolve; }) });
    await updater.check();
    const pending = updater.update({ confirmed: true, version: "1.3.0" });
    await assert.rejects(updater.update({ confirmed: true, version: "1.3.0" }), /already in progress/);
    await new Promise((resolve) => setImmediate(resolve));
    unblock("[]");
    await assert.rejects(pending, /single enabled managed/);
});

test("HTTP update routes reject cross-origin and unmarked requests", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "speckit-updates-"));
    t.after(() => rmSync(root, { force: true, recursive: true }));
    const calls = [];
    const instance = await startServer(root, {}, { updater: {
        check: async (force) => { calls.push(["check", force]); return { available: true }; },
        update: async (body) => { calls.push(["install", body]); return { restartRequired: true }; },
    } });
    t.after(() => stopServer(instance));
    assert.equal((await fetch(`${instance.url}api/updates`)).status, 200);
    for (const headers of [{}, { "X-Speckit-Update": "1", Origin: "https://example.com" }]) {
        const response = await fetch(`${instance.url}api/updates/install`, { method: "POST", headers });
        assert.equal(response.status, 403);
    }
    assert.equal(calls.length, 1);
    const headers = { "X-Speckit-Update": "1", Origin: new URL(instance.url).origin, "Content-Type": "application/json" };
    assert.equal((await fetch(`${instance.url}api/updates/check`, { method: "POST", headers })).status, 200);
    const response = await fetch(`${instance.url}api/updates/install`, {
        method: "POST", headers, body: JSON.stringify({ confirmed: true, version: "1.3.0" }),
    });
    assert.equal((await response.json()).restartRequired, true);
    assert.deepEqual(calls[1], ["check", true]);
    assert.deepEqual(calls[2], ["install", { confirmed: true, version: "1.3.0" }]);
    assert.equal((await fetch(`${instance.url}updates.js`)).status, 200);
});

function renderer(respond = async () => ({ currentVersion: "1.2.0", latestVersion: "1.3.0", available: true, canUpdate: true })) {
    const elements = new Map();
    for (const id of ["update-status", "update-check", "update-install", "update-dialog", "update-description", "update-confirm", "update-cancel"]) {
        elements.set(id, {
            hidden: id === "update-install",
            listeners: {},
            addEventListener(name, handler) { this.listeners[name] = handler; },
            showModal() { this.open = true; },
            close() { this.open = false; },
        });
    }
    const requests = [];
    const timers = [];
    const context = {
        document: { getElementById: (id) => elements.get(id) },
        fetch: async (path, options) => {
            requests.push({ path, options });
            const body = await respond(path);
            return { ok: !body.error, json: async () => body };
        },
        setInterval: (handler, delay) => { timers.push({ handler, delay }); },
        clearInterval() {},
        addEventListener() {},
    };
    runInNewContext(readFileSync(new URL("../public/updates.js", import.meta.url), "utf-8"), context);
    return { elements, requests, timers, tick: () => new Promise((resolve) => setImmediate(resolve)) };
}

test("UI automatically checks, cancels without installing and confirms the displayed version", async () => {
    const app = renderer(async (path) => path.endsWith("/install")
        ? { restartRequired: true, installedVersion: "1.3.0" }
        : { currentVersion: "1.2.0", latestVersion: "1.3.0", available: true, canUpdate: true });
    await app.tick();
    assert.equal(app.requests[0].path, "/api/updates");
    assert.equal(app.timers[0].delay, 3600000);
    const element = (id) => app.elements.get(`update-${id}`);
    assert.equal(element("install").hidden, false);
    element("install").listeners.click();
    assert.equal(element("dialog").open, true);
    assert.match(element("description").textContent, /Only this release's tagged code/);
    assert.match(element("description").textContent, /marketplace copy will be disabled/);
    element("cancel").listeners.click();
    await element("confirm").listeners.click();
    assert.equal(app.requests.length, 1);
    element("install").listeners.click();
    await element("confirm").listeners.click();
    assert.equal(app.requests[1].path, "/api/updates/install");
    assert.deepEqual(JSON.parse(app.requests[1].options.body), { confirmed: true, version: "1.3.0" });
    assert.match(element("status").textContent, /Reload extensions/);
    assert.equal(element("install").hidden, true);
});

test("UI shows check and install failures and supports retrying a check", async () => {
    let fail = true;
    const app = renderer(async (path) => fail || path.endsWith("/install")
        ? { error: "offline" }
        : { currentVersion: "1.2.0", latestVersion: "1.3.0", available: true, canUpdate: true });
    await app.tick();
    assert.match(app.elements.get("update-status").textContent, /Could not check.*offline/);
    assert.equal(app.elements.get("update-install").hidden, true);
    fail = false;
    app.elements.get("update-check").listeners.click();
    await app.tick();
    assert.equal(app.requests[1].path, "/api/updates/check");
    app.elements.get("update-install").listeners.click();
    await app.elements.get("update-confirm").listeners.click();
    assert.match(app.elements.get("update-status").textContent, /Update failed: offline/);
    assert.equal(app.elements.get("update-install").disabled, false);
});

test("UI allows checking progress of another panel's update without a duplicate install", async () => {
    const app = renderer(async () => ({
        currentVersion: "1.2.0", latestVersion: "1.3.0", available: true, canUpdate: true, updating: true,
    }));
    await app.tick();
    assert.equal(app.elements.get("update-check").disabled, false);
    assert.equal(app.elements.get("update-install").disabled, true);
    assert.match(app.elements.get("update-status").textContent, /in progress/);
});
