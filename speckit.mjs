// Spec-kit repository scanner.
//
// Everything the canvas renders is derived from files already on disk, so the
// repo itself is the durable store. Nothing here writes state except
// `setActiveFeature`, which updates the same `.specify/feature.json` that the
// spec-kit shell scripts read to resolve the current feature.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

/** Ordered main pipeline. Optional agents are listed separately below. */
export const PIPELINE = [
    { id: "specify", agent: "speckit.specify", label: "Specify", blurb: "Write the feature specification" },
    { id: "clarify", agent: "speckit.clarify", label: "Clarify", blurb: "Resolve underspecified requirements" },
    { id: "plan", agent: "speckit.plan", label: "Plan", blurb: "Produce the technical plan and design artifacts" },
    { id: "tasks", agent: "speckit.tasks", label: "Tasks", blurb: "Break the plan into ordered tasks" },
    { id: "implement", agent: "speckit.implement", label: "Implement", blurb: "Execute the tasks" },
];

/** Agents that can be run at any point rather than as a pipeline gate. */
export const OPTIONAL_AGENTS = [
    { id: "analyze", agent: "speckit.analyze", label: "Analyze", blurb: "Cross-artifact consistency check" },
    { id: "checklist", agent: "speckit.checklist", label: "Checklist", blurb: "Generate a quality checklist" },
    { id: "converge", agent: "speckit.converge", label: "Converge", blurb: "Append unbuilt work back onto tasks.md" },
    { id: "taskstoissues", agent: "speckit.taskstoissues", label: "Tasks → issues", blurb: "Create GitHub issues from tasks" },
    { id: "constitution", agent: "speckit.constitution", label: "Constitution", blurb: "Update project principles" },
];

const ARTIFACT_DEFS = [
    { key: "spec", file: "spec.md", label: "Spec", stage: "specify" },
    { key: "plan", file: "plan.md", label: "Plan", stage: "plan" },
    { key: "research", file: "research.md", label: "Research", stage: "plan" },
    { key: "dataModel", file: "data-model.md", label: "Data model", stage: "plan" },
    { key: "quickstart", file: "quickstart.md", label: "Quickstart", stage: "plan" },
    { key: "tasks", file: "tasks.md", label: "Tasks", stage: "tasks" },
];

/**
 * Walk up from `startDir` looking for a spec-kit repo. `.specify/` wins over
 * `.git/` so a worktree nested inside another repo still resolves correctly.
 */
export function findRepoRoot(startDir) {
    const walk = (marker) => {
        let dir = resolve(startDir);
        for (;;) {
            if (existsSync(join(dir, marker))) return dir;
            const parent = dirname(dir);
            if (parent === dir) return null;
            dir = parent;
        }
    };
    return walk(".specify") ?? walk(".git") ?? resolve(startDir);
}

function safeStat(path) {
    try {
        return statSync(path);
    } catch {
        return null;
    }
}

function readTextFile(path) {
    try {
        return readFileSync(path, "utf-8");
    } catch {
        return null;
    }
}

function listMarkdown(dir) {
    try {
        return readdirSync(dir, { withFileTypes: true })
            .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
            .map((e) => e.name)
            .sort();
    } catch {
        return [];
    }
}

/**
 * Count `- [ ]` / `- [x]` checkboxes. Groups break on `##` only — `###`
 * sub-headings (e.g. "Tests for User Story 1" inside a phase) annotate their
 * items instead of starting a new group, so phase counts stay accurate.
 */
