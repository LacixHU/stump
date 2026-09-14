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
