import {
	BASIC_START,
	type C64Program,
	firstD64Program,
	firstT64Program,
	isD64Size,
	looksLikeT64,
	programFromPrg,
} from './c64-images'
import { C64_KEYBOARD_JOYSTICK_MAP, retargetC64MixedLetterKey } from './c64-keys'
import type {
	EmulatorMountOptions,
	RetroDiskSpeed,
	RetroEmulatorHandle,
	RetroEmulatorModule,
} from './types'

/** Served from packages/browser/public/retro/c64 (copied from c64-ready). */
const C64_ASSET_BASE = '/retro/c64'
const WASM_URL = `${C64_ASSET_BASE}/c64.wasm`
const WORKLET_URL = `${C64_ASSET_BASE}/audio-worklet-processor.js`

/** What we were handed, before any unwrapping. */
type C64Container = 'prg' | 'd64' | 't64' | 'crt' | 'snapshot'
/** What c64-ready knows how to mount. */
type C64LoadType = 'prg' | 'd64' | 'crt' | 'snapshot'

/** One PAL frame. Only used to ask for a single frame's worth of emulation. */
const FRAME_MS = 1000 / 50
/**
 * Longest real-time gap we hand the emulator in one go. A hidden tab, a stalled
 * main thread or a debugger pause must not turn into a sprint through minutes of
 * emulated time, so anything larger is treated as a single dropped frame.
 */
const MAX_DELTA_MS = 100
/** Wall-clock budget per animation frame for catch-up emulation while warping. */
const WARP_BUDGET_MS = 12
const WARP_MAX_FRAMES = 24
/** c1541_getStatus: 1 = idle, 2 = motor running / transfer in progress. */
const DRIVE_BUSY = 2
/**
 * Emulated frames the 1541 needs between power-on and its first bus transaction.
 *
 * c64_setDriveEnabled starts the drive's ROM self-test, and the drive does not
 * reach its idle loop for the best part of an emulated second. A program that
 * addresses the bus before then loses the ATN handshake, and neither side ever
 * recovers: the C64 spins in the KERNAL serial routines while the drive sits
 * idle. Measured against a real title, the deadlock is certain below 7 frames
 * and gone by 8; this is the drive's own power-on time over again, and warp
 * spends it in a few real milliseconds.
 */
const DRIVE_SPINUP_FRAMES = 60
/** Wall-clock ceiling for a wait denominated in emulated frames. */
const EMULATED_WAIT_TIMEOUT_MS = 5000

const SCREEN_RAM = 0x0400
const SCREEN_CELLS = 1000
/** "READY." in screen codes — the KERNAL is done and the keyboard buffer is live. */
const READY_PROMPT = [0x12, 0x05, 0x01, 0x04, 0x19, 0x2e]
const KEYBOARD_BUFFER_LENGTH = 0x00c6
const KEYBOARD_BUFFER = 0x0277
const KEYBOARD_BUFFER_MAX = 8

/** BASIC's end-of-program / start-of-variables pointers (VARTAB, ARYTAB, STREND). */
const BASIC_POINTERS = [0x002d, 0x002f, 0x0031]
/** Where variables start when no BASIC program is present. */
const EMPTY_BASIC_END = 0x0803
/** Where the KERNAL leaves the address a load started at (MEMUSS) and ended past (EAL). */
const LOAD_START_POINTER = 0x00c3
const LOAD_END_POINTER = 0x00ae

const BOOT_TIMEOUT_MS = 5000
const KEYBOARD_DRAIN_TIMEOUT_MS = 2000
const AUDIO_READY_TIMEOUT_MS = 5000
const AUDIO_PRIME_ATTEMPTS = 8
const AUDIO_PRIME_INTERVAL_MS = 250
/** What c64-ready asks its own AudioContext for, and what it tells the SID to render at. */
const AUDIO_SAMPLE_RATE = 44100
/** The SID's circular buffer, and so the largest chunk a pull can answer with. */
const SID_BUFFER_SAMPLES = 4096

type FrameBufferLike = { width: number; height: number; data: Uint8Array; timestamp: number }

/**
 * The slice of c64-ready's C64Emulator we drive directly. Going through the
 * emulator rather than C64Player lets us insert a disk without triggering the
 * player's scripted `LOAD"*",8,1` and its fixed multi-second waits.
 */
