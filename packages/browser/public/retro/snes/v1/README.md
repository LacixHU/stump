# Snes9x (vendored)

The SNES core behind `scenes/book/reader/retro/emulators/snes.ts`.

> **Snes9x is licensed for non-commercial use only** (see `COPYING`: "for non-commercial
> purposes", "freeware for PERSONAL USE only"). It is not an open-source licence, and it is not
> compatible with selling, or commercially redistributing, a build of Stump that contains it.
> Remove `public/retro/snes/` and the `snes` platform before doing either.

|             |                                                                                      |
| ----------- | ------------------------------------------------------------------------------------ |
| Upstream    | https://github.com/snes9xgit/snes9x                                                  |
| Build       | `@wasm-gaming/snes9x-wasm@0.1.1` (https://github.com/wasm-gaming/snes9x-wasm), MIT   |
| Files       | `snes9x.js` (Emscripten glue, `-sMODULARIZE`), `snes9x.wasm`                         |
| Core        | Snes9x, non-commercial licence — see `COPYING`                                       |
| Host        | `emulators/snes.ts` in Stump (MIT); the package's own JS SDK is **not** used         |

| File          | SHA-256                                                            |
| ------------- | ------------------------------------------------------------------ |
| `snes9x.js`   | `e057b8fab54fe99c4498932fe793d8458c62979c31b4dc5f1f2ed27f1f3ce2bb` |
| `snes9x.wasm` | `9a5289818a0160cc986037c93c70794c798ff16dbe9b2671f443cccb9691f597` |

Both files are byte-for-byte what the npm tarball ships in `dist/snes9x/`. Keep them together.

## Why Stump has its own host

The package's SDK uses `AudioWorklet` and the Origin Private File System, both of which need a
secure context, and Stump is usually served over plain HTTP on a LAN. `snes.ts` drives the
core's flat C exports itself (a ScriptProcessor for audio, IndexedDB for cartridge saves) and
follows the SDK's frame-pacing logic. There is no iframe: the core is a plain factory
(`createSnes9xModule`), so every play session gets its own instance.

Exports `snes.ts` relies on, from the shim in the wasm-gaming package (`scripts/shim/s9x_shim.cpp`):
`_s9xwasm_setup`, `_s9xwasm_load_rom`, `_s9xwasm_reset`, `_s9xwasm_exec`, `_s9xwasm_skip_render`,
`_s9xwasm_audio_ptr`, `_s9xwasm_frame_rgba`, `_s9xwasm_frame_width`, `_s9xwasm_frame_height`,
`_s9xwasm_framerate_micro`, `_s9xwasm_input`, `_s9xwasm_state_size`, `_s9xwasm_state_save`,
`_s9xwasm_state_load`, `_s9xwasm_sram_ptr`, `_s9xwasm_sram_size`, plus `HEAPU8`, `HEAP16`,
`_malloc` and `_free`.

## Versioning

`/retro/*` is served `immutable` for a year and the files are not hashed. A new build goes in a
new directory (`v2/`) and the asset constant in `snes.ts` moves with it.

## Upgrading

Copy `snes9x.js` and `snes9x.wasm` from a newer package's `dist/snes9x/` into a new `vN/`, then
re-check that every export listed above still exists and that `_s9xwasm_input`'s bit layout
(`b y select start up down left right a x l r`, bit 0 upwards) has not changed.

No BIOS is needed and none is bundled. Game ROMs are never bundled.
