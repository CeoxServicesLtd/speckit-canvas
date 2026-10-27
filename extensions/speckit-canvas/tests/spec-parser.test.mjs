import assert from "node:assert/strict";
import { test } from "node:test";
import { parseScenario, parseSpec } from "../public/spec-parser.js";

// A filled-in spec following github/spec-kit templates/spec-template.md,
// including a clarify session and the variations real specs drift into.
const SPEC = `# Feature Specification: Photo Albums

**Feature Branch**: \`003-photo-albums\`

**Created**: 2026-10-01

**Status**: Draft

**Input**: User description: "Let users group photos into albums"

## Clarifications

### Session 2026-10-02

- Q: Can an album be shared? → A: Read-only links only
- Q: Max photos per album? -> A: 500

## User Scenarios & Testing *(mandatory)*

<!--
  IMPORTANT: User stories should be PRIORITIZED.
-->

### User Story 1 - Create an album (Priority: P1)

A user picks photos and saves them
as a named album.

**Why this priority**: Albums are the core value
of the feature.

**Independent Test**: Create an album with 3 photos and reopen it.

**Acceptance Scenarios**:

1. **Given** a library with photos, **When** the user selects 3 and saves, **Then** an album with 3 photos exists
2. **Given** an empty name, **When** the user saves, **Then** a validation error is shown

---

### User Story 2 – Share an album (Priority: P2)

Share a read-only link. See FR-002 and User Story 1.

**Why this priority**: Nice to have.

**Independent Test**: Open the link in a private window.

**Acceptance Scenarios**:

1. Visitors see photos but cannot edit

### Edge Cases

- What happens when an album exceeds 500 photos?
- How does the system handle a deleted photo [NEEDS CLARIFICATION: keep placeholder?]

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST let users create albums
- **FR-002**: System SHOULD allow sharing via link
- **FR-003**: Users MAY reorder photos
- **FR-004**: System MUST retain albums for [NEEDS CLARIFICATION: retention period not specified]

### Key Entities *(include if feature involves data)*

- **Album**: A named collection of photos
- **Photo**: An image owned by a user

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users create an album in under 30 seconds
- **SC-002**: 90% of shares open on first attempt

## Assumptions

- Users are signed in
- Mobile is out of scope

## Notes

Free-form section the parser does not know about.
`;

const byKind = (spec, kind) => spec.sections.filter((s) => s.kind === kind);

test("reads header title and metadata", () => {
    const spec = parseSpec(SPEC);
    assert.equal(spec.title, "Photo Albums");
    const meta = Object.fromEntries(spec.meta.map((m) => [m.key, m.value]));
    assert.equal(meta["Feature Branch"], "003-photo-albums");
    assert.equal(meta.Status, "Draft");
    assert.equal(meta.Input, "Let users group photos into albums");
});

test("parses prioritised user stories with labelled fields and scenarios", () => {
    const [section] = byKind(parseSpec(SPEC), "stories");
    assert.equal(section.stories.length, 2);
    const [one, two] = section.stories;
    assert.equal(one.number, 1);
    assert.equal(one.title, "Create an album");
    assert.equal(one.priority, "P1");
    assert.equal(one.anchor, "us-1");
    assert.deepEqual(one.description, ["A user picks photos and saves them as a named album."]);
    assert.equal(one.why, "Albums are the core value of the feature.");
    assert.equal(one.independentTest, "Create an album with 3 photos and reopen it.");
    assert.equal(one.scenarios.length, 2);
    assert.deepEqual(one.scenarios[0], {
        given: "a library with photos",
        when: "the user selects 3 and saves",
        then: "an album with 3 photos exists",
    });
    assert.equal(two.title, "Share an album");
    assert.equal(two.priority, "P2");
    assert.deepEqual(two.scenarios[0], { raw: "Visitors see photos but cannot edit" });
});

test("edge cases, entities, assumptions and unknown sections are kept", () => {
    const spec = parseSpec(SPEC);
    const edge = spec.sections.find((s) => s.id === "sec-edge");
    assert.equal(edge.items.length, 2);
    const entities = byKind(spec, "entities")[0];
    assert.deepEqual(entities.items.map((e) => e.name), ["Album", "Photo"]);
    assert.equal(entities.items[0].description, "A named collection of photos");
    const assumptions = spec.sections.find((s) => s.tone === "assumption");
    assert.equal(assumptions.items.length, 2);
    const notes = byKind(spec, "markdown")[0];
    assert.equal(notes.title, "Notes");
    assert.match(notes.body, /Free-form/);
});

