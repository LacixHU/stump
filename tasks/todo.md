# Server-side retro save states

## Problem

Retro save states only ever land in the browser's IndexedDB
(`packages/browser/src/scenes/book/reader/retro/saves.ts`, keyed
`stump-retro-save:${userId}:${mediaId}:${slot}`). A save made on the desktop is invisible
on a phone, is lost when site data is cleared, and is invisible to another browser on the
same machine. On a server whose whole point is that the library lives on the server, the
save state is the one piece of state that doesn't.

## Decisions

| Question                 | Decision                                                                |
| ------------------------ | ----------------------------------------------------------------------- |
| Visibility               | Private per user — one save per `(user, media)`                         |
| Blob storage             | Files on disk under the config dir + a DB metadata row (no SQLite BLOB) |
| Slots                    | A single auto slot — keeps today's Save / Load button behaviour         |
| Existing IndexedDB saves | Dropped; `saves.ts` is deleted, the server is the only store            |

## Plan

### Server

- [x] Migration `crates/migrations/src/m*_add_media_save_states.rs` — table
      `media_save_states` (uuid PK, `user_id`/`media_id` FKs cascade, `size_bytes`,
      `created_at`, `updated_at`) + unique index on `(user_id, media_id)`; register in
      `crates/migrations/src/lib.rs`
- [x] Entity `crates/models/src/entity/media_save_state.rs` (no GraphQL derives — REST
      only); register in `entity/mod.rs` **and** `crates/tests/src/db.rs`
- [x] `StumpConfig::get_save_states_dir()` → `{config_dir}/save_states`, created in
      `write_config_dir()`; layout `save_states/{media_id}/{user_id}.savestate`
- [x] `SAVE_STATE_MAX_BYTES` (16 MiB) beside `RETRO_CONTROLS_MAX_BYTES`
- [x] `apps/server/src/utils/save_state.rs` — GET / PUT / DELETE handlers, library-access
      auth + retro-extension guard, temp-write + atomic rename, orphan self-heal
- [x] Routes on `apps/server/src/routers/api/v2/media.rs` with an explicit
      `DefaultBodyLimit::max(SAVE_STATE_MAX_BYTES)` (repo sets no body limit today, so
      axum's 2 MiB default would truncate Amiga snapshots)
- [x] `remove_save_states()` called alongside `remove_thumbnails()` on library delete

### Client

- [x] `MediaAPI` methods: `saveStateURL`, `getRetroSaveState` (404 → null),
      `putRetroSaveState`, `deleteRetroSaveState`
- [x] Delete `retro/saves.ts`; rewrite `onSave`/`onLoad` in `RetroPlayerScene.tsx` against
      the SDK, with an in-flight guard
- [x] "Delete save state" entry in `retro/RetroPlayerSettings.tsx`

### Docs + tests

- [x] `docs/.../retro-libraries.mdx` — Save states section currently says the opposite;
      add the routes to the endpoint table
- [x] Integration tests `apps/server/tests/save_state/` (+ a `put_bytes` TestApp helper)

## Review

Save states now live on the server. `saves.ts` (IndexedDB) is gone; the player reads and
writes `GET|PUT|DELETE /api/v2/media/{id}/save-state`, and the bytes land in
`{config_dir}/save_states/{media_id}/{user_id}.savestate` with a `media_save_states` row
alongside. One save per user per game, enforced by a unique index.

### Deviations from the plan, and why

- **Dropped the `X-Stump-Save-State-Updated-At` header.** The CORS layer
  (`apps/server/src/config/cors.rs`) never calls `.expose_headers`, so a custom response
  header is unreadable cross-origin — it would have worked in the same-origin production
  build and silently read as `null` in Tauri and the dev client. Nothing in the UI needed
  the timestamp anyway.
- **No new `ContentType` variant.** Axum already types a `Vec<u8>` response as
  `application/octet-stream`. Adding `OCTET_STREAM` to the core enum would have forced
  edits at three exhaustive match sites for a string we already had.
- **Saves key to the opened book, not `activeMediaId`.** The scene re-points
  `activeMediaId` when you swap disks, so the old code saved under disk 2 and then found
  nothing when you next opened the game at disk 1. Server-side that bug would have become
  durable and cross-device. One game, one save.
- **Find-then-write instead of an `ON CONFLICT` upsert.** Tests build their schema from
  the entities, which emits columns but no standalone indexes — an upsert on the unique
  index would have worked in production and failed in CI.
- **`DefaultBodyLimit` sits on the method router**, not the parent, so `/thumbnail`,
  `/page`, `/file` and `/play-file` keep axum's default rather than silently inheriting
  16 MiB.
- **No "Delete save state" UI.** The settings dropdown only renders while
  `platform === 'c64' && status === 'playing'`, i.e. it is unreachable exactly when a user
  would want to clear a bad save. The endpoint and SDK method exist and are tested; the UI
  needs a reachable home and a confirmation step, which is its own change.

### Two pre-existing problems found along the way

- **The server test suite was fully red at HEAD** — 28 failures. `series::Entity` declares
  `#[sea_orm(default_value = "false")]` on a `bool`, so the schema generated from the
  entity defaults the column to the _string_ `'false'`, which then fails to decode as a
  boolean. Migrations use a real boolean default, so only tests were affected. Fixed in
  the fixture (`crates/tests/src/fake_data.rs`) by setting the column explicitly. The
  suite is now 49/49 green. `library_config` has the same attribute pattern on two
  columns and will bite the same way if anything ever decodes them.
- **`TestApp` was writing into the developer's real `~/.stump`.** `Ctx::for_testing` uses
  `StumpConfig::debug()`, whose `config_dir` is the actual home config directory. Any test
  that touched the filesystem would have littered it. `TestApp` now owns a `TempDir` and
  overrides `config_dir`.

### Known gaps

- **`crates/graphql/schema.graphql` is stale at HEAD** — `cargo dump-schema --check` fails
  on drift from earlier commits (the `RETRO` library type, the new metadata providers,
  `updateSeriesUseSingleThumbnail`, the PDF cache config fields). Nothing to do with save
  states; the regenerated file was deliberately left out of this change.
- **Orphaned snapshots on `deleteLibrary`.** Cleanup is hooked into `clean_library`, where
  the deleted media ids are already in hand. `delete_library` relies on a DB cascade and
  collects no ids — it carries a pre-existing `// TODO: delete thumbnails!` for exactly
  the same gap, so save states leak there in the same way thumbnails already do.
- **User deletion** cascades the rows away but leaves `{user_id}.savestate` files behind.
- Snapshots are stored uncompressed. `flate2` is not in the workspace and
  `CompressionStream` would add a browser fallback path; revisit if Amiga snapshots make
  disk use painful.
- `apps/desktop` does not compile at HEAD (a `tauri-plugin-store` API mismatch in
  `store/app_store.rs`), unrelated and untouched.

### Verified

- `cargo test -p stump_server --test api_tests` — **49 passed, 0 failed** (8 of them new,
  covering round-trip, replace, delete, per-user isolation, non-retro rejection, empty
  body, and the stale-row self-heal).
- `cargo migrate up` / `cargo rollback` / re-apply, against a throwaway database.
- `cargo fmt --all --check` clean; `cargo clippy` reports nothing in the new files.
- Prettier clean on both changed TypeScript files; ESLint clean apart from two
  pre-existing errors in `RetroPlayerScene.tsx` that predate this change.
- **Not yet done: the manual end-to-end.** Save/reload/Load in a real browser against a
  real `.d64` is the only thing that proves the emulator half, and it needs a running
  server and a game image.

---

# C64 games start slowly even with disk speed set to "Instant"

## Problem

Starting a `.d64` game took tens of seconds. "Instant" disk speed was not instant:
it only nudged the emulator to ~2.4x realtime while the emulated 1541 performed a
full, cycle-accurate serial load — the same one to two minutes it took on real
hardware.

Measured against the `c64-ready` WASM core (headless harness, synthetic `.d64`):

|                           | emulated time | wall clock            |
| ------------------------- | ------------- | --------------------- |
| 33-block (8 KB) program   | 24 s          | ~10 s at the old 2.4x |
| 162-block (40 KB) program | ~120 s        | ~50 s at the old 2.4x |

Two root causes:

1. The frame loop called `debugger_update()` once per `requestAnimationFrame`.
   The core advances **at most two frames per call**, so rAF — not the CPU — was
   the ceiling. `debugger_set_speed(300)` could only buy 2.4x.
2. Even at the core's true ceiling (~9x realtime, CPU-bound), a real disk load is
   still 10+ seconds. Warping alone can never make loading "instant".

## Plan

- [x] Measure the core's actual throughput (`debugger_update` semantics, effect of
      `debugger_set_speed`, per-call frame cap) instead of guessing
