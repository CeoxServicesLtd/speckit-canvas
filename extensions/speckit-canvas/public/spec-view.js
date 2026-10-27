// Structured rendering of a parsed spec.md (see spec-parser.js).
//
// Pure string templates: app.js owns state and event wiring, this module only
// turns `{ spec, ui }` into markup. Interactive hooks are data attributes:
//   data-xref="<anchor>"        jump to (and flash) an element in the spec
//   data-story="<anchor>"       open a story in the focus panel
//   data-story-step="-1|1"      previous / next story
//   data-story-close            return to the tile grid
//   data-req-filter="<id>"      requirement filter
//   data-spec-mode="<mode>"     structured / markdown toggle

import { ID_REF, STORY_REF } from "./spec-parser.js";

const REQ_FILTERS = [
    { id: "all", label: "All" },
    { id: "must", label: "Must" },
    { id: "should", label: "Should / may" },
    { id: "open", label: "Needs clarification" },
];

const CLARIFY = /\[NEEDS CLARIFICATION/;

/** Applies `fn` to text outside HTML tags so attributes are never rewritten. */
function mapText(html, fn) {
    return html
        .split(/(<[^>]+>)/)
        .map((part) => (part.startsWith("<") ? part : fn(part)))
        .join("");
}

export function createSpecView({ esc, inline, renderMarkdown, icons }) {
    let anchors = new Set();
    let storyTitles = new Map();

    /** Inline markdown plus cross-links to requirements, criteria and stories. */
    function rich(text, { modal = false, qty = false } = {}) {
        let html = inline(text);
        // <mark> and <code> contents stay literal; everything else is linkable.
        const parts = html.split(/(<code>[\s\S]*?<\/code>|<mark[^>]*>[\s\S]*?<\/mark>|<a [^>]*>[\s\S]*?<\/a>)/);
        html = parts
            .map((part, i) => {
                if (i % 2 === 1) return part;
                return mapText(part, (t) => {
                    let out = t.replace(ID_REF, (m, id) => {
                        const anchor = id.toLowerCase();
                        return anchors.has(anchor) ? `<button class="xref" type="button" data-xref="${anchor}">${id}</button>` : m;
                    });
                    out = out.replace(STORY_REF, (m, n) => {
                        const anchor = `us-${n}`;
                        if (!anchors.has(anchor)) return m;
                        const title = storyTitles.get(anchor);
                        return `<button class="xref xref--story" type="button" data-story="${anchor}"${
                            title ? ` title="${esc(title)}"` : ""
                        }>${m}</button>`;
                    });
                    return out;
                });
            })
            .join("");
        if (modal) {
            html = mapText(html, (t) =>
                t.replace(/\b(MUST NOT|MUST|SHALL NOT|SHALL|SHOULD NOT|SHOULD|MAY)\b/, (m) => `<span class="modal-verb">${m}</span>`),
            );
        }
        if (qty) {
            html = mapText(html, (t) =>
                t.replace(
                    /(?<![\w-])((?:under|within|at least|at most|less than|more than|over|<|>|≤|≥)?\s?\d[\d,.]*\s?(?:%|percent|ms|milliseconds?|s|secs?|seconds?|mins?|minutes?|hours?|hrs?|days?|weeks?|x|×)?)(?![\w-])/gi,
                    (m) => (/\d/.test(m) ? `<strong class="qty">${m.trim()}</strong>` : m),
                ),
            );
        }
        return html;
    }

    const md = (src) => (src ? `<div class="md">${renderMarkdown(src)}</div>` : "");
    const hasOpen = (text) => CLARIFY.test(text ?? "");

    // ---------------------------------------------------------------- head

    function renderMeta(spec) {
        const meta = spec.meta.filter((m) => !/^input$/i.test(m.key));
        const input = spec.meta.find((m) => /^input$/i.test(m.key));
        const chips = meta
            .map((m) => {
                const status = /^status$/i.test(m.key);
                return `<span class="spec-meta__item"><span class="spec-meta__key">${esc(m.key)}</span> <span class="${
                    status ? "spec-meta__status" : "spec-meta__value"
                }">${inline(m.value)}</span></span>`;
            })
            .join("");
        return `${chips ? `<div class="spec-meta">${chips}</div>` : ""}${
            input
                ? `<details class="spec-input"><summary>Original request</summary><blockquote>${inline(input.value)}</blockquote></details>`
                : ""
        }`;
    }

    function renderNav(spec, ui) {
        const items = spec.sections
            .map((s) => {
                const count = spec.counts[s.id];
                return `<button class="spec-nav__item" type="button" data-xref="${esc(s.id)}" aria-current="${ui.section === s.id}">${esc(
                    s.label,
                )}${count ? `<span class="count">${count}</span>` : ""}</button>`;
            })
            .join("");
        return `<nav class="spec-nav" aria-label="Spec sections">${items}</nav>`;
    }

    function renderOpenQuestions(spec) {
        const open = spec.openQuestions;
        if (!open.length) return "";
        const rows = open
            .map(
                (q) => `<li>${
                    q.anchor
                        ? `<button class="spec-open__where" type="button" data-xref="${esc(q.anchor)}">${esc(q.where)}</button>`
                        : `<span class="spec-open__where">${esc(q.where)}</span>`
                }<span class="spec-open__detail">${esc(q.detail)}</span></li>`,
            )
            .join("");
        return `<section class="spec-open" aria-label="Open questions">
            <div class="spec-open__head">
                <span class="spec-open__icon">${icons.warn}</span>
                <h2 class="spec-open__title">${open.length} open question${open.length === 1 ? "" : "s"}</h2>
                <span class="spec-open__hint">The spec isn't ready to plan against until these are answered.</span>
                <button class="btn" type="button" data-run="speckit.clarify">Run clarify ${icons.arrow}</button>
            </div>
            <ul class="spec-open__list">${rows}</ul>
        </section>`;
    }

    // ------------------------------------------------------------- stories

    function priorityRank(p) {
        return p ? Number(p.slice(1)) : 99;
    }

    function storyTile(st) {
        const open = [st.title, ...st.description, st.why, st.independentTest].some(hasOpen);
        const summary = st.description[0] ?? st.why ?? "";
        const facts = [
            `US${st.number}`,
            st.scenarios.length ? `${st.scenarios.length} scenario${st.scenarios.length === 1 ? "" : "s"}` : "No scenarios",
            st.independentTest ? "Independently testable" : null,
        ].filter(Boolean);
        return `<button class="story-tile${st.priority === "P1" ? " story-tile--p1" : ""}" type="button" data-story="${esc(st.anchor)}" id="${esc(
            st.anchor,
        )}">
            <span class="story-tile__top">
                <span class="story-tile__title">${inline(st.title)}</span>
                ${st.priority ? `<span class="prio prio--${esc(st.priority.toLowerCase())}">${esc(st.priority)}</span>` : ""}
            </span>
            ${summary ? `<span class="story-tile__summary">${inline(summary)}</span>` : ""}
            <span class="story-tile__facts">${facts.map(esc).join('<span aria-hidden="true"> · </span>')}${
                open ? `<span class="story-tile__open">${icons.warn} Open question</span>` : ""
            }</span>
        </button>`;
    }

    function storyGrid(section) {
        const groups = new Map();
        for (const st of section.stories) {
            const key = st.priority ?? "—";
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(st);
        }
        const ordered = [...groups.entries()].sort((a, b) => priorityRank(a[1][0].priority) - priorityRank(b[1][0].priority));
        if (ordered.length === 1) return `<div class="story-grid">${ordered[0][1].map(storyTile).join("")}</div>`;
        return ordered
            .map(([key, list]) => {
                const label = key === "—" ? "Unprioritised" : key === "P1" ? "P1 · minimum viable slice" : `${key}`;
                return `<div class="story-group">
                    <h3 class="story-group__title">${esc(label)} <span class="count">${list.length}</span></h3>
                    <div class="story-grid">${list.map(storyTile).join("")}</div>
                </div>`;
            })
            .join("");
    }

    function scenarioRow(sc, n) {
        if (sc.raw) return `<li class="scenario scenario--raw"><span class="scenario__n">${n}</span><span>${rich(sc.raw)}</span></li>`;
        return `<li class="scenario">
            <span class="scenario__n">${n}</span>
            <dl class="scenario__steps">
                <dt>Given</dt><dd>${rich(sc.given)}</dd>
                <dt>When</dt><dd>${rich(sc.when)}</dd>
                <dt>Then</dt><dd>${rich(sc.then)}</dd>
            </dl>
        </li>`;
    }

    function storyFocus(section, ui) {
        const list = section.stories;
        const index = Math.max(0, list.findIndex((s) => s.anchor === ui.story));
        const st = list[index];
        const rail = list
            .map(
                (s) => `<li><button class="story-rail__item" type="button" data-story="${esc(s.anchor)}" aria-current="${s.anchor === st.anchor}">
                    <span class="story-rail__n">US${s.number}</span>
                    <span class="story-rail__title">${inline(s.title)}</span>
                    ${s.priority ? `<span class="prio prio--${esc(s.priority.toLowerCase())}">${esc(s.priority)}</span>` : ""}
                </button></li>`,
            )
            .join("");

        const facts = [
            st.why ? `<div class="story-fact"><dt>Why this priority</dt><dd>${rich(st.why)}</dd></div>` : "",
            st.independentTest ? `<div class="story-fact"><dt>Independent test</dt><dd>${rich(st.independentTest)}</dd></div>` : "",
        ].join("");

        return `<div class="story-focus">
            <ul class="story-rail" aria-label="User stories">${rail}</ul>
            <article class="story-panel" id="${esc(st.anchor)}" aria-labelledby="story-panel-title">
                <header class="story-panel__head">
                    <h3 class="story-panel__title" id="story-panel-title" tabindex="-1">${inline(st.title)}</h3>
                    <span class="story-panel__ids">US${st.number}${
                        st.priority ? ` <span class="prio prio--${esc(st.priority.toLowerCase())}">${esc(st.priority)}</span>` : ""
                    }</span>
                    <span class="story-panel__nav">
                        <span class="story-panel__pos">${index + 1} of ${list.length}</span>
                        <button class="icon-btn" type="button" data-story-step="-1" aria-label="Previous story"${index === 0 ? " disabled" : ""}>${
                            icons.chevronLeft
                        }</button>
                        <button class="icon-btn" type="button" data-story-step="1" aria-label="Next story"${
                            index === list.length - 1 ? " disabled" : ""
                        }>${icons.chevronRight}</button>
                        <button class="icon-btn" type="button" data-story-close="1" aria-label="Back to all stories">${icons.close}</button>
                    </span>
                </header>
                ${st.description.map((p) => `<p class="story-panel__lede">${rich(p)}</p>`).join("")}
                ${facts ? `<dl class="story-facts">${facts}</dl>` : ""}
                ${
                    st.scenarios.length
                        ? `<h4 class="story-panel__sub">Acceptance scenarios <span class="count">${st.scenarios.length}</span></h4>
                    <ol class="scenarios">${st.scenarios.map((sc, n) => scenarioRow(sc, n + 1)).join("")}</ol>`
                        : `<p class="spec-empty">No acceptance scenarios written for this story yet.</p>`
                }
                ${md(st.extra)}
                <p class="story-panel__keys">Use <kbd>←</kbd> <kbd>→</kbd> to step through stories, <kbd>Esc</kbd> to return to the grid.</p>
            </article>
        </div>`;
    }

    function renderStories(section, ui) {
        const body = !section.stories.length
            ? `<p class="spec-empty">No user stories found. Stories use headings like <code>### User Story 1 - Title (Priority: P1)</code>.</p>`
            : ui.story && section.stories.some((s) => s.anchor === ui.story)
              ? storyFocus(section, ui)
              : storyGrid(section);
        return `${md(section.intro)}${body}${section.other.map((o) => `<h3 class="spec-sub">${esc(o.title)}</h3>${md(o.body)}`).join("")}`;
    }

    // -------------------------------------------------------- requirements

    function idRow(item, opts) {
        const open = hasOpen(item.text);
        return `<li class="idrow${open ? " idrow--open" : ""}" id="${esc(item.anchor)}" data-modality="${esc(item.modality ?? "")}" data-open="${open}">
            <span class="idrow__id">${esc(item.id ?? "•")}</span>
            <span class="idrow__text">${rich(item.text, opts)}</span>
        </li>`;
    }

    function renderRequirements(section, ui) {
        const all = section.groups.flatMap((g) => g.items);
        const counts = {
            all: all.length,
            must: all.filter((i) => i.modality === "must").length,
            should: all.filter((i) => i.modality === "should" || i.modality === "may").length,
            open: all.filter((i) => hasOpen(i.text)).length,
        };
        const keep = (i) =>
            ui.reqFilter === "must"
                ? i.modality === "must"
                : ui.reqFilter === "should"
                  ? i.modality === "should" || i.modality === "may"
                  : ui.reqFilter === "open"
                    ? hasOpen(i.text)
                    : true;
        const filters = REQ_FILTERS.filter((f) => f.id === "all" || counts[f.id] > 0)
            .map(
                (f) =>
                    `<button class="chip-btn" type="button" data-req-filter="${f.id}" aria-pressed="${ui.reqFilter === f.id}">${f.label} <span class="chip-btn__n">${counts[f.id]}</span></button>`,
            )
            .join("");
        const groups = section.groups
            .map((g) => {
                const items = g.items.filter(keep);
                if (!items.length) return "";
                return `${section.groups.length > 1 && g.title ? `<h3 class="spec-sub">${esc(g.title)}</h3>` : ""}
                    <ul class="idlist">${items.map((i) => idRow(i, { modal: true })).join("")}</ul>
                    ${ui.reqFilter === "all" && g.note ? md(g.note) : ""}`;
            })
            .join("");
        return `${all.length > 3 ? `<div class="spec-filters" role="group" aria-label="Filter requirements">${filters}</div>` : ""}
            ${groups || `<p class="spec-empty">No requirements match this filter.</p>`}
            ${section.other.map((o) => `<h3 class="spec-sub">${esc(o.title)}</h3>${md(o.body)}`).join("")}`;
    }

    function renderSuccess(section) {
        return (
            section.groups
                .map(
                    (g) => `${section.groups.length > 1 && g.title ? `<h3 class="spec-sub">${esc(g.title)}</h3>` : ""}
                <ul class="idlist idlist--outcomes">${g.items.map((i) => idRow(i, { qty: true })).join("")}</ul>${md(g.note)}`,
                )
                .join("") + section.other.map((o) => `${o.title ? `<h3 class="spec-sub">${esc(o.title)}</h3>` : ""}${md(o.body)}`).join("")
        );
    }

    function renderEntities(section) {
        if (!section.items.length) return md(section.note) || `<p class="spec-empty">No entities listed.</p>`;
        return `<dl class="entities">${section.items
            .map(
                (e) => `<div class="entity" id="${esc(e.anchor)}"><dt>${inline(e.name)}</dt><dd>${rich(e.description)}</dd></div>`,
            )
            .join("")}</dl>${md(section.note)}`;
    }

    function renderList(section) {
        if (!section.items.length) return md(section.note) || `<p class="spec-empty">Nothing listed yet.</p>`;
        return `<ul class="plainlist plainlist--${esc(section.tone ?? "")}">${section.items
            .map((i) => `<li id="${esc(i.anchor)}"${hasOpen(i.text) ? ' class="is-open"' : ""}>${rich(i.text)}</li>`)
            .join("")}</ul>${md(section.note)}`;
    }

    function renderClarifications(section) {
        return section.sessions
            .map(
                (s) => `${s.title ? `<h3 class="spec-sub">Session ${esc(s.title)}</h3>` : ""}
                <dl class="qa">${s.items
                    .map(
                        (qa) => `<div class="qa__row"><dt><span class="qa__k">Q</span>${rich(qa.q)}</dt>${
                            qa.a ? `<dd><span class="qa__k">A</span>${rich(qa.a)}</dd>` : ""
                        }</div>`,
                    )
                    .join("")}</dl>${md(s.note)}`,
            )
            .join("");
    }

    function renderSection(section, ui) {
        const body =
            section.kind === "stories"
                ? renderStories(section, ui)
                : section.kind === "requirements"
                  ? renderRequirements(section, ui)
                  : section.kind === "success"
                    ? renderSuccess(section)
                    : section.kind === "entities"
                      ? renderEntities(section)
                      : section.kind === "list"
                        ? renderList(section)
                        : section.kind === "clarifications"
                          ? renderClarifications(section)
                          : md(section.body);
        return `<section class="spec-sec spec-sec--${esc(section.kind)}" id="${esc(section.id)}" data-spec-section="${esc(section.id)}">
            <h2 class="spec-sec__title">${esc(section.title)}</h2>
            ${body}
        </section>`;
    }

    // ---------------------------------------------------------------- page

    function render(spec, ui) {
        anchors = spec.anchors;
        storyTitles = new Map(
            spec.sections.filter((s) => s.kind === "stories").flatMap((s) => s.stories.map((st) => [st.anchor, `${st.title}`])),
        );
        return `${renderMeta(spec)}
            ${spec.intro ? md(spec.intro) : ""}
            ${spec.sections.length > 1 ? renderNav(spec, ui) : ""}
            ${renderOpenQuestions(spec)}
            ${spec.sections.map((s) => renderSection(s, ui)).join("")}`;
    }

    return { render };
}
