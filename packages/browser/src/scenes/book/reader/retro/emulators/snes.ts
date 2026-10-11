import type { Dispatchable } from '../keys'
import { SnesAudioRing } from './snes-audio'
import {
	isSnesKey,
	keyboardButton,
	maskFor,
	mergeMasks,
	overlayButton,
	readGamepad,
	type SnesHeld,
} from './snes-keys'
import { packSnesSave, unpackSnesSave } from './snes-saves'
import {
	audioClockAdvancing,
	audioTargetFrames,
	framesForAudioClock,
	framesForWallClock,
	newAudioClockWatch,
	newWallClock,
} from './snes-timing'
import { frameGeometry } from './snes-video'
import type { EmulatorMountOptions, RetroEmulatorHandle, RetroEmulatorModule } from './types'

/**
 * Versioned: `/retro/*` is served immutable for a year and its files are not hashed, so a new
 * build of the core goes in a new directory (and this constant moves with it).
 */
const ASSET_BASE = '/retro/snes/v1'
const SCRIPT_URL = `${ASSET_BASE}/snes9x.js`

const REGION_AUTO = 0
const INTERPOLATION_GAUSSIAN = 2
const LOG_ERRORS = 1

const SRAM_SAVE_INTERVAL_MS = 15000
const AUDIO_CHUNK_FRAMES = 2048

/**
 * What the Snes9x shim exports (see the README next to the core). Every entry point is a flat
 * C function: the host asks for one frame at a time, so there is no main loop to stop, no SDL
 * and no Asyncify.
 */
type Snes9xModule = {
	HEAP16: Int16Array
	HEAPU8: Uint8Array
	_free(ptr: number): void
	_malloc(size: number): number
	_s9xwasm_audio_ptr(): number
	_s9xwasm_exec(): number
	_s9xwasm_frame_height(): number
	_s9xwasm_frame_rgba(): number
	_s9xwasm_frame_width(): number
	_s9xwasm_framerate_micro(): number
	_s9xwasm_input(pad: number, mask: number): void
	_s9xwasm_load_rom(ptr: number, size: number): number
	_s9xwasm_reset(): void
	_s9xwasm_set_loglevel(level: number): void
	_s9xwasm_setup(sampleRate: number, region: number, interpolation: number): number
	_s9xwasm_skip_render(skip: number): void
	_s9xwasm_sram_ptr(): number
	_s9xwasm_sram_size(): number
	_s9xwasm_state_load(ptr: number, size: number): number
	_s9xwasm_state_save(): number
	_s9xwasm_state_size(): number
}

type Snes9xFactory = (overrides: { locateFile: (path: string) => string }) => Promise<Snes9xModule>

let scriptLoad: Promise<void> | null = null

function loadScriptOnce(): Promise<void> {
	if (!scriptLoad) {
		scriptLoad = new Promise<void>((resolve, reject) => {
			const script = document.createElement('script')
			script.src = SCRIPT_URL
			script.async = true
			script.onload = () => resolve()
			script.onerror = () => {
				// A failed load must be retryable, not remembered
				scriptLoad = null
				script.remove()
				reject(new Error('Could not load the Super Nintendo emulator core'))
			}
			document.head.appendChild(script)
		})
	}
	return scriptLoad
}

function isTypingTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false
	return target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)
}

// ---------------------------------------------------------------------- cartridge saves
// Battery RAM stays in the browser, keyed by file name (IndexedDB, because the Origin Private
// File System needs a secure context and Stump is usually served over plain HTTP). Save
// states are the cross-device way to keep progress.

const DB_NAME = 'stump-snes'
const STORE = 'cartridge'

function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		try {
			const request = indexedDB.open(DB_NAME, 1)
			request.onupgradeneeded = () => request.result.createObjectStore(STORE)
			request.onsuccess = () => resolve(request.result)
			request.onerror = () => reject(request.error)
		} catch (error) {
			reject(error)
		}
	})
}