- [x] Read the first program out of the container ourselves and inject it into RAM,
      bypassing the emulated drive entirely
- [x] Keep the disk in the drive so multi-load games still work
- [x] Replace the CIA2 IEC heuristic with the core's real drive-activity signal
- [x] Raise the warp ceiling for the loads that still have to be emulated
- [x] Fall back cleanly when injection is not safe
- [x] Tests + docs

## Changes

- **`retro/emulators/c64-images.ts`** (new) — `.d64` directory/sector-chain walker
  and `.t64` directory reader. Returns the program `LOAD"*",8,1` would pick up.
  Bounds-checked and loop-guarded; malformed images return `null`, never throw.
- **`retro/emulators/c64.ts`**
  - On `instant`, extract the first program and inject it with `c64_loadPRG`, then
    type `RUN` into the KERNAL keyboard buffer. The disk is still inserted first,
    so later in-game loads read from it normally.
  - For a **disk**, only injects when the program loads at `$0801`; anything else
    falls back to the emulated `LOAD"*",8,1` (unchanged behaviour).
  - Warp loop now runs `debugger_update()` repeatedly inside a 12 ms wall-clock
    budget per animation frame, skipping the intermediate paints. ~10x realtime,
    vs 2.4x before.
  - Drive-busy detection switched to `c1541_getStatus()` (1 = idle, 2 = busy),
    replacing the CIA2 IEC-line change heuristic and its 24-frame hold.
  - `.t64` is no longer handed to `c64_insertDisk` as if it were a disk image.
  - Disk swap inserts directly into the drive instead of going through the
    player's first-disk path, which would have reset the machine.
  - Reset now restarts the game the same way it was started.
- **`retro/emulators/types.ts`**, **`RetroPlayerScene.tsx`** — the mount options
  carry the disk-speed preference, so `create()` knows whether to inject.
- **`__tests__/c64-images.test.ts`** — 18 tests over the parsers.
- **`docs/.../retro-libraries.mdx`** — describes what Instant/Authentic now do.

## Follow-up: `.t64` tapes did not start

Reported after the first pass. Two defects, both in the tape path:

1. **The `$0801` gate is wrong for tapes.** It was written for disks, where a
   program we decline still loads the authentic way. Tapes have no such fallback,
   and most `.t64` rips are machine code that loads somewhere other than `$0801`,
   so the gate rejected them.
