# Retro computer libraries (C64 / Spectrum / Amiga)

## Goal

Add a **Retro** library section to Stump for single-file disk/tape images. Catalog them like other media, fetch online metadata + covers, and **play in the browser** via WASM emulators. The server serves disk images and optional firmware bytes only—it does **not** run emulators or stream video.

## Decisions (locked)

| Topic                  | Choice                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| Playback               | In-browser WASM emulators                                                                |
| Platforms (MVP)        | C64 + ZX Spectrum + Amiga                                                                |
| Library model          | `LibraryType::Retro` + nested folders                                                    |
| Multi-disk             | One **Series** = game; each disk/tape = **Media**                                        |
| Metadata               | Lemon64 (C64), World of Spectrum–style (Spectrum), parallel Amiga source                 |
| Covers                 | Scraper `cover_url` → download into `media.thumbnail_path` on match apply                |
| Amiga Kickstart        | Server-wide `STUMP_FIRMWARE_DIR`; never bundle ROMs                                      |
| Saves                  | Browser IndexedDB; no server sync                                                        |
| Server emulator stream | **Out of scope**                                                                         |
| Play auth              | **Library access only** (same as page read); Download still needs `DownloadFile`         |
| Platform storage       | **No new DB column**; derive at runtime + path-hint tags when ambiguous                  |
| Extensions scope       | Registered **globally** in `ContentType` (like PDF); auto metadata only for `RETRO` libs |

## Why not server-side emulator + picture stream

Stump has no A/V session runtime (no WebRTC/HLS, no input channel, no process isolation). Server VICE/FS-UAE would need per-session processes, encode + input reverse channel, and much higher CPU. In-browser play keeps Stump as catalog + file server; revisit streaming only if thin clients become a hard requirement.

## Architecture

```
NAS disk image
  → Scanner (extension-first ContentType + RetroProcessor)
  → Media (pages = -1, size, hash)
  → Optional metadata job (platform-specific provider)
  → cover_url download → thumbnail_path

Web UI Play
  → GET /api/v2/media/{id}/play-file   (library access, inline)
  → WASM emulator (lazy-loaded)
  → series siblings for disk swap
  → IndexedDB save states

Admin
  → STUMP_FIRMWARE_DIR
  → GET /api/v2/firmware/{name}        (auth + library-capable users; path-traversal safe)
```

### Existing hooks to reuse

| Concern              | Existing                                                                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Full file bytes      | `serve_media::serve_media_file` + `GET .../media/{id}/file` — **requires DownloadFile**; Play needs a **sibling** path without that permission |
| `pages = -1`         | Already documented on `media.pages`                                                                                                            |
| Nested series        | `LibraryPattern::Nested` + `parent_series_id`                                                                                                  |
| Metadata trait       | `MetadataProvider` in `crates/integrations/metadata`                                                                                           |
| Reader routing       | `BookRouter.tsx` (`:id/reader`, `epub-reader`, `pdf-reader`) → add `:id/retro-player`                                                          |
| Config external path | Pattern like `PDFIUM_PATH` / `STUMP_PIPER_*`                                                                                                   |

### Folder layout (convention)

```text
/Retro/
  C64/Last Ninja/Last Ninja Side A.d64
  C64/Last Ninja/Last Ninja Side B.d64
  Spectrum/Manic Miner/manic.tap
  Amiga/Lemmings/Lemmings.adf
```

Path segments `c64`, `commodore`, `spectrum`, `zx`, `amiga` are **hints** for platform when extension is ambiguous.

### Formats (MVP)

| Platform | Extensions                                               | Notes       |
| -------- | -------------------------------------------------------- | ----------- |
| C64      | `d64`, `t64`, `prg`, `g64` (opt), `tap` if hint says C64 |             |
| Spectrum | `tzx`, `z80`, `sna`, `tap` if hint says Spectrum         |             |
| Amiga    | `adf`, `adz` (opt)                                       | `hdf` later |

MIME: extension-first → `application/octet-stream` (or `application/x-d64`, etc.). Do **not** rely on `infer` (usually fails).

### Platform resolution (locked algorithm)

Shared helper in Rust + TS (`resolve_retro_platform(path, extension)`):

1. Unique extension map: `d64|t64|prg|g64` → C64; `tzx|z80|sna` → Spectrum; `adf|adz` → Amiga.
2. If `tap` (or other dual-use): scan path segments (case-insensitive) for `c64|commodore` → C64; `spectrum|zx|sinclair` → Spectrum.
3. Else if series already has any media with known platform → inherit.
4. Else default **C64** for bare `.tap` and log a scan warning (document folder naming).
5. Persist disambiguation as media tag `platform:c64|spectrum|amiga` only when step 2–3 applied or default used for ambiguous ext—optional but helps UI; UI may also re-derive.

Do **not** add a `media.platform` column in MVP.

## Implementation tasks

### 1. ContentType + Retro processor

