# JSSpeccy 3.2 (vendored)

The ZX Spectrum core behind `scenes/book/reader/retro/emulators/spectrum.ts`.

|                |                                                                             |
| -------------- | --------------------------------------------------------------------------- |
| Upstream       | https://github.com/gasman/jsspeccy3                                         |
| Version        | 3.2 (released 2024-11-23)                                                   |
| Source archive | https://github.com/gasman/jsspeccy3/releases/download/v3.2/jsspeccy-3.2.zip |
| Author         | Matt Westcott                                                               |
| Licence        | GPL-3.0 — see `COPYING`                                                     |

These files are the unmodified contents of the release archive's `jsspeccy/` folder
(`jsspeccy-core.wasm.map` and the archive's `.DS_Store` files dropped). They must stay
together: the bundle resolves the worker, the WASM core, `roms/` and `tapeloaders/`
relative to its own script URL, so moving `jsspeccy.js` alone breaks the rest.

Stump itself is MIT. JSSpeccy is GPL-3.0 and is distributed here under that licence, with
its full text in `COPYING`. Swapping in a different core means touching only
`emulators/spectrum.ts` — nothing else imports these files.

## ROMs

`roms/` holds the Sinclair/Amstrad Spectrum ROMs shipped with JSSpeccy. Amstrad, which
holds the copyright, permits their redistribution as part of an emulator. Unlike the Amiga
Kickstart (user-supplied via `STUMP_FIRMWARE_DIR`), these need no setup.

## Upgrading

Download the next release archive, copy `jsspeccy/` over this directory, and re-check
`spectrum.ts`: it drives the emulator's Web Worker protocol
(`keyDown`/`keyUp`/`openTAPFile`/`reset`) directly, because the public `JSSpeccy()` API
exposes neither key injection nor raw tape bytes.
