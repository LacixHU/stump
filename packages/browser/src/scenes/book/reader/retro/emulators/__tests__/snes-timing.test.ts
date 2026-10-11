import {
	AUDIO_STALL_MS,
	audioClockAdvancing,
	audioTargetFrames,
	framesForAudioClock,
	framesForWallClock,
	MAX_FRAMES_PER_TICK,
	newAudioClockWatch,
	newWallClock,
} from '../snes-timing'

describe('framesForAudioClock', () => {
	const perFrame = 44100 / 60.0988

	it('runs nothing while the queue is full enough', () => {
		const target = audioTargetFrames(44100)
		expect(framesForAudioClock(target, target, perFrame)).toBe(0)
		expect(framesForAudioClock(target + 1000, target, perFrame)).toBe(0)
	})

	it('runs just enough frames to refill the queue', () => {
		const target = audioTargetFrames(44100)
		// one frame short: exactly one frame
		expect(framesForAudioClock(target - Math.floor(perFrame) + 10, target, perFrame)).toBe(1)
		expect(framesForAudioClock(target - Math.floor(perFrame * 2), target, perFrame)).toBe(2)
	})

	it('never fast-forwards more than the cap after a stall', () => {
		const target = audioTargetFrames(44100)
		expect(framesForAudioClock(0, target * 100, perFrame)).toBe(MAX_FRAMES_PER_TICK)
	})

	it('survives a nonsense frame length', () => {
		expect(framesForAudioClock(0, 1000, 0)).toBe(0)
	})

	it('keeps about 120 ms ahead', () => {
		expect(audioTargetFrames(48000)).toBe(5760)
	})
})

describe('framesForWallClock', () => {
	it('only starts the clock on the first call', () => {
		const clock = newWallClock()
		expect(framesForWallClock(clock, 1000, 60)).toBe(0)
		expect(clock.start).toBe(1000)
	})

	it('hands out each frame exactly once at the core frame rate', () => {
		const clock = newWallClock()
		framesForWallClock(clock, 1000, 60)
		expect(framesForWallClock(clock, 1000 + 1000 / 60 + 1, 60)).toBe(1)
		expect(framesForWallClock(clock, 1000 + 1000 / 60 + 2, 60)).toBe(0)
		expect(framesForWallClock(clock, 2000, 60)).toBeGreaterThanOrEqual(1)
	})

	it('totals the frame rate over a second', () => {
		const clock = newWallClock()
		framesForWallClock(clock, 0.5, 50)
		let total = 0
		for (let t = 16; t <= 1000; t += 16) total += framesForWallClock(clock, t, 50)
		expect(total).toBeGreaterThanOrEqual(48)
		expect(total).toBeLessThanOrEqual(50)
	})

	it('caps a long stall instead of fast-forwarding', () => {
		const clock = newWallClock()
		framesForWallClock(clock, 1, 60)
		expect(framesForWallClock(clock, 60_000, 60)).toBe(MAX_FRAMES_PER_TICK)
	})
})

describe('audioClockAdvancing', () => {
	it('is live while the consumed total moves', () => {
		const watch = newAudioClockWatch()
		expect(audioClockAdvancing(watch, 0, 0)).toBe(true)
		expect(audioClockAdvancing(watch, 1024, 100)).toBe(true)
		expect(audioClockAdvancing(watch, 2048, 5000)).toBe(true)
	})

	it('is stalled once the total stands still past the limit', () => {
		const watch = newAudioClockWatch()
		audioClockAdvancing(watch, 100, 0)
		expect(audioClockAdvancing(watch, 100, AUDIO_STALL_MS)).toBe(true)
		expect(audioClockAdvancing(watch, 100, AUDIO_STALL_MS + 1)).toBe(false)
	})

	it('recovers as soon as audio moves again', () => {
		const watch = newAudioClockWatch()
		audioClockAdvancing(watch, 100, 0)
		expect(audioClockAdvancing(watch, 100, 2000)).toBe(false)
		expect(audioClockAdvancing(watch, 200, 2010)).toBe(true)
	})
})
