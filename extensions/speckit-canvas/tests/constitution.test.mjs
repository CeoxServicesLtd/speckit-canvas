import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { readConstitutionFile, scanRepo } from "../speckit.mjs";

function repo(t) {
    const root = mkdtempSync(join(tmpdir(), "speckit-constitution-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    return root;
}

function writeConstitution(root, content) {
    const memory = join(root, ".specify", "memory");
    mkdirSync(memory, { recursive: true });
    writeFileSync(join(memory, "constitution.md"), content);
}

function renderer(data, respond = async () => ({ content: "# Principles" })) {
    const elements = new Map();
    const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf-8");
    for (const [, id] of html.matchAll(/id="([^"]+)"/g)) {
        elements.set(id, {
            innerHTML: "",
            hidden: true,
            attributes: {},
            listeners: {},
            setAttribute(name, value) { this.attributes[name] = value; },
            addEventListener(name, handler) { this.listeners[name] = handler; },
            querySelector() { return null; },
            focus() { this.focused = true; },
        });
    }
    const scroller = { scrollTop: 0 };
    elements.get("detail").querySelector = () => scroller;
    const documentListeners = {};
    const eventListeners = {};
    const requests = [];
    const context = {
        document: {
            getElementById: (id) => elements.get(id),
            addEventListener: (name, handler) => { documentListeners[name] = handler; },
        },
        EventSource: class {
            addEventListener(name, handler) { eventListeners[name] = handler; }
        },
        fetch: async (path) => {
            // Leave the automatic initial load pending; each test supplies its state explicitly.
            if (path === "/api/state") return new Promise(() => {});
            requests.push(path);
            const body = await respond(path);
            return { ok: !body.error, status: body.status ?? 200, json: async () => body };
        },
        setInterval() {},
        setTimeout() {},
        clearTimeout() {},
    };
    const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf-8");
    runInNewContext(`${source}\nglobalThis.app = { state, applyState, loadConstitution, closeConstitution, selectFeature };`, context);
    context.app.applyState(data);
    return { ...context.app, elements, requests, documentListeners, eventListeners };
}

test("constitution can be read without any feature and stays outside feature artifacts", (t) => {
    const root = repo(t);
    writeConstitution(root, "# Principles\n\n**Be clear.**");
    assert.deepEqual(readConstitutionFile(root), {
        path: ".specify/memory/constitution.md",
        content: "# Principles\n\n**Be clear.**",
    });
    assert.equal(scanRepo(root).constitution.exists, true);
    assert.equal(scanRepo(root).features.length, 0);
    mkdirSync(join(root, "specs", "001-example"), { recursive: true });
    const feature = scanRepo(root).features[0];
    assert.ok(!feature.artifacts.some((artifact) => artifact.file.includes("constitution")));
    assert.ok(!feature.files.some((file) => file.path.includes("constitution")));
});

test("missing constitution returns null, but read failures are not disguised as missing", (t) => {
    const root = repo(t);
    assert.equal(readConstitutionFile(root), null);
    mkdirSync(join(root, ".specify", "memory", "constitution.md"), { recursive: true });
    assert.throws(() => readConstitutionFile(root), { code: "EISDIR" });
});

test("dedicated API serves only the fixed constitution path and reports missing files", async (t) => {
    const root = repo(t);
    writeConstitution(root, "# Repository principles");
    const source = readFileSync(new URL("../extension.mjs", import.meta.url), "utf-8");
    const handlerSource = source.slice(source.indexOf("function createRequestHandler("), source.indexOf("async function startInstance("));
    const handler = runInNewContext(`${handlerSource}\ncreateRequestHandler({ repoRoot }, {})`, {
        repoRoot: root,
        URL,
        readConstitutionFile,
        sendJson: (_res, status, body) => ({ status, body }),
    });
    const result = await handler({ method: "GET", url: "/api/constitution?path=README.md&feature=001-example" }, {});
    assert.equal(result.status, 200);
    assert.equal(result.body.path, ".specify/memory/constitution.md");
    assert.equal(result.body.content, "# Repository principles");
    rmSync(join(root, ".specify", "memory", "constitution.md"));
    const missing = await handler({ method: "GET", url: "/api/constitution" }, {});
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, "Constitution not found");
});

test("sidebar opens rendered constitution without a selected feature", async (t) => {
    const root = repo(t);
    writeConstitution(root, "# Principles");
    const app = renderer(scanRepo(root), async () => ({ content: "# Principles\n\n**Be clear.** <script>" }));
    app.elements.get("constitution").listeners.click();
    await app.loadConstitution();
    const html = app.elements.get("detail").innerHTML;
    assert.match(html, /<h1>Principles<\/h1>/);
    assert.match(html, /<strong>Be clear\.<\/strong>/);
    assert.match(html, /&lt;script&gt;/);
    assert.equal(app.state.selected, null);
    assert.equal(app.elements.get("constitution").attributes["aria-pressed"], "true");
    assert.ok(app.requests.every((path) => path === "/api/constitution"));
});

