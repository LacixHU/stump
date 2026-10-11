/**
 * A single-producer, single-consumer ring of stereo audio. The emulator pushes each frame's
 * interleaved 16-bit samples in; the audio callback pulls floats out. Both run on the main
 * thread (Stump cannot use an AudioWorklet over plain HTTP), so there is no locking, just two
 * running counters.
 */
export class SnesAudioRing {
	private readonly samples: Float32Array
	/** Frames ever written / read; their difference is what is queued. */
	private written = 0
	private read = 0

	constructor(readonly capacityFrames = 32768) {
		this.samples = new Float32Array(capacityFrames * 2)
	}

	/** Frames waiting to be played. */
	get buffered(): number {
		return this.written - this.read
	}

	/** Frames played so far, which only moves while an output is pulling. */
	get consumed(): number {
		return this.read
	}

	/** Queue `sampleCount` interleaved int16 samples (so `sampleCount / 2` frames); excess is dropped. */
	push(source: Int16Array, sampleCount: number = source.length): void {
		const frames = Math.min(sampleCount >> 1, source.length >> 1)
		for (let i = 0; i < frames; i++) {
			if (this.written - this.read >= this.capacityFrames) return
			const slot = (this.written % this.capacityFrames) * 2
			this.samples[slot] = (source[i * 2] ?? 0) / 32768
			this.samples[slot + 1] = (source[i * 2 + 1] ?? 0) / 32768
			this.written++
		}
	}

	/** Fill both channels, padding with silence when the queue runs dry. Returns frames of real audio played. */
	pull(left: Float32Array, right: Float32Array): number {
		const wanted = Math.min(left.length, right.length)
		let played = 0
		for (let i = 0; i < wanted; i++) {
			if (this.read < this.written) {
				const slot = (this.read % this.capacityFrames) * 2
				left[i] = this.samples[slot] ?? 0
				right[i] = this.samples[slot + 1] ?? 0
				this.read++
				played++
			} else {
				left[i] = 0
				right[i] = 0
			}
		}
		return played
	}

	clear(): void {
		this.read = this.written
	}
}