function parseChecklist(text) {
    if (!text) return { total: 0, done: 0, groups: [], title: null };
    const groups = [];
    let current = null;
    let subheading = null;
    let total = 0;
    let done = 0;

    for (const rawLine of text.split(/\r?\n/)) {
        const heading = /^(#{2,4})\s+(.*\S)\s*$/.exec(rawLine);
        if (heading) {
            const title = heading[2].replace(/[*_`]/g, "").trim();
            if (heading[1].length === 2) {
                current = { title, total: 0, done: 0, items: [] };
                groups.push(current);
                subheading = null;
            } else {
                subheading = title;
            }
            continue;
        }
        const item = /^\s*[-*]\s+\[([ xX])\]\s*(.*)$/.exec(rawLine);
        if (!item) continue;

        const isDone = item[1].toLowerCase() === "x";
        const body = item[2].trim();
        const id = /^\*{0,2}(T\d{3,}|CHK\d{3,})\*{0,2}/i.exec(body)?.[1] ?? null;

        total += 1;
        if (isDone) done += 1;
        if (!current) {
            current = { title: "Tasks", total: 0, done: 0, items: [] };
            groups.push(current);
        }
        current.total += 1;
        if (isDone) current.done += 1;
        current.items.push({
            id,
            done: isDone,
            group: subheading,
            text: body.replace(/^\*{0,2}(?:T\d{3,}|CHK\d{3,})\*{0,2}\s*/i, "").trim(),
        });
    }

    const title = /^#\s+(.*\S)\s*$/m.exec(text)?.[1] ?? null;
    return { total, done, groups: groups.filter((g) => g.total > 0), title };
}

function parseSpec(text) {
    if (!text) return { hasClarifications: 0, openQuestions: 0, title: null };
    const clarificationHeading = /^##\s+Clarifications\s*$/im.test(text);
    const openQuestions = (text.match(/\[NEEDS CLARIFICATION/gi) ?? []).length;
    // Count answered clarification rounds, which spec-kit records as `### Session <date>`.
    const sessions = clarificationHeading
        ? (text.split(/^##\s+Clarifications\s*$/im)[1] ?? "").split(/^##\s+/m)[0].match(/^###\s+/gm)?.length ?? 0
        : 0;
    const title = /^#\s+(.*\S)\s*$/m.exec(text)?.[1] ?? null;
    return { hasClarifications: clarificationHeading ? Math.max(sessions, 1) : 0, openQuestions, title };
}

/** `**Feature Branch**: `[003-name]`` as declared in spec.md, if present. */
function parseFeatureBranch(text) {
    if (!text) return null;
    const m = /^\*\*Feature Branch\*\*:\s*`?\[?([^`\]\n]+?)\]?`?\s*$/im.exec(text);
    const value = m?.[1]?.trim();
    return value && value !== "[###-feature-name]" ? value : null;
}

/**
 * Current checked-out branch. In a worktree `.git` is a file pointing at the
 * real git dir, so resolve that indirection before reading HEAD.
 */
export function readGitBranch(repoRoot) {
    let gitDir = join(repoRoot, ".git");
    const st = safeStat(gitDir);
    if (!st) return null;
    if (st.isFile()) {
        const pointer = /^gitdir:\s*(.+)$/m.exec(readTextFile(gitDir) ?? "");
        if (!pointer) return null;
        gitDir = resolve(repoRoot, pointer[1].trim());
    }
    const head = readTextFile(join(gitDir, "HEAD"));
    if (!head) return null;
    const ref = /^ref:\s*refs\/heads\/(.+)$/m.exec(head);
    return ref ? ref[1].trim() : head.trim().slice(0, 8);
}

/** Task groups in tasks.md are `## Phase N: Name` headings. */
function derivePhases(groups) {
    return groups.map((g, index) => {
        const m = /^Phase\s+(\d+)\s*[:.\u2013-]\s*(.*)$/i.exec(g.title);
        return {
            index,
            number: m ? Number(m[1]) : null,
            name: (m ? m[2] : g.title).trim(),
            title: g.title,
            total: g.total,
            done: g.done,
            items: g.items,
        };
    });
}

function currentPhase(phases) {
    return phases.find((p) => p.done < p.total) ?? phases[phases.length - 1] ?? null;
}

const MS = 1000;

/** True when `later` was modified meaningfully after `earlier`. */
function isStale(earlier, later) {
    if (!earlier || !later) return false;
    return Date.parse(later) - Date.parse(earlier) > 2 * MS;
}

/**
 * Everything the "Attention required" list shows. Each item is grounded in a
 * fact on disk — no inferred test results or invented findings.
 */
function deriveAttention(f, mtimes) {
    const items = [];

    if (f.spec.openQuestions > 0) {
        const n = f.spec.openQuestions;
        items.push({
            id: "open-clarifications",
            severity: "error",
            title: `${n} unresolved clarification${n === 1 ? "" : "s"} in spec.md`,
            detail: `[NEEDS CLARIFICATION] marker${n === 1 ? " is" : "s are"} still open, so the spec is not ready to plan against.`,
            at: mtimes.spec,
            action: { kind: "agent", agent: "speckit.clarify", label: "Run clarify" },
        });
    }

    if (f.present.tasks && f.tasks.total === 0) {
        items.push({
            id: "tasks-empty",
            severity: "error",
            title: "tasks.md contains no tasks",
            detail: "The file exists but has no checkbox items to execute.",
            at: mtimes.tasks,
            action: { kind: "agent", agent: "speckit.tasks", label: "Regenerate" },
        });
    }

    if (isStale(mtimes.plan, mtimes.spec)) {
        items.push({
            id: "stale-plan",
            severity: "warn",
            title: "spec.md changed after plan.md",
            detail: "The technical plan may no longer reflect the specification.",
            at: mtimes.spec,
            action: { kind: "agent", agent: "speckit.analyze", label: "Check consistency" },
        });
    }
    if (isStale(mtimes.tasks, mtimes.plan)) {
        items.push({
            id: "stale-tasks",
            severity: "warn",
            title: "plan.md changed after tasks.md",
            detail: "The task breakdown may be missing work introduced by the newer plan.",
            at: mtimes.plan,
            action: { kind: "agent", agent: "speckit.converge", label: "Converge" },
        });
    }

    const remainingChecklist = f.checklists.total - f.checklists.done;
    if (remainingChecklist > 0) {
        items.push({
            id: "checklists-open",
            severity: "todo",
            title: "Checklist review incomplete",
            detail: `${f.checklists.done} of ${f.checklists.total} criteria marked satisfied — ${remainingChecklist} remain unchecked.`,
            at: mtimes.checklists,
            action: { kind: "tab", tab: "checklists", label: "Open checklists" },
        });
    }

    items.push({
        id: "next-step",
        severity: "suggestion",
        title: `Suggested: run ${f.status.next.agent}`,
        detail: f.status.next.reason,
        at: f.modified,
        action: { kind: "agent", agent: f.status.next.agent, label: "Run agent" },
    });

    return items;
}

/** Health rolls the blocking-severity attention items into one verdict. */
function deriveHealth(attention) {
    const errors = attention.filter((a) => a.severity === "error").length;
    const warns = attention.filter((a) => a.severity === "warn").length;
    const todos = attention.filter((a) => a.severity === "todo").length;

    if (errors > 0) {
        return { tone: "error", label: errors === 1 ? "1 blocking issue" : `${errors} blocking issues`, detail: "Resolve before continuing" };
    }
    if (warns > 0) {
        return { tone: "warn", label: warns === 1 ? "1 warning" : `${warns} warnings`, detail: "Artifacts may be out of sync" };
    }
    if (todos > 0) {
        return { tone: "todo", label: "Review pending", detail: "Checklist criteria outstanding" };
    }
    return { tone: "success", label: "Healthy", detail: "No outstanding findings" };
}

function scanFeature(repoRoot, name, gitBranch) {
    const dir = join(repoRoot, "specs", name);
    const artifacts = [];
    const present = {};

    for (const def of ARTIFACT_DEFS) {
        const full = join(dir, def.file);
        const st = safeStat(full);
        present[def.key] = Boolean(st?.isFile());
        artifacts.push({
            ...def,
            exists: Boolean(st?.isFile()),
            size: st?.size ?? 0,
            modified: st ? st.mtime.toISOString() : null,
        });
    }

    const contracts = listMarkdownTree(join(dir, "contracts"));
    const checklistNames = listMarkdown(join(dir, "checklists"));

    const specText = present.spec ? readTextFile(join(dir, "spec.md")) : null;
    const tasksText = present.tasks ? readTextFile(join(dir, "tasks.md")) : null;

    const spec = parseSpec(specText);
    const tasks = parseChecklist(tasksText);

    let checklistTotal = 0;
    let checklistDone = 0;
    let checklistModified = null;
    const checklistFiles = checklistNames.map((file) => {
        const full = join(dir, "checklists", file);
        const parsed = parseChecklist(readTextFile(full));
        const st = safeStat(full);
        checklistTotal += parsed.total;
        checklistDone += parsed.done;
        if (st && (!checklistModified || st.mtimeMs > Date.parse(checklistModified))) {
            checklistModified = st.mtime.toISOString();
        }
        return {
            file,
            path: `checklists/${file}`,
            title: parsed.title ?? humanize(file.replace(/\.md$/i, "")),
            total: parsed.total,
            done: parsed.done,
            groups: parsed.groups,
            modified: st ? st.mtime.toISOString() : null,
        };
    });

    const phases = derivePhases(tasks.groups);
    const mtimes = {
        spec: artifacts.find((a) => a.key === "spec")?.modified ?? null,
        plan: artifacts.find((a) => a.key === "plan")?.modified ?? null,
        tasks: artifacts.find((a) => a.key === "tasks")?.modified ?? null,
        checklists: checklistModified,
    };

    const feature = {
        name,
        dir: `specs/${name}`,
        title: spec.title ? spec.title.replace(/^Feature Specification:\s*/i, "").trim() : humanize(name),
        displayName: humanize(name),
        number: /^(\d+)/.exec(name)?.[1] ?? null,
        artifacts,
        present,
        contracts,
        checklists: { files: checklistFiles, total: checklistTotal, done: checklistDone },
        spec,
        tasks: { total: tasks.total, done: tasks.done, groups: tasks.groups },
        phases,
        currentPhase: currentPhase(phases),
        branch: { current: gitBranch, expected: parseFeatureBranch(specText) },
        files: listFeatureFiles(dir),
        modified: newestMtime(dir),
        mtimes,
    };

    feature.status = deriveStatus(feature);
    feature.stages = deriveStages(feature);
    feature.attention = deriveAttention(feature, mtimes);
    feature.health = deriveHealth(feature.attention);
    feature.blocked = deriveBlocked(feature);
    feature.issueCount = feature.attention.filter((a) => ["error", "warn", "todo"].includes(a.severity)).length;
    return feature;
}

/**
 * A feature is blocked when a hard gate stops the recommended agent from doing
 * useful work — currently only unresolved clarifications and an empty tasks.md.
 */
function deriveBlocked(f) {
    if (f.spec.openQuestions > 0) {
        return { blocked: true, label: "Yes", detail: "Clarifications must be resolved first" };
    }
    if (f.present.tasks && f.tasks.total === 0) {
        return { blocked: true, label: "Yes", detail: "tasks.md has no executable tasks" };
    }
    return { blocked: false, label: "No", detail: "Work can continue" };
}

function listMarkdownTree(dir) {
    const st = safeStat(dir);
    if (!st?.isDirectory()) return [];
    return listMarkdown(dir);
}

/** All markdown under the feature dir (2 levels deep), for the file browser. */
function listFeatureFiles(dir, depth = 2, prefix = "") {
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }
    const out = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            if (depth > 1) out.push(...listFeatureFiles(join(dir, entry.name), depth - 1, rel));
        } else if (entry.name.toLowerCase().endsWith(".md")) {
            const st = safeStat(join(dir, entry.name));
            out.push({ path: rel, size: st?.size ?? 0, modified: st ? st.mtime.toISOString() : null });
        }
    }
    return out;
}

function newestMtime(dir, depth = 2) {
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return null;
    }
    let newest = 0;
    for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (depth > 1) {
                const nested = newestMtime(full, depth - 1);
                if (nested && Date.parse(nested) > newest) newest = Date.parse(nested);
            }
            continue;
        }
        const st = safeStat(full);
        if (st && st.mtimeMs > newest) newest = st.mtimeMs;
    }
    return newest ? new Date(newest).toISOString() : null;
}