type EmulatorHost = {
	tick: (dTime: number) => void
	onFrame?: (frame: FrameBufferLike) => void
	loadGame: (options: { type: C64LoadType; data: Uint8Array }) => void
	ramRead: (addr: number) => number
	cpuRead: (addr: number) => number
	cpuWrite: (addr: number, value: number) => void
	getSidBuffer: () => Float32Array | null
	wasm?: { exports?: { c1541_getStatus?: () => number } }
}

function inferContainer(byteLength: number, hintName?: string): C64Container {
	const name = (hintName || '').toLowerCase()
	if (name.endsWith('.prg')) return 'prg'
	if (name.endsWith('.crt')) return 'crt'
	if (name.endsWith('.t64')) return 't64'
	if (name.endsWith('.d64') || name.endsWith('.g64')) return 'd64'
	if (name.endsWith('.c64') || name.endsWith('.s64') || name.endsWith('.snapshot')) {
		return 'snapshot'
	}
	if (isD64Size(byteLength)) return 'd64'
	if (byteLength < 65536) return 'prg'
	return 'd64'
}

function toLoadType(container: C64Container): C64LoadType {
	// A .t64 is a tape archive, not a disk — it only ever reaches the emulator
	// as the PRG we pull out of it.
	return container === 't64' ? 'prg' : container
}

/**
 * The program to drop into memory, or null to let the emulated drive load it.
 */
function findAutostartProgram(
	bytes: Uint8Array,
	container: C64Container,
	diskSpeed: RetroDiskSpeed,
): C64Program | null {
	// Tapes and bare programs never touch the drive, so disk speed does not apply
	// to them — and for a tape there is no fallback either, since c64-ready has no
	// way to mount a .t64.
	if (container === 'prg') return programFromPrg(bytes)
	if (container === 't64' || looksLikeT64(bytes)) return firstT64Program(bytes)
	if (container !== 'd64' || diskSpeed !== 'instant') return null
	// A disk we decline still loads the authentic way, so only take it over when
	// RUN is certain to work.
	const program = firstD64Program(bytes)
	return program?.loadAddress === BASIC_START ? program : null
}

/**
 * How to start a program already sitting in memory. Machine code has no BASIC
 * line to RUN; by tape and PRG convention its entry point is its load address.
 */
function startCommand(program: C64Program): string {
	return program.loadAddress === BASIC_START ? 'run\n' : `sys ${program.loadAddress}\n`
}

function writePointer(host: EmulatorHost, pointer: number, address: number): void {
	host.cpuWrite(pointer, address & 0xff)
	host.cpuWrite(pointer + 1, (address >> 8) & 0xff)
}

function setBasicPointers(host: EmulatorHost, address: number): void {
	for (const pointer of BASIC_POINTERS) {
		writePointer(host, pointer, address)
	}
}

/** One past the last byte a load writes: the two-byte load address never reaches RAM. */
function programEnd(program: C64Program): number {
	return program.loadAddress + program.prg.length - 2
}

/**
 * Point BASIC at an empty program. c64_loadPRG sets the variable pointers past
 * whatever it just injected, which leaves them well outside BASIC RAM for a
 * machine-code load — enough to upset the interpreter before it reaches our SYS.
 */
function clearBasicProgram(host: EmulatorHost): void {
	host.cpuWrite(BASIC_START, 0)
	host.cpuWrite(BASIC_START + 1, 0)
	setBasicPointers(host, EMPTY_BASIC_END)
}

/**
 * Say where the file went, the way a KERNAL LOAD would have.
 *
 * Injecting a program is not a load, so nothing writes the bookkeeping a load
 * leaves behind. A single-file crack needs it: the depacker wrapped around the
 * game has to know where its packed data ends, and reads whichever pointer its
 * author preferred — $ae from the KERNAL, or the variable pointers BASIC copies
 * it into. Neither is set correctly for us. c64_loadPRG does move the variable
 * pointers, but it counts the two-byte load address as if it had been written to
 * RAM, so they land one byte past where the KERNAL puts them; $ae and $c3 it
 * leaves alone entirely.
 *
 * Either way the depacker unpacks nonsense over itself, which presents as a
 * machine that stops rather than as an error.
 */
function setLoadExtent(host: EmulatorHost, program: C64Program): void {
	writePointer(host, LOAD_START_POINTER, program.loadAddress)
	writePointer(host, LOAD_END_POINTER, programEnd(program))
}

function isAtBasicPrompt(host: EmulatorHost): boolean {
	for (let cell = 0; cell <= SCREEN_CELLS - READY_PROMPT.length; cell += 1) {
		let matched = true
		for (let i = 0; i < READY_PROMPT.length; i += 1) {
			if (host.ramRead(SCREEN_RAM + cell + i) !== READY_PROMPT[i]) {
				matched = false
				break
			}
		}
		if (matched) return true
	}
	return false
}

