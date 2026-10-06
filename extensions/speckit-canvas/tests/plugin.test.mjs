import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const json = (path) => JSON.parse(readFileSync(join(root, path), "utf-8"));
const plugin = json("plugin.json");
const marketplace = json(join(".github", "plugin", "marketplace.json"));

test("root manifest uses legacy extension discovery, not Agent Plugins metadata", () => {
    assert.equal(plugin.name, "speckit-canvas");
    assert.equal(plugin.$schema, undefined);
    assert.equal(plugin.extensions, "extensions");
    assert.match(plugin.version, /^\d+\.\d+\.\d+$/);
    assert.ok(!existsSync(join(root, ".github", "plugin", "plugin.json")), "Do not keep competing manifests");
    assert.ok(existsSync(join(root, "LICENSE")));
});

test("marketplace installs the repository-root plugin with matching release metadata", () => {
    assert.equal(marketplace.name, "ceox-speckit");
    assert.equal(marketplace.owner.name, plugin.author.name);
    assert.equal(marketplace.plugins.length, 1);
    const entry = marketplace.plugins[0];
    assert.equal(entry.name, plugin.name);
    assert.equal(entry.source, "./");
    assert.equal(entry.version, plugin.version);
    assert.equal(marketplace.metadata.version, plugin.version);
});

test("plugin ships exactly one complete canvas extension with matching package version", () => {
    const extensions = readdirSync(join(root, plugin.extensions), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(join(root, plugin.extensions, entry.name, "extension.mjs")));
    assert.deepEqual(extensions.map((entry) => entry.name), ["speckit-canvas"]);
    const extension = join(plugin.extensions, extensions[0].name);
    const pkg = json(join(extension, "package.json"));
    assert.equal(pkg.name, plugin.name);
    assert.equal(pkg.version, plugin.version);
    assert.equal(pkg.type, "module");
    assert.equal(pkg.main, "extension.mjs");
    for (const path of [
        "copilot-extension.json", "speckit.mjs", join("public", "app.js"),
        join("public", "index.html"), join("public", "styles.css"), join("public", "assets", "ceox-logo.jpg"),
    ]) {
        assert.ok(existsSync(join(root, extension, path)), `Missing plugin asset: ${path}`);
    }
});
