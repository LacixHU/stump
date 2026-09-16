# Amiga mobile trackpad mouse

## Goal

On a phone/tablet, the Amiga playfield acts like Microsoft Remote Desktop: the on-screen pointer is **not** under the finger. Dragging a finger moves the Amiga mouse relatively; a tap is left click; a still long-press is right click.

Desktop mouse + pointer-lock stays as it is.

## Locked decisions

| Topic              | Choice                                                                                                                              |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Gestures           | Move = cursor only. Tap = left click. Long-press = right click. **No** click-and-drag, **no** RMB-hold for Amiga menus              |
| Scope              | Amiga only (`emulators/amiga.ts`). C64/Spectrum unchanged                                                                           |
| Activation         | `pointerType` `touch` or `pen` on the canvas. Real `mouse` pointers keep the existing path (Bluetooth mouse on an iPad still works) |
| Overlay            | Unchanged. Stick/buttons keep `pointer-events-auto`; empty canvas is the trackpad                                                   |
| Settings           | None. Always on for touch/pen                                                                                                       |
| Click-drag / menus | Out of scope (user choice). Workbench icon drag and hold-RMB menus will not work on a finger                                        |

## Gestures

One captured pointer at a time. Extra fingers on the canvas are ignored.

| Input                                      | Result                                                                                                                  |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Finger move past slop (~12 CSS px)         | `_wasm_mouse(1, dx, dy)` only. Cancel tap and long-press                                                                |
| Pointer up, never past slop, before 500 ms | Left click: button 1 down then up                                                                                       |
| Still for 500 ms                           | Right click: button 3 down then up. No left click on lift. Further movement of that pointer still only moves the cursor |
| Two taps                                   | Two left clicks (Workbench double-click; no special double-tap recognizer)                                              |
| `pointercancel` / blur                     | Drop the gesture; no click                                                                                              |

Do **not** request pointer lock for touch/pen.

## Wiring

Today `amiga.ts` listens to `mousemove` / `mousedown` / `mouseup` only, so a finger never moves the mouse. Compatibility mouse events after a touch would also `requestPointerLock` and click — those must be ignored.

1. Add a pure gesture helper `emulators/amiga-touch-mouse.ts` (no DOM globals besides types). It receives pointer down/move/up/cancel + now-ms, and returns commands: `{ type: 'move', dx, dy } | { type: 'click', button: 1 \| 3 }`.
2. Scale touch deltas like unlocked desktop mouse: client movement × `canvas.width / displayedWidth` (X) and `clip.height / displayedHeight` (Y), using the same `containPoint` display box as `amiga-video.ts`. Letterbox still counts as trackpad (do not drop moves the way unlocked desktop drops `containPoint === null`).
3. In `create()`:
   - `canvas` listeners: `pointerdown` / `pointermove` / `pointerup` / `pointercancel` (non-passive). `setPointerCapture` on down.
   - If `pointerType === 'mouse'`, leave existing mouse + pointer-lock handlers to do the work (do not also run the trackpad machine).
   - If `touch`/`pen`, run the helper; `preventDefault`; never call `requestPointerLock`.
   - Existing `mousedown`: skip when `event.sourceCapabilities?.firesTouchEvents` is true (Safari/Chrome compat clicks).
4. Add `touch-none` on the retro `<canvas>` in `RetroPlayerScene.tsx` so the page does not scroll/zoom under a drag.
5. Long-press timer via `setTimeout` in `amiga.ts` (helper is synchronous; pass `now` and let the caller schedule the 500 ms fire). Helper API should expose `longPressMs` and `slopPx` as constants.

vAmiga buttons stay as today: left = `1`, right = `3`, port `1`.

## Files

- `packages/browser/src/scenes/book/reader/retro/emulators/amiga-touch-mouse.ts` (new)
- `packages/browser/src/scenes/book/reader/retro/emulators/__tests__/amiga-touch-mouse.test.ts` (new)
- `packages/browser/src/scenes/book/reader/retro/emulators/amiga.ts` (pointer listeners, ignore synthetic mouse)
- `packages/browser/src/scenes/book/reader/RetroPlayerScene.tsx` (`touch-none` on canvas)

## Failure modes

- **Double click from compat mouse events** — ignore `firesTouchEvents` mousedown/up; `preventDefault` on touch pointers.
- **Stick + trackpad** — overlay already steals its own hits; canvas `setPointerCapture` so a trackpad drag that later crosses the stick does not start joystick.
- **Scroll/zoom** — `touch-none` + `preventDefault`.
- **Hover mouse on a phone with a BT mouse** — `pointerType === 'mouse'` uses pointer-lock path, not tap-to-click.

## Validation

Unit-test the helper (no WASM):

- tap inside slop before 500 ms → one left click, no move
- hold still past 500 ms → one right click, pointerup does not left-click
- move past slop → moves only, pointerup does not click
- second pointer ignored
- `pointercancel` → no click

Manual: Amiga Workbench on a phone — finger drag moves the pointer, tap selects, long-press is RMB. Overlay stick still fires. Laptop mouse unchanged.

## Out of scope

- Left-button drag, RMB-hold menus, two-finger gestures, sensitivity setting, haptics, C64/Spectrum, on-screen LMB/RMB buttons