2. **The fallback then corrupted memory.** With no program, `create()` passed the
   _raw `.t64` container_ to `c64_loadPRG` as `gameType: 'prg'`. The emulator read
   the file's own signature bytes `"C6"` as a little-endian load address and dumped
   the header into RAM at `$3643`, leaving `VARTAB` at `$3A4D`.

Also found while fixing: `looksLikeT64` tested only for a leading `"C64"`, which a
`.crt` cartridge (`"C64 CARTRIDGE   "`) also satisfies — a cartridge could have
been diverted into the tape reader.

Fixes:

- Tapes and bare `.prg` files are always unwrapped and injected, at any load
  address, independent of the disk-speed setting — no drive is involved either way.
  A raw container is never handed to the emulator again.
- Programs that do not load at `$0801` start with `SYS <load address>` instead of
  `RUN`, which is the convention for machine-code tape and PRG rips.
- `SYS 49152` exceeds the ten-byte KERNAL keyboard buffer, so typing is now chunked
  and waits for the buffer to drain between chunks.
- `c64_loadPRG` leaves BASIC's variable pointers past whatever it injected, which
  lands far outside BASIC RAM for a machine-code load; the pointers are reset to an
  empty program before the `SYS`.
- `looksLikeT64` now requires the signature to both start with `"C64"` and contain
  `"TAPE"`, matching all four documented spellings and excluding cartridges.
- An unreadable tape raises a clear error instead of silently injecting garbage.
- Swapping in a different tape or PRG resets first (a different game), whereas a
  disk side swap still just inserts.

Verified in the headless harness with realistic tapes (30-slot directory, data
after the slot table): a `$C000` machine-code tape now starts via `SYS 49152` in
two keyboard chunks and runs; a `$0801` tape starts via `RUN`; all four signature
spellings parse; a real `bubble-bobble.crt` is not mistaken for a tape. 10/10 in
the harness, `jest` 18/18.

## Follow-up: intermittent silence

Reported as "no sound now", then "after a reload it worked, maybe sometimes works".
Intermittent, and a reload clears it — a startup race, not a logic error.

The emulated SID was ruled out first: running the old `LOAD"*",8,1` path and the
new injection path against the same disk produced byte-identical SID output
(same peak, same non-zero sample count). The fault is on the Web Audio side.

`public/retro/c64/audio-worklet-processor.js` asks for samples **once**:

```js
if (this.samplesAvailable < this.lowWaterMark && !this.requested) {
	this.requested = true
	this.port.postMessage('need-samples')
}
```

`requested` is cleared only when samples actually arrive, so the worklet never
asks a second time. And `AudioEngine.feedWorklet()` silently drops the request
when `_suspended` is set. `AudioEngine.init()` leaves `_suspended` stale:

```ts
this.ctx.resume().catch(() => {})              // not awaited
this._suspended = this.ctx.state === 'suspended'  // read too early -> still true
```

So if the worklet's single request lands while the context is mid-transition to
`running`, it is dropped and the SID is silent for the whole session.

The latch pre-dates this work. What exposed it was removing the ~1.75 s of
scripted disk autoload (`DISK_AUTOLOAD_DELAY_MS` and friends) that used to sit in
front of audio startup and reliably carried the context past that window.

Fix in `c64.ts`: `primeAudio()` waits for `audio.ready` (the worklet module is
loaded), then retries `audio.resume()` until the context reports it is really
running. `resume()` awaits the transition before updating `_suspended` and ends by
feeding the worklet, so it answers the pending request and restarts the pump. It
runs at startup and on every `pointerdown`, and gives up after 8 attempts so a
genuinely blocked autoplay just waits for the next gesture.

Not verified in a browser from here — the mechanism is confirmed from the worklet
and engine sources, but the fix needs testing across several cold loads.

## Review

Verified against the real `c64-ready` WASM core in a headless Node harness with
synthetic `.d64`/`.t64` images (built to spec, including interleave):

- 40 KB game from boot to running: **~270 ms wall**, versus ~120 s of emulated
  drive time. 8 KB game likewise sub-second.
- Disk remains inserted and readable after injection (`LOAD"*",8,1` from the
  still-mounted disk succeeds); `c64_getDriveEnabled()` stays 1.
- `c64_init()` and `c64_reset()` boot to the BASIC prompt synchronously, so the
  READY-prompt wait costs nothing and the reset path is safe.
- Warp loop measured at 10.2x realtime with the 12 ms budget.
- Parsers: 22 assertions over empty/short/zeroed/0xff/truncated/random input,
  self-referential sector chains, non-`$0801` load addresses, and bogus `.t64`
  end addresses.
- `jest` 11/11 pass; `eslint` clean on all touched files; `tsc` clean on the new
  parser.

Known, pre-existing and untouched: `packages/browser` cannot resolve `c64-ready`'s
types (the package is `exports`-only and the tsconfig uses node10 resolution), so
everything in `c64.ts` that comes from that import is implicitly `any`. Worth
fixing separately — it would give the emulator glue real type checking.

## Fix: C64 emulation/audio speed tied to display refresh rate

**Symptom:** sound (and the whole machine) runs faster or slower than a real C64.

**Cause:** the custom render loop in
`packages/browser/src/scenes/book/reader/retro/emulators/c64.ts` called
`runTick(FRAME_MS)` — a constant 20 ms — once per `requestAnimationFrame`.
`C64Emulator.tick(dTime)` forwards straight to `debugger_update(dTime)`, which
consumes _real elapsed milliseconds_ and releases a frame only once a full PAL
frame is due (upstream's own `CanvasRenderer.attachTo` and the headless CLI both
pass a wall-clock delta, the latter explicitly "to avoid long-term A/V drift").
Passing a constant instead pinned the emulated machine to the panel:

| display                | emulated rate | error    |
| ---------------------- | ------------- | -------- |
| 60 Hz                  | 60 fps        | +20%     |
| 120 Hz                 | 120 fps       | +140%    |
| 144 Hz                 | 144 fps       | +188%    |
| throttled / hidden tab | < 50 fps      | too slow |

The SID then produced samples at that same wrong rate while the audio worklet
drained them at a fixed 44.1 kHz, so on top of the wrong tempo the ring buffer
over- or under-ran continuously — the crackle and dropouts.

**Fix:** feed `tick()` the real rAF delta, clamped to `MAX_DELTA_MS` (100 ms) so
a hidden tab or a stalled main thread is dropped rather than sprinted through.
The deliberate warp path still calls `runTick(FRAME_MS)` per iteration, since
there each call means "advance exactly one frame".

**Verification:** `tsc -p packages/browser` produces an identical error set
before and after (all pre-existing — the `c64-ready` type-resolution issue noted
above); `eslint` clean on the touched file.

---

# Virtual keyboard for the retro player

## Problem

The retro player has no way to reach most of the C64 keyboard. The on-screen overlay
(`retro/OnScreenControls.tsx`) is a _joystick_ pad: a handful of free-floating round
buttons an admin positions per game. A touch user cannot type `LOAD"$",8`, answer a
game's "PRESS F1 TO START", or enter a text-adventure command at all, and a desktop user
with no physical `£`, `↑` or `RUN/STOP` key is in the same position.

## Decisions

| Question        | Decision                                                                             |
| --------------- | ------------------------------------------------------------------------------------ |
| Where           | Docked below the canvas _inside_ the fullscreen element, not floating over it        |
| Layout          | The authentic 66-key breadbin layout, per-platform data so Amiga/Spectrum can follow |
| Shift           | Sticky one-shot + a real SHIFT LOCK cap, as on the machine                           |
| Shifted legends | Printed on the cap (`!` over `1`, `CLR` over `HOME`, `F2` over `F1`)                 |
| Who sees it     | Everyone — desktop and touch. It is a toggle, not a permission                       |

## Plan

- [x] `retro/keys.ts` — move `OVERLAY_KEY_IDS` / `OverlayKeyId` / `OVERLAY_LABELS` /
      `keySpec` / `dispatchKey` out of `OnScreenControls.tsx` so both input surfaces share
      one key vocabulary; `dispatchKey` grows a `shiftKey` option
- [x] `retro/VirtualKeyboard.tsx` — layout data + cap rendering + sticky modifiers
- [x] `RetroPlayerScene.tsx` — `Keyboard` toggle in the header, playfield becomes a flex
      column so the keyboard docks under the canvas instead of covering it
- [x] `reader.retro.virtualKeyboard` in `en-US.json`
- [x] Docs: on-screen controls section of `retro-libraries.mdx`
- [x] Unit tests for the layout invariants and the shift/latch dispatch

## Review

A `Keyboard` toggle in the player toolbar docks the C64's own keyboard under the canvas.
It lives _inside_ the fullscreen element, so it survives fullscreen, and it is one panel
for both desktop and touch — there is no mobile-only path.

### How it reaches the emulator

c64-ready listens on `window` and maps matrix keys off `event.key` but joystick keys off
`event.code`, so every cap dispatches a synthetic `KeyboardEvent` with a deliberately
bogus code (`C64_z`). A real `KeyZ` would be eaten as joystick fire in mixed mode and
never reach the matrix. That trick already existed for the joystick overlay; it now lives
in `retro/keys.ts` where both surfaces share it.

### Decisions worth knowing

- **Shift is a flag, not a held key.** `dispatchKey` stamps `shiftKey` on the event and
  c64-ready presses matrix SHIFT itself. That is what makes the printed legends real —
  `SHIFT`+`1` is `!`, `SHIFT`+`HOME` is `CLR`, `SHIFT`+`F1` is `F2`, `SHIFT`+`CRSR` ↓
  is ↑ — with no code of ours, and it cannot leave SHIFT stuck the way a held keydown
  could, because every unshifted keydown releases it again.
- **`C=` and `CTRL` are genuinely held**, since they have no event flag. They are
  released by the keystroke they modify, by a second tap, and on unmount — a panel
  toggled off mid-chord must not leave a matrix key down for the rest of the session.
- **One cap needed an override.** c64-ready keys its matrix off the _character_, so it
  clears shift inside its `:` case and `SHIFT` + `:` would have typed a colon rather than
  the `[` printed on the cap. `dispatchKey` therefore also accepts a raw `KeySpec`, and
  that cap carries one. It is not a new entry in the shared vocabulary on purpose — that
  list is mirrored by the server's `controls.json` allow-list
  (`core/src/filesystem/media/format/retro.rs`), and a shifted legend is no reason to
  make the two drift.
- **The cursor cluster is two caps, not four.** The four-way version would have been
  easier to tap, but Shift already reverses direction in the emulator's own mapping, so
  the authentic pair costs nothing in capability.
- **Rows are sized in cap units and stretched to fit** (16 units of main block + a
  1.5-unit function column), with `clamp(20px, min(4.4vw, 6.2vh), 40px)` for height. One
  rule covers a 1080p desktop, a landscape phone and fullscreen; a test asserts every row
  totals 17.5 units, because a row that does not silently breaks the column alignment.
- **The playfield became a flex column.** The keyboard docks under the canvas instead of
  covering it, which also keeps the joystick overlay's percentage coordinates relative to
  the canvas alone rather than to canvas-plus-keyboard.