**Files:** `core/src/filesystem/content_type.rs`, `core/src/filesystem/media/format/retro.rs` (new), `core/src/filesystem/media/process.rs`, `common.rs` support checks.

- Add ContentType variants (or one `RETRO` + extension helpers).
- `from_extension` must win over failed `infer` for these paths.
- `ProcessorType::Retro` + `RetroProcessor`:
  - `process`: `pages = -1`, size from metadata, **full-file** stump hash (files are small; sample-page hash N/A).
  - `process_metadata`: `None` or filename title only.
  - `get_page` / `get_page_count` / `analyze_page` / `get_page_content_types`: return clear `FileError` (not used for play).
- Wire `determine_processor` on extension list **before** mime fallback fails.
- Unit tests: each extension → processor; unknown stays unsupported.

### 2. Skip book-oriented jobs for retro media

- Thumbnail job: if `pages < 1`, **do not** call `get_page`; leave empty until cover apply or manual thumb.
- Analysis / dimension jobs: skip `pages < 1`.
- OPDS: acquisition link via file download only; no page links; avoid fake page counts in feeds (`core/src/opds/**`).

### 3. Models / GraphQL / client enums

- `LibraryType::Retro` in `crates/models/src/shared/enums.rs` (+ GraphQL regen, TS enums).
- `MediaType::Retro` (or Game) in metadata integrations `MediaType` for provider support lists.
- `MetadataProvider::{Lemon64, WorldOfSpectrum, /* Amiga */}` — Amiga name TBD behind trait (`LemonAmiga` or `HolAmiga`); no API token required if public HTML/JSON (credentials verify = soft OK).
- Library create UI: Retro option; default pattern Nested.

### 4. Play file + firmware HTTP

**Play file** (new):

- `GET /api/v2/media/{id}/play-file`
- Auth: `find_for_user` only (mirror `get_media_page`); **no** `DownloadFile`.
- Serve with `ServeFile` + `Content-Disposition: inline` (still fetchable as ArrayBuffer).
- Optional: restrict to retro extensions server-side so play-file cannot exfiltrate arbitrary books without DownloadFile—**lock this**: only allow if extension is in retro set (defense in depth).

**Download** unchanged: `GET .../file` + `DownloadFile` + `attachment`.

**Firmware:**

- Env/config: `STUMP_FIRMWARE_DIR` (PathBuf), default e.g. `{config_dir}/firmware`.
- `GET /api/v2/firmware/{file_name}` — authenticated user; resolve **only** basename under firmware dir (reject `..`, absolute paths); 404 if missing.
- Admin GraphQL or settings: list expected Kickstart names for chosen Amiga WASM; status “present/missing”.
- Never commit ROMs; document filenames required by pinned emulator.

### 5. Metadata providers + cover pipeline

- Implement providers behind existing `MetadataProvider` trait (`search_series` primary for games; `search_media` can alias or return disk-level if needed).
- **Series-first matching**: game folder = series title query; apply series metadata + optional same cover on all media in series.
- Lemon64 / WoS: no stable public API guaranteed—implement with:
  - HTTP client + HTML or documented endpoints
  - **Fixture-based unit tests** (saved HTML/JSON snapshots)
  - Rate limit → `MetadataFetchStatus::RateLimited`
  - Feature/config enable per provider
  - Respect ToS; user-agent; backoff
- **Cover gap today:** `ExternalMediaMetadata.cover_url` is **not** applied to thumbnails in `apply.rs`. Add post-apply step (retro or general): if `cover_url` Some and media/series has no `thumbnail_path`, `download_image` → write under thumbnails dir → set `thumbnail_path` / `thumbnail_meta`.
- Prefer applying at **series** level then cascade first-book thumb pattern already used for series thumbs.
- Auto-fetch only when library type is Retro and provider has overlap.

### 6. Frontend catalog

- `patterns.ts`: `RETRO_EXTENSIONS`, `resolveRetroPlatform(extension, path?)`.
- Overview: primary **Play** → `/books/:id/retro-player`; secondary Download if `DownloadFile`.
- Hide page counts for `pages < 1`; show platform badge.
- Series view: list disks ordered by name; Play opens first disk (or last-played local).

### 7. Retro player UI

- Route: `packages/browser/src/scenes/book/BookRouter.tsx` → `:id/retro-player`.
- Lazy-load platform bundles so comic routes never pull WASM.
- Shell:
  - Resolve platform → load emulator module.
  - `fetch(play-file URL)` with credentials → `ArrayBuffer`.
  - Canvas + audio; keyboard/gamepad; fullscreen.
  - Disk menu: series media list; hot-swap if emulator API allows, else reboot with new image.
  - Save/load state: IndexedDB key `stump-retro-save:{userId}:{mediaId}:{slot}`.
  - Amiga: fetch firmware files first; if 404, show setup instructions (no Play).
