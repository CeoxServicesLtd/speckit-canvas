// Structured reader for spec-kit `spec.md` files.
//
// Follows the shape of github/spec-kit `templates/spec-template.md`:
// header metadata, User Scenarios & Testing (prioritised user stories with
// Given/When/Then scenarios, plus Edge Cases), Requirements (Functional
// Requirements, Key Entities), Success Criteria, Assumptions, and the
// `## Clarifications` log that speckit.clarify appends. Anything unrecognised
// is kept as a markdown section so nothing in the file is ever hidden.
//
// Pure and dependency-free so it runs in the canvas and under node:test.

const CLARIFY = /\[NEEDS CLARIFICATION[^\]]*\]/g;

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Removes HTML comments (the template's guidance blocks) without disturbing line numbers much. */
function stripComments(text) {
    return text.replace(/<!--[\s\S]*?-->/g, "");
}

/** Splits lines into `{ title, lines }` blocks at headings of exactly `level`. */
function splitAt(lines, level) {
    const head = new RegExp(`^#{${level}}\\s+(.*?)\\s*#*\\s*$`);
    const fence = /^\s*```/;
    const blocks = [{ title: null, lines: [] }];
    let inFence = false;
    for (const line of lines) {
        if (fence.test(line)) inFence = !inFence;
        const m = !inFence && head.exec(line);
        if (m) blocks.push({ title: m[1].trim(), lines: [] });
        else blocks[blocks.length - 1].lines.push(line);
    }
    return blocks;
}

/** Drops the template's `*(mandatory)*` style qualifiers from a heading. */
function cleanTitle(title) {
    return String(title ?? "")
        .replace(/\s*\*\([^)]*\)\*\s*/g, " ")
        .replace(/\s*_\([^)]*\)_\s*/g, " ")
        .trim();
}

/**
 * Bullet and numbered list items, with wrapped continuation lines and nested
 * bullets folded into their parent item. Non-list text is returned separately.
 */
function listItems(lines) {
    const items = [];
    const rest = [];
    let current = null;
    for (const line of lines) {
        const top = /^(?: {0,1})(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
        if (top) {
            current = { text: top[1].trim() };
            items.push(current);
            continue;
        }
        if (current && /^\s{2,}\S/.test(line)) {
            const nested = /^\s+(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
            current.text += nested ? ` · ${nested[1].trim()}` : ` ${line.trim()}`;
            continue;
        }
        if (!line.trim()) {
            current = null;
            continue;
        }
        current = null;
        rest.push(line);
    }
    return { items, rest };
}

/** Joins plain text lines into paragraphs. */
function paragraphs(lines) {
    const out = [];
    let buf = [];
    for (const line of lines) {
        if (line.trim()) buf.push(line.trim());
        else if (buf.length) {
            out.push(buf.join(" "));
            buf = [];
        }
    }
    if (buf.length) out.push(buf.join(" "));
    return out;
}

const isBlank = (lines) => lines.every((l) => !l.trim() || /^\s*(---+|\*\*\*+|___+)\s*$/.test(l));

const trimRule = (lines) => lines.filter((l) => !/^\s*(---+|\*\*\*+|___+)\s*$/.test(l));

// -------------------------------------------------------------- stories

const STORY_HEAD = /^(?:user\s+story|story|us)\s*(\d+)\s*(?:[-–—:]\s*(.*))?$/i;

function parseStoryHeading(title, fallbackNumber) {
    let rest = title;
    let priority = null;
    const p = /\(\s*priority\s*:\s*(P\d+)\s*\)/i.exec(rest) ?? /\[\s*(P\d+)\s*\]/i.exec(rest);
    if (p) {
        priority = p[1].toUpperCase();
        rest = rest.replace(p[0], "").trim();
    }
    const m = STORY_HEAD.exec(rest);
    if (m) {
        return { number: Number(m[1]), title: (m[2] ?? "").trim() || `User story ${m[1]}`, priority };
    }
    return { number: fallbackNumber, title: rest.replace(/^primary\s+/i, "").trim() || "User story", priority };
}

/** `**Given** a, **When** b, **Then** c` → `{ given, when, then }`. */
export function parseScenario(text) {
    const plain = text.replace(/\*\*/g, "").replace(/__/g, "").trim();
    const m = /^\s*given\s+([\s\S]*?),?\s+when\s+([\s\S]*?),?\s+then\s+([\s\S]*?)\s*$/i.exec(plain);
    if (!m) return { raw: text.trim() };
    return { given: m[1].trim(), when: m[2].trim(), then: m[3].trim().replace(/\.$/, "") };
}

const LABEL = /^\s*\*\*([^*]+?)\*\*\s*:?\s*(.*)$/;

function parseStoryBody(lines) {
    const story = { description: [], why: null, independentTest: null, scenarios: [], extra: [] };
    let mode = "description";
    const buf = [];
    const flush = () => {
        if (!buf.length) return;
        const chunk = buf.splice(0);
        if (mode === "scenarios") {
            const { items, rest } = listItems(chunk);
            story.scenarios.push(...items.map((i) => parseScenario(i.text)));
            if (rest.length) story.extra.push(...rest);
        } else if (mode === "description") {
            story.description.push(...paragraphs(chunk));
        } else {
            story.extra.push(...chunk);
        }
    };

    // A wrapped "**Why this priority**:" paragraph continues until a blank line.
    let open = null;
    for (const line of trimRule(lines)) {
        const label = LABEL.exec(line);
        const key = label ? label[1].replace(/:$/, "").trim().toLowerCase() : "";
        if (label && /^why/.test(key)) {
            flush();
            story.why = label[2].trim();
            mode = "after";
            open = "why";
            continue;
        }
        if (label && /independent(ly)?\s+test/.test(key)) {
            flush();
            story.independentTest = label[2].trim();
            mode = "after";
            open = "independentTest";
            continue;
        }
        if (label && /acceptance/.test(key)) {
            flush();
            mode = "scenarios";
            open = null;
            if (label[2].trim()) buf.push(label[2]);
            continue;
        }
        if (!line.trim()) open = null;
        else if (open && !/^\s*([-*+]|\d+[.)])\s/.test(line)) {
            story[open] += ` ${line.trim()}`;
            continue;
        }
        buf.push(line);
    }
    flush();
    story.extra = isBlank(story.extra) ? "" : story.extra.join("\n").trim();
    return story;
}

function parseStoriesSection(lines, sink) {
    const blocks = splitAt(lines, 3);
    const out = { intro: isBlank(blocks[0].lines) ? "" : trimRule(blocks[0].lines).join("\n").trim(), stories: [], edgeCases: null, other: [] };
    let last = null;
    for (const block of blocks.slice(1)) {
        const title = cleanTitle(block.title);
        if (/^edge\s+cases?/i.test(title)) {
            out.edgeCases = listSection(block.lines, "edge");
            continue;
        }
        if (/^acceptance\s+scenarios?/i.test(title) && last) {
            const { items, rest } = listItems(block.lines);
            last.scenarios.push(...items.map((i) => parseScenario(i.text)));
            if (!isBlank(rest)) last.extra = [last.extra, rest.join("\n")].filter(Boolean).join("\n").trim();
            continue;
        }
        if (STORY_HEAD.test(title.replace(/\([^)]*\)/g, "").trim()) || /user\s+story/i.test(title)) {
            const head = parseStoryHeading(title, out.stories.length + 1);
            const body = parseStoryBody(block.lines);
            last = { ...head, ...body, anchor: `us-${head.number}` };
            out.stories.push(last);
            continue;
        }
        out.other.push({ title, body: block.lines.join("\n").trim() });
    }
    // Duplicate numbers (hand-edited specs) still need unique anchors.
    const seen = new Set();
    for (const s of out.stories) {
        while (seen.has(s.anchor)) s.anchor += "b";
        seen.add(s.anchor);
        sink.anchors.add(s.anchor);
    }
    return out;
}

// ---------------------------------------------------------- id'd lists

const ID_ITEM = /^\*\*([A-Z][A-Z0-9]{0,6}-\d+[A-Za-z]?)\s*:?\s*\*\*\s*:?\s*(.*)$/;
const ID_PLAIN = /^([A-Z][A-Z0-9]{0,6}-\d+[A-Za-z]?)\s*:\s*(.*)$/;

function modality(text) {
    const m = /\b(MUST NOT|MUST|SHALL NOT|SHALL|SHOULD NOT|SHOULD|MAY)\b/.exec(text);
    if (!m) return null;
    if (/^(MUST|SHALL)/.test(m[1])) return "must";
    if (/^SHOULD/.test(m[1])) return "should";
    return "may";
}

function idItems(lines) {
    const { items, rest } = listItems(lines);
    const parsed = items.map((i) => {
        const m = ID_ITEM.exec(i.text) ?? ID_PLAIN.exec(i.text);
        return m ? { id: m[1], text: m[2].trim() } : { id: null, text: i.text };
    });
    return { items: parsed, rest };
}

function listSection(lines, prefix) {
    const { items, rest } = listItems(trimRule(lines));
    return {
        items: items.map((i, n) => ({ text: i.text, anchor: `${prefix}-${n + 1}` })),
        note: isBlank(rest) ? "" : rest.join("\n").trim(),
    };
}

function parseRequirementsSection(lines, sink) {
    const blocks = splitAt(lines, 3);
    const groups = [];
    let entities = null;
    const other = [];
    const pushGroup = (title, blockLines) => {
        const { items, rest } = idItems(trimRule(blockLines));
        if (!items.length) {
            if (!isBlank(rest)) other.push({ title: title ?? "Notes", body: rest.join("\n").trim() });
            return;
        }
        groups.push({
            title,
            note: isBlank(rest) ? "" : rest.join("\n").trim(),
            items: items.map((it, n) => ({
                ...it,
                modality: modality(it.text),
                anchor: it.id ? slug(it.id) : `${slug(title ?? "req")}-${n + 1}`,
            })),
        });
    };
    if (!isBlank(blocks[0].lines)) pushGroup(null, blocks[0].lines);
    for (const block of blocks.slice(1)) {
        const title = cleanTitle(block.title);
        if (/key\s+entities|entities|data\s+model/i.test(title)) {
            entities = parseEntities(block.lines);
            continue;
        }
        pushGroup(title, block.lines);
    }
    for (const g of groups) for (const it of g.items) sink.anchors.add(it.anchor);
    return { groups, entities, other };
}

function parseEntities(lines) {
    const { items, rest } = listItems(trimRule(lines));
    return {
        items: items.map((i, n) => {
            const m = /^\*\*(.+?)\*\*\s*:?\s*(.*)$/.exec(i.text);
            const name = m ? m[1].replace(/:$/, "").trim() : i.text.split(/[:–—-]\s/)[0].trim();
            const description = m ? m[2].trim() : i.text.slice(name.length).replace(/^\s*[:–—-]\s*/, "");
            return { name, description, anchor: `entity-${slug(name) || n + 1}` };
        }),
        note: isBlank(rest) ? "" : rest.join("\n").trim(),
    };
}

function parseSuccessSection(lines, sink) {
    const blocks = splitAt(lines, 3);
    const groups = [];
    const other = [];
    for (const block of blocks) {
        if (isBlank(block.lines)) continue;
        const { items, rest } = idItems(trimRule(block.lines));
        if (!items.length) {
            other.push({ title: block.title ? cleanTitle(block.title) : null, body: rest.join("\n").trim() });
            continue;
        }
        groups.push({
            title: block.title ? cleanTitle(block.title) : null,
            note: isBlank(rest) ? "" : rest.join("\n").trim(),
            items: items.map((it, n) => ({ ...it, anchor: it.id ? slug(it.id) : `sc-item-${groups.length + 1}-${n + 1}` })),
        });
    }
    for (const g of groups) for (const it of g.items) sink.anchors.add(it.anchor);
    return { groups, other };
}

function parseClarifications(lines) {
    const blocks = splitAt(lines, 3);
    const sessions = [];
    for (const block of blocks) {
        const { items, rest } = listItems(block.lines);
        const qa = items.map((i) => {
            const m = /^\s*(?:\*\*)?Q(?:\*\*)?\s*:\s*([\s\S]*?)\s*(?:→|->|=>)\s*(?:\*\*)?A(?:\*\*)?\s*:\s*([\s\S]*)$/.exec(i.text);
            return m ? { q: m[1].trim(), a: m[2].trim() } : { q: i.text, a: null };
        });
        if (!qa.length && isBlank(rest)) continue;
        sessions.push({
            title: block.title ? cleanTitle(block.title).replace(/^session\s+/i, "") : null,
            items: qa,
            note: isBlank(rest) ? "" : rest.join("\n").trim(),
        });
    }
    return { sessions };
}

// ----------------------------------------------------------------- header

function parseHeader(lines) {
    let title = null;
    const meta = [];
    const rest = [];
    for (const line of lines) {
        const h1 = /^#\s+(.*)$/.exec(line);
        if (h1 && !title) {
            title = h1[1].replace(/^Feature Specification:\s*/i, "").trim();
            continue;
        }
        const m = /^\s*\*\*([^*]+?)\*\*\s*:?\s*(.*)$/.exec(line);
        if (m && m[2].trim()) {
            const key = m[1].replace(/:$/, "").trim();
            let value = m[2].trim();
            if (/^input$/i.test(key)) value = value.replace(/^User description:\s*/i, "").replace(/^"([\s\S]*)"$/, "$1");
            else value = value.replace(/^`([^`]*)`$/, "$1");
            meta.push({ key, value });
            continue;
        }
        rest.push(line);
    }
    return { title, meta, intro: isBlank(rest) ? "" : rest.join("\n").trim() };
}

