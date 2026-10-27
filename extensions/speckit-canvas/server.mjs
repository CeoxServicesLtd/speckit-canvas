// Loopback HTTP server behind the Spec-kit board canvas.
//
// Kept free of the Copilot SDK so the same server can run inside the extension
// host (extension.mjs) or standalone for local manual testing (dev.mjs). The
// only session capability it needs is `send`/`log` for the run bridge.

import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

import { readConstitutionFile, readFeatureFile, scanRepo, setActiveFeature } from "./speckit.mjs";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(EXTENSION_DIR, "public");

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
};

// ---------------------------------------------------------------------------
// User-global preferences (last selected feature per repo). Panel identity is
// transient, so this is keyed by repo root rather than by instanceId.
// ---------------------------------------------------------------------------

const COPILOT_HOME = process.env.COPILOT_HOME || join(homedir(), ".copilot");
const PREFS_PATH = join(COPILOT_HOME, "extensions", "speckit-canvas", "artifacts", "ui-state.json");

function readPrefs() {
    try {
        return JSON.parse(readFileSync(PREFS_PATH, "utf-8"));
    } catch {
        return {};
    }
}

function writePrefs(prefs) {
    try {
        mkdirSync(dirname(PREFS_PATH), { recursive: true });
        writeFileSync(PREFS_PATH, `${JSON.stringify(prefs, null, 2)}\n`, "utf-8");
    } catch {
        /* preferences are best-effort */
    }
}

function rememberSelection(repoRoot, feature) {
    const prefs = readPrefs();
    prefs.lastSelected = { ...(prefs.lastSelected ?? {}), [repoRoot]: feature };
    writePrefs(prefs);
}

// ---------------------------------------------------------------------------
// Loopback server
// ---------------------------------------------------------------------------

function sendJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Length": Buffer.byteLength(payload),
    });
    res.end(payload);
}

function serveStatic(res, name) {
    const path = join(PUBLIC_DIR, name);
    if (!existsSync(path)) {
        res.writeHead(404).end("Not found");
        return;
    }
    res.writeHead(200, {
        "Content-Type": MIME[extname(path)] ?? "application/octet-stream",
        "Cache-Control": "no-store",
    });
    res.end(readFileSync(path));
}

async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (chunks.length === 0) return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    } catch {
        return {};
    }
}

/**
 * Build the prompt injected into the session. The speckit agents are custom
 * agents in `.github/agents/`, so we ask the assistant to dispatch to the named
 * agent and give it the feature context it needs.
 */
function buildPrompt({ agent, feature, featureDir, args }) {
    const extra = (args ?? "").trim();
    return [
        `Run the **${agent}** agent for spec-kit feature \`${feature}\`.`,
        "",
        `The active feature has been set in \`.specify/feature.json\` (\`feature_directory: ${featureDir}\`), so the spec-kit scripts will resolve this feature.`,
        "",
        `Use the task tool with \`agent_type: "${agent}"\`. Pass the context below through as that agent's user input.`,
        "",
        "---",
        "",
        extra || "(no additional input - proceed with the agent's default behaviour for this feature)",
    ].join("\n");
}

function broadcast(instance, event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of instance.clients) {
        try {
            client.write(payload);
        } catch {
            instance.clients.delete(client);
        }
    }
}

function pushState(instance) {
    try {
        broadcast(instance, "state", scanRepo(instance.repoRoot));
    } catch (error) {
        broadcast(instance, "scan-error", { message: String(error?.message ?? error) });
    }
}

/** Watch specs/ and .specify/ so the board reflects agent edits in real time. */
function startWatchers(instance) {
    const watchers = [];
    let timer = null;
    const schedule = () => {
        clearTimeout(timer);
        timer = setTimeout(() => pushState(instance), 250);
    };

    for (const rel of ["specs", ".specify"]) {
        const dir = join(instance.repoRoot, rel);
        if (!existsSync(dir)) continue;
        try {
            const watcher = watch(dir, { recursive: true }, schedule);
            watcher.on("error", () => {});
            watchers.push(watcher);
        } catch {
            /* watching is a nicety; the UI can also refresh on demand */
        }
    }

    instance.stopWatchers = () => {
        clearTimeout(timer);
        for (const w of watchers) {
            try {
                w.close();
            } catch {
                /* ignore */
            }
        }
    };
}

