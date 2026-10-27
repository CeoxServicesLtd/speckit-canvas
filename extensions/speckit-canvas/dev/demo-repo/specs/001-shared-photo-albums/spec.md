# Feature Specification: Shared Photo Albums

**Feature Branch**: `001-shared-photo-albums`
**Created**: 2026-10-20
**Status**: Draft
**Input**: User description: "Let people group photos into albums, share an album with family using a link, and let invited people add their own photos. Albums should feel quick to make and safe to share."

## Clarifications

### Session 2026-10-22

- Q: Can people who receive a link edit the album? → A: Only if the owner invites them as a contributor; links are view-only.
- Q: What is the maximum album size? → A: 2,000 photos per album.
- Q: Should albums support videos? → A: Not in this feature; photos only.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Create an album from selected photos (Priority: P1)

A signed-in user selects photos in their library and saves them as a named album, so related photos stay together and are easy to find later.

**Why this priority**: Albums are the core unit every other story builds on; without them there is nothing to share.

**Independent Test**: Select 3 photos, save them as "Beach 2026", reopen the library and confirm the album exists with those 3 photos in order.

**Acceptance Scenarios**:

1. **Given** a library with at least 3 photos, **When** the user selects 3 photos and saves them as "Beach 2026", **Then** an album named "Beach 2026" containing those 3 photos appears in the album list.
2. **Given** the album form is open, **When** the user saves without a name, **Then** the album is created with the date range of its photos as its name.
3. **Given** an existing album, **When** the user adds 2 more photos, **Then** the album shows 5 photos and the new ones appear at the end.

---

### User Story 2 - Share an album with a view-only link (Priority: P1)

The album owner creates a link that lets anyone with it view the album without an account, and can switch the link off at any time.

**Why this priority**: Sharing is the main reason users asked for albums (see User Story 1); it is part of the minimum viable slice.

**Independent Test**: Create a link for an album, open it in a private browser window, confirm photos load, then revoke the link and confirm it stops working.

**Acceptance Scenarios**:

1. **Given** an album the user owns, **When** they choose "Share link", **Then** a link is copied and the album is marked as shared.
2. **Given** a shared link, **When** a signed-out visitor opens it, **Then** they see the album's photos and cannot change anything (FR-006).
3. **Given** a shared link, **When** the owner revokes it, **Then** visitors opening the link see a "This album is no longer shared" message within 1 minute.

---

### User Story 3 - Invite contributors to add photos (Priority: P2)

The owner invites named people by email to contribute; contributors can add their own photos but cannot remove other people's.

**Why this priority**: Valuable for events and families, but sharing must work first.

**Independent Test**: Invite a second account, add a photo from that account, and confirm the owner sees it attributed to the contributor.

**Acceptance Scenarios**:

1. **Given** an album and a contributor invite, **When** the invitee accepts, **Then** they can add photos to the album.
2. **Given** a contributor, **When** they try to remove a photo someone else added, **Then** the action is not offered.
3. **Given** a contributor, **When** the owner removes them, **Then** their previously added photos stay in the album [NEEDS CLARIFICATION: or should they be removed too?]

---

### User Story 4 - Reorder and set a cover photo (Priority: P3)

The owner drags photos into a preferred order and picks one as the album cover shown in lists and link previews.

**Why this priority**: Polishes presentation; albums are usable without it.

**Independent Test**: Move the last photo to the front, set it as cover, and confirm the album list and link preview both show it.

**Acceptance Scenarios**:

1. **Given** an album with 5 photos, **When** the owner drags photo 5 to position 1, **Then** the new order persists after reload.
2. **Given** an album, **When** the owner sets a cover photo, **Then** the album list thumbnail updates.

---

### Edge Cases

- What happens when a photo in an album is deleted from the library? The album keeps a placeholder until the owner removes it.
- How does the system handle an album that reaches the 2,000 photo limit? Further additions are blocked with a clear message.
- What happens when a contributor's account is deleted? [NEEDS CLARIFICATION: keep or remove their photos?]
- Two contributors add photos at the same moment; both additions are kept and ordered by time added.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST let a signed-in user create an album from one or more selected photos.
- **FR-002**: System MUST let the owner rename an album and add or remove photos at any time.
- **FR-003**: System MUST default an unnamed album's title to the date range of its photos.
- **FR-004**: System MUST let the owner create, copy and revoke a view-only share link per album.
- **FR-005**: System MUST stop serving a revoked link within 1 minute.
- **FR-006**: Link visitors MUST NOT be able to add, remove or reorder photos.
- **FR-007**: System MUST let the owner invite contributors by email and remove them.
- **FR-008**: Contributors MUST be able to add photos and SHOULD see who added each photo.
- **FR-009**: System SHOULD let the owner reorder photos by drag and drop (see User Story 4).
- **FR-010**: System MAY generate a link preview image from the cover photo.
- **FR-011**: System MUST retain albums of deleted accounts for [NEEDS CLARIFICATION: retention period not specified].

### Key Entities

- **Album**: A named, ordered collection of photos with one owner, an optional cover photo and a sharing state.
- **Album Photo**: A reference from an album to a library photo, with position, who added it and when.
- **Share Link**: A revocable, unguessable token granting view-only access to one album.
- **Contributor**: A person invited by the owner who may add photos to one album.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can create an album of 10 photos in under 30 seconds.
- **SC-002**: 95% of shared links open on the first attempt on mobile and desktop.
- **SC-003**: A revoked link stops working within 1 minute in 99% of cases.
- **SC-004**: At least 40% of albums created in the first month are shared (supports FR-004).

## Assumptions

- Users are signed in to create, share or contribute; link visitors need no account.
- Photos already exist in the user's library; uploading is out of scope.
- Videos are out of scope for this feature, per the 2026-10-22 clarification.
- Existing storage limits per user apply; contributor uploads count against the contributor.
