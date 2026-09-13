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