- **Overlay editing hides the keyboard.** Dragging a joystick button around while a
  keyboard occupies the bottom third is nobody's intent.
- **C64 only.** `LAYOUTS` is keyed by platform and the toolbar button is gated on
  `hasVirtualKeyboard`, so the Amiga and Spectrum stubs get no button rather than a
  keyboard that is not theirs. Adding one is a data change.

### Pre-existing problems left alone

`eslint` on `RetroPlayerScene.tsx` was already red at HEAD and still is, for two things
that are not this change: `isFullscreen` is assigned by the `fullscreenchange` effect and
never read, and the `react-compiler` rule objects to the `exhaustive-deps` disable on the
mount-once effect. Both want their own change.

# One virtual joystick instead of four direction buttons

## Problem

The touch overlay drew `up` / `down` / `left` / `right` as four separate round buttons.
Each one is its own press target, so changing direction means lifting a finger and
finding the next button — a diagonal means two fingers, and a fast turn in a game like
_Last Ninja_ or _Boulder Dash_ is simply not playable. The player wanted one control that
a single finger holds and slides across, the way every other touch game works.

## Decisions

- **`joystick` is a placement, not a key.** It joins `controls.json` under the same
  `{ id, x, y }` shape as everything else, so layouts, the editor, dragging and the
  server allow-list all keep working unchanged. It is the one id that never reaches
  `keySpec`: the stick resolves itself into the four direction keys as the finger moves,
  and those are what the emulator sees. This keeps the vocabulary honest — `keys.ts` now
  distinguishes `OverlayKeyId` (things that dispatch a key) from `OverlayControlId`
  (things that can be placed).
- **Direction is angle, not distance.** Past a 24% dead zone the offset vector is
  normalized before the thresholds are applied, so a small throw and a full-stretch throw
  point the same way. Without that, a finger just past the dead zone hits no threshold at
  all and the stick goes dead in the most-used part of its travel.
- **Cardinals are twice as wide as diagonals** (threshold 0.5 = a 60° pure window against
  30° for each corner). Most C64 games are four-way, where a stray diagonal is a missed
  jump; the eight-way games still reach the corners without effort. A diagonal holds both
  directions at once, exactly as a real stick closes two switches.
- **Pointer capture is what makes it feel continuous.** The stream keeps arriving after
  the finger leaves the base, so a hard throw does not silently disengage.
- **Old layouts are not rewritten.** A saved `controls.json` holding the four separate
  buttons still renders them. Silently collapsing them would have made it impossible to
  ever place a discrete direction button again, since the next load would collapse it
  back. Both defaults (client `DEFAULT_OVERLAY_KEYS` and server `default_base_overlay`)
  now ship the stick, and `up`/`down`/`left`/`right` stay in the editor palette for
  layouts that want them.
- **Drag behaviour was factored out.** `usePlacementDrag` is now shared by the stick and
  the buttons, so edit mode moves and clamps both identically rather than by two copies
  of the same arithmetic.

## Changes

- `packages/browser/src/scenes/book/reader/retro/keys.ts` — `JOYSTICK_ID`,
  `OverlayControlId`, `OVERLAY_CONTROL_IDS`, `JoystickDirection`, `OVERLAY_CONTROL_LABELS`.
- `packages/browser/src/scenes/book/reader/retro/OnScreenControls.tsx` — `Thumbstick`,
  the exported pure `joystickDirections`, `usePlacementDrag`, new defaults.
- `core/src/filesystem/media/format/retro.rs` — `joystick` in the allow-list and in the
  default overlay.
- `docs/content/docs/guides/features/retro-libraries.mdx`, plus a new
  `__tests__/OnScreenControls.test.tsx`.

## Review

### Also fixed along the way

A control unmounted while held — overlay hidden, disk swapped, player navigating away —
left its key down inside the emulator forever. Both the stick and the buttons now release
on unmount. This was already true of the buttons before this change; it is a three-line
fix in the same component and a covered case in the new tests.

### Verified

- `yarn jest src/scenes/book/reader/retro` — 47 passed (14 new). The new suite covers the
  direction maths directly and drives a rendered stick through a slide, asserting the
  exact `keydown`/`keyup` stream: one finger sliding up→right emits `ArrowUp` down/up then
  `ArrowRight` down/up with no gap, a diagonal holds two, moves that do not change
  direction emit nothing, and edit mode drags instead of dispatching.
- `cargo test -p stump_core --lib retro` — 13 passed, including a saved `joystick` round
  trip and the updated fallback default.
- `eslint` clean on every file touched. `RetroPlayerScene.tsx` is still red for the two
  pre-existing problems noted in the previous section; neither is this change.

---

# Retro cover art never found for new games

Reported against `F:\Retro`: "Operation Wolf" and "Zamzara" were added but got no cover.

## Diagnosis

Three separate problems, only one of which was visible.

- [x] **Nothing was ever attempted.** Every scan on 2026-09-14 logged
      `No thumbnail generation job will be enqueued`. `finalize` in `library_scan_job.rs` only
      enqueued thumbnail generation when the library had an explicit `thumbnail_config`; this
      library has none. The covers the older games do have came from `thumbnail_generation`
      jobs run by hand on 09-13 — every file in `~/.stump/thumbnails` is dated 09-13.
