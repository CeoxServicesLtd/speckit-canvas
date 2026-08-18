// Spec-kit board renderer.
//
// The extension owns all truth: this module fetches `/api/state`, subscribes to
// `/events` for live pushes while agents edit the repo, and renders. Every
// mutation (select, make active, run an agent) goes back over HTTP to the
// extension, which is the only thing that can reach the session.

const els = {
    app: document.getElementById("app"),
    sidebar: document.getElementById("sidebar"),
    detail: document.getElementById("detail"),
    list: document.getElementById("feature-list"),
    rollup: document.getElementById("rollup"),
    count: document.getElementById("feature-count"),
    search: document.getElementById("search"),
    searchRow: document.getElementById("search-row"),
    filterRow: document.getElementById("filter-row"),
    toggleSearch: document.getElementById("toggle-search"),
    toggleFilter: document.getElementById("toggle-filter"),
    newFeature: document.getElementById("new-feature"),
    runner: document.getElementById("runner"),
    runnerBody: document.getElementById("runner-body"),
    runnerHint: document.getElementById("runner-hint"),
    runnerGo: document.getElementById("runner-go"),
    toast: document.getElementById("toast"),
};

const FILTERS = [
    { id: "all", label: "All" },
    { id: "active", label: "In progress" },
    { id: "attention", label: "Needs attention" },
    { id: "complete", label: "Complete" },
];

const TABS = [
    { id: "overview", label: "Overview" },
    { id: "progress", label: "Progress" },
    { id: "artifacts", label: "Artifacts" },
    { id: "checklists", label: "Checklists" },
];

const state = {
    data: null,
    selected: null,
    tab: "overview",
    filter: "all",
    search: "",
    openFile: null,
    fileCache: new Map(),
    expanded: new Set(),
    expandedChecklists: new Set(),
    menuOpen: false,
    runner: null,
    lastSync: null,
};

// ------------------------------------------------------------------ helpers

const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function relTime(iso) {
    if (!iso) return "";
    const secs = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
}

function pct(done, total) {
    return total > 0 ? Math.round((done / total) * 100) : 0;
}

function bar(tone, done, total) {
    const ratio = total > 0 ? done / total : 0;
    return `<div class="bar tone-${esc(tone)}"><span class="bar__fill" style="transform:scaleX(${ratio.toFixed(4)})"></span></div>`;
}

/** Health outranks status for the dot/bar colour, so real problems show up. */
function toneOf(feature) {
    if (feature.health?.tone === "error") return "error";
    if (feature.health?.tone === "warn") return "warn";
    return feature.status.tone;
}

function toast(message, kind) {
    const isError = kind === "error";
    els.toast.className = isError ? "toast toast--error" : "toast";
    els.toast.innerHTML = `<span>${esc(message)}</span>${
        isError ? '<button class="toast__close" type="button" aria-label="Dismiss" data-toast-close="1">' + icons.close + "</button>" : ""
    }`;
    els.toast.hidden = false;
    clearTimeout(toast.timer);
    if (isError) return; // errors persist until dismissed or replaced
    toast.timer = setTimeout(() => {
        els.toast.hidden = true;
    }, 3200);
}

async function api(path, options) {
    const res = await fetch(path, options);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
    return body;
}

const icons = {
    error: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.25"/><path d="M5.9 5.9l4.2 4.2M10.1 5.9l-4.2 4.2"/></svg>',
    warn: '<svg viewBox="0 0 16 16"><path d="M8 2.2 14.4 13.4H1.6z"/><path d="M8 6.4v3.1M8 11.4v.1"/></svg>',
    todo: '<svg viewBox="0 0 16 16"><rect x="2.4" y="2.4" width="11.2" height="11.2" rx="2.4"/></svg>',
    info: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.25"/><path d="M8 7.4v3.4M8 5.3v.1"/></svg>',
    suggestion: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.25"/><path d="M8 7.4v3.4M8 5.3v.1"/></svg>',
    check: '<svg viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" rx="3"/><path d="M5 8.2 7.1 10.3 11 6.4"/></svg>',
    box: '<svg viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" rx="3"/></svg>',
    arrow: '<svg viewBox="0 0 16 16"><path d="M3 8h9M8.6 4.6 12 8l-3.4 3.4"/></svg>',
    branch: '<svg viewBox="0 0 16 16"><circle cx="4.5" cy="3.5" r="1.6"/><circle cx="4.5" cy="12.5" r="1.6"/><circle cx="11.5" cy="5.5" r="1.6"/><path d="M4.5 5.1v5.8M11.5 7.1c0 2.2-1.6 2.9-3.4 3.3"/></svg>',
    refresh: '<svg viewBox="0 0 16 16"><path d="M13.4 7a5.5 5.5 0 1 0-.4 3.4"/><path d="M13.6 3.4V7h-3.5"/></svg>',
    copy: '<svg viewBox="0 0 16 16"><rect x="5.5" y="5.5" width="8" height="8" rx="1.8"/><path d="M10.5 5.5v-1a1.8 1.8 0 0 0-1.8-1.8H4.3a1.8 1.8 0 0 0-1.8 1.8v4.4a1.8 1.8 0 0 0 1.8 1.8h1.2"/></svg>',
    chevron: '<svg viewBox="0 0 16 16"><path d="M4.5 6.5 8 10l3.5-3.5"/></svg>',
    close: '<svg viewBox="0 0 16 16"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>',
};