// ------------------------------------------------------------------ spec

const KINDS = [
    { kind: "stories", test: /user\s+(scenarios|stories)|scenarios\s*&\s*testing/i, label: "Stories" },
    { kind: "edge", test: /^edge\s+cases?/i, label: "Edge cases" },
    { kind: "requirements", test: /^requirements|functional\s+requirements/i, label: "Requirements" },
    { kind: "success", test: /success\s+criteria|measurable\s+outcomes/i, label: "Success criteria" },
    { kind: "assumptions", test: /^assumptions|dependencies\s*(&|and)\s*assumptions/i, label: "Assumptions" },
    { kind: "clarifications", test: /^clarifications?/i, label: "Clarifications" },
];

/**
 * Parses spec.md into an ordered list of typed sections plus cross-reference
 * targets and the open [NEEDS CLARIFICATION] questions.
 */
export function parseSpec(source) {
    const text = stripComments(String(source ?? "").replace(/\r\n?/g, "\n"));
    const lines = text.split("\n");
    const blocks = splitAt(lines, 2);
    const header = parseHeader(blocks[0].lines);
    const sink = { anchors: new Set() };
    const sections = [];

    blocks.slice(1).forEach((block, index) => {
        const title = cleanTitle(block.title);
        const def = KINDS.find((k) => k.test.test(title));
        const id = def ? `sec-${def.kind}` : `sec-${slug(title) || index + 1}`;
        const base = { id: sections.some((s) => s.id === id) ? `${id}-${index + 1}` : id, title, label: def?.label ?? title };

        if (def?.kind === "stories") {
            const parsed = parseStoriesSection(block.lines, sink);
            sections.push({ ...base, kind: "stories", stories: parsed.stories, intro: parsed.intro, other: parsed.other });
            if (parsed.edgeCases) {
                sections.push({ id: "sec-edge", title: "Edge cases", label: "Edge cases", kind: "list", tone: "edge", ...parsed.edgeCases });
            }
        } else if (def?.kind === "edge") {
            sections.push({ ...base, kind: "list", tone: "edge", ...listSection(block.lines, "edge") });
        } else if (def?.kind === "requirements") {
            const parsed = parseRequirementsSection(block.lines, sink);
            if (parsed.groups.length || parsed.other.length) {
                sections.push({ ...base, kind: "requirements", groups: parsed.groups, other: parsed.other });
            }
            if (parsed.entities) {
                sections.push({ id: "sec-entities", title: "Key entities", label: "Entities", kind: "entities", ...parsed.entities });
            }
        } else if (def?.kind === "success") {
            sections.push({ ...base, kind: "success", ...parseSuccessSection(block.lines, sink) });
        } else if (def?.kind === "assumptions") {
            sections.push({ ...base, kind: "list", tone: "assumption", ...listSection(block.lines, "assumption") });
        } else if (def?.kind === "clarifications") {
            sections.push({ ...base, kind: "clarifications", ...parseClarifications(block.lines) });
        } else if (!isBlank(block.lines)) {
            sections.push({ ...base, kind: "markdown", body: block.lines.join("\n").trim() });
        }
    });

    for (const s of sections) {
        for (const item of s.items ?? []) if (item.anchor) sink.anchors.add(item.anchor);
        if (s.kind === "markdown") sink.anchors.add(s.id);
    }

    const spec = { title: header.title, meta: header.meta, intro: header.intro, sections, anchors: sink.anchors };
    spec.openQuestions = collectOpenQuestions(spec);
    spec.counts = Object.fromEntries(sections.map((s) => [s.id, countOf(s)]));
    spec.recognised = sections.some((s) => s.kind !== "markdown");
    return spec;
}