- [x] **Operation Wolf would have failed anyway.** Candidates are sorted longest-first, so
      the stem `Operation Wolf [Sir 13]` was tried before the clean folder name.
      `sanitize_game_title` stripped `_`, `-` and disk/side suffixes but not bracketed release
      tags. Wikipedia answers `/page/summary/Operation_Wolf_%5BSir_13%5D` with **403**, not
      404 (reproduced twice: `{"status":403,"type":"Internal error"}`). `fetch_page_summary`
      only special-cased `NOT_FOUND`, so 403 became an `Err`, and the `?` in
      `fetch_wikipedia_cover_bytes` propagated it out of the loop — the clean `Operation Wolf`
      candidate was never tried. The article has a usable cover
      (`Operation_Wolf_Poster.png`, 200 / `image/png` / 173 KB).
- [x] **Zamzara is a true negative.** No en.wikipedia article (only _Jukka Tapanimäki_ and
      _List of Evercade games_ mention it), 0 hits for
      `incategory:"Commodore 64 game covers" Zamzara`, 0 for the `Zamzara cover video game`
      fallback. Needs a sidecar image; no code fix possible.

## Changes

- [x] `wikipedia.rs` — `strip_release_tags` removes `[...]`, `(...)` and `{...}` groups
      before the existing sanitising, with a fallback for names that are _entirely_ a tag.
- [x] `wikipedia.rs` — `fetch_page_summary` treats any client error except 429 as "no
      page" rather than a hard failure. 429 stays an error because it genuinely means retry.
- [x] `generate.rs` — the candidate loop logs and skips a failing candidate instead of
      aborting. Download failures skip too. Signature dropped from
      `Result<Option<Vec<u8>>, String>` to `Option<Vec<u8>>`, which is what it now is, and the
      caller lost its dead error arm.
- [x] `library_scan_job.rs` — a `LibraryType::Retro` library with no `thumbnail_config`
      now falls back to `retro_cover_image_options()` (fit-within 512x512) so new games pick
      up covers on scan. Non-retro libraries are unchanged: a library that deliberately has no
      thumbnail config still gets none. The duplicate `library_type` binding was hoisted.

## Review

### Verified

- `cargo test -p metadata_integrations --lib` — 35 passed. New
  `test_sanitize_strips_release_tags` covers the `[Sir 13]` case, TOSEC `(1990)(Rainbow
Arts)`, `{cr TCF}`, tag-only names, and unbalanced brackets.
- `cargo test -p stump_core --lib` — 211 passed (was 208), 3 new tests in `generate.rs`
  asserting `Operation Wolf [Sir 13].d64` now yields exactly `["Operation Wolf"]`.
- Live API checks against en.wikipedia confirmed the 403, the Operation Wolf cover
  download, and Zamzara's three empty result sets.
- `cargo clippy` clean on both touched crates; `cargo fmt` applied.

### Pre-existing failures, not this change

Confirmed by stashing these three files and re-running:

- `kobo::entity::tests` — 7 failures (`Option::unwrap()` on `None`).
- `stump_desktop` does not compile (`E0599` `load` on `Result`, `E0308`).

### Still needs a sidecar

`F:\Retro\C64\Zamzara\cover.jpg` — Wikipedia has nothing for it.

# ZX Spectrum: pin an emulator, keyboard and on-screen controls

Playing a Spectrum game showed the placeholder canvas ("WASM emulator not pinned yet"),
and both touch input surfaces were hard-wired to the C64.

## Plan

- [x] Vendor JSSpeccy 3.2 (GPL-3.0, Matt Westcott) into `packages/browser/public/retro/spectrum/`
      — prebuilt `jsspeccy.js` + worker + `jsspeccy-core.wasm` + ROMs + tape loaders, served by
      the existing `/retro` static route. Licence + provenance recorded next to it.
- [x] `emulators/spectrum.ts`: real module. Script-tag load (the bundle reads
      `document.currentScript`), capture the emulator's Worker for key/matrix and tape
      messages, drive snapshots through `openUrl` with a blob URL.
- [x] `emulators/spectrum-keys.ts`: Spectrum keyboard matrix, physical `event.code` map and
      overlay-id map, with the joystick scheme (QAOP / cursor / Sinclair) applied to the
      stick. JSSpeccy has no Kempston, so the stick has to be keys.
- [x] `keys.ts`: platform-aware vocabulary (`capsshift`, `symbolshift`, per-platform labels).
- [x] `VirtualKeyboard.tsx`: per-layout modifier set, Spectrum 40-key layout.
- [x] `OnScreenControls.tsx`: per-platform editor rows, labels and defaults.
- [x] `RetroPlayerScene.tsx` / `RetroPlayerSettings.tsx`: chrome driven by what the handle
      implements rather than `platform === 'c64'`; Spectrum gets machine + joystick scheme +
      tape speed, no input mode / joystick port / save state.
- [x] `core/.../retro.rs`: allow `capsshift` / `symbolshift` in `controls.json`.
- [x] Docs + tests.

## Known limits (JSSpeccy 3.2)

- No Kempston joystick in the core (port 0x1f reads 0), so the on-screen stick maps to keys.
- The bundle exposes no snapshot _writer_, so Spectrum has no save states; the scene already
  degrades to "Save states not available for this emulator yet".

## Review

### What the player does now

- `spectrum.ts` drives JSSpeccy through its Web Worker. The public `JSSpeccy()` API can open
  a URL, switch machine and exit -- it cannot press a key, take tape bytes or reset -- so the
  module takes a reference to the worker as it is constructed (`window.Worker` swapped for the
  length of that one synchronous call) and talks the worker's own protocol.
- Tapes are posted to the worker as bytes; the machine is then booted into a tape-loading
  prompt by opening one of the bundled loader snapshots. Snapshots go the other way, through
  `openUrl` with a blob URL and a `#image.z80` fragment, because the bundle picks its parser
  off the URL's extension and the fetch that follows ignores the fragment by spec.