// ----------------------------------------------------------------- markdown

function inline(text) {
    let out = esc(text);
    out = out.replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`);
    out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_, alt) => `<em>${alt || "image"}</em>`);
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_, label, href) =>
        /^https?:/i.test(href) ? `<a href="${esc(href)}" target="_blank" rel="noreferrer noopener">${label}</a>` : label,
    );
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    out = out.replace(/\[NEEDS CLARIFICATION[^\]]*\]/g, (m) => `<mark class="needs-clarification">${m}</mark>`);
    return out;
}

function renderMarkdown(src) {
    const lines = String(src ?? "").split(/\r?\n/);
    const out = [];
    let i = 0;

    const listBuffer = { type: null, items: [] };
    const flushList = () => {
        if (!listBuffer.type) return;
        out.push(`<${listBuffer.type}>${listBuffer.items.join("")}</${listBuffer.type}>`);
        listBuffer.type = null;
        listBuffer.items = [];
    };

    while (i < lines.length) {
        const line = lines[i];

        const fence = /^\s*```(\w*)\s*$/.exec(line);
        if (fence) {
            flushList();
            const buf = [];
            i += 1;
            while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) buf.push(lines[i++]);
            i += 1;
            out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`);
            continue;
        }

        if (/^\s*(\|.*\|)\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")) {
            flushList();
            const cells = (row) =>
                row
                    .trim()
                    .replace(/^\||\|$/g, "")
                    .split("|")
                    .map((c) => c.trim());
            const head = cells(line);
            i += 2;
            const body = [];
            while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) body.push(cells(lines[i++]));
            out.push(
                `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>` +
                    body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("") +
                    "</tbody></table>",
            );
            continue;
        }

        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading) {
            flushList();
            const level = Math.min(heading[1].length, 4);
            out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
            i += 1;
            continue;
        }

        if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
            flushList();
            out.push("<hr />");
            i += 1;
            continue;
        }

        const quote = /^\s*>\s?(.*)$/.exec(line);
        if (quote) {
            flushList();
            const buf = [quote[1]];
            i += 1;
            while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
            out.push(`<blockquote>${inline(buf.join(" "))}</blockquote>`);
            continue;
        }

        const item = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line);
        if (item) {
            const ordered = /\d/.test(item[2]);
            const type = ordered ? "ol" : "ul";
            if (listBuffer.type && listBuffer.type !== type) flushList();
            listBuffer.type = type;
            const task = /^\[([ xX])\]\s*(.*)$/.exec(item[3]);
            if (task) {
                const done = task[1].toLowerCase() === "x";
                listBuffer.items.push(
                    `<li class="md-task">${done ? "\u2611" : "\u2610"} ${done ? `<s>${inline(task[2])}</s>` : inline(task[2])}</li>`,
                );
            } else {
                listBuffer.items.push(`<li>${inline(item[3])}</li>`);
            }
            i += 1;
            continue;
        }

        if (!line.trim()) {
            flushList();
            i += 1;
            continue;
        }

        flushList();
        const buf = [line];
        i += 1;
        while (i < lines.length && lines[i].trim() && !/^(\s*(#{1,6}\s|>|```|[-*+]\s|\d+\.\s)|\s*\|)/.test(lines[i])) {
            buf.push(lines[i++]);
        }
        out.push(`<p>${inline(buf.join(" "))}</p>`);
    }

    flushList();
    return out.join("");
}

// ------------------------------------------------------------------ sidebar

