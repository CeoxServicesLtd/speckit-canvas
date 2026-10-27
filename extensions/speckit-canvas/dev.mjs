#!/usr/bin/env node
// Run the Spec-kit board outside Copilot for local manual verification.
//
//   node dev.mjs                 # serve a throwaway copy of dev/demo-repo
//   node dev.mjs --repo <path>   # serve a real spec-kit repo
//   node dev.mjs --port 5000     # pick a port (default 4317, or $PORT)
//
// Uses the same server as the extension. There is no Copilot session here, so
// "Run agent" clicks print the prompt they would send instead of starting it.

import { cpSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { findRepoRoot } from "./speckit.mjs";
import { startServer, stopServer } from "./server.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
    const args = { repo: null, port: Number(process.env.PORT) || 4317, host: "127.0.0.1" };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--repo") args.repo = argv[++i];
        else if (arg === "--port") args.port = Number(argv[++i]);
        else if (arg === "--host") args.host = argv[++i];
        else if (arg === "--help" || arg === "-h") args.help = true;
        else throw new Error(`Unknown argument: ${arg}`);
    }
    if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) throw new Error("--port must be 0-65535");
    return args;
}

let args;
try {
    args = parseArgs(process.argv.slice(2));
} catch (error) {
    console.error(error.message);
    process.exit(2);
}
if (args.help) {
    console.log("Usage: node dev.mjs [--repo <path>] [--port <n>] [--host <addr>]");
    process.exit(0);
}

let repoRoot;
let cleanup = () => {};
if (args.repo) {
    repoRoot = findRepoRoot(realpathSync.native(resolve(args.repo)));
} else {
    // Copy the fixture so "make active"/"run" writes never touch the committed files.
    // Expand Windows 8.3 short names (e.g. ALEXMA~1); libuv's fs.watch asserts on them.
    repoRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "speckit-canvas-demo-")));
    cpSync(join(HERE, "dev", "demo-repo"), repoRoot, { recursive: true });
    cleanup = () => rmSync(repoRoot, { recursive: true, force: true });
}

const session = {
    async send({ prompt }) {
        console.log(`\n--- prompt that would be sent to the Copilot session ---\n${prompt}\n--- end prompt ---\n`);
    },
    log(message) {
        console.log(message);
    },
};

let instance;
try {
    instance = await startServer(repoRoot, session, { host: args.host, port: args.port });
} catch (error) {
    cleanup();
    console.error(error.code === "EADDRINUSE" ? `Port ${args.port} is in use; try --port 0 for any free port.` : error.message);
    process.exit(1);
}

console.log(`Spec-kit board serving ${repoRoot}${args.repo ? "" : " (demo copy)"}`);
console.log(`Local: ${instance.url}`);
console.log("Edit files under specs/ there to see live updates. Press Ctrl+C to stop.");

let stopping = false;
async function shutdown() {
    if (stopping) return;
    stopping = true;
    await stopServer(instance);
    cleanup();
    process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