function countOf(section) {
    switch (section.kind) {
        case "stories":
            return section.stories.length;
        case "requirements":
            return section.groups.reduce((n, g) => n + g.items.length, 0);
        case "success":
            return section.groups.reduce((n, g) => n + g.items.length, 0);
        case "clarifications":
            return section.sessions.reduce((n, g) => n + g.items.length, 0);
        case "list":
        case "entities":
            return section.items.length;
        default:
            return null;
    }
}

/** Every [NEEDS CLARIFICATION] marker, tied to the element that holds it. */
function collectOpenQuestions(spec) {
    const found = [];
    const scan = (text, anchor, where) => {
        for (const m of String(text ?? "").matchAll(CLARIFY)) {
            const detail = m[0].replace(/^\[NEEDS CLARIFICATION\s*:?\s*/i, "").replace(/\]$/, "").trim();
            found.push({ anchor, where, detail: detail || "Clarification needed" });
        }
    };
    for (const { key, value } of spec.meta) scan(value, null, key);
    for (const s of spec.sections) {
        if (s.kind === "stories") {
            for (const st of s.stories) {
                const where = `User story ${st.number}`;
                [st.title, ...st.description, st.why, st.independentTest, st.extra].forEach((t) => scan(t, st.anchor, where));
                st.scenarios.forEach((sc) => scan(sc.raw ?? `${sc.given} ${sc.when} ${sc.then}`, st.anchor, where));
            }
            scan(s.intro, s.id, s.label);
        } else if (s.kind === "requirements" || s.kind === "success") {
            for (const g of s.groups) for (const it of g.items) scan(it.text, it.anchor, it.id ?? s.label);
            for (const o of s.other) scan(o.body, s.id, s.label);
        } else if (s.kind === "list") {
            s.items.forEach((it, n) => scan(it.text, it.anchor, `${s.label} #${n + 1}`));
        } else if (s.kind === "entities") {
            s.items.forEach((it) => scan(`${it.name} ${it.description}`, it.anchor, it.name));
        } else if (s.kind === "markdown") {
            scan(s.body, s.id, s.label);
        }
    }
    return found;
}

/** Story-number references: "User Story 2", "US2", "Story 2". */
export const STORY_REF = /\b(?:User\s+Story|Story|US)\s?(\d+)\b/g;
/** Requirement/criterion ids such as FR-001, SC-004, NFR-12. */
export const ID_REF = /(?<![\w-])([A-Z][A-Z0-9]{0,6}-\d+[A-Za-z]?)(?![\w-])/g;