- All input -- physical keyboard, the docked keyboard, the overlay -- is mapped to the
  Spectrum key matrix in our own code and reference counted, so CAPS SHIFT being half of every
  cursor key cannot be lifted out from under a cap that is also holding it.
- Player chrome is now driven by what the handle implements rather than `platform === 'c64'`,
  so the Spectrum gets machine, joystick-keys and loading-speed settings, and no save-state
  buttons, without the scene knowing which machine it is talking to.

### Verified

- `jest src/scenes/book/reader/retro` -- 68 passed across 4 suites (was 47). The C64 suites
  are unchanged and still pass, which is what says the shared surfaces did not regress.
- `cargo test -p stump_core --lib ...retro` -- 12 passed, including the new allow-list test.
- Lint and types clean on everything touched. Two pre-existing errors remain in
  `RetroPlayerScene.tsx` (`isFullscreen` unused, a react-compiler complaint about the existing
  eslint-disable); both are present at HEAD, confirmed by stashing.
- **Ran for real in headless Chrome** (esbuild bundle of the actual module + a static server +
  CDP), against `F:\Retro\ZX Spectrum\Manic Miner\Manic Miner - Alternate Cover.tzx`:
  - every asset resolves under `/retro/spectrum/` (worker, core, five ROMs, loader snapshot)
  - the tape loads instantly and reaches the title screen; a real Enter starts the game
  - `handle.sendKey('right')` -- the overlay/keyboard path -- walks Willy across Central Cavern
  - a `.szx` fed as the image is fetched as `blob:...#image.szx` and loads, with no errors
  - `reset()` reloads the game; `destroy()` removes the emulator's canvas and un-hides ours
- Authentic tape speed needed a fix found this way: the 128 ROM's own loader takes a trapped
  load but never picks up the emulated tape's pulses, so real-time loading now boots through
  the `usr0` loader (48K BASIC) instead. Confirmed by watching the border go pilot (red/cyan)
  then data (blue/yellow) and the Manic Miner loading screen paint in line by line. The same
  stall reproduces with upstream JSSpeccy's own auto-load path, so it is the core's quirk, not
  the integration's.

### Known limits

- No save states for Spectrum: the bundle reads snapshots but cannot write one. The header
  buttons are hidden rather than offered and then refused.
- No Kempston: the core returns an idle port, so the on-screen stick presses keys and the
  scheme (QAOP / cursor / Sinclair) is a setting.
- `.szx` is understood by the player but is not a catalogued retro extension, so no library
  will hand one to it. Adding it means touching the scanner, content types and OPDS lists --
  deliberately left out of this change.
- JSSpeccy is GPL-3.0 in an MIT repo. It is vendored unmodified with its licence next to it,
  and nothing but `spectrum.ts` touches it, but that is a real constraint on redistributing a
  Stump build and on upstreaming this branch.

---

# Fix: C64 player silent

Two independent reasons the C64 could play without a sound, both of them in how the audio is
reached rather than in the emulation. The SID was rendering correctly the whole time.

## 1. AudioWorklet does not exist off a secure origin

`AudioWorklet` is a secure-context feature. Stump runs with `tls_enabled = false`, so the
worklet exists at `http://localhost:10801` and nowhere else -- open the same server by IP or
machine name, which is how every other device on the LAN reaches it, and `ctx.audioWorklet`
is `undefined`. c64-ready's `AudioEngine.init()` wraps everything in a `try/catch` that
"silently degrades", so `addModule` throwing left `ready = false`, no node, no error, and a
perfectly running picture with no sound at all -- for every game.

- [x] `c64.ts`: when the page cannot have a worklet, pull the SID through a
      `ScriptProcessorNode` instead. Deprecated, main-thread, and exactly what c64.js did
      before worklets existed -- but it has no secure-context requirement.
- [x] The context is opened at 44100, the rate c64-ready already tells the SID to render at,
      so the two never have to agree about anything.
- Scope: the capability is checked, not the failure. A worklet that exists but fails to load
  (a 404, say) still ends in silence; that has never happened here and the check stays honest
  about what it is testing.
- The Spectrum is unaffected: JSSpeccy uses a `ScriptProcessorNode` already.

## 2. Nothing unlocked the audio for a keyboard-only session

The `AudioContext` is created while the emulator boots, which is not a user gesture, so it is
born `suspended` whenever the page has no sticky activation -- opening the player URL
directly, or reloading on it. Only `pointerdown` was listened for, and a C64 is played on the
keyboard, so a session that never happened to click stayed silent for as long as it lasted.

- [x] `c64.ts` and `spectrum.ts`: unlock on `keydown` as well as `pointerdown`
- [x] Skip the retry loop once the context is running, so a key press per frame does not
      start a fresh 2 s prime loop each time

## Verified (headless Chrome over CDP, real modules, real disks)

| scenario                        | before                                    | after                                                   |
| ------------------------------- | ----------------------------------------- | ------------------------------------------------------- |
| `http://<lan-ip>`, click first  | `ready=false`, 0 samples out, SID at 0.37 | 300 pulls, 116 carrying audio, peak 0.52                |
| `http://localhost`, click first | 117 worklet feeds with audio              | unchanged; fallback never engages                       |
| keyboard only, no click ever    | context `suspended`, 0 samples out        | first key press starts it, 108 of 150 pulls carry audio |

- `jest src/scenes/book/reader/retro` -- 68 passed, 4 suites. Lint and types clean.
- Also checked and clean: C64 -> Spectrum -> C64 in one page (each closes its own context),
  two overlapping `create()` calls, worklet and wasm served 200 from `/retro/c64/`.