function visibleFeatures() {
    const q = state.search.trim().toLowerCase();
    return (state.data?.features ?? []).filter((f) => {
        if (state.filter === "complete" && f.status.key !== "complete") return false;
        if (state.filter === "active" && f.status.key === "complete") return false;
        if (state.filter === "attention" && (f.issueCount ?? 0) === 0) return false;
        if (!q) return true;
        return `${f.name} ${f.displayName} ${f.title} ${f.status.label}`.toLowerCase().includes(q);
    });
}

function renderRollup() {
    const r = state.data?.rollup;
    if (!r) {
        els.rollup.innerHTML = "";
        return;
    }
    const segTotal = r.total || 1;
    const segments = r.segments
        .map((s) => `<span class="segbar__seg tone-${esc(s.tone)}" style="width:${((s.tasks / segTotal) * 100).toFixed(2)}%;background:currentColor" title="${esc(s.name)}: ${s.tasks} done"></span>`)
        .join("");

    els.rollup.innerHTML = `
        <div class="rollup__figure">${r.done} / ${r.total} tasks</div>
        <div class="rollup__line">${r.percent}% complete${r.complete ? ` · ${r.complete} feature${r.complete === 1 ? "" : "s"} done` : ""}</div>
        ${r.issues > 0 ? `<div class="rollup__line rollup__line--attn">${r.issues} item${r.issues === 1 ? "" : "s"} need${r.issues === 1 ? "s" : ""} attention</div>` : ""}
        <div class="segbar">${segments}</div>`;
}

function renderFilters() {
    els.filterRow.innerHTML = FILTERS.map(
        (f) => `<button class="chip-btn" type="button" data-filter="${f.id}" aria-pressed="${state.filter === f.id}">${f.label}</button>`,
    ).join("");
}

function renderSidebar() {
    const features = visibleFeatures();
    els.count.textContent = String(features.length);

    els.list.innerHTML = features
        .map((f) => {
            const tone = toneOf(f);
            const isActive = state.data.activeFeature === f.name;
            const counts = f.tasks.total > 0 ? ` · ${f.tasks.done}/${f.tasks.total}` : "";
            return `<li>
                <button class="feature-card" type="button" data-feature="${esc(f.name)}" aria-current="${state.selected === f.name}">
                    <span class="feature-card__head">
                        <span class="feature-card__num">${esc(f.number ?? "—")}</span>
                        <span class="feature-card__name">${esc(f.displayName)}</span>
                        ${isActive ? '<span class="feature-card__active">Active</span>' : ""}
                    </span>
                    <span class="feature-card__status tone-${esc(tone)}">
                        <span class="dot"></span>
                        <span class="feature-card__statustext">${esc(f.status.short ?? f.status.label)}${counts}</span>
                    </span>
                    ${(f.issueCount ?? 0) > 0 ? `<span class="feature-card__attn">${f.issueCount} item${f.issueCount === 1 ? "" : "s"} need${f.issueCount === 1 ? "s" : ""} attention</span>` : ""}
                    ${bar(tone, f.tasks.done, f.tasks.total)}
                </button>
            </li>`;
        })
        .join("");

    if (features.length === 0) {
        els.list.innerHTML = `<li class="empty" style="height:auto;padding:24px 12px">${
            state.data?.features?.length ? "No features match this filter." : "No folders found under specs/."
        }</li>`;
    }
}

/** The feature the detail pane should show: the selection, unless the current search/filter hides it. */
function displayedFeature() {
    const visible = visibleFeatures();
    if (!visible.length) return null;
    return visible.find((f) => f.name === state.selected) ?? visible[0];
}

// ------------------------------------------------------------------- detail

function currentFeature() {
    return (state.data?.features ?? []).find((f) => f.name === state.selected) ?? null;
}

function tabCounts(f) {
    return {
        overview: null,
        progress: Math.max(0, f.tasks.total - f.tasks.done) || null,
        artifacts: f.files.length || null,
        checklists: f.checklists.files.length || null,
    };
}

