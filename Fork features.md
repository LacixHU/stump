# Fork features

**Fork version:** 0.1.7  
**Based on:** [Stump](https://github.com/stumpapp/stump) `upstream/nightly`

This fork adds the following features and improvements on top of `upstream/nightly`. See [Retro computer libraries](docs/content/docs/guides/features/retro-libraries.mdx) and [server TTS](docs/content/docs/guides/features/server-tts.mdx) for setup guides.

## Text-to-speech

- Server-side TTS using [Piper](https://github.com/rhasspy/piper)
- Gated by the **Server TTS** permission (`ACCESS_SERVER_TTS`); other users keep browser/OS voices
- Client TTS controls with rate and pitch adjustments
- Sentence-level playback with prefetch of the next sentence for continuous read-aloud
- Short gap between sentences for smoother continuity
- Hungarian voice pronunciation aid: common English names and foreign words are rewritten to Hungarian phonetics before Piper speaks (not a translator)

## Access control

- Library access is **opt-in** instead of opt-out
- Users only see libraries they have been granted
- Library settings button is shown only to users with **Manage library** permission
- The server owner always has access to every library

## Libraries and series

- Nested library pattern for hierarchical series
- Parent series with child series get a **Series** tab (like libraries), plus **Books** and **Files**
- Opening a parent series lands on the Series tab; leaf series still open on Books
- Series tab shows **sub-series and direct books** together (series first), in grid or list view
- Books tab is **books only** (no nested series cards mixed in)
- Book search within the library series view (results toggle alongside the alphabet selector)
- Go-up controls from book overview and nested series views to the parent series or library

## File explorer

- Create folders from the explorer header
- Rename or delete a file or folder from the right-click menu
- Drag-and-drop book files onto the explorer to upload into the current folder
- Renames and deletes update matching library records and enqueue a scan
- Create/rename/delete require **Manage library**; upload also requires **Upload file** and `enable_upload`

## Retro computer libraries

Catalog and play classic computer disk, tape, and program images in the browser. The server only serves files and optional firmware — it does **not** run emulators or stream video. Create a library with type **Retro** (nested folders are the default pattern).

See [Retro computer libraries](docs/content/docs/guides/features/retro-libraries.mdx) for formats, controls, firmware, and OPDS notes.

### Platforms and formats

| Platform     | Core                                                                | Extensions                                    |
| ------------ | ------------------------------------------------------------------- | --------------------------------------------- |
| Commodore 64 | [c64-ready](https://www.npmjs.com/package/c64-ready) (MIT)          | `d64`, `t64`, `prg`, `g64`, `tap` (path hint) |
| ZX Spectrum  | [JSSpeccy 3.2](https://github.com/gasman/jsspeccy3) (GPL-3.0)       | `tzx`, `z80`, `sna`, `tap` (path hint)        |
| Amiga        | [vAmigaWeb 4.3.6](https://github.com/vAmigaWeb/vAmigaWeb) (GPL-3.0) | `adf`, `adz`                                  |
| DOS          | [js-dos 6.22](https://js-dos.com) / em-dosbox (GPL-2.0)             | `img`, `ima`, `exe`, `com`, `dosz`            |

`.tap` is used by both C64 and Spectrum; platform is resolved from path segments, then sibling media, then C64. Do **not** use `.zip` for DOS — that extension is already comic/CBZ; rename a game-folder zip to `.dosz`.

### Shared player

- **Play** vs **Download**: play is library access only; download still requires **Download file**
- **Virtual keyboard** docks under the canvas (inside fullscreen) with per-platform layouts (C64 breadbin, Spectrum 40-key, Amiga A500, PC 101)
- **On-screen stick** (not four direction buttons) plus fire and extra keys; **Edit overlay** (Manage library) writes series-folder `controls.json`
- USB/Bluetooth **gamepad** is the same stick as the overlay (D-pad or left analog, face button to fire)
- **Instant** vs **Authentic** loading speed (C64 disk inject/warp, Spectrum tape traps, Amiga floppy warp)
- **Reset** restarts the machine and reloads the game without destroying the session
- Multi-disk titles: insert a sibling image without rebooting
- **Mouse sensitivity** for relative mouse (Amiga and DOS)

### C64

- Instant load injects the first `.d64` program into RAM (disk stays in the drive for multi-load games); tapes and `.prg` always inject
- Mixed / keyboard / joystick input modes and joystick port selection
- Audio works off a non-HTTPS LAN origin (ScriptProcessor fallback) and unlocks on keydown as well as click

### ZX Spectrum

- Machines: Spectrum 128K (default), 48K, Pentagon 128
- Joystick-as-keys schemes: QAOP+Space, cursor, Sinclair 6–0 (no Kempston in this core)
- Instant tape traps with stall detection and warped fallback for custom loaders
- Spectrum ROMs are bundled (Amstrad permits emulator redistribution)
- **No save states** (the core cannot write a snapshot); Save/Load buttons are hidden

### Amiga

- Machines: A500 Kickstart 1.3 (default) / 1.2, and A1200 AGA Kickstart 3.1 / 3.0 when those ROMs are present
- Kickstart ROMs are **not** bundled; place them in `firmware_dir` (see Configuration)
- Joystick defaults to port 2; canvas mouse is port 1
- Touch/pen trackpad: finger drag moves the pointer (not under the finger); tap = left click; still long-press = right click. A real mouse keeps pointer-lock

### DOS

- `.img`/`.ima` mounted as `A:`; `.exe`/`.com` written to `C:` and run; `.dosz` zip extracted to `C:` (AUTOEXEC/START/matching EXE)
- No IBM BIOS required
- Canvas mouse is the DOS mouse; same touch trackpad gestures as Amiga
- Save states snapshot DOSBox memory and changed files on `C:`/`A:`

### Save states

- Stored **on the server**, one private slot per user per game (follows you across devices)
- C64, Amiga, and DOS can save/load; Spectrum cannot
- Written to `{config_dir}/save_states/{media_id}/{user_id}.savestate` (max **64 MiB**)
- Saving again asks before replacing the previous snapshot

### Covers and metadata

- Retro files have no internal pages; covers come from a **sidecar** image (`cover.jpg`, `folder.jpg`, …) or a **Wikipedia** Category:Video game covers lookup (platform subcategories for C64 / Spectrum / Amiga / MS-DOS)
- Sidecar always wins; scan (or thumbnail generation) copies/resizes into the thumbnail store
- Retro libraries without an explicit thumbnail config still get covers on scan
- Metadata providers: Lemon64 (C64), World of Spectrum, Lemon Amiga, Wikipedia (no API token)

## Thumbnails

- Versioned thumbnail URLs
- More reliable thumbnail upload and image loading
- Nested parent series use descendant books for the 3-cover stack

## Localization

- Broad browser UI internationalization (readers, navigation, filters, book/series/library scenes, settings, errors)
- English and Hungarian locale coverage for fork UI strings, including EPUB reader control tooltips

## Filtering and sorting

- Localized filter forms and ordering controls
- Additional media/series filter options (including age rating, extension, and status)
- More accurate title sorting via metadata title with fallback to base name

## EPUB reader

- Improved table-of-contents navigation, including root-relative hrefs
- Working chapters (contents) button
- Browser fullscreen on desktop
- Centered loading spinner while the file downloads
- Translated control tooltips (search, bookmark, read aloud, fullscreen), including Hungarian
- Paragraph and image alignment fixes
- Close button on the appearance settings dialog

## Image reader

- Pinch-to-zoom and pan/zoom
- Higher maximum zoom (2×)
- More forgiving tap-to-advance (slip-tolerant)
- 20% side tap zones on web (mobile browsers)
- Fast horizontal swipe at 1× zoom turns the page by direction; pinch/pan still used when zoomed in
- Android address-bar page centering
- Zoom clipping fix
- Image scaling defaults to Auto

## PDF reader

- Centered loading spinner while the file downloads

## Server

- TLS support
- Apalis job worker runs alongside the HTTP server and shuts down gracefully
- Safer PDF processing and server routing
- Authenticated firmware serving (`GET /api/v2/firmware/{file_name}`, basename only)

## Configuration (`Stump.toml`)

These extra keys can be set in `Stump.toml` (in the config directory) or as environment variables.

### TLS

HTTPS for the HTTP listener. When `tls_enabled` is `true`, both `tls_cert_path` and `tls_key_path` are required.

| Key             | Env                   | Default | Description                                  |
| --------------- | --------------------- | ------- | -------------------------------------------- |
| `tls_enabled`   | `STUMP_TLS_ENABLED`   | `false` | Serve HTTPS                                  |
| `tls_cert_path` | `STUMP_TLS_CERT_PATH` | —       | PEM certificate chain (e.g. `fullchain.pem`) |
| `tls_key_path`  | `STUMP_TLS_KEY_PATH`  | —       | PEM private key                              |

```toml
tls_enabled = true
tls_cert_path = "/etc/ssl/certs/fullchain.pem"
tls_key_path = "/etc/ssl/private/privkey.pem"
```

### Server TTS (Piper)

See [server TTS](docs/content/docs/guides/features/server-tts.mdx) for setup. Voices are `.onnx` + matching `.onnx.json` files.

| Key                    | Env                          | Default                   | Description                         |
| ---------------------- | ---------------------------- | ------------------------- | ----------------------------------- |
| `enable_server_tts`    | `STUMP_ENABLE_SERVER_TTS`    | `false`                   | Master switch for server TTS        |
| `piper_path`           | `STUMP_PIPER_PATH`           | `piper` (on `PATH`)       | Path to the Piper executable        |
| `piper_voices_dir`     | `STUMP_PIPER_VOICES_DIR`     | `{config_dir}/tts/voices` | Directory of Piper voice models     |
| `piper_default_voice`  | `STUMP_PIPER_DEFAULT_VOICE`  | first voice found         | Voice id (filename without `.onnx`) |
| `server_tts_max_chars` | `STUMP_SERVER_TTS_MAX_CHARS` | `2000`                    | Max characters per TTS request      |

```toml
enable_server_tts = true
# piper_path = "/usr/local/bin/piper"
# piper_voices_dir = "/var/lib/stump/tts/voices"
# piper_default_voice = "en_US-lessac-medium"
```

### Retro firmware

User-supplied emulator firmware/BIOS. Files are never bundled with Stump. Served via authenticated `GET /api/v2/firmware/{file_name}` (basename only).

| Key            | Env                  | Default                 | Description                       |
| -------------- | -------------------- | ----------------------- | --------------------------------- |
| `firmware_dir` | `STUMP_FIRMWARE_DIR` | `{config_dir}/firmware` | Directory of Kickstart/BIOS files |

Amiga Kickstart basenames (no subfolders):

- `kick33180.A500` — Kickstart 1.2 (A500)
- `kick34005.A500` — Kickstart 1.3 (A500)
- `kick39106.A1200` — Kickstart 3.0 (A1200, optional)
- `kick40068.A1200` — Kickstart 3.1 (A1200, optional)

```toml
# firmware_dir = "/var/lib/stump/firmware"
```

### PDF rendering

| Key                          | Env                                  | Default | Description                                                      |
| ---------------------------- | ------------------------------------ | ------- | ---------------------------------------------------------------- |
| `pdf_render_dpi`             | `STUMP_PDF_RENDER_DPI`               | `150`   | DPI for rendering PDF pages                                      |
| `pdf_max_dimension`          | `STUMP_PDF_MAX_DIMENSION`            | `1200`  | Max width or height (px) for rendered pages                      |
| `pdf_render_format`          | `STUMP_PDF_RENDER_FORMAT`            | `webp`  | Image format: `webp`, `png`, or `jpeg`                           |
| `pdf_cache_pages`            | `STUMP_PDF_CACHE_PAGES`              | `true`  | Cache rendered PDF pages on disk                                 |
| **pdf_cache_max_size**       | **`STUMP_PDF_CACHE_MAX_SIZE`**       | `2GB`   | Max total size of the PDF page cache on disk                     |
| **pdf_cache_eviction_chunk** | **`STUMP_PDF_CACHE_EVICTION_CHUNK`** | `500MB` | Bytes removed per eviction pass when the cache is over the limit |
| `pdf_prerender_range`        | `STUMP_PDF_PRERENDER_RANGE`          | `5`     | Pages to pre-render before/after the current one                 |
| `pdf_high_quality`           | `STUMP_PDF_HIGH_QUALITY`             | `true`  | Higher-quality rendering (slower)                                |

## UI polish

- Library create/update form and settings context cleanup
- Error-boundary “Go Home” navigation fix
- Reader image error fallback
- Close buttons on comics and EPUB settings dialogs
