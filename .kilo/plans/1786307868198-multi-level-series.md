# Multi-level (nested) series structure

## Goal

Add a **Nested** library pattern that builds a **filesystem-derived series tree** (parent/child series), without changing behavior of existing Series-priority or Collection-priority libraries. Aligns with [stump#280](https://github.com/stumpapp/stump/issues/280).

## Locked decisions

| Decision                    | Choice                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| Hierarchy source            | Filesystem folder tree only (not metadata-only #288)                                       |
| Pattern integration         | New `LibraryPattern` value; keep Series/Collection unchanged                               |
| Media ownership             | Media belong to the series whose folder **directly** contains the file                     |
| Parent views                | Direct media + optional **rollup** of descendant media/counts                              |
| Which folders become series | Dirs that directly contain media **plus all ancestors** up to (not including) library root |
| V1 surface                  | Full stack: DB + scanner + GraphQL + web tree/breadcrumbs (Expo deferred)                  |

Out of scope for this plan: metadata-only series (#288), Expo nested UI, renaming Series/Collection patterns, manual drag-and-drop hierarchy.

## Current state (constraints)

- `series` is flat: `id`, `name`, `path`, `library_id`, … — **no** `parent_id` (`crates/models/src/entity/series.rs`).
- Identity = absolute `path`; scanner creates/reconciles series by path.
- `LibraryPattern::{SeriesBased, CollectionBased}` drive walk `max_depth` and “valid series dir” rules (`core/src/filesystem/scanner/walk.rs`, `library_scan_job.rs`).
- Media: `media.series_id` → one series; no multi-parent membership.
- GraphQL/UI: flat series lists and `/series/:id/*` detail; no tree APIs.

## Target model

```text
Library (path, library_pattern = NESTED)
  └── Series (path = /lib/Author, parent_id = null)
        ├── Media (files directly in Author/)
        └── Series (path = /lib/Author/Mistborn, parent_id = Author)
              └── Media (files directly in Mistborn/)
```

**Example** (ebook tree from docs):

| Path                                  | Series?                 | parent    | Direct media                                                                                                                                                                             |
| ------------------------------------- | ----------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/Ebooks/Sanderson, Brandon`          | yes (root-level series) | null      | `Elantris.epub`                                                                                                                                                                          |
| `/Ebooks/Sanderson, Brandon/Mistborn` | yes                     | Sanderson | trilogy epubs                                                                                                                                                                            |
| `/Ebooks/Shannon, Samantha`           | yes                     | null      | single epub                                                                                                                                                                              |
| Library root `/Ebooks`                | **not** a series        | —         | (if root has loose media: treat like SeriesBased special case — create series at root **or** document unsupported; prefer create root series only if root has direct media, parent null) |

### Discovery rules (Nested)

1. Walk full tree under library (respect ignore rules); no `max_depth` on library walk for discovery.
2. A directory is a **media dir** if it **directly** contains ≥1 supported media file.
3. Series paths = every media dir ∪ every proper ancestor of a media dir that is still under the library root (exclude library root unless it is itself a media dir).
4. `parent_series_id`: series whose `path` is the nearest ancestor series path (or null if parent would be library root).
5. On series walk for Nested: only ingest **direct** media files in that series folder (`max_depth = 1` for files); do **not** claim files under child series paths (child series own those).
6. Reconciliation still keyed by `path`; when parent moves on disk, path change may look like delete+create (same as today) — optional improvement: re-link `parent_id` from path after create batch.

### Non-Nested patterns

- **SeriesBased / CollectionBased**: leave walk logic as today; `parent_series_id` always null for series they create. No migration required for existing libraries.

## Schema / migration

New migration under `crates/migrations/`:

1. `series.parent_series_id` — `TEXT NULL`, FK → `series.id`, **ON DELETE SET NULL** (or CASCADE children — prefer **CASCADE delete of subtree** when parent series hard-deleted with library; for missing FS mark missing recursively). Safer for library delete: existing library → series cascade already deletes all series; self-FK should use `ON DELETE CASCADE` for children when parent row deleted, or delete children explicitly in job order (deepest first). **Recommendation:** `ON DELETE CASCADE` on `parent_series_id` so deleting a parent series removes descendants; library cascade still works if children deleted first or DB supports it — verify SQLite FK order; if problematic, null parent first then delete by path prefix in scanner.
2. Index: `(library_id, parent_series_id)`, keep existing `path` index.
3. Optional denormalized `depth: INTEGER NOT NULL DEFAULT 0` for sort/UI (recomputed on scan from path segments under library). Nice-to-have; can derive from path if skipped.
4. No change to `media.series_id` semantics.

Entity updates:

- `series::Model`: `parent_series_id: Option<String>`
- SeaORM relations: self-ref `belongs_to` parent, `has_many` children
- `LibraryPattern::Nested` in `crates/models/src/shared/enums.rs` (`NESTED`)
- `library_config::is_collection_based()` unchanged; add `is_nested()` helper

## Scanner / core

**Files (primary):**

- `core/src/filesystem/scanner/walk.rs` — nested discovery + series walk depth
- `core/src/filesystem/scanner/library_scan_job.rs` — branch on Nested; after inserts, set `parent_series_id` from path map
- `core/src/filesystem/scanner/series_scan_job.rs` — Nested: direct media only
- `core/src/filesystem/scanner/utils.rs` / `series/builder.rs` — accept optional parent id
- `core/src/filesystem/media/builder.rs` and any pattern match exhaustiveness
- Integration fixtures: `core/integration-tests/tests/utils.rs` + new nested tree cases in `scanner.rs`

**Algorithm sketch for `walk_library` Nested:**

1. Collect candidate dirs (all non-ignored directories under library).
2. Classify media dirs (direct media).
3. Expand to series path set via ancestors.
4. Diff vs DB series paths → create / visit / missing / recover (same as today).
5. Build `HashMap<path, id>` including newly created IDs; assign parents:
   - sort creates by path depth ascending so parents exist first
   - `parent_path = path.parent()` while under library; lookup map

**Series walk Nested:** `max_depth = 1` for files; skip subdirectories that are known child series paths (or simply never recurse into subdirs for media — children scanned as their own series jobs).

**Parent link repair:** on every nested library scan, recompute `parent_series_id` for all series in library from current path set (idempotent).

## GraphQL API

**Object** (`crates/graphql/src/object/series.rs`):

- `parent: Option<Series>`
- `children(filter, orderBy, pagination): …` (direct children only)
- `ancestors: [Series!]!` (root → … → parent; or leaf-up — document order: root-first)
- `childCount: Int!`
- `mediaCount` — keep as **direct** media only (current semantics)
- `descendantMediaCount: Int!` (rollup; efficient SQL subquery or recursive CTE)
- Optional: `media(includeDescendants: Boolean = false)` — if expensive, ship count + separate query first

**Filter** (`filter/series.rs`):

- `parentSeriesId: StringFilter` / `isRoot: Boolean` (`parent_series_id IS NULL`)
- Do not break existing library series list (defaults to all series flat, or roots-only when `isRoot` — **default remains all series** for backward compat; UI for nested libraries requests `isRoot: true` or `parentSeriesId`)

**Library config input/output:** accept `NESTED` pattern.

Regenerate client: `packages/graphql` codegen after schema change.

## Web UI (`packages/browser`)

1. **Library pattern picker** — `LibraryPattern.tsx`, `schema.ts` type guard, `LibraryReview.tsx`, `PatternDisplay.tsx`: third option “Nested / hierarchical” with short explanation + doc link.
2. **Library series tab** (`LibrarySeriesScene` + cards/table):
   - If library is Nested: show **root series** by default; expandable children or drill-in navigation (`?parent=` or route `/libraries/:id/series` → child list).
   - Prefer drill-in + breadcrumbs over huge expand-all trees for performance.
3. **Series layout** (`SeriesLayout` / `SeriesHeader`):
   - Breadcrumbs: Library → ancestor series… → current
   - Sub-series section/grid when `childCount > 0`
   - Books tab: direct media only; show rollup count + optional “Show books in sub-series” toggle if `media(includeDescendants)` lands; else link into children only for v1 minimum.
4. **Global `/series` search:** keep flat list (path or resolved name); optional breadcrumb subtitle `Author / Mistborn`.
5. **i18n** strings for pattern name and empty states.

Expo: no nested navigation required in v1.

## Docs

- `docs/content/docs/guides/fundamentals/libraries.mdx` — Nested pattern + tree example (Author → Mistborn).
- `docs/content/docs/guides/fundamentals/series.mdx` — series can nest under Nested libraries; still path-defined.
- Note #280 addressed for Nested pattern; #288 still open.

## Failure modes & edge cases

| Case                                       | Behavior                                                                                                                                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Switch SeriesBased → Nested                | Rescan rebuilds parent links; may **add** intermediate series rows; media `series_id` may move from leaf-only flat siblings to correct owners — expect media reassignment by path on rescan |
| Switch Nested → SeriesBased                | Parents null; intermediate series without direct media become empty → missing/removed like today if no media; leaves remain                                                                 |
| Series with only children, no direct media | Valid; `mediaCount=0`, `childCount>0`, books tab empty + sub-series UI                                                                                                                      |
| Deep trees                                 | No hard max depth in v1; watch scan memory; pagination on children                                                                                                                          |
| Path case/normalization                    | Keep existing path utils; parent resolution must use same normalization as series `path`                                                                                                    |
| Concurrent parent delete                   | FK + scan missing handling                                                                                                                                                                  |
| `series.json` on intermediate folders      | Still load via existing builder when series created                                                                                                                                         |
| Smart lists `BySeries`                     | Unchanged flat grouping by `series_id` (direct membership)                                                                                                                                  |
| Favorites / tags / metadata                | Remain on each series node independently                                                                                                                                                    |
| Root library media                         | If Nested library root has direct media, create series at library path (parent null), same as SeriesBased root case                                                                         |

## Implementation order

1. **Migration + models** — `parent_series_id`, `LibraryPattern::Nested`, relations, entity helpers (`find_children`, `find_roots`).
2. **Scanner Nested path** — discovery, parent assignment, series walk direct-only; unit/integration tests with Author/Mistborn/loose-file fixture.
3. **GraphQL** — parent/children/ancestors/counts/filters; update library config enum surface; codegen.
4. **Web** — pattern UI, library series roots+drill-in, series breadcrumbs + children section.
5. **Docs** — libraries + series guides.
6. **Regression** — existing Series/Collection integration tests must stay green unchanged.

## Validation

- Integration: Nested temp library fixture matching docs Example 1 → assert series count, parent links, media `series_id` placement (`Elantris` under Author, Mistborn books under Mistborn).
- Integration: ignore rules still exclude branches from series set.
- Integration: SeriesBased/CollectionBased counts unchanged on same trees as today.
- Manual: create Nested library in UI, scan, navigate breadcrumbs, open child series, read book, favorite parent and child independently.
- GraphQL: query roots, children pagination, `descendantMediaCount` correctness after adding/removing nested book.
- Lint/typecheck: Rust workspace + browser package after codegen.

## Key files

| Area    | Paths                                                                                                                                          |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema  | `crates/migrations/src/*`, `crates/models/src/entity/series.rs`, `shared/enums.rs`, `library_config.rs`                                        |
| Scanner | `core/src/filesystem/scanner/walk.rs`, `library_scan_job.rs`, `series_scan_job.rs`, `utils.rs`, `series/builder.rs`                            |
| API     | `crates/graphql/src/object/series.rs`, `filter/series.rs`, `query/series.rs`, `input/library.rs`                                               |
| Web     | `packages/browser/.../LibraryPattern.tsx`, `schema.ts`, `PatternDisplay.tsx`, `LibrarySeriesScene.tsx`, `SeriesLayout.tsx`, `SeriesHeader.tsx` |
| Docs    | `docs/content/docs/guides/fundamentals/{libraries,series}.mdx`                                                                                 |
| Tests   | `core/integration-tests/tests/{utils,scanner}.rs`                                                                                              |

## Open items (non-blocking)

- Exact copy for pattern name in UI (“Nested” vs “Hierarchical”) — product polish.
- Whether `media(includeDescendants)` ships in same PR as counts-only rollup.
- SQLite self-referential FK delete strategy verification during migration implementation.