## Not a bug (found while hunting)

- **Wizard of Wor goes quiet ~10 s in.** The SID's own buffer is zero from then on, and the
  stock c64-ready player does the same with that disk, so it is the cracktro's tune ending.
  Uridium plays continuously for 100 s+.

# Operation Wolf froze at the title screen, and cleaning a library emptied its series list

Two unrelated reports, two unrelated causes.

## 1. A multi-load disk deadlocked against a drive that was still booting

`Operation Wolf [Sir 13].d64` holds two programs: `OP. WOLF TITLE` (13 blocks) and
`OPERATION WOLF` (174 blocks). The title program draws the screen and then loads the
game itself, addressing the drive directly -- the only KERNAL calls in it are `$FF5B`
and `$FFD2`, and the filename sits in it as a raw 16-byte `$A0`-padded string. So it
needs a working 1541, unlike Uridium or Zamzara, whose first file _is_ the whole game.

`autostart()` did insert the disk, but in the same breath as the `RUN`:

```ts
await waitUntil(() => isAtBasicPrompt(host), BOOT_TIMEOUT_MS)
if (disk) host.loadGame({ type: 'd64', data: disk }) // c64_setDriveEnabled(1) + insert
host.loadGame({ type: 'prg', data: target.prg })
await typeText(host, startCommand(target))
```

Two things conspire. `c64_setDriveEnabled(1)` starts the 1541's ROM self-test, which
runs for ~48 frames before the drive reaches its idle loop. And the boot wait above
returns instantly -- `c64_init()` already leaves the machine at `READY`, so
`isAtBasicPrompt` is true before a single tick. The game therefore addressed the bus
while the drive was still at `$EAB7`, the ATN handshake was lost, and **neither side
recovers**: the C64 spins in the KERNAL serial routines and the drive sits idle. Not
slow -- deadlocked. 150 emulated seconds changed nothing.

- [x] Insert the disk first, then wait `DRIVE_SPINUP_FRAMES` (60) before injecting and
      typing `RUN`
- [x] Count the wait in emulated frames rather than wall clock, since only the frame
      loop advances the core -- and `forceWarp` is already on, so it costs a few real ms

Measured threshold, injecting into the real `c64.wasm`: deadlock at <= 6 frames, loads
from 8 up. 60 leaves an ample margin and still lands well inside one warped rAF burst.

### Verified (headless Node, real `c64.wasm`, real disks, real container parsers)

| disk                    |             before |                           after |
| ----------------------- | -----------------: | ------------------------------: |
| Operation Wolf [Sir 13] | **STUCK** at $EEAC | loads; game code at $6D8B @127s |
| Uridium                 |            RUNNING |                         RUNNING |
| Wizard of Wor           |            RUNNING |                         RUNNING |
| Zamzara-TCF             |            RUNNING |                         RUNNING |
| UjVadnyugat-IBM / II    |            RUNNING |                         RUNNING |
| REVENGE.T64             |            RUNNING |                         RUNNING |

Single-load disks go from 47 spurious drive-busy frames to 0, which is right: they
never read from the drive once injected. `jest --testPathPatterns retro` -- 68 passed.

## 2. Clean Library deleted exactly the folders the series list is built from

Reproduced against the real database. `clean_library` deleted a series when it had no
media, measured as `id NOT IN (SELECT DISTINCT series_id FROM media)` -- **direct**
media only. A nested library deliberately gets a series per ancestor directory, and
those hold no books of their own. Running the mutation's own SQL against the user's
`F:\Retro` library selected precisely `C64` and `ZX Spectrum` -- its only two roots.

Their nine children survived, still pointing at deleted rows, because
`series.parent_series_id` has no foreign key and nothing detaches them. The list filters
`isRoot: true` (`parent_series_id IS NULL`), so every one of them was excluded too:
an empty library whose rows were all still in the table. A later scan re-created the two
parents from disk, which is why they came back "after a full restart".

- [x] Do not delete a series that is some other series' parent -- reusing the same two
      subqueries `series_visible_in_lists_condition` already uses, so one rule holds:
      if it is visible, clean leaves it alone unless it is genuinely missing from disk
- [x] Guard the `NOT IN` with `series_id IS NOT NULL` -- a single NULL made the whole
      branch NULL for every row, silently turning it into a no-op
- [x] Ignore soft-deleted media when deciding a series has books
- [x] Re-root the children of a series that _is_ deleted, so a parent that really did
      go missing cannot strand its subtree

Verified against a copy of the live database:

| scenario                | before                       | after                               |
| ----------------------- | ---------------------------- | ----------------------------------- |
| healthy library, clean  | deletes `C64`, `ZX Spectrum` | deletes nothing                     |
| `C64` genuinely missing | 8 children invisible         | `C64` removed, 8 children re-rooted |

### And why it only recovered on a restart

- [x] `CleanLibrary.tsx` invalidated nothing at all, so the missing-entities table kept
      offering rows that had already been deleted
- [x] `useCoreEvent.ts` matched scan events against `['series', 'media']` lowercased --
      `librarySeries` folds to `libraryseries` and matched neither, so a library left
      open was never told when a scan re-created its series

## Left alone (real, but out of scope for this report)

- `delete_library` never calls `remove_watcher`, so the OS watch outlives the library
- Deleting a library orphans its `library_configs` row (that column has no FK either)
- `scanned_directories` is never purged, so a rescan after a clean can skip subtrees
- `.tap` and `.g64` on C64 have no branch in `inferContainer` and will misload
