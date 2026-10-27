# Feature Specification: Photo Search

**Feature Branch**: `002-photo-search`
**Created**: 2026-10-05
**Status**: Approved
**Input**: User description: "Find photos by date, place or album name from one search box."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Search by album or place name (Priority: P1)

A user types a word into the search box and sees matching albums and photos taken at matching places.

**Why this priority**: Finding photos is the most common complaint in feedback.

**Independent Test**: Search for "Lisbon" and confirm photos geotagged in Lisbon are returned.

**Acceptance Scenarios**:

1. **Given** photos geotagged in Lisbon, **When** the user searches "Lisbon", **Then** those photos are listed first.
2. **Given** an album named "Lisbon trip", **When** the user searches "lisbon", **Then** the album is shown above individual photos.

---

### User Story 2 - Filter results by date (Priority: P2)

A user narrows search results to a month or year.

**Why this priority**: Useful refinement once basic search works.

**Independent Test**: Search "beach", filter to 2025, and confirm only 2025 photos remain.

**Acceptance Scenarios**:

1. **Given** search results spanning several years, **When** the user picks 2025, **Then** only photos taken in 2025 remain.

### Edge Cases

- What happens when nothing matches? An empty state suggests checking spelling or clearing filters.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST search album names and place names from a single box.
- **FR-002**: System MUST rank album matches above individual photos.
- **FR-003**: System SHOULD support filtering by year and month.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Results appear within 1 second for libraries of up to 50,000 photos.
- **SC-002**: 80% of searches lead to a photo being opened.