- Pin concrete WASM builds in `package.json` / vendored assets (implementer picks maintained VICE/JSSpeccy/vAmiga-class ports); record licenses in NOTICE.
- Progress: do **not** spam `current_page`; optional “Mark complete” via existing finish progress mutation only.

### 8. Docs

- Library layout, extensions, `.tap` folder naming.
- Firmware dir + Kickstart filenames.
- Legal: user-supplied games/BIOS only.
- Permissions: Play vs Download.

## Data flows

### Scan

1. Walk nested library → series per game folder.
2. Each supported disk → `RetroProcessor` → media row `pages=-1`.
3. Resolve platform; optional `platform:*` tag.
4. Queue metadata if Retro + provider configured.

### Play

1. User opens media with retro extension → Retro player.
2. `play-file` authorized via library inclusion.
3. WASM mounts buffer; user plays.
4. Multi-disk: pick sibling → new fetch → mount/reboot.
5. Save state → IndexedDB.

### Metadata

1. Search by series name (cleaned filename).
2. Candidate review or auto-apply threshold.
3. Title/summary/year/genres + cover download → thumbs.

## Failure modes

| Case                        | Behavior                                                                     |
| --------------------------- | ---------------------------------------------------------------------------- |
| Ambiguous `.tap`            | Path hint → else inherit series → else C64 + warning                         |
| Scraper down / HTML change  | Filename title; status Failed/RateLimited; fixtures catch parse breaks in CI |
| Missing Kickstart           | Catalog OK; Play blocked with config message                                 |
| `play-file` on non-retro    | 400/403                                                                      |
| User without library access | 404 discreet (existing pattern)                                              |
| User without DownloadFile   | Play works; Download hidden                                                  |
| WASM OOM / bad image        | Toast + Download if permitted                                                |
| Thumbnail job on pages=-1   | No-op (no get_page)                                                          |
| Cover download fail         | Metadata text still applied; placeholder platform icon in UI                 |

## Out of scope (MVP)

- Server-side emulation / video streaming
- Server-synced save states
- IPF/CAPS, WHDLoad packs, HDF
- Netplay / mobile control polish
- Bundled games or BIOS
- `media.platform` DB column
- OPDS “read” as emulator

## Validation

- Fixture library: nested C64 (multi-disk), Spectrum, Amiga → correct series/media counts, `pages=-1`.
- Create library `RETRO`; scan; GraphQL lists items.
- User **without** `DownloadFile` can Play; cannot hit `/file`.
- User **without** library inclusion cannot `play-file` or firmware.
- `play-file` rejected for `.cbz`.
- Thumbnail generate job does not error-spam on retro media.
- Metadata: fixture HTML → candidate + cover written to thumbnail path (mock HTTP).
- Play smoke: one title per platform (Amiga with local Kickstart in firmware dir).
- Multi-disk swap UI lists siblings.
- Save state survives reload.
- Comic/EPUB/PDF routes unchanged; no WASM on those chunks.
- `cargo test` / processor unit tests; prettier/fmt on touched files.

## Key files

```
crates/models/src/shared/enums.rs
crates/integrations/metadata/src/{provider,providers,types,lib}.rs
core/src/filesystem/content_type.rs
core/src/filesystem/media/process.rs
core/src/filesystem/media/format/retro.rs          # new
core/src/filesystem/image/thumbnail/generate.rs    # skip pages<1
core/src/filesystem/metadata/apply.rs              # cover_url → thumb
core/src/config/stump_config.rs                    # STUMP_FIRMWARE_DIR
apps/server/src/routers/api/v2/media.rs            # play-file
apps/server/src/routers/api/v2/firmware.rs         # new
apps/server/src/utils/serve_media.rs               # shared serve helper
packages/client/src/utils/patterns.ts
packages/browser/src/scenes/book/BookRouter.tsx
packages/browser/src/scenes/book/reader/RetroPlayerScene.tsx  # new
packages/sdk/src/controllers/media-api.ts
```

## Implementation order

1. ContentType + RetroProcessor + scan fixtures + skip thumbs/analysis for `pages < 1`
2. `LibraryType::Retro` + UI type + patterns + hide pages
3. `play-file` endpoint (retro-only) + Download unchanged
4. Retro player shell + **C64** WASM path
5. Spectrum + Amiga WASM + `STUMP_FIRMWARE_DIR` + firmware route
6. Multi-disk menu + IndexedDB saves
7. Metadata providers + cover download on apply
8. OPDS acquisition-only behavior + docs + regression

## Implementer notes (pinned defaults, not user choices)

- Default bare `.tap` → C64; document `Spectrum/` folder naming.
- Prefer series-level metadata match for multi-disk games.
- Hash entire file for retro (not page samples).
- Pin WASM versions explicitly; code-split per platform.
- Amiga metadata: first workable automatable source behind trait; if all fragile, ship Lemon64+WoS and Amiga filename-only with provider stub returning empty (must not block play).
- If Lemon64/WoS require brittle HTML scrape, keep behind config flag default-on for Retro libraries only.