/** Type into the KERNAL keyboard buffer, which only holds ten characters. */
async function typeText(host: EmulatorHost, text: string): Promise<void> {
	const bytes = [...text.toUpperCase()].map((char) => (char === '\n' ? 13 : char.charCodeAt(0)))
	while (bytes.length > 0) {
		await waitUntil(() => host.cpuRead(KEYBOARD_BUFFER_LENGTH) === 0, KEYBOARD_DRAIN_TIMEOUT_MS)
		const chunk = bytes.splice(0, KEYBOARD_BUFFER_MAX)
		host.cpuWrite(KEYBOARD_BUFFER_LENGTH, chunk.length)
		chunk.forEach((byte, index) => host.cpuWrite(KEYBOARD_BUFFER + index, byte))
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		const deadline = performance.now() + timeoutMs
		const poll = () => {
			if (predicate()) {
				resolve(true)
			} else if (performance.now() >= deadline) {
				resolve(false)
			} else {
				setTimeout(poll, 8)
			}
		}
		poll()
	})
}

/**
 * Whether this page is allowed an AudioWorklet at all.
 *
 * Worklets are a secure-context feature, so on a Stump served over plain HTTP they exist
 * at `localhost` and nowhere else — reach the same server by IP or machine name, which is
 * how every other device on the LAN reaches it, and `audioWorklet` is simply not there.
 * c64-ready catches the failure and plays on in silence, so we have to notice for it.
 */
function canUseAudioWorklet(): boolean {
	return typeof AudioContext !== 'undefined' && 'audioWorklet' in AudioContext.prototype
}

/**
 * Pull the SID through a ScriptProcessorNode instead of the worklet.
 *
 * Deprecated, and it runs on the main thread — but it carries no secure-context
 * requirement, and reading the SID's buffer from it is exactly what c64.js did before
 * worklets existed. The context is asked for the rate the SID is already rendering at, so
 * neither side has to be told about the other.
 */
function createSidPump(host: EmulatorHost): { resume: () => void; destroy: () => void } {
	const context = new AudioContext({ sampleRate: AUDIO_SAMPLE_RATE })
	const node = context.createScriptProcessor(SID_BUFFER_SAMPLES, 0, 1)

	node.onaudioprocess = (event) => {
		const output = event.outputBuffer.getChannelData(0)
		const samples = host.getSidBuffer()
		if (samples && samples.length >= output.length) {
			output.set(samples.subarray(0, output.length))
		} else {
			output.fill(0)
		}
	}
	node.connect(context.destination)

	return {
		resume: () => void context.resume().catch(() => undefined),
		destroy: () => {
			node.onaudioprocess = null
			node.disconnect()
			void context.close().catch(() => undefined)
		},
	}
}

/**
 * C64 emulator via c64-ready (WASM, MIT; based on c64.js / lvllvl).
 * Fully dynamic import so React/main bundle never share its graph.
 */