function humanize(name) {
    return name
        .replace(/^\d+[-_]/, "")
        .split(/[-_]/)
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
}

/**
 * The heart of the board: pick the single next spec-kit agent to run, and the
 * reason why. Order mirrors the documented specify → clarify → plan → tasks →
 * implement cycle, with converge as the post-implementation verification pass.
 */
function deriveStatus(f) {
    const step = (id, reason) => {
        const stage = PIPELINE.find((s) => s.id === id) ?? OPTIONAL_AGENTS.find((s) => s.id === id);
        return { agent: stage.agent, label: stage.label, blurb: stage.blurb, reason };
    };

    if (!f.present.spec) {
        return {
            key: "not-started",
            short: "Not started",
            label: "Not started",
            tone: "neutral",
            detail: "No spec.md in this feature folder yet.",
            next: step("specify", "spec.md does not exist yet"),
        };
    }
    if (f.spec.openQuestions > 0) {
        const n = f.spec.openQuestions;
        return {
            key: "needs-clarification",
            short: "Needs clarification",
            label: "Needs clarification",
            tone: "warn",
            detail: `${n} unresolved [NEEDS CLARIFICATION] marker${n === 1 ? "" : "s"} in spec.md.`,
            next: step("clarify", `${n} open [NEEDS CLARIFICATION] marker${n === 1 ? "" : "s"} in spec.md`),
        };
    }
    if (!f.present.plan) {
        return {
            key: "spec-ready",
            short: "Spec ready",
            label: "Spec ready",
            tone: "info",
            detail: "Specification is written. No technical plan yet.",
            next: step("plan", "plan.md does not exist yet"),
        };
    }
    if (!f.present.tasks) {
        return {
            key: "plan-ready",
            short: "Plan ready",
            label: "Plan ready",
            tone: "info",
            detail: "Technical plan exists. No task breakdown yet.",
            next: step("tasks", "tasks.md does not exist yet"),
        };
    }
    if (f.tasks.total === 0) {
        return {
            key: "tasks-empty",
            short: "Tasks empty",
            label: "Tasks empty",
            tone: "warn",
            detail: "tasks.md exists but contains no checkbox tasks.",
            next: step("tasks", "tasks.md contains no parsable tasks"),
        };
    }
    if (f.tasks.done < f.tasks.total) {
        const remaining = f.tasks.total - f.tasks.done;
        const started = f.tasks.done > 0;
        return {
            key: started ? "implementing" : "tasks-ready",
            short: started ? "Implementing" : "Ready",
            label: started ? `Implementing ${f.tasks.done}/${f.tasks.total}` : "Ready to implement",
            tone: started ? "active" : "info",
            detail: started
                ? `${remaining} of ${f.tasks.total} tasks remaining.`
                : `${f.tasks.total} tasks are ready and none are started.`,
            next: step("implement", `${remaining} unchecked task${remaining === 1 ? "" : "s"} in tasks.md`),
        };
    }
    return {
        key: "complete",
        short: "Complete",
        label: "Complete",
        tone: "success",
        detail: `All ${f.tasks.total} tasks are checked off.`,
        next: step("converge", "all tasks are complete — verify the codebase matches the spec"),
    };
}

