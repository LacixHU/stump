export const AUDIO_SAMPLE_RATE = 44100
export const AUDIO_FRAMES = 1024
export const AUDIO_CHUNK_FLOATS = AUDIO_FRAMES * 2
export const AUDIO_QUEUE_MAX = 16
export const AUDIO_GAIN = 5

export function enqueueSoundChunks(
	heap: Float32Array,
	samples: number,
	queue: Float32Array[],
	max = AUDIO_QUEUE_MAX,
) {
	const floats = Math.min(heap.length, Math.floor(samples / AUDIO_FRAMES) * AUDIO_CHUNK_FLOATS)
	for (let offset = 0; offset + AUDIO_CHUNK_FLOATS <= floats; offset += AUDIO_CHUNK_FLOATS) {
		if (queue.length >= max) queue.shift()
		queue.push(heap.slice(offset, offset + AUDIO_CHUNK_FLOATS))
	}
}

export function writeSoundOutput(
	left: Float32Array,
	right: Float32Array,
	chunk: Float32Array | undefined,
) {
	if (!chunk) {
		left.fill(0)
		right.fill(0)
		return
	}
	left.set(chunk.subarray(0, AUDIO_FRAMES))
	right.set(chunk.subarray(AUDIO_FRAMES, AUDIO_CHUNK_FLOATS))
}
