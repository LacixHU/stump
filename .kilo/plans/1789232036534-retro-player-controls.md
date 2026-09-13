# Retro player: reset, settings, mobile controls, disk swap

## Decisions

- Replace the top **Stop** button with **Hard Reset** (C64 `hardReset()`: CPU/machine reset, disk stays inserted). Destroy only on unmount / leave route.
- Add a compact **Settings** dropdown on the same header: input mode (`mixed` / `keyboard` / `joystick`) and joystick port (`1` / `2`). C64 only.
- Mobile (`max-width: 768px`), C64 only: on-canvas overlay with D-pad + fire + Run/Stop + Space + Return.
- Optional extra overlay keys from series-folder `controls.json` (same folder as the disks). Missing/invalid → defaults. No scan, no DB.
- Disk list click **inserts** the new image into the running emulator. Do **not** call `startPlay` (that destroys + auto `LOAD"*",8,1` / `RUN`).

## Current bugs to fix

- Stop (`Square`) calls `destroy()` and leaves a blank canvas (`status: idle`). Not a reset.
- `onSwapDisk` always `startPlay` → full reboot and autoload. `c64-ready` already skips autoload when `diskSessionActive` is true (`loadGameData` → `c64_insertDisk` only).
- `mountImage` exists on the C64 handle but is unused, and infers type from the **original** `fileName`.

Do **not** use `c64-ready` `UIController` (injects its own DOM). Keep `C64Player` + `CanvasRenderer` only.

## Handle API (`retro/emulators/types.ts`)

Extend `RetroEmulatorHandle`:

- `reset?: () => void` — C64: `player.hardReset()`
- `setInputMode?: (mode: 'mixed' | 'keyboard' | 'joystick') => void`
- `setJoystickPort?: (port: 1 | 2) => void`
- `mountImage?: (image: ArrayBuffer, fileName?: string) => Promise<void>` — pass the **new** disk name into `inferLoadType`

C64 implements all of these from the existing `C64Player` instance. Amiga/Spectrum omit them.

## Toolbar (`RetroPlayerScene.tsx`)

- Replace Stop with Reset (`RotateCcw`). Call `handle.reset()` when `platform === 'c64'` and playing; toast if missing.
- Gear dropdown (existing `@stump/components` Dropdown): input mode radios, port 1/2. Hidden unless C64 + playing.
- Keep Back, title, platform badge, save/load, fullscreen.

## Disk swap

`onSwapDisk`:

1. If `status === 'playing'` and `handle.mountImage`: `fetchImage(diskId)` then `mountImage(buf, disk.path || disk.name)`. Set `activeMediaId`. Toast on failure; keep running session.
2. Else fallback to `startPlay` (Amiga/Spectrum / first load).

Do not `stopEmulator()` on swap.

## Mobile overlay

New `packages/browser/src/scenes/book/reader/retro/OnScreenControls.tsx`.

- Show when `platform === 'c64'` and `useMediaMatch('(max-width: 768px)')`.
- Absolutely positioned over `<main>` only (not disk aside). Semi-transparent; `touch-action: none` on pads.
- Left: D-pad. Right: Fire. Bottom: Run/Stop, Space, Return, then `extraKeys`.
- Pointer down/up/leave/cancel; release all on blur. `preventDefault` so the page does not scroll.
- Drive input by dispatching `KeyboardEvent` on `window` (`c64-ready` `InputHandler` is attached to `window`):
  - D-pad → `ArrowUp/Down/Left/Right`
  - Fire → `KeyZ` (mixed-mode fire)
  - Run/Stop → `Escape`
  - Space / Return → `Space` / `Enter`
- Overlay buttons must not steal canvas focus permanently; re-focus canvas after pointer up.

## `controls.json`

Series folder, next to disks, e.g. `Last Ninja/controls.json`:

```json
{ "extraKeys": ["commodore", "ctrl", "f1", "f3", "f5", "f7"] }
```

Allowlist only: `commodore`, `ctrl`, `f1`, `f3`, `f5`, `f7`, `restore`, `instdel`, `home`, `shift`. Drop unknown entries. `restore` may be listed but is a no-op in this WASM (same as c64-ready).

Key → event: commodore `ControlLeft`, ctrl `Tab`, f1–f7 `F1`…, instdel `Backspace`, home `Home`, shift `ShiftLeft`.

### API

`GET /api/v2/media/{id}/retro-controls`

- Auth: library access (same as `play-file`), not `DownloadFile`.
- Reject non-retro extensions.
- Resolve `parent(media.path)/controls.json`. Canonicalize; require the file stays under that parent (no traversal). Max 16 KiB.
- Missing/invalid → `200 { "extraKeys": [] }`.
- SDK: `MediaAPI.retroControlsURL(id)` (or fetch helper). Client fetch on play; ignore network errors → defaults.

Add a small Rust unit test for path resolution (sibling `controls.json` found; `../` rejected), next to sidecar cover tests in `core/src/filesystem/media/format/retro.rs`.

## Docs / i18n

- `docs/content/docs/guides/features/retro-libraries.mdx`: Reset vs destroy; disk insert vs reboot; mobile overlay; `controls.json` schema.
- `packages/i18n/src/locales/en-US.json`: toolbar labels (Reset, Settings, input mode, port).

## Validation

- Prettier on touched JS/TS/JSON/MD; `cargo fmt` on Rust.
- C64: Reset returns to BASIC with the same disk still in the drive (can `LOAD` again without re-picking the file).
- Multi-disk: switching the list inserts D64 and does **not** auto-RUN; in-game disk change still works.
- Desktop: no overlay. Mobile width: overlay visible and usable.
- Missing `controls.json` → default three keys only.
- Amiga/Spectrum: no Reset/Settings/overlay; disk click may still reboot (no `mountImage`).

## Out of scope

- c64-ready hamburger/help UI, Reboot (unloads game), fast-forward, save-state slot UI.
- Spectrum/Amiga virtual controls.
- Persisting input mode/port.
