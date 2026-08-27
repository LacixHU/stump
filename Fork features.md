# Fork features

This fork of [Stump](https://github.com/stumpapp/stump) adds the following features and improvements on top of `upstream/nightly`.

## Text-to-speech

- Server-side TTS using [Piper](https://github.com/rhasspy/piper)
- Client TTS controls with rate and pitch adjustments
- Sentence-level playback with prefetch of the next sentence for continuous read-aloud
- Short gap between sentences for smoother continuity
- Hungarian voice pronunciation aid: common English names and foreign words are rewritten to Hungarian phonetics before Piper speaks (not a translator)

## Access control

- Library access is **opt-in** instead of opt-out
- Users only see libraries they have been granted
- Library settings button is shown only to users with **Manage library** permission

## Libraries and series

- Nested library pattern for hierarchical series
- Parent series with child series get a **Series** tab (like libraries), plus **Books** and **Files**
- Opening a parent series lands on the Series tab; leaf series still open on Books
- Series tab shows **sub-series and direct books** together (series first), in grid or list view
- Books tab is **books only** (no nested series cards mixed in)
- Book search within the library series view (results toggle alongside the alphabet selector)

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
- Android address-bar page centering
- Zoom clipping fix
- Image scaling defaults to Auto

## Server

- TLS support
- Apalis job worker runs alongside the HTTP server and shuts down gracefully
- Safer PDF processing and server routing

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

### PDF rendering (same as in original repository)

| Key                   | Env                         | Default | Description                                      |
| --------------------- | --------------------------- | ------- | ------------------------------------------------ |
| `pdf_render_dpi`      | `STUMP_PDF_RENDER_DPI`      | `150`   | DPI when rendering PDF pages                     |
| `pdf_max_dimension`   | `STUMP_PDF_MAX_DIMENSION`   | `1200`  | Max width or height (px) for rendered pages      |
| `pdf_render_format`   | `STUMP_PDF_RENDER_FORMAT`   | `webp`  | Image format: `webp`, `png`, or `jpeg`           |
| `pdf_cache_pages`     | `STUMP_PDF_CACHE_PAGES`     | `true`  | Cache rendered PDF pages on disk                 |
| `pdf_prerender_range` | `STUMP_PDF_PRERENDER_RANGE` | `5`     | Pages to pre-render before/after the current one |
| `pdf_high_quality`    | `STUMP_PDF_HIGH_QUALITY`    | `true`  | Higher-quality rendering (slower)                |

## PDF reader

- Centered loading spinner while the file downloads

## UI polish

- Library create/update form and settings context cleanup
- Error-boundary “Go Home” navigation fix
- Reader image error fallback
- Close buttons on comics and EPUB settings dialogs