function deriveStages(f) {
    const doneThrough = {
        specify: f.present.spec,
        clarify: f.present.spec && f.spec.openQuestions === 0 && f.spec.hasClarifications > 0,
        plan: f.present.plan,
        tasks: f.present.tasks && f.tasks.total > 0,
        implement: f.tasks.total > 0 && f.tasks.done === f.tasks.total,
    };
    const nextAgent = f.status.next.agent;

    return PIPELINE.map((stage) => {
        let state = "todo";
        if (doneThrough[stage.id]) state = "done";
        if (stage.id === "clarify" && !doneThrough.clarify && f.present.spec && f.spec.openQuestions === 0) {
            // Clarify is advisory: a spec with no open markers can move on without it.
            state = f.present.plan ? "skipped" : "optional";
        }
        if (stage.agent === nextAgent) state = "current";
        if (stage.id === "implement" && f.tasks.total > 0 && f.tasks.done > 0 && f.tasks.done < f.tasks.total) {
            state = "current";
        }
        return { ...stage, state };
    });
}

function readActiveFeature(repoRoot) {
    const text = readTextFile(join(repoRoot, ".specify", "feature.json"));
    if (!text) return null;
    try {
        const dir = JSON.parse(text).feature_directory;
        return typeof dir === "string" ? basename(dir.replace(/[\\/]+$/, "")) : null;
    } catch {
        return null;
    }
}

