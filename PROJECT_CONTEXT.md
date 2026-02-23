# Stumble - Project Context (Read Before Coding)

## Product Overview

Stumble is a desktop inspiration vault (Eagle-like) with a dark, minimal UI.

Users can store:
- bookmarks (URLs)
- images
- videos
- PDFs
- files (any type)
- notes (text)

Primary goals:
- fast capture
- fast search
- simple organization
- clean dark interface

This is a local-first desktop application.
No cloud sync in MVP.

---

## Tech Stack

- Tauri (desktop wrapper)
- React
- TypeScript
- SQLite (local database, actively used for persisted app data)
- Local filesystem storage for imported files

Target platform: Windows (for now).

---

## Core Data Model Direction

## Item

Represents any stored content.

Core fields:
- id (uuid)
- type: "bookmark" | "image" | "video" | "pdf" | "file" | "note"
- filename (string, where applicable)
- title (string)
- description (editable text)
- rating (0-5)
- status: "saved" | "archived"
- tags (string[])
- createdAt
- updatedAt
- sizeBytes (nullable)
- format (nullable, e.g. "jpg", "mp4", "pdf")

Type-specific optional fields:
- sourceUrl (bookmarks)
- faviconUrl (bookmarks)
- bookmarkScreenshotPath (optional, manual screenshot for bookmarks)
- filePath (local managed copy path)
- thumbPath (preview thumbnail path)
- noteText (notes)
- meta (JSON: mime, width/height, etc.)

## Collection

Collections replace single-level categories.

Fields:
- id
- name
- parentId (nullable for root)

Rules:
- Collections support nesting (tree structure).
- An item can appear in multiple collections.
- Duplicating into another collection is a COPY, not a reference.
- Copies are independent items after duplication.

## Tag

- id
- name
- color
- createdAt
- updatedAt
- sortIndex (for sidebar ordering / drag reordering)

Many-to-many relation with Item.

## Future-Proofing (Non-MVP but must not be blocked)

Per-file annotations are planned (comments/markup layers on image or video frames).
This is not in MVP, but architecture should keep room for:
- annotation entities tied to item + target surface/frame
- multiple annotation layers
- editable/commentable annotation metadata

---

## Preview Behavior

- Images: show thumbnail in grid.
- Videos: show thumbnail in grid (duration badge later).
- PDFs: show first-page thumbnail (later).
- Bookmarks: show favicon; optional manually-added screenshot per bookmark.
- Grid tile size is adjustable via topbar slider (future refinements still expected).

---

## MVP Features (Strict Scope)

Must have in Phase 1 UI scaffold:
- Add URL flow entry point
- Import files via button
- Drag and drop import area/behavior
- Create note flow entry point
- Responsive item grid
- Item select and preview panel
- Search state and UI
- Multi-select behavior (Ctrl/Shift)
- Tile-size slider for grid

Must prepare for later multi-item actions (not fully implemented yet):
- delete
- move
- duplicate

---

## Right Preview Panel Requirements

Show these fields in the right panel:
- filename
- title
- type
- status
- rating
- tags
- collection path
- createdAt / updatedAt
- size
- format
- description (editable)

---

## Storage Rules

All imported files must be copied into:

%APPDATA%/Stumble/storage/

Do not reference original file paths after import.
Stumble owns managed storage copies.

---

## UI Layout (MVP)

Structure:
- Left sidebar: collections tree + tags (behavior inspired by Eagle/ChatGPT sidebar patterns)
- Topbar: search + filter controls + sort + add/import controls + tile-size slider
- Main area: responsive grid/list for items
- Right panel: detailed item preview and editable description

Visual direction:
- Dark theme by default
- Minimal and content-focused
- Use CSS variables/tokens for colors, spacing, typography, borders, and states
- Theme architecture should support future theme switching

---

## Current Phase

Phase 2 - SQLite-backed core UX iteration

Current reality (implemented/in progress):
- SQLite persistence is wired for core entities (items, collections, tags)
- local filesystem storage + import pipeline is in use
- thumbnail and bookmark metadata flows exist (still being refined)
- sidebar + preview panel UX is being iterated for speed and consistency
- debounced in-memory search + advanced filters (type/tags/rating/favorites) are wired into current view contexts
- sorting is integrated with filtering (newest/oldest/name/rating)
- search query + active filters + sort state persist in localStorage across reloads

Current focus:
- polish organization UX (collections/tags)
- reduce visual regressions while shipping features
- keep interactions fast and local-first

---

## Non-Goals (Still Not in MVP)

Do not implement:
- cloud sync
- browser extension
- AI auto-tagging
- duplicate detection intelligence
- full-text PDF/video indexing
- background workers
- authentication

Keep the app simple and shippable.

---

## Coding Principles

- Prefer simple and readable code.
- Avoid unnecessary abstractions.
- One feature at a time.
- No over-engineering.
- Keep UI separate from domain/state logic where practical.
- Do not introduce new libraries unless clearly required.
- Design state and component boundaries so DB integration can be added with minimal refactor.
- Reuse existing icons/components/patterns when available (especially context menus, dialogs, and action icons) to keep the UI visually consistent.
- Prefer existing custom confirm dialog + snackbar patterns over native browser dialogs for app actions.
- In dark mode, use subtle/saturated-low color tints for chip backgrounds (avoid overly bright fills).

---

## Assistant Behavior Rules

When generating code:
- Always include file paths.
- Modify existing files instead of rewriting the whole project.
- Do not change architecture without explicit instruction.
- If unsure, propose a sensible default and continue.
- Keep responses concise and implementation-focused.
- Reuse existing iconography and UI patterns before introducing new alternatives.