function createRequestHandler(instance, session) {
    return async (req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const path = url.pathname;

        try {
            if (req.method === "GET" && (path === "/" || path === "/index.html")) {
                return serveStatic(res, "index.html");
            }
            if (req.method === "GET" && ["/styles.css", "/app.js", "/spec-parser.js", "/spec-view.js"].includes(path)) {
                return serveStatic(res, path.slice(1));
            }
            if (req.method === "GET" && path.startsWith("/assets/")) {
                // Serve only a bare filename from the assets folder (no traversal).
                const name = path.slice("/assets/".length);
                if (/^[\w.-]+$/.test(name)) return serveStatic(res, join("assets", name));
            }

            if (req.method === "GET" && path === "/api/state") {
                const state = scanRepo(instance.repoRoot);
                state.preferredFeature = readPrefs().lastSelected?.[instance.repoRoot] ?? null;
                state.requestedFeature = instance.requestedFeature ?? null;
                return sendJson(res, 200, state);
            }

            if (req.method === "GET" && path === "/api/constitution") {
                const result = readConstitutionFile(instance.repoRoot);
                if (!result) return sendJson(res, 404, { error: "Constitution not found" });
                return sendJson(res, 200, result);
            }

            if (req.method === "GET" && path === "/api/file") {
                const feature = url.searchParams.get("feature") ?? "";
                const file = url.searchParams.get("path") ?? "";
                const result = readFeatureFile(instance.repoRoot, feature, file);
                if (!result) return sendJson(res, 404, { error: "File not found" });
                return sendJson(res, 200, result);
            }

            if (req.method === "POST" && path === "/api/active") {
                const { feature } = await readBody(req);
                if (!feature || !/^[\w.-]+$/.test(feature)) {
                    return sendJson(res, 400, { error: "A valid feature name is required" });
                }
                setActiveFeature(instance.repoRoot, feature);
                rememberSelection(instance.repoRoot, feature);
                pushState(instance);
                return sendJson(res, 200, { ok: true, feature });
            }

            if (req.method === "POST" && path === "/api/select") {
                const { feature } = await readBody(req);
                if (feature && /^[\w.-]+$/.test(feature)) rememberSelection(instance.repoRoot, feature);
                return sendJson(res, 200, { ok: true });
            }

            if (req.method === "POST" && path === "/api/run") {
                const { feature, agent, args, setActive = true } = await readBody(req);
                if (!agent || !/^speckit\.[a-z]+$/.test(agent)) {
                    return sendJson(res, 400, { error: "A valid speckit agent name is required" });
                }
                if (!feature || !/^[\w.-]+$/.test(feature)) {
                    return sendJson(res, 400, { error: "A valid feature name is required" });
                }

                const featureDir = `specs/${feature}`;
                if (setActive) setActiveFeature(instance.repoRoot, feature);
                rememberSelection(instance.repoRoot, feature);

                await session.send({ prompt: buildPrompt({ agent, feature, featureDir, args }) });
                session.log(`Spec-kit board: dispatching ${agent} for ${featureDir}`, { level: "info" });

                pushState(instance);
                return sendJson(res, 200, { ok: true, agent, feature });
            }

            if (req.method === "GET" && path === "/events") {
                res.writeHead(200, {
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-store",
                    Connection: "keep-alive",
                });
                res.write(": connected\n\n");
                instance.clients.add(res);
                const keepAlive = setInterval(() => {
                    try {
                        res.write(": ping\n\n");
                    } catch {
                        clearInterval(keepAlive);
                    }
                }, 25000);
                req.on("close", () => {
                    clearInterval(keepAlive);
                    instance.clients.delete(res);
                });
                return undefined;
            }

            res.writeHead(404).end("Not found");
            return undefined;
        } catch (error) {
            return sendJson(res, 500, { error: String(error?.message ?? error) });
        }
    };
}

/**
 * Start a server for one repo. `session` needs `send({ prompt })` and
 * `log(message, options)`. Pass `port: 0` for an ephemeral port.
 */
export async function startServer(repoRoot, session, { host = "127.0.0.1", port = 0 } = {}) {
    const instance = { repoRoot, clients: new Set(), requestedFeature: null };
    const server = createServer(createRequestHandler(instance, session));
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
    });
    const address = server.address();
    const bound = typeof address === "object" && address ? address.port : port;

    instance.server = server;
    instance.url = `http://${host}:${bound}/`;
    startWatchers(instance);
    return instance;
}

export async function stopServer(instance) {
    instance.stopWatchers?.();
    for (const client of instance.clients) {
        try {
            client.end();
        } catch {
            /* ignore */
        }
    }
    instance.clients.clear();
    await new Promise((resolve) => instance.server.close(() => resolve()));
}

export { broadcast, pushState, readPrefs, rememberSelection };