/**
 * Point `.specify/feature.json` at a feature so spec-kit scripts resolve it.
 * Existing line endings are preserved so clicking "make active" on a CRLF
 * checkout doesn't show up as a whole-file diff.
 */
export function setActiveFeature(repoRoot, featureName) {
    const dir = join(repoRoot, ".specify");
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "feature.json");
    const existing = readTextFile(target);
    const eol = existing?.includes("\r\n") ? "\r\n" : "\n";
    const payload = { feature_directory: `specs/${featureName}` };
    const body = JSON.stringify(payload, null, 2).replace(/\n/g, eol);
    writeFileSync(target, `${body}${eol}`, "utf-8");
    return payload;
}

export function scanRepo(repoRoot) {
    const specsDir = join(repoRoot, "specs");
    let names = [];
    try {
        names = readdirSync(specsDir, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name)
            .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    } catch {
        names = [];
    }

    const gitBranch = readGitBranch(repoRoot);
    const features = names.map((name) => scanFeature(repoRoot, name, gitBranch));
    const constitutionPath = join(repoRoot, ".specify", "memory", "constitution.md");
    const constitutionStat = safeStat(constitutionPath);

    return {
        repoRoot,
        repoName: basename(repoRoot),
        branch: gitBranch,
        hasSpecify: existsSync(join(repoRoot, ".specify")),
        activeFeature: readActiveFeature(repoRoot),
        constitution: {
            exists: Boolean(constitutionStat?.isFile()),
            modified: constitutionStat ? constitutionStat.mtime.toISOString() : null,
        },
        pipeline: PIPELINE,
        optionalAgents: OPTIONAL_AGENTS,
        features,
        rollup: deriveRollup(features),
        scannedAt: new Date().toISOString(),
    };
}