test("returning preserves selected feature, tab, open artifact and active feature", async (t) => {
    const root = repo(t);
    writeConstitution(root, "# Principles");
    mkdirSync(join(root, "specs", "001-example"), { recursive: true });
    const data = scanRepo(root);
    const app = renderer(data);
    app.state.tab = "artifacts";
    app.state.openFile = "spec.md";
    app.elements.get("constitution").listeners.click();
    await app.loadConstitution();
    app.closeConstitution();
    assert.equal(app.state.view, "feature");
    assert.equal(app.state.selected, "001-example");
    assert.equal(app.state.tab, "artifacts");
    assert.equal(app.state.openFile, "spec.md");
    assert.equal(app.state.data.activeFeature, data.activeFeature);
    assert.equal(app.elements.get("constitution").focused, true);
    assert.match(app.elements.get("detail").innerHTML, /Pipeline artifacts/);
    assert.ok(!app.requests.includes("/api/active"));
});

test("live pushes update the constitution, including deletion and recreation", async (t) => {
    const root = repo(t);
    writeConstitution(root, "# Original");
    let content = "# Original";
    const app = renderer(scanRepo(root), async () => ({ content }));
    app.elements.get("constitution").listeners.click();
    await app.loadConstitution();
    content = "# Revised";
    writeConstitution(root, content);
    app.eventListeners.state({ data: JSON.stringify(scanRepo(root)) });
    await app.loadConstitution();
    assert.match(app.elements.get("detail").innerHTML, /<h1>Revised<\/h1>/);
    rmSync(join(root, ".specify", "memory", "constitution.md"));
    app.applyState(scanRepo(root));
    assert.match(app.elements.get("detail").innerHTML, /Constitution not found/);
    assert.doesNotMatch(app.elements.get("detail").innerHTML, /<h1>Revised/);
    content = "# Recreated";
    writeConstitution(root, content);
    app.applyState(scanRepo(root));
    await app.loadConstitution();
    assert.match(app.elements.get("detail").innerHTML, /<h1>Recreated<\/h1>/);
});

test("missing files and server errors have explicit states and can recover", async (t) => {
    const root = repo(t);
    writeConstitution(root, "# Principles");
    let response = { error: "Constitution not found", status: 404 };
    const app = renderer(scanRepo(root), async () => response);
    app.elements.get("constitution").listeners.click();
    await app.loadConstitution();
    assert.match(app.elements.get("detail").innerHTML, /Constitution not found/);
    response = { error: "Permission denied", status: 500 };
    await app.loadConstitution();
    assert.match(app.elements.get("detail").innerHTML, /role="alert">Could not read the constitution: Permission denied/);
    response = { content: "# Recovered" };
    await app.loadConstitution();
    assert.match(app.elements.get("detail").innerHTML, /<h1>Recovered<\/h1>/);
    assert.doesNotMatch(app.elements.get("detail").innerHTML, /Permission denied/);
});

test("late responses cannot restore deleted or superseded constitution content", async (t) => {
    const root = repo(t);
    writeConstitution(root, "# Principles");
    const pending = [];
    const app = renderer(scanRepo(root), () => new Promise((resolve) => pending.push(resolve)));
    app.state.view = "constitution";
    const first = app.loadConstitution();
    const second = app.loadConstitution();
    pending[1]({ content: "# Latest" });
    await second;
    pending[0]({ content: "# Stale" });
    await first;
    assert.equal(app.state.constitution.content, "# Latest");
    const third = app.loadConstitution();
    rmSync(join(root, ".specify", "memory", "constitution.md"));
    app.applyState(scanRepo(root));
    pending[2]({ content: "# Deleted" });
    await third;
    assert.equal(app.state.constitution.content, null);
    assert.match(app.elements.get("detail").innerHTML, /Constitution not found/);
});

test("Escape and feature selection return to features", async (t) => {
    const root = repo(t);
    writeConstitution(root, "# Principles");
    mkdirSync(join(root, "specs", "001-example"), { recursive: true });
    const app = renderer(scanRepo(root));
    app.elements.get("runner").hidden = true;
    app.elements.get("constitution").listeners.click();
    app.documentListeners.keydown({ key: "Escape" });
    assert.equal(app.state.view, "feature");
    app.elements.get("constitution").listeners.click();
    await app.selectFeature("001-example");
    assert.equal(app.state.view, "feature");
    assert.equal(app.state.selected, "001-example");
});
