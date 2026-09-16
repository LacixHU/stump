import {
	AUDIO_CHUNK_FLOATS,
	AUDIO_FRAMES,
	AUDIO_QUEUE_MAX,
	enqueueSoundChunks,
	writeSoundOutput,
} from '../amiga-audio'

function planar(chunks: number, fill: (chunk: number, channel: 0 | 1, i: number) => number) {
	const heap = new Float32Array(chunks * AUDIO_CHUNK_FLOATS)
	for (let chunk = 0; chunk < chunks; chunk += 1) {
		const base = chunk * AUDIO_CHUNK_FLOATS
		for (let i = 0; i < AUDIO_FRAMES; i += 1) {
			heap[base + i] = fill(chunk, 0, i)
			heap[base + AUDIO_FRAMES + i] = fill(chunk, 1, i)
		}
	}
	return heap
}

describe('Amiga sound queue', () => {
	it('keeps every 1024-frame chunk the WASM copy already drained', () => {
		const queue: Float32Array[] = []
		enqueueSoundChunks(
			planar(2, (chunk, channel) => chunk * 10 + channel),
			2048,
			queue,
		)
		expect(queue).toHaveLength(2)
		expect(queue[0][0]).toBe(0)
		expect(queue[0][AUDIO_FRAMES]).toBe(1)
		expect(queue[1][0]).toBe(10)
		expect(queue[1][AUDIO_FRAMES]).toBe(11)
	})

	it('drops the oldest chunk when the speaker queue is full', () => {
		const queue: Float32Array[] = []
		enqueueSoundChunks(
			planar(AUDIO_QUEUE_MAX + 2, (chunk) => chunk),
			(AUDIO_QUEUE_MAX + 2) * AUDIO_FRAMES,
			queue,
		)
		expect(queue).toHaveLength(AUDIO_QUEUE_MAX)
		expect(queue[0][0]).toBe(2)
		expect(queue[AUDIO_QUEUE_MAX - 1][0]).toBe(AUDIO_QUEUE_MAX + 1)
	})

	it('writes planar L/R into the ScriptProcessor buffers', () => {
		const left = new Float32Array(AUDIO_FRAMES)
		const right = new Float32Array(AUDIO_FRAMES)
		const chunk = planar(1, (_chunk, channel, i) => (channel === 0 ? i : -i))
		writeSoundOutput(left, right, chunk)
		expect(left[3]).toBe(3)
		expect(right[3]).toBe(-3)
		writeSoundOutput(left, right, undefined)
		expect(left[3]).toBe(0)
		expect(right[3]).toBe(0)
	})
})