/**
 * Portfolio-level summary for the sidebar header. The segmented bar is built
 * from each feature's completed tasks in pipeline order, so the colours read as
 * "how much of the whole backlog each feature has actually finished".
 */
function deriveRollup(features) {
    const ordered = [...features].sort((a, b) => (a.name > b.name ? 1 : -1));
    let total = 0;
    let done = 0;
    let issues = 0;

    const segments = [];
    for (const f of ordered) {
        total += f.tasks.total;
        done += f.tasks.done;
        issues += f.issueCount ?? 0;
        if (f.tasks.done > 0) segments.push({ name: f.name, tone: f.status.tone, tasks: f.tasks.done });
    }

    return {
        features: features.length,
        total,
        done,
        percent: total > 0 ? Math.round((done / total) * 100) : 0,
        issues,
        segments,
        complete: features.filter((f) => f.status.key === "complete").length,
        active: features.filter((f) => f.status.key !== "complete").length,
    };
}

/**
 * Read one markdown file inside a feature folder. `relPath` is validated to
 * stay under the feature directory so the loopback server can't be walked out
 * of the repo.
 */
export function readFeatureFile(repoRoot, featureName, relPath) {
    if (!/^[\w.-]+$/.test(featureName)) return null;
    const featureDir = resolve(join(repoRoot, "specs", featureName));
    const target = resolve(join(featureDir, relPath));
    if (target !== featureDir && !target.startsWith(featureDir + sep)) return null;
    if (!target.toLowerCase().endsWith(".md")) return null;
    const content = readTextFile(target);
    if (content === null) return null;
    return { path: relative(featureDir, target).split(sep).join("/"), content };
}