async function create(options: EmulatorMountOptions): Promise<RetroEmulatorHandle> {
	const { canvas, image, fileName } = options
	const container = inferContainer(image.byteLength, fileName)
	const bytes = new Uint8Array(image)

	let diskSpeed: RetroDiskSpeed = options.diskSpeed ?? 'instant'
	// Injecting the program skips the emulated 1541 entirely: a disk load that
	// costs ~2 emulated minutes becomes a memcpy.
	let program = findAutostartProgram(bytes, container, diskSpeed)
	let disk = container === 'd64' ? bytes : null

	// There is no fallback for a tape: handing the raw container to the emulator
	// would inject the .t64 header itself as if it were program bytes.
	if (container === 't64' && !program) {
		throw new Error('No program found in this tape image (.t64 directory is empty or damaged)')
	}

	const { CanvasRenderer, C64Player } = await import('c64-ready')

	canvas.width = 384
	canvas.height = 272
	canvas.tabIndex = 0
	canvas.style.outline = 'none'
	canvas.focus()

	const renderer = new CanvasRenderer(canvas)
	const player = new C64Player({
		wasmUrl: WASM_URL,
		gameUrl: 'null',
		// When we autostart ourselves the player must boot to a bare prompt and
		// leave the loading to us.
		gameData: program ? undefined : bytes,
		gameType: toLoadType(container),
		gameSource: `stump-play-file.${container}`,
		renderer,
		audio: {
			workletUrl: WORKLET_URL,
			assetBaseUrl: C64_ASSET_BASE,
		},
		onProgress: (percent, label) => {
			renderer.setProgress(percent, label)
			if (percent >= 100) renderer.hideLoader()
		},
	})

	let host: EmulatorHost | null = null
	let frameRaf = 0
	let forceWarp = false
	/** Frames the core has actually been ticked, so a wait can be denominated in emulated time. */
	let framesEmulated = 0
	let sidPump: { resume: () => void; destroy: () => void } | null = null

	const isDriveBusy = () => host?.wasm?.exports?.c1541_getStatus?.() === DRIVE_BUSY

	const origDetach = renderer.detach.bind(renderer)
	renderer.detach = () => {
		if (frameRaf) {
			cancelAnimationFrame(frameRaf)
			frameRaf = 0
		}
		origDetach()
	}

	renderer.attachTo = (emulator) => {
		renderer.detach()
		host = emulator as unknown as EmulatorHost
		const runTick = emulator.tick.bind(emulator)
		let skipRender = false
		emulator.onFrame = (frame) => {
			if (!skipRender) renderer.render(frame)
		}

		// tick() takes real elapsed milliseconds: the emulator accumulates them and
		// releases a frame only once a full PAL frame is due. Feeding it a constant
		// 20 ms per animation frame instead ties the machine to the display, so a
		// 60 Hz panel runs it 20% fast and a 144 Hz one nearly three times fast —
		// audible immediately, since the SID then produces samples faster than the
		// 44.1 kHz worklet drains them.
		let lastTimestamp = 0

		const loop = (timestamp: number) => {
			frameRaf = requestAnimationFrame(loop)
			const elapsed = lastTimestamp ? timestamp - lastTimestamp : FRAME_MS
			lastTimestamp = timestamp
			const delta = elapsed > 0 && elapsed <= MAX_DELTA_MS ? elapsed : FRAME_MS
			// debugger_update() advances at most two frames per call, so catching
			// up means calling it repeatedly — bounded by wall clock so the tab
			// stays responsive, and without painting frames nobody will see.
			if (diskSpeed === 'instant' && (forceWarp || isDriveBusy())) {
				const deadline = performance.now() + WARP_BUDGET_MS
				skipRender = true
				for (let i = 0; i < WARP_MAX_FRAMES && performance.now() < deadline; i += 1) {
					runTick(FRAME_MS)
					framesEmulated += 1
				}
				skipRender = false
			}
			runTick(delta)
			framesEmulated += 1
		}
		frameRaf = requestAnimationFrame(loop)
	}

	/**
	 * Wait out a stretch of emulated time. Only the frame loop advances the core, so
	 * this is measured in ticks rather than wall clock — under warp it costs a
	 * fraction of the emulated duration, and it gives up rather than hanging if the
	 * loop is not running at all (a hidden tab suspends requestAnimationFrame).
	 */
	const waitForEmulatedFrames = (frames: number) => {
		const target = framesEmulated + frames
		return waitUntil(() => framesEmulated >= target, EMULATED_WAIT_TIMEOUT_MS)
	}

	/** Boot to the BASIC prompt, drop the program straight into RAM, RUN it. */
	const autostart = async (target: C64Program) => {
		if (!host) return
		forceWarp = true
		try {
			// Power the drive up before anything can address the bus: the disk has to
			// stay in it for a multi-load game, and its self-test has to finish first
			// or the game's very first LOAD deadlocks against a drive still booting.
			if (disk) {
				host.loadGame({ type: 'd64', data: disk })
				await waitForEmulatedFrames(DRIVE_SPINUP_FRAMES)
				if (!host) return
			}
			await waitUntil(() => (host ? isAtBasicPrompt(host) : false), BOOT_TIMEOUT_MS)
			if (!host) return
			host.loadGame({ type: 'prg', data: target.prg })
			setLoadExtent(host, target)
			if (target.loadAddress === BASIC_START) {
				setBasicPointers(host, programEnd(target))
			} else {
				clearBasicProgram(host)
			}
			await typeText(host, startCommand(target))
		} finally {
			forceWarp = false
		}
	}

	/**
	 * Keep the audio pump primed.
	 *
	 * The worklet asks for samples exactly once and will not ask again until it
	 * gets a reply, while the engine drops that request if the AudioContext is
	 * still flagged suspended — and it stays flagged that way until an awaited
	 * resume() updates it. A request lost in that window silences the SID for the
	 * rest of the session. resume() ends by feeding the worklet, so retrying it
	 * until the context really is running answers the pending request and
	 * restarts the pump.
	 */
	const primeAudio = async () => {
		await waitUntil(() => player.audio.ready, AUDIO_READY_TIMEOUT_MS)
		for (let attempt = 0; attempt < AUDIO_PRIME_ATTEMPTS; attempt += 1) {
			await player.audio.resume().catch(() => undefined)
			if (!player.audio.suspended) return
			await delay(AUDIO_PRIME_INTERVAL_MS)
		}
	}

	/**
	 * Any gesture lifts the autoplay block, but only a pointer was ever listened for
	 * — and a C64 is played on the keyboard. Open the player straight on its URL, or
	 * reload it there, and a session that never happens to click stays silent for as
	 * long as it lasts.
	 */
	const unlockAudio = () => {
		if (sidPump) {
			sidPump.resume()
			return
		}
		if (player.audio.ready && !player.audio.suspended) return
		void primeAudio()
	}

	const swallowKeyRepeat = (event: KeyboardEvent) => {
		if (!event.repeat) return
		event.preventDefault()
		event.stopImmediatePropagation()
	}

	window.addEventListener('pointerdown', unlockAudio, true)
	window.addEventListener('keydown', unlockAudio, true)
	window.addEventListener('keydown', swallowKeyRepeat, true)
	window.addEventListener('keydown', retargetC64MixedLetterKey, true)
	window.addEventListener('keyup', retargetC64MixedLetterKey, true)
	canvas.addEventListener('pointerdown', unlockAudio)

	await player.start()
	if (program) {
		await autostart(program)
	}
	renderer.hideLoader(0)
	if (canUseAudioWorklet()) {
		await player.audio.init().catch(() => undefined)
	} else if (host) {
		sidPump = createSidPump(host)
	}
	unlockAudio()
	player.setKeyboardJoystickMap(C64_KEYBOARD_JOYSTICK_MAP)
	player.setInputMode('mixed')
	player.setFastForwardSpeed(100)

	return {
		destroy: () => {
			window.removeEventListener('pointerdown', unlockAudio, true)
			window.removeEventListener('keydown', unlockAudio, true)
			window.removeEventListener('keydown', swallowKeyRepeat, true)
			window.removeEventListener('keydown', retargetC64MixedLetterKey, true)
			window.removeEventListener('keyup', retargetC64MixedLetterKey, true)
			canvas.removeEventListener('pointerdown', unlockAudio)
			sidPump?.destroy()
			sidPump = null
			void player.destroy()
		},
		saveState: async () => {
			const snap = player.getSnapshot()
			if (!snap?.byteLength) return null
			return snap.buffer.slice(snap.byteOffset, snap.byteOffset + snap.byteLength)
		},
		loadState: async (data) => {
			await player.loadGameData(data, 'snapshot', 'stump-save-state')
		},
		mountImage: async (nextImage, nextFileName) => {
			const nextBytes = new Uint8Array(nextImage)
			const nextContainer = inferContainer(nextImage.byteLength, nextFileName || fileName)
			disk = nextContainer === 'd64' ? nextBytes : null
			program = findAutostartProgram(nextBytes, nextContainer, diskSpeed)

			// Swapping a disk must not reset the machine — a game mid-run expects
			// to find the next side in the drive, nothing more.
			if (disk && host) {
				host.loadGame({ type: 'd64', data: disk })
				return
			}
			if (nextContainer === 't64' && !program) {
				throw new Error('No program found in this tape image (.t64 directory is empty or damaged)')
			}
			if (program && host) {
				// Unlike a disk side, a different tape or program is a different
				// game: reset first so it starts from a clean prompt.
				player.hardReset()
				await autostart(program)
				return
			}
			const nextType = toLoadType(nextContainer)
			await player.loadGameData(nextBytes, nextType, `stump-disk.${nextType}`)
		},
		reset: () => {
			player.hardReset()
			canvas.focus()
			if (program) {
				void autostart(program)
			}
		},
		setInputMode: (mode) => {
			player.setInputMode(mode)
		},
		setJoystickPort: (port) => {
			player.setKeyboardJoystickPort(port)
		},
		setDiskSpeed: (speed) => {
			diskSpeed = speed
			player.setFastForwardSpeed(100)
		},
	}
}

const module: RetroEmulatorModule = {
	platform: 'c64',
	label: 'Commodore 64',
	create,
}

export default module
