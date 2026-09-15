# vAmigaWeb WASM (vendored)

The Amiga core behind `scenes/book/reader/retro/emulators/amiga.ts`.

|                |                                                    |
| -------------- | -------------------------------------------------- |
| Upstream       | https://github.com/vAmigaWeb/vAmigaWeb             |
| Version        | 4.3.6 (built files from https://vamigaweb.github.io) |
| Authors        | mithrendal, Dirk W. Hoffmann                       |
| Licence        | GPL-3.0 — see `COPYING`                            |

`vAmiga.js` and `vAmiga.wasm` are the published Emscripten build. They must stay
together: the glue resolves the WASM relative to its own script URL.

Stump itself is MIT. vAmigaWeb is GPL-3.0 and is distributed here under that
licence, with its full text in `COPYING`. Swapping in a different core means
touching only `emulators/amiga.ts` — nothing else imports these files.

Kickstart ROMs are **not** bundled. Place `kick33180.A500` (1.2) and
`kick34005.A500` (1.3) in `STUMP_FIRMWARE_DIR` (default `{config_dir}/firmware`).

## Upgrading

Copy the next `vAmiga.js` / `vAmiga.wasm` from a vAmigaWeb release or
https://vamigaweb.github.io and re-check `amiga.ts`: it drives the exported
C API (`wasm_loadFile`, `wasm_key`, `wasm_joystick`, `wasm_draw_one_frame`)
directly, without the upstream jQuery UI.
