import { SnesAudioRing } from '../snes-audio'

const stereo = (...pairs: [number, number][]) => Int16Array.from(pairs.flat())

describe('SnesAudioRing', () => {
	it('starts empty and silent', () => {
		const ring = new SnesAudioRing(8)
		const left = new Float32Array(4).fill(9)
		const right = new Float32Array(4).fill(9)
		expect(ring.buffered).toBe(0)
		expect(ring.pull(left, right)).toBe(0)
		expect(Array.from(left)).toEqual([0, 0, 0, 0])
		expect(Array.from(right)).toEqual([0, 0, 0, 0])
		expect(ring.consumed).toBe(0)
	})

	it('scales 16-bit samples to floats and keeps the channels apart', () => {
		const ring = new SnesAudioRing(8)
		ring.push(stereo([16384, -16384], [-32768, 32767]))
		const left = new Float32Array(2)
		const right = new Float32Array(2)
		expect(ring.pull(left, right)).toBe(2)
		expect(left[0]).toBeCloseTo(0.5)
		expect(right[0]).toBeCloseTo(-0.5)
		expect(left[1]).toBeCloseTo(-1)
		expect(right[1]).toBeCloseTo(32767 / 32768)
	})

	it('counts queued and consumed frames', () => {
		const ring = new SnesAudioRing(8)
		ring.push(stereo([1, 1], [2, 2], [3, 3]))
		expect(ring.buffered).toBe(3)
		ring.pull(new Float32Array(2), new Float32Array(2))
		expect(ring.buffered).toBe(1)
		expect(ring.consumed).toBe(2)
	})

	it('pads with silence when the queue runs dry, and counts only real audio', () => {
		const ring = new SnesAudioRing(8)
		ring.push(stereo([32767, 32767]))
		const left = new Float32Array(3).fill(5)
		const right = new Float32Array(3).fill(5)
		expect(ring.pull(left, right)).toBe(1)
		expect(left[1]).toBe(0)
		expect(right[2]).toBe(0)
		expect(ring.consumed).toBe(1)
	})

	it('wraps around the end of the ring without losing order', () => {
		const ring = new SnesAudioRing(4)
		const left = new Float32Array(3)
		const right = new Float32Array(3)
		ring.push(stereo([100, 0], [200, 0], [300, 0]))
		ring.pull(left, right)
		ring.push(stereo([400, 0], [500, 0], [600, 0]))
		ring.pull(left, right)
		expect(Array.from(left).map((v) => Math.round(v * 32768))).toEqual([400, 500, 600])
	})

	it('drops what does not fit instead of overwriting audio still queued', () => {
		const ring = new SnesAudioRing(2)
		ring.push(stereo([100, 0], [200, 0], [300, 0]))
		expect(ring.buffered).toBe(2)
		const left = new Float32Array(2)
		ring.pull(left, new Float32Array(2))
		expect(Array.from(left).map((v) => Math.round(v * 32768))).toEqual([100, 200])
	})

	it('pushes only as many samples as it is told', () => {
		const ring = new SnesAudioRing(8)
		ring.push(stereo([1, 1], [2, 2], [3, 3]), 4)
		expect(ring.buffered).toBe(2)
	})

	it('clears what is queued without losing the running consumed total', () => {
		const ring = new SnesAudioRing(8)
		ring.push(stereo([1, 1], [2, 2]))
		ring.pull(new Float32Array(1), new Float32Array(1))
		ring.clear()
		expect(ring.buffered).toBe(0)
		expect(ring.consumed).toBe(2)
	})
})