function renderHead(f) {
    const counts = tabCounts(f);
    const branchOk = !f.branch.expected || !f.branch.current || f.branch.expected === f.branch.current;
    const synced = state.lastSync ? `Synced ${relTime(state.lastSync)}` : "Syncing…";
    const next = f.status?.next;

    return `
    <div class="detail__head">
        <div class="detail__titlerow">
            <h1 class="detail__title">${esc(f.displayName)}</h1>
            <button class="btn btn--ghost" id="copy-path" type="button">${icons.copy} Copy path</button>
            <div class="detail__headactions">
                <span class="sync"><span class="dot"></span>${esc(synced)}</span>
                <button class="btn" id="refresh" type="button">${icons.refresh} Refresh</button>
                ${
                    next
                        ? `<div class="splitbtn">
                    <button class="btn btn--primary splitbtn__main" type="button" data-run="${esc(next.agent)}" title="${esc(next.reason || next.blurb || "")}">${icons.arrow} ${esc(next.label)}</button>
                    <button class="btn btn--primary splitbtn__toggle" id="actions" type="button" aria-expanded="${state.menuOpen}" aria-haspopup="menu" aria-label="All agents">${icons.chevron}</button>
                    ${state.menuOpen ? renderMenu(f) : ""}
                </div>`
                        : ""
                }
            </div>
            ${f.title && f.title !== f.displayName ? `<div class="detail__subtitle">${esc(f.title)}</div>` : ""}
        </div>
        <div class="detail__meta">
            <span>${esc(f.number ?? "—")}</span>
            <span class="detail__sep">·</span>
            <span>${esc(f.name)}</span>
            ${
                f.branch.current
                    ? `<span class="branch-chip${branchOk ? "" : " branch-chip--warn"}" title="${
                          branchOk ? "Checked-out branch" : `spec.md expects ${esc(f.branch.expected)}`
                      }">${icons.branch}${esc(f.branch.current)}</span>`
                    : ""
            }
            ${state.data.activeFeature === f.name ? '<span class="feature-card__active">Active feature</span>' : ""}
        </div>
        <nav class="tabs" role="tablist">
            ${TABS.map(
                (t) =>
                    `<button class="tab" type="button" role="tab" data-tab="${t.id}" aria-selected="${state.tab === t.id}">${t.label}${
                        counts[t.id] ? `<span class="count">${counts[t.id]}</span>` : ""
                    }</button>`,
            ).join("")}
        </nav>
    </div>`;
}

function renderMenu(f) {
    const agent = (a) =>
        `<button class="menu__item" type="button" data-run="${esc(a.agent)}"><strong>${esc(a.agent)}</strong><span>${esc(a.blurb)}</span></button>`;
    return `<div class="menu__pop" id="actions-menu">
        <div class="menu__label">Pipeline</div>
        ${state.data.pipeline.map(agent).join("")}
        <div class="menu__rule"></div>
        <div class="menu__label">Any time</div>
        ${state.data.optionalAgents.map(agent).join("")}
        <div class="menu__rule"></div>
        <button class="menu__item" type="button" data-make-active="1"${state.data.activeFeature === f.name ? " disabled" : ""}>
            <strong>Set as active feature</strong><span>Point .specify/feature.json at this folder</span>
        </button>
    </div>`;
}

function renderStats(f) {
    const phase = f.currentPhase;
    return `<div class="card"><div class="stats">
        <div class="stat">
            <div class="stat__label">Lifecycle</div>
            <div class="stat__value"><span class="stat__pill">${esc(f.status.short ?? f.status.label)}</span></div>
        </div>
        <div class="stat">
            <div class="stat__label">Health</div>
            <div class="stat__value stat__value--sm tone-${esc(f.health.tone)}"><span class="dot"></span><span>${esc(f.health.label)}</span></div>
            <div class="stat__note">${esc(f.health.detail)}</div>
        </div>
        <div class="stat">
            <div class="stat__label">Blocked</div>
            <div class="stat__value tone-${f.blocked.blocked ? "error" : "success"}">${esc(f.blocked.label)}</div>
            <div class="stat__note">${esc(f.blocked.detail)}</div>
        </div>
        <div class="stat">
            <div class="stat__label">Tasks</div>
            <div class="stat__value stat__value--row"><span>${f.tasks.done} / ${f.tasks.total}</span><span>${pct(f.tasks.done, f.tasks.total)}%</span></div>
            ${bar(toneOf(f), f.tasks.done, f.tasks.total)}
        </div>
        <div class="stat">
            <div class="stat__label">Current phase</div>
            <div class="stat__value">${phase ? esc(phase.number ? `Phase ${phase.number}` : phase.name) : "—"}</div>
            <div class="stat__note">${phase ? esc(phase.number ? phase.name : "") : "No phases in tasks.md"}</div>
            ${f.phases.length ? '<button class="stat__link" type="button" data-tab="progress">View all phases ' + icons.arrow + "</button>" : ""}
        </div>
    </div></div>`;
}

function renderAttention(f) {
    const titleTone = { error: "tone-error", warn: "tone-warn" };
    const rows = f.attention
        .map(
            (a) => `<div class="attn">
        <span class="attn__icon tone-${esc(a.severity === "suggestion" ? "neutral" : a.severity)}">${icons[a.severity] ?? icons.info}</span>
        <span class="attn__main">
            <span class="attn__title ${titleTone[a.severity] ?? ""}">${esc(a.title)}</span>
            <div class="attn__detail">${esc(a.detail)}</div>
        </span>
        <span class="attn__time">${esc(relTime(a.at))}</span>
        ${
            a.action
                ? `<span class="attn__action"><button class="btn btn--soft" type="button" ${
                      a.action.kind === "agent" ? `data-run="${esc(a.action.agent)}"` : `data-tab="${esc(a.action.tab)}"`
                  }>${esc(a.action.label)} ${icons.arrow}</button></span>`
                : ""
        }
    </div>`,
        )
        .join("");

    return `<div class="card"><div class="card__head">Attention required</div>${rows}</div>`;
}

function renderProgress(f) {
    if (!f.phases.length) return `<div class="card"><div class="attn">No task phases found in tasks.md.</div></div>`;

    const phases = f.phases
        .map((p, index) => {
            const key = `${f.name}:${index}`;
            const isCurrent = f.currentPhase && f.currentPhase.index === p.index;
            const open = state.expanded.has(key) || (isCurrent && !state.expanded.has(`!${key}`));
            const tone = p.done === p.total ? "success" : isCurrent ? "active" : "neutral";

            let items = "";
            if (open) {
                let lastGroup = null;
                items =
                    '<ul class="tasks">' +
                    p.items
                        .map((t) => {
                            const header =
                                t.group && t.group !== lastGroup ? `<li class="task__group">${esc((lastGroup = t.group))}</li>` : "";
                            if (!t.group) lastGroup = null;
                            return `${header}<li class="task${t.done ? " task--done" : ""}">
                                <span class="task__box">${t.done ? icons.check : icons.box}</span>
                                ${t.id ? `<span class="task__id">${esc(t.id)}</span>` : ""}
                                <span class="task__text">${inline(t.text)}</span>
                            </li>`;
                        })
                        .join("") +
                    "</ul>";
            }

            return `<div class="phase">
                <div class="phase__head">
                    <span class="phase__name">${esc(p.number ? `Phase ${p.number} · ${p.name}` : p.name)}</span>
                    ${isCurrent ? '<span class="phase__badge">Current</span>' : ""}
                    <span class="phase__count">${p.done}/${p.total}</span>
                </div>
                ${bar(tone, p.done, p.total)}
                ${items}
                <button class="disclosure" type="button" data-phase="${key}">${open ? "Hide" : "Show"} ${p.total} task${p.total === 1 ? "" : "s"}</button>
            </div>`;
        })
        .join("");

    return `<div class="card">${phases}</div>`;
}

function renderArtifacts(f) {
    const known = new Map(f.artifacts.map((a) => [a.file, a]));
    const cards = f.artifacts
        .map((a) => {
            const meta = a.exists ? `${(a.size / 1024).toFixed(1)} KB · ${relTime(a.modified)}` : "Not created yet";
            return `<button class="artifact${a.exists ? "" : " artifact--missing"}" type="button" ${
                a.exists ? `data-file="${esc(a.file)}"` : "disabled"
            } aria-current="${state.openFile === a.file}">
                <span class="artifact__name">${esc(a.label)}</span>
                <span class="artifact__meta">${esc(meta)}</span>
            </button>`;
        })
        .join("");

    const extras = f.files
        .filter((file) => !known.has(file.path))
        .map(
            (file) => `<button class="artifact" type="button" data-file="${esc(file.path)}" aria-current="${state.openFile === file.path}">
                <span class="artifact__name">${esc(file.path)}</span>
                <span class="artifact__meta">${(file.size / 1024).toFixed(1)} KB · ${esc(relTime(file.modified))}</span>
            </button>`,
        )
        .join("");

    const viewer = state.openFile
        ? `<div class="viewer">
            <div class="viewer__head">
                <span class="viewer__path">${esc(f.dir)}/${esc(state.openFile)}</span>
                <button class="btn btn--ghost" type="button" data-file-close="1">Close</button>
            </div>
            <div class="md">${
                state.fileCache.has(`${f.name}/${state.openFile}`)
                    ? renderMarkdown(state.fileCache.get(`${f.name}/${state.openFile}`))
                    : "<p>Loading…</p>"
            }</div>
        </div>`
        : "";

    return `<div class="card">
        <div class="card__head">Pipeline artifacts</div>
        <div class="artifact-grid">${cards}</div>
        ${extras ? `<div class="card__head">Supporting files</div><div class="artifact-grid">${extras}</div>` : ""}
        ${viewer}
    </div>`;
}

function renderChecklists(f) {
    if (!f.checklists.files.length) {
        return `<div class="card">
            <div class="attn">
                <span class="attn__main">
                    <span class="attn__title">No checklists yet</span>
                    <div class="attn__detail">Checklists validate the quality of the requirements themselves.</div>
                </span>
                <span class="attn__action"><button class="btn btn--soft" type="button" data-run="speckit.checklist">Generate ${icons.arrow}</button></span>
            </div>
        </div>`;
    }

    return f.checklists.files
        .map((c) => {
            const key = `${f.name}:${c.file}`;
            const open = state.expandedChecklists.has(key);
            const tone = c.done === c.total ? "success" : c.done === 0 ? "neutral" : "active";
            const groups = open
                ? c.groups
                      .map(
                          (g) => `<div class="phase">
                    <div class="phase__head">
                        <span class="phase__name">${esc(g.title)}</span>
                        <span class="phase__count">${g.done}/${g.total}</span>
                    </div>
                    <ul class="tasks">${g.items
                        .map(
                            (item) => `<li class="task${item.done ? " task--done" : ""}">
                            <span class="task__box">${item.done ? icons.check : icons.box}</span>
                            ${item.id ? `<span class="task__id">${esc(item.id)}</span>` : ""}
                            <span class="task__text">${inline(item.text)}</span>
                        </li>`,
                        )
                        .join("")}</ul>
                </div>`,
                      )
                      .join("")
                : "";

            return `<div class="card">
                <div class="phase">
                    <div class="phase__head">
                        <span class="phase__name">${esc(c.title)}</span>
                        <span class="phase__count">${c.done}/${c.total} satisfied</span>
                    </div>
                    ${bar(tone, c.done, c.total)}
                    <button class="disclosure" type="button" data-checklist="${esc(key)}">${open ? "Hide" : "Show"} ${c.total} criteria</button>
                </div>
                ${groups}
                <div class="card__foot">
                    <button class="btn btn--ghost" type="button" data-file="${esc(c.path)}">Open ${esc(c.path)}</button>
                </div>
            </div>`;
        })
        .join("");
}

function renderDetail() {
    const f = displayedFeature();
    if (!f) {
        els.detail.innerHTML = `<div class="empty">${
            state.data?.features?.length
                ? "No features match the current search or filter. Clear them to see detail."
                : "No spec-kit features found under specs/."
        }</div>`;
        return;
    }

    const body =
        state.tab === "progress"
            ? renderProgress(f)
            : state.tab === "artifacts"
              ? renderArtifacts(f)
              : state.tab === "checklists"
                ? renderChecklists(f)
                : `${renderStats(f)}${renderAttention(f)}`;

    // Surfacing a feature the search/filter hid, so it's clear this isn't the selection.
    const filteredOut = state.selected && state.selected !== f.name;
    const banner = filteredOut
        ? `<div class="detail__filtered">“${esc(state.selected)}” is hidden by the current search/filter — showing <strong>${esc(f.displayName)}</strong> instead.</div>`
        : "";

    const scroller = els.detail.querySelector(".detail__body");
    const scrollTop = scroller ? scroller.scrollTop : 0;

    els.detail.innerHTML = `${renderHead(f)}<div class="detail__body">${banner}${body}</div>`;

    const next = els.detail.querySelector(".detail__body");
    if (next) next.scrollTop = scrollTop;
}

function render() {
    if (!state.data) return;
    renderRollup();
    renderFilters();
    renderSidebar();
    renderDetail();
}

// ------------------------------------------------------------------- runner

function openRunner(agentName) {
    const f = currentFeature();
    if (!f) return;
    const all = [...state.data.pipeline, ...state.data.optionalAgents];
    const agent = all.find((a) => a.agent === agentName) ?? { agent: agentName, blurb: "" };
    state.runner = { agent: agentName, args: "" };

    els.runnerBody.innerHTML = `
        <div class="runner__agent">
            <strong>${esc(agent.agent)}</strong>
            <span>${esc(agent.blurb || "")}</span>
        </div>
        <p class="runner__note">Runs in your current chat against <code>${esc(f.dir)}</code> and may edit files in that folder. You'll see the changes appear here live.</p>
        <div class="runner__field">
            <label for="runner-args">Extra instructions <span style="font-weight:400;color:var(--sk-muted)">(optional)</span></label>
            <textarea id="runner-args" placeholder="Anything the agent should know — scope, constraints, focus areas."></textarea>
        </div>`;
    els.runnerHint.textContent = "Ctrl+Enter to run · Esc to cancel";
    els.runner.hidden = false;
    document.getElementById("runner-args")?.focus();
}

function closeRunner() {
    els.runner.hidden = true;
    state.runner = null;
}

async function dispatchRun() {
    const f = currentFeature();
    if (!f || !state.runner) return;
    const args = document.getElementById("runner-args")?.value ?? "";
    const agent = state.runner.agent;
    els.runnerGo.disabled = true;
    try {
        await api("/api/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ feature: f.name, agent, args }),
        });
        closeRunner();
        toast(`Sent ${agent} to the session`);
    } catch (error) {
        toast(error.message, "error");
    } finally {
        els.runnerGo.disabled = false;
    }
}

// ------------------------------------------------------------------ actions

async function selectFeature(name) {
    state.selected = name;
    state.openFile = null;
    render();
    try {
        await api("/api/select", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ feature: name }),
        });
    } catch {
        /* remembering the selection is best-effort */
    }
}

async function openFile(path) {
    const f = currentFeature();
    if (!f) return;
    state.openFile = path;
    state.tab = "artifacts";
    render();
    await loadFile(path, false);
}

/**
 * Fetches a file's text into the cache. `force` re-reads a file we already hold,
 * which is what a state push needs so the viewer reflects an agent's edit.
 */
async function loadFile(path, force) {
    const f = currentFeature();
    if (!f) return;
    const key = `${f.name}/${path}`;
    if (!force && state.fileCache.has(key)) return;
    try {
        const result = await api(`/api/file?feature=${encodeURIComponent(f.name)}&path=${encodeURIComponent(path)}`);
        state.fileCache.set(key, result.content);
        if (state.openFile === path) render();
    } catch (error) {
        toast(error.message, "error");
    }
}

async function makeActive() {
    const f = currentFeature();
    if (!f) return;
    try {
        await api("/api/active", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ feature: f.name }),
        });
        toast(`${f.name} is now the active feature`);
    } catch (error) {
        toast(error.message, "error");
    }
}

function copyPath() {
    const f = currentFeature();
    if (!f) return;
    const text = `${state.data.repoRoot}\\${f.dir.replace(/\//g, "\\")}`;
    navigator.clipboard?.writeText(text).then(
        () => toast("Path copied"),
        () => toast("Could not copy path", "error"),
    );
}

// -------------------------------------------------------------------- wiring

els.toggleSearch.addEventListener("click", () => {
    const open = els.searchRow.hidden;
    els.searchRow.hidden = !open;
    els.toggleSearch.setAttribute("aria-pressed", String(open));
    if (open) els.search.focus();
    else {
        state.search = "";
        els.search.value = "";
        render();
    }
});

els.toggleFilter.addEventListener("click", () => {
    const open = els.filterRow.hidden;
    els.filterRow.hidden = !open;
    els.toggleFilter.setAttribute("aria-pressed", String(open));
    if (!open && state.filter !== "all") {
        state.filter = "all";
        render();
    }
});

els.search.addEventListener("input", () => {
    state.search = els.search.value;
    renderSidebar();
    renderDetail();
});

els.filterRow.addEventListener("click", (event) => {
    const button = event.target.closest("[data-filter]");
    if (!button) return;
    state.filter = button.dataset.filter;
    render();
});

els.list.addEventListener("click", (event) => {
    const card = event.target.closest("[data-feature]");
    if (card) selectFeature(card.dataset.feature);
});

els.newFeature.addEventListener("click", () => {
    if (!state.data) return;
    if (!currentFeature() && state.data.features.length === 0) state.selected = null;
    openRunner("speckit.specify");
});

els.detail.addEventListener("click", (event) => {
    const target = event.target;

    const tab = target.closest("[data-tab]");
    if (tab) {
        state.tab = tab.dataset.tab;
        state.menuOpen = false;
        render();
        return;
    }

    const run = target.closest("[data-run]");
    if (run) {
        state.menuOpen = false;
        const agent = run.dataset.run;
        render();
        openRunner(agent);
        return;
    }

    if (target.closest("[data-make-active]")) {
        state.menuOpen = false;
        render();
        makeActive();
        return;
    }

    if (target.closest("#actions")) {
        state.menuOpen = !state.menuOpen;
        render();
        return;
    }

    if (target.closest("#refresh")) {
        load();
        return;
    }

    if (target.closest("#copy-path")) {
        copyPath();
        return;
    }

    const phase = target.closest("[data-phase]");
    if (phase) {
        const key = phase.dataset.phase;
        // A negated key records "explicitly collapsed" so the auto-opened
        // current phase can be closed and stay closed.
        if (state.expanded.has(key)) {
            state.expanded.delete(key);
            state.expanded.add(`!${key}`);
        } else {
            state.expanded.delete(`!${key}`);
            state.expanded.add(key);
        }
        render();
        return;
    }

    const checklist = target.closest("[data-checklist]");
    if (checklist) {
        const key = checklist.dataset.checklist;
        if (state.expandedChecklists.has(key)) state.expandedChecklists.delete(key);
        else state.expandedChecklists.add(key);
        render();
        return;
    }

    if (target.closest("[data-file-close]")) {
        state.openFile = null;
        render();
        return;
    }

    const file = target.closest("[data-file]");
    if (file) {
        openFile(file.dataset.file);
        return;
    }

    if (state.menuOpen) {
        state.menuOpen = false;
        render();
    }
});

els.runner.addEventListener("click", (event) => {
    if (event.target.closest("[data-close]") || event.target.closest("#runner-close") || event.target.closest("#runner-cancel")) {
        closeRunner();
    }
});

els.runnerGo.addEventListener("click", dispatchRun);

els.toast.addEventListener("click", (event) => {
    if (event.target.closest("[data-toast-close]")) {
        clearTimeout(toast.timer);
        els.toast.hidden = true;
    }
});

document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
        if (!els.runner.hidden) closeRunner();
        else if (state.menuOpen) {
            state.menuOpen = false;
            render();
        }
        return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !els.runner.hidden) {
        dispatchRun();
        return;
    }

    // Global shortcuts — ignore while typing in a field or while the modal is open.
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? "");
    if (!els.runner.hidden) return;

    if (event.key === "/" && !typing) {
        event.preventDefault();
        if (els.searchRow.hidden) els.toggleSearch.click();
        els.search.focus();
        els.search.select();
        return;
    }

    if (typing) return;

    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "j" || event.key === "k") {
        const cards = [...els.list.querySelectorAll("[data-feature]")];
        if (!cards.length) return;
        event.preventDefault();
        const current = cards.findIndex((c) => c.dataset.feature === state.selected);
        const delta = event.key === "ArrowDown" || event.key === "j" ? 1 : -1;
        const next = cards[(current + delta + cards.length) % cards.length] ?? cards[0];
        selectFeature(next.dataset.feature);
        next.scrollIntoView({ block: "nearest" });
    }
});

