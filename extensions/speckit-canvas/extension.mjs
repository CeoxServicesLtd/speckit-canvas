// Extension: speckit-canvas
// Browse spec-kit features, see their status, and run the next speckit agent.
//
// The canvas is a thin renderer over the repo's own `specs/` folder — the files
// on disk are the source of truth, so nothing meaningful lives in memory here.
// The one privileged thing this extension does is bridge the iframe back into
// the session: a "run" click sets `.specify/feature.json` to the chosen feature
// and then injects a prompt via `session.send`, which is what actually starts
// the speckit agent in the user's conversation.


import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { findRepoRoot, scanRepo, setActiveFeature } from "./speckit.mjs";
import { broadcast, pushState, readPrefs, rememberSelection, startServer, stopServer } from "./server.mjs";

const instances = new Map(); // instanceId -> { server, url, repoRoot, clients, ... }

async function startInstance(instanceId, repoRoot, session) {
    const instance = await startServer(repoRoot, session);
    instances.set(instanceId, instance);
    return instance;
}

async function closeInstance(instanceId) {
    const instance = instances.get(instanceId);
    if (!instance) return;
    instances.delete(instanceId);
    await stopServer(instance);
}

function requireInstance(instanceId) {
    const instance = instances.get(instanceId);
    if (!instance) throw new CanvasError("canvas_instance_not_found", "Canvas instance is not open.");
    return instance;
}

// ---------------------------------------------------------------------------
// Canvas declaration
// ---------------------------------------------------------------------------

const session = await joinSession({
    canvases: [
        createCanvas({
            id: "speckit-canvas",
            displayName: "Spec-kit board",
            description:
                "Browse the repo's spec-kit features, see each spec's pipeline status, and launch the next speckit agent for it.",
            inputSchema: {
                type: "object",
                properties: {
                    feature: {
                        type: "string",
                        description: "Feature folder name under specs/ to focus on, e.g. 004-rank-tier-import.",
                    },
                    repoRoot: {
                        type: "string",
                        description: "Absolute path to the repo to inspect. Defaults to the session's working directory.",
                    },
                },
                additionalProperties: false,
            },
            actions: [
                {
                    name: "refresh",
                    description: "Re-scan the specs folder and push the latest state to the canvas.",
                    handler: async (ctx) => {
                        const instance = requireInstance(ctx.instanceId);
                        const state = scanRepo(instance.repoRoot);
                        broadcast(instance, "state", state);
                        return {
                            repoRoot: state.repoRoot,
                            activeFeature: state.activeFeature,
                            features: state.features.map((f) => ({
                                name: f.name,
                                status: f.status.label,
                                nextAgent: f.status.next.agent,
                                tasks: `${f.tasks.done}/${f.tasks.total}`,
                            })),
                        };
                    },
                },
                {
                    name: "get_status",
                    description:
                        "Return the derived spec-kit status and recommended next agent for every feature, or for one named feature.",
                    inputSchema: {
                        type: "object",
                        properties: { feature: { type: "string", description: "Optional feature folder name to filter to." } },
                        additionalProperties: false,
                    },
                    handler: async (ctx) => {
                        const instance = requireInstance(ctx.instanceId);
                        const state = scanRepo(instance.repoRoot);
                        const wanted = ctx.input?.feature;
                        const features = wanted ? state.features.filter((f) => f.name === wanted) : state.features;
                        if (wanted && features.length === 0) {
                            throw new CanvasError("feature_not_found", `No feature folder named "${wanted}" under specs/.`);
                        }
                        return {
                            activeFeature: state.activeFeature,
                            features: features.map((f) => ({
                                name: f.name,
                                title: f.title,
                                status: f.status.key,
                                statusLabel: f.status.label,
                                detail: f.status.detail,
                                next: f.status.next,
                                tasks: { done: f.tasks.done, total: f.tasks.total },
                                openQuestions: f.spec.openQuestions,
                                artifacts: f.artifacts.filter((a) => a.exists).map((a) => a.file),
                            })),
                        };
                    },
                },
                {
                    name: "focus_feature",
                    description: "Select a feature in the canvas and set it as the active spec-kit feature.",
                    inputSchema: {
                        type: "object",
                        properties: { feature: { type: "string", description: "Feature folder name under specs/." } },
                        required: ["feature"],
                        additionalProperties: false,
                    },
                    handler: async (ctx) => {
                        const instance = requireInstance(ctx.instanceId);
                        const feature = ctx.input.feature;
                        const state = scanRepo(instance.repoRoot);
                        if (!state.features.some((f) => f.name === feature)) {
                            throw new CanvasError("feature_not_found", `No feature folder named "${feature}" under specs/.`);
                        }
                        setActiveFeature(instance.repoRoot, feature);
                        rememberSelection(instance.repoRoot, feature);
                        instance.requestedFeature = feature;
                        broadcast(instance, "focus", { feature });
                        pushState(instance);
                        return { ok: true, feature, featureDirectory: `specs/${feature}` };
                    },
                },
            ],
            open: async (ctx) => {
                const repoRoot = findRepoRoot(ctx.input?.repoRoot || process.cwd());

                let instance = instances.get(ctx.instanceId);
                if (instance && instance.repoRoot !== repoRoot) {
                    await closeInstance(ctx.instanceId);
                    instance = undefined;
                }
                if (!instance) {
                    instance = await startInstance(ctx.instanceId, repoRoot, session);
                }

                // Which feature is focused is transient UI state; the durable
                // state is the repo itself, so this is only a starting hint.
                const requested = ctx.input?.feature ?? readPrefs().lastSelected?.[repoRoot] ?? null;
                instance.requestedFeature = requested;
                if (requested) broadcast(instance, "focus", { feature: requested });

                const state = scanRepo(repoRoot);
                const pending = state.features.filter((f) => f.status.key !== "complete").length;

                return {
                    title: `Spec-kit · ${state.repoName}`,
                    status: state.features.length
                        ? `${state.features.length} feature${state.features.length === 1 ? "" : "s"} · ${pending} in progress`
                        : "No specs found",
                    url: instance.url,
                };
            },
            onClose: async (ctx) => {
                await closeInstance(ctx.instanceId);
            },
        }),
    ],
});