test("requirements carry ids, modality and anchors", () => {
    const spec = parseSpec(SPEC);
    const [req] = byKind(spec, "requirements");
    const items = req.groups[0].items;
    assert.equal(req.groups[0].title, "Functional Requirements");
    assert.deepEqual(items.map((i) => i.id), ["FR-001", "FR-002", "FR-003", "FR-004"]);
    assert.deepEqual(items.map((i) => i.modality), ["must", "should", "may", "must"]);
    assert.ok(spec.anchors.has("fr-002"));
    const [sc] = byKind(spec, "success");
    assert.deepEqual(sc.groups[0].items.map((i) => i.id), ["SC-001", "SC-002"]);
    assert.ok(spec.anchors.has("sc-001"));
});

test("clarification sessions become Q/A pairs", () => {
    const [clar] = byKind(parseSpec(SPEC), "clarifications");
    assert.equal(clar.sessions[0].title, "2026-10-02");
    assert.deepEqual(clar.sessions[0].items, [
        { q: "Can an album be shared?", a: "Read-only links only" },
        { q: "Max photos per album?", a: "500" },
    ]);
});

test("open questions point at the element holding the marker", () => {
    const spec = parseSpec(SPEC);
    assert.deepEqual(
        spec.openQuestions.map((q) => [q.anchor, q.detail]),
        [
            ["edge-2", "keep placeholder?"],
            ["fr-004", "retention period not specified"],
        ],
    );
});

test("the unfilled spec-kit template still parses into its sections", () => {
    const template = `# Feature Specification: [FEATURE NAME]

**Feature Branch**: \`[###-feature-name]\`

## User Scenarios & Testing *(mandatory)*

### User Story 1 - [Brief Title] (Priority: P1)

[Describe this user journey in plain language]

**Why this priority**: [Explain the value]

**Independent Test**: [Describe how]

**Acceptance Scenarios**:

1. **Given** [initial state], **When** [action], **Then** [expected outcome]

### Edge Cases

- What happens when [boundary condition]?

## Requirements *(mandatory)*

### Functional Requirements

- **FR-006**: System MUST authenticate users via [NEEDS CLARIFICATION: auth method not specified - email/password, SSO, OAuth?]

*Example of marking unclear requirements:*

### Key Entities *(include if feature involves data)*

- **[Entity 1]**: [What it represents]

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: [Measurable metric]

## Assumptions

- [Assumption about target users]
`;
    const spec = parseSpec(template);
    assert.deepEqual(
        spec.sections.map((s) => s.kind),
        ["stories", "list", "requirements", "entities", "success", "list"],
    );
    assert.equal(spec.sections[0].stories[0].title, "[Brief Title]");
    assert.equal(spec.sections[3].items[0].name, "[Entity 1]");
    assert.equal(spec.openQuestions.length, 1);
    assert.equal(spec.recognised, true);
});

test("scenario parsing tolerates missing commas and falls back to raw", () => {
    assert.deepEqual(parseScenario("Given A When B Then C."), { given: "A", when: "B", then: "C" });
    assert.deepEqual(parseScenario("Just a sentence"), { raw: "Just a sentence" });
});

test("empty or unstructured input yields markdown-only output", () => {
    assert.equal(parseSpec("").sections.length, 0);
    const spec = parseSpec("## Something\n\nText");
    assert.equal(spec.recognised, false);
    assert.equal(spec.sections[0].kind, "markdown");
});

test("the view renders tiles, a focus panel and cross-links", async () => {
    const { createSpecView } = await import("../public/spec-view.js");
    const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    const icons = new Proxy({}, { get: () => "<svg></svg>" });
    const view = createSpecView({ esc, inline: esc, renderMarkdown: (t) => `<p>${esc(t)}</p>`, icons });
    const spec = parseSpec(SPEC);
    const ui = { mode: "structured", story: null, reqFilter: "all", section: null };

    const grid = view.render(spec, ui);
    assert.match(grid, /class="story-tile[^"]*"[^>]*data-story="us-1"/);
    assert.match(grid, /data-xref="sec-requirements"/);
    assert.match(grid, /data-xref="fr-\d{3}"|id="fr-001"/);
    assert.doesNotMatch(grid, /story-panel/);

    const focused = view.render(spec, { ...ui, story: "us-1" });
    assert.match(focused, /id="story-panel-title"/);
    assert.match(focused, /data-story-step="1"/);
    assert.match(focused, /scenario__steps/);
});
