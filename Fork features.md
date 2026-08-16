# Fork features

This fork of [Stump](https://github.com/stumpapp/stump) adds the following features and improvements on top of `upstream/nightly`.

## Text-to-speech

- Server-side TTS using [Piper](https://github.com/rhasspy/piper)
- Client TTS controls with rate and pitch adjustments

## Access control

- Library access is **opt-in** instead of opt-out
- Users only see libraries they have been granted

## Libraries

- Nested library pattern for hierarchical series

## Thumbnails

- Versioned thumbnail URLs
- More reliable thumbnail upload and image loading

## EPUB reader

- Improved table-of-contents navigation, including root-relative hrefs
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

## UI polish

- Library create/update form and settings context cleanup
- Error-boundary “Go Home” navigation fix
- Reader image error fallback
- Close buttons on comics and EPUB settings dialogs
