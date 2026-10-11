# N64Wasm (vendored)

The N64 core behind `scenes/book/reader/retro/emulators/n64.ts`.

|              |                                                                                          |
| ------------ | ---------------------------------------------------------------------------------------- |
| Upstream     | https://github.com/nbarkhina/N64Wasm (`dist/`, last upstream push 2025-02)               |
| Core         | https://github.com/libretro/parallel-n64 (ParaLLEl N64, built with Emscripten 2.0.7)     |
| Glue         | MIT (`n64wasm.js`, from N64Wasm) — see `COPYING`                                         |
| Core (wasm)  | GPL-2.0 (`n64wasm.wasm`) — see `COPYING`                                                 |
| Host page    | `player.html` + `player.js`, written for Stump (MIT); replaces upstream's UI             |

| File               | SHA-256                                                            |
| ------------------ | ------------------------------------------------------------------ |
| `n64wasm.js`       | `1db1dce5e356d1a1673d5dab6f73afd30bf4b69523c3292b1d44e33ff8f4d22e` |
| `n64wasm.wasm`     | `c829ac2ac2a620816a3906af1135c1203f606b92ae7a6e118ea8a90749f028ea` |
| `assets.zip`       | `72f8b414469d0b40630c82ca193b6f67dba906bd84ccc43991ee1ac3e4b900a2` |

`n64wasm.js`, `n64wasm.wasm` and `assets.zip` are byte-for-byte upstream. Keep them together.

## Why an iframe

N64Wasm is a page-level singleton: one global `Module`, one `callMain`, no way to stop it (upstream's "new ROM" reloads the page), and it owns its own WebGL2 canvas. Stump's player shares one canvas between every platform and stops an emulator by calling `destroy()`. So `n64.ts` mounts `player.html` in an iframe and removes the frame to stop, which also frees the 512 MB heap, the GL context and the audio graph.

`player.js` is the whole host: it defines `Module` and `window.myApp` (the object the compiled code calls back into), writes `assets.zip`, the ROM, `config.txt` and `cheat.txt` into the emulator's filesystem, drains the audio ring buffer, and exposes `window.stumpN64` to `n64.ts` (same origin, called directly).

Input goes through the core's "mobile" path (`neil_send_mobile_controls`: 14 button flags plus an analog x/y, once a frame). The core only runs that path while it sees no gamepad (`mymain.cpp`: `mobileMode && !sdlJoysticks[0].gamepadConnected`), so `player.js` hides gamepads from the frame (`navigator.getGamepads()` returns `[]`) and the host polls them instead. The frame is never focused (`pointer-events: none`), so the core's own SDL keyboard handling sees nothing either.

## Versioning

`/retro/*` is served `immutable` for a year and the files are not hashed. A new build of the core goes in a new directory (`v2/`) and `PLAYER_URL` in `n64.ts` moves with it.

## Upgrading

Copy `n64wasm.js`, `n64wasm.wasm` and `assets.zip` from upstream `dist/` into a new `vN/`, then re-check `player.js` against upstream `script.js` / `input_controller.js`:

- the order of the lines in `config.txt` (`WriteConfigFile`) — the core reads it positionally
- the callbacks the compiled code reaches for on `myApp` (`grep -o 'myApp[^;"]*' n64wasm.js`)
- the `_neil_*` exports used: `neil_send_mobile_controls`, `neil_set_buffer_remaining`, `neil_serialize`, `neil_unserialize`, `neil_reset`

No console BIOS or boot ROM is bundled or needed. Game ROMs are never bundled.
