# js-dos 6.22 / wdosbox (vendored)

The DOS core behind `scenes/book/reader/retro/emulators/dos.ts`.

|             |                                                           |
| ----------- | --------------------------------------------------------- |
| Upstream    | https://github.com/caiiiycuk/js-dos (branch `6.22`)       |
| npm         | `js-dos@6.22.60`                                          |
| DOSBox port | https://github.com/dreamlayers/em-dosbox                  |
| Wrapper     | ISC (`js-dos.js`)                                         |
| DOSBox WASM | GPL-2.0 — see `COPYING` (`wdosbox.js`, `wdosbox.wasm.js`) |

`js-dos.js` loads `wdosbox.js`, which compiles `wdosbox.wasm.js` (raw WASM bytes, js-dos 6.22 filename). Keep these three together.

Stump itself is MIT. DOSBox is GPL-2.0 and is distributed here under that licence. Swapping in a different core means touching only `emulators/dos.ts`.

IBM BIOS ROMs are **not** bundled. DOSBox emulates the machine without user-supplied firmware.

## Upgrading

Copy `js-dos.js`, `wdosbox.js` and `wdosbox.wasm.js` from `js-dos@6.22.x` `dist/` (rename `wdosbox.wasm` → `wdosbox.wasm.js` if the package ships a `.wasm`). Re-check `dos.ts`: it uses `Dos(canvas).then(({ fs, main }) => …)` and `ci.simulateKeyEvent`.

`wdosbox.js` is patched so the emscripten module exposes `SDL` and `Asyncify` (`Module["SDL"]=SDL;Module["Asyncify"]=Asyncify` before `return WDOSBOX`). Save/load needs those to pause audio and wait until the main loop is idle. Re-apply that line after upgrading.