async function readSram(name: string): Promise<Uint8Array | null> {
	try {
		const db = await openDb()
		return await new Promise((resolve) => {
			const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(name)
			request.onsuccess = () => resolve(request.result ? new Uint8Array(request.result) : null)
			request.onerror = () => resolve(null)
		})
	} catch {
		// no storage (a private window): the game starts with an empty cartridge
		return null
	}
}

async function writeSram(name: string, data: Uint8Array): Promise<void> {
	try {
		const db = await openDb()
		db.transaction(STORE, 'readwrite').objectStore(STORE).put(data, name)
	} catch {
		// best effort
	}
}

function sameBytes(a: Uint8Array | null, b: Uint8Array): boolean {
	if (!a || a.byteLength !== b.byteLength) return false
	for (let i = 0; i < a.byteLength; i++) {
		if (a[i] !== b[i]) return false
	}
	return true
}

async function create(options: EmulatorMountOptions): Promise<RetroEmulatorHandle> {
	const { canvas, image, fileName } = options
	const saveName = fileName ?? 'game'

	const ctx2d = canvas.getContext('2d')
	if (!ctx2d) {
		throw new Error('The picture surface is in use by another emulator; reload the page and retry')
	}

	const AudioContextCtor = window.AudioContext
	const audio = new AudioContextCtor({ latencyHint: 'interactive' })
	const sampleRate = Math.round(audio.sampleRate)
	const ring = new SnesAudioRing()
	const gain = audio.createGain()
	gain.gain.value = 1
	gain.connect(audio.destination)
	// A ScriptProcessor, not an AudioWorklet: worklets need a secure context
	const processor = audio.createScriptProcessor(AUDIO_CHUNK_FRAMES, 0, 2)
	processor.onaudioprocess = (event) => {
		ring.pull(event.outputBuffer.getChannelData(0), event.outputBuffer.getChannelData(1))
	}
	processor.connect(gain)

	const previousRendering = canvas.style.imageRendering
	let mod: Snes9xModule | null = null
	let alive = true

	const abandon = () => {
		alive = false
		try {
			processor.disconnect()
			gain.disconnect()
			void audio.close()
		} catch {
			// already closed
		}
	}

	let framerate = 60
	let audioFramesPerExec = sampleRate / framerate
	let sramSize = 0
	let lastSavedSram: Uint8Array | null = null

	try {
		await loadScriptOnce()
		const factory = (globalThis as { createSnes9xModule?: Snes9xFactory }).createSnes9xModule
		if (typeof factory !== 'function') {
			throw new Error('The Super Nintendo emulator core did not initialise')
		}
		mod = await factory({ locateFile: (path) => `${ASSET_BASE}/${path}` })

		mod._s9xwasm_set_loglevel(LOG_ERRORS)
		// The APU resamples to whatever rate it is given, so the audio device's own rate
		// means no second resampling stage here
		if (!mod._s9xwasm_setup(sampleRate, REGION_AUTO, INTERPOLATION_GAUSSIAN)) {
			throw new Error('The Super Nintendo emulator core failed to initialise')
		}

		const romPtr = mod._malloc(image.byteLength)
		mod.HEAPU8.set(new Uint8Array(image), romPtr)
		const loaded = mod._s9xwasm_load_rom(romPtr, image.byteLength)
		mod._free(romPtr)
		if (!loaded) {
			throw new Error('This is not a valid Super Nintendo ROM (.sfc / .smc)')
		}

		// The region (and so the frame rate) comes from the cartridge header
		framerate = mod._s9xwasm_framerate_micro() / 1e6 || 60
		audioFramesPerExec = sampleRate / framerate

		// Battery RAM lives inside the cartridge's memory map, so it is restored after power-on
		mod._s9xwasm_reset()
		sramSize = mod._s9xwasm_sram_size()
		if (sramSize > 0) {
			const saved = await readSram(saveName)
			if (saved && saved.byteLength === sramSize) {
				mod.HEAPU8.set(saved, mod._s9xwasm_sram_ptr())
				lastSavedSram = saved
			}
		}
	} catch (error) {
		abandon()
		throw error instanceof Error ? error : new Error(String(error))
	}
	const core = mod

	// ------------------------------------------------------------------ video
	const source = document.createElement('canvas')
	const sourceCtx = source.getContext('2d')
	let frameImage: ImageData | null = null
	// The 4x scaled picture is already crisp, so the browser may smooth the final downscale
	canvas.style.imageRendering = 'auto'

	const renderFrame = () => {
		const w = core._s9xwasm_frame_width()
		const h = core._s9xwasm_frame_height()
		if (w <= 0 || h <= 0 || !sourceCtx) return
		const geometry = frameGeometry(w, h)
		if (!frameImage || source.width !== w || source.height !== geometry.srcH) {
			source.width = w
			source.height = geometry.srcH
			frameImage = sourceCtx.createImageData(w, geometry.srcH)
		}
		if (canvas.width !== geometry.canvasW || canvas.height !== geometry.canvasH) {
			canvas.width = geometry.canvasW
			canvas.height = geometry.canvasH
		}
		const start = core._s9xwasm_frame_rgba() + geometry.srcY * w * 4
		frameImage.data.set(core.HEAPU8.subarray(start, start + w * geometry.srcH * 4))
		sourceCtx.putImageData(frameImage, 0, 0)
		// Resizing a canvas resets its state, so the scaling mode is set every frame
		ctx2d.imageSmoothingEnabled = false
		ctx2d.drawImage(source, 0, 0, w, geometry.srcH, 0, 0, geometry.canvasW, geometry.canvasH)
	}

	// ------------------------------------------------------------------ input
	const keyboardHeld: SnesHeld = {}
	const overlayHeld: SnesHeld = {}
	let padMask = 0
	let sentMask = -1

	const pushInput = () => {
		const mask = mergeMasks([maskFor(keyboardHeld), maskFor(overlayHeld), padMask])
		if (mask !== sentMask) {
			sentMask = mask
			core._s9xwasm_input(0, mask)
		}
	}

	const resumeAudio = () => {
		if (audio.state === 'suspended') void audio.resume().catch(() => {})
	}

	const onKey = (down: boolean) => (event: KeyboardEvent) => {
		if (!isSnesKey(event.code) || isTypingTarget(event.target)) return
		// The page would otherwise scroll on the arrows
		event.preventDefault()
		if (event.repeat) return
		const button = keyboardButton(event.code)
		if (!button) return
		keyboardHeld[button] = down
		if (down) resumeAudio()
		pushInput()
	}
	const onKeyDown = onKey(true)
	const onKeyUp = onKey(false)

	const releaseAll = () => {
		for (const held of [keyboardHeld, overlayHeld]) {
			for (const key of Object.keys(held)) delete held[key as keyof SnesHeld]
		}
		pushInput()
	}

	window.addEventListener('keydown', onKeyDown, true)
	window.addEventListener('keyup', onKeyUp, true)
	window.addEventListener('blur', releaseAll)
	window.addEventListener('pointerdown', resumeAudio, true)

	let padWasActive = false
	const pollGamepad = () => {
		const pads = navigator.getGamepads?.() ?? []
		const connected = pads.find((p): p is Gamepad => !!p && p.connected && p.buttons.length > 0)
		const next = connected ? readGamepad(connected) : 0
		// Audio can only start after a gesture, and a pad press is the only one a player on a pad makes
		if (next !== 0 && !padWasActive) resumeAudio()
		padWasActive = next !== 0
		if (next !== padMask) {
			padMask = next
			pushInput()
		}
	}

	// ------------------------------------------------------------------- loop
	const targetFrames = audioTargetFrames(sampleRate)
	const clockWatch = newAudioClockWatch()
	let wallClock = newWallClock()
	let onWallClock = false
	let raf = 0

	const runFrames = (count: number) => {
		for (let i = 0; i < count; i++) {
			// Only the last frame of a catch-up burst is drawn
			core._s9xwasm_skip_render(i < count - 1 ? 1 : 0)
			const samples = core._s9xwasm_exec()
			if (samples > 0) {
				const at = core._s9xwasm_audio_ptr() >> 1
				ring.push(core.HEAP16.subarray(at, at + samples), samples)
			}
		}
	}

	const tick = (now: number) => {
		if (!alive) return
		raf = window.requestAnimationFrame(tick)
		pollGamepad()

		let frames: number
		if (audio.state === 'running' && audioClockAdvancing(clockWatch, ring.consumed, now)) {
			if (onWallClock) {
				// Whatever the wall clock queued while audio was stalled is stale now
				ring.clear()
				onWallClock = false
			}
			wallClock = newWallClock()
			frames = framesForAudioClock(ring.buffered, targetFrames, audioFramesPerExec)
		} else {
			onWallClock = true
			frames = framesForWallClock(wallClock, now, framerate)
		}

		if (frames > 0) {
			runFrames(frames)
			renderFrame()
		}
	}
	raf = window.requestAnimationFrame(tick)
	resumeAudio()

	// ---------------------------------------------------------------- saving
	const flushSram = async () => {
		if (sramSize <= 0) return
		const ptr = core._s9xwasm_sram_ptr()
		const bytes = core.HEAPU8.slice(ptr, ptr + sramSize)
		if (sameBytes(lastSavedSram, bytes)) return
		lastSavedSram = bytes
		await writeSram(saveName, bytes)
	}
	const sramTimer = window.setInterval(() => void flushSram(), SRAM_SAVE_INTERVAL_MS)
	const onHide = () => {
		if (document.visibilityState === 'hidden') void flushSram()
	}
	document.addEventListener('visibilitychange', onHide)
	window.addEventListener('pagehide', onHide)

	return {
		destroy: () => {
			if (!alive) return
			// Last: the heap is read to write the final cartridge save
			void flushSram()
			alive = false
			window.cancelAnimationFrame(raf)
			window.clearInterval(sramTimer)
			window.removeEventListener('keydown', onKeyDown, true)
			window.removeEventListener('keyup', onKeyUp, true)
			window.removeEventListener('blur', releaseAll)
			window.removeEventListener('pointerdown', resumeAudio, true)
			document.removeEventListener('visibilitychange', onHide)
			window.removeEventListener('pagehide', onHide)
			canvas.style.imageRendering = previousRendering
			try {
				processor.onaudioprocess = null
				processor.disconnect()
				gain.disconnect()
				void audio.close()
			} catch {
				// already closed
			}
		},
		loadState: async (data) => {
			const state = unpackSnesSave(data)
			const ptr = core._malloc(state.byteLength)
			core.HEAPU8.set(state, ptr)
			const ok = core._s9xwasm_state_load(ptr, state.byteLength)
			core._free(ptr)
			if (!ok) throw new Error('The emulator could not load this save state')
			ring.clear()
			sentMask = -1
			pushInput()
		},
		reset: () => {
			core._s9xwasm_reset()
			ring.clear()
		},
		saveState: async () => {
			const size = core._s9xwasm_state_size()
			const ptr = core._s9xwasm_state_save()
			if (!ptr || !size) throw new Error('The emulator could not save its state')
			return packSnesSave(core.HEAPU8.slice(ptr, ptr + size))
		},
		sendKey: (target: Dispatchable, down) => {
			const button = overlayButton(target)
			if (!button) return
			overlayHeld[button] = down
			if (down) resumeAudio()
			pushInput()
		},
	}
}

const module: RetroEmulatorModule = {
	create,
	label: 'Super Nintendo',
	platform: 'snes',
}

export default module