// --------------------------------------------------------------------- data

function applyState(data) {
    const previous = state.data;
    state.data = data;
    state.lastSync = data.scannedAt;

    const names = data.features.map((f) => f.name);
    if (!state.selected || !names.includes(state.selected)) {
        state.selected = data.requestedFeature ?? data.preferredFeature ?? data.activeFeature ?? names[0] ?? null;
        if (!names.includes(state.selected)) state.selected = names[0] ?? null;
    }

    if (previous) {
        // Files may have changed underneath us, so drop cached text. The open
        // file keeps its entry (no "Loading…" flash) and is re-read below.
        const open = state.openFile ? `${state.selected}/${state.openFile}` : null;
        for (const key of [...state.fileCache.keys()]) {
            if (key !== open) state.fileCache.delete(key);
        }
    }

    render();
    if (previous && state.openFile) void loadFile(state.openFile, true);
}

async function load() {
    try {
        applyState(await api("/api/state"));
    } catch (error) {
        els.detail.innerHTML = `<div class="empty">Could not read the repo: ${esc(error.message)}</div>`;
    }
}

function connect() {
    const source = new EventSource("/events");
    source.addEventListener("state", (event) => applyState(JSON.parse(event.data)));
    source.addEventListener("focus", (event) => {
        const { feature } = JSON.parse(event.data);
        if (feature) {
            state.selected = feature;
            state.openFile = null;
            render();
        }
    });
    source.addEventListener("scan-error", (event) => toast(JSON.parse(event.data).message, "error"));
    source.onerror = () => {
        /* EventSource reconnects on its own */
    };
}

// Keep the "Synced Ns ago" label honest without re-rendering the whole board.
setInterval(() => {
    const sync = els.detail.querySelector(".sync");
    if (sync && state.lastSync) sync.lastChild.textContent = `Synced ${relTime(state.lastSync)}`;
}, 5000);

load();
connect();
