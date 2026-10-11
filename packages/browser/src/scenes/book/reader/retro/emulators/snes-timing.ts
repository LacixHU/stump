/**
 * Frame pacing for the Snes9x player. The core produces one frame, and with it roughly 1/60th
 * of a second of audio, each time it is asked; something has to decide how often to ask.
 *
 * Normally the audio output is the clock: keep a short queue of audio ahead of what the
 * speakers have consumed and run just enough frames to refill it, which locks emulation speed
 * to the sound hardware with no drift. When there is no usable audio clock (the context is
 * suspended until a gesture, or there is no output device at all, as in a headless browser or
 * a VM) the wall clock takes over so the picture still runs at the core's frame rate.
 */

/** Never run more than this many frames for one display refresh (a long stall must not fast-forward). */
export const MAX_FRAMES_PER_TICK = 5

/** How much audio to keep queued ahead, in seconds. A ScriptProcessor pulls big chunks, so this is generous. */
export const AUDIO_TARGET_SECONDS = 0.12

/** An audio clock that has not moved for this long is treated as stalled. */
export const AUDIO_STALL_MS = 500

export function audioTargetFrames(sampleRate: number): number {
	return Math.round(sampleRate * AUDIO_TARGET_SECONDS)
}

/** Frames needed to bring the queue back up to `target`, given how long one frame's audio is. */
export function framesForAudioClock(
	bufferedFrames: number,
	targetFrames: number,
	audioFramesPerExec: number,
	max = MAX_FRAMES_PER_TICK,
): number {
	const deficit = targetFrames - bufferedFrames
	if (deficit <= 0 || audioFramesPerExec <= 0) return 0
	return Math.max(0, Math.min(max, Math.ceil(deficit / audioFramesPerExec)))
}

export type WallClock = { start: number; done: number }

export function newWallClock(): WallClock {
	return { done: 0, start: 0 }
}

/**
 * Frames due by the wall clock at `now` (milliseconds), at `framerate` Hz. The first call only
 * starts the clock. Mutates `clock` so successive calls hand out each frame once.
 */
export function framesForWallClock(
	clock: WallClock,
	now: number,
	framerate: number,
	max = MAX_FRAMES_PER_TICK,
): number {
	if (!clock.start) {
		clock.start = now
		clock.done = 0
		return 0
	}
	const due = Math.floor(((now - clock.start) / 1000) * framerate)
	const frames = due - clock.done
	clock.done = due
	return Math.max(0, Math.min(max, frames))
}

export type AudioClockWatch = { consumed: number; since: number }

export function newAudioClockWatch(): AudioClockWatch {
	return { consumed: -1, since: 0 }
}

/**
 * Whether the audio side is actually consuming samples. `consumedFrames` is a running total
 * that only advances when the output pulls audio, so a total that has stood still for
 * `AUDIO_STALL_MS` means the clock is dead even if the context claims to be running.
 */
export function audioClockAdvancing(
	watch: AudioClockWatch,
	consumedFrames: number,
	now: number,
): boolean {
	if (consumedFrames !== watch.consumed) {
		watch.consumed = consumedFrames
		watch.since = now
		return true
	}
	return now - watch.since <= AUDIO_STALL_MS
}
