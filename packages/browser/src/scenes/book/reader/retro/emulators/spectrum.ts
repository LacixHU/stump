import type { OverlayKeyId } from '../keys'
import {
	overlayCombo,
	physicalKeyCombo,
	SPECTRUM_JOYSTICK_LABELS,
	SPECTRUM_JOYSTICK_SCHEMES,
	type SpectrumCombo,
	type SpectrumJoystickScheme,
} from './spectrum-keys'
import type {
	EmulatorMountOptions,
	RetroDiskSpeed,
	RetroEmulatorHandle,
	RetroEmulatorModule,
	RetroOption,
} from './types'

/** Vendored JSSpeccy 3.2 (GPL-3.0); see packages/browser/public/retro/spectrum/README.md. */
const ASSET_BASE = '/retro/spectrum'
const SCRIPT_URL = `${ASSET_BASE}/jsspeccy.js`

/** JSSpeccy's own machine ids: 48K, 128K, Pentagon 128. */
const MACHINES: readonly RetroOption[] = [
	{ id: '128', label: 'Spectrum 128K' },
	{ id: '48', label: 'Spectrum 48K' },
	{ id: '5', label: 'Pentagon 128' },
]
const DEFAULT_MACHINE = '128'

const loaderUrl = (name: string) => `${ASSET_BASE}/tapeloaders/${name}.szx`

/**
 * Snapshots of each machine sitting at its tape-loading prompt. Loading one is how a tape
 * gets started: the ROM's load routine runs, and either the trap turns it into a memcpy or
 * the tape plays into it for real.
 *
 * The 128K machines need a different prompt for each: the 128 ROM's own loader takes a
 * trapped load happily but never picks up the emulated tape's pulses, so real-time loading
 * goes through `usr0` instead -- 48K BASIC reached the way a 128 owner reaches it -- whose
 * ROM routine does.
 */
const DEFAULT_TAPE_LOADERS = {
	realtime: loaderUrl('tape_128_usr0'),
	trapped: loaderUrl('tape_128'),
}
const TAPE_LOADERS: Record<string, { realtime: string; trapped: string }> = {
	'48': { realtime: loaderUrl('tape_48'), trapped: loaderUrl('tape_48') },
	'128': DEFAULT_TAPE_LOADERS,
	'5': { realtime: loaderUrl('tape_pentagon_usr0'), trapped: loaderUrl('tape_pentagon') },
}

const JOYSTICK_SCHEMES: readonly RetroOption[] = SPECTRUM_JOYSTICK_SCHEMES.map((id) => ({
	id,
	label: SPECTRUM_JOYSTICK_LABELS[id],
}))

const TAPE_EXTENSIONS = ['tap', 'tzx']
const SNAPSHOT_EXTENSIONS = ['z80', 'sna', 'szx']

type JSSpeccyOptions = {
	machine?: number
	autoStart?: boolean
	autoLoadTapes?: boolean
	tapeTrapsEnabled?: boolean
	keyboardEnabled?: boolean
	uiEnabled?: boolean
	sandbox?: boolean
	zoom?: number
}

/** The whole of JSSpeccy's public surface that we use. */
type JSSpeccyInstance = {
	setMachine: (model: number) => void
	openUrl: (url: string) => void
	onReady: (callback: () => void) => void
	exit: () => void
}

declare global {
	interface Window {
		JSSpeccy?: (container: HTMLElement, opts: JSSpeccyOptions) => JSSpeccyInstance
	}
}

let scriptPromise: Promise<void> | null = null

/**
 * The bundle resolves its worker, core and ROMs against `document.currentScript.src`, so it
 * has to arrive as a classic script tag -- a dynamic `import()` would leave that null and
 * every asset URL broken.
 */
function loadScript(): Promise<void> {
	if (window.JSSpeccy) return Promise.resolve()
	scriptPromise ??= new Promise<void>((resolve, reject) => {
		const element = document.createElement('script')
		element.src = SCRIPT_URL
		element.async = true
		element.addEventListener('load', () => resolve())
		element.addEventListener('error', () => {
			// A failed load is cached by the browser for this element only; drop the promise
			// so a retry actually retries.
			scriptPromise = null
			element.remove()
			reject(new Error('Failed to load the ZX Spectrum emulator'))
		})
		document.head.appendChild(element)
	})
	return scriptPromise
}

/**
 * Take a reference to the Web Worker JSSpeccy runs its core in.
 *
 * Its public API can open a URL, switch machine and exit, and that is all -- it cannot
 * press a key or accept tape bytes, both of which are worker messages. The worker is
 * constructed synchronously inside the `JSSpeccy()` call, so swapping the constructor for
 * the length of that call is enough to catch it, and nothing else in the app sees the
 * substitution.
 */
function withWorkerCapture(create: () => JSSpeccyInstance): {
	emulator: JSSpeccyInstance
	worker: Worker
} {
	const NativeWorker = window.Worker
	let captured: Worker | null = null
	const capture = (worker: Worker) => {
		captured ??= worker
	}

	class CapturingWorker extends NativeWorker {
		constructor(scriptURL: string | URL, options?: WorkerOptions) {
			super(scriptURL, options)
			capture(this)
		}
	}

	window.Worker = CapturingWorker
	let emulator: JSSpeccyInstance
	try {
		emulator = create()
	} finally {
		window.Worker = NativeWorker
	}

	if (!captured) {
		emulator.exit()
		throw new Error('ZX Spectrum emulator did not start its core')
	}
	return { emulator, worker: captured }
}

/**
 * Catch the AudioContext the emulator creates when it starts.
 *
 * It creates one and never looks at it again, so a context that was born suspended --
 * which is what an autoplay policy does to a page the user has not touched yet -- would
 * stay silent for the whole session with nothing able to resume it.
 */
function withAudioContextCapture(onCapture: (context: AudioContext) => void): () => void {
	const NativeAudioContext = window.AudioContext
	if (!NativeAudioContext) return () => undefined

	let restored = false
	const restore = () => {
		if (restored) return
		restored = true
		window.AudioContext = NativeAudioContext
	}

	class CapturingAudioContext extends NativeAudioContext {
		constructor(contextOptions?: AudioContextOptions) {
			super(contextOptions)
			restore()
			onCapture(this)
		}
	}

	window.AudioContext = CapturingAudioContext
	return restore
}

function extensionOf(fileName?: string): string {
	return (fileName || '').split('.').pop()?.toLowerCase() || ''
}

/**
 * ZX Spectrum via JSSpeccy 3 (GPL-3.0): WASM core in a worker, 48K/128K/Pentagon, AY and
 * beeper audio, instant tape loading through ROM traps.
 */
async function create(options: EmulatorMountOptions): Promise<RetroEmulatorHandle> {
	const { canvas, image, fileName } = options
	const parent = canvas.parentElement
	if (!parent) {
		throw new Error('Retro player canvas is not mounted')
	}

	await loadScript()
	const JSSpeccy = window.JSSpeccy
	if (!JSSpeccy) {
		throw new Error('ZX Spectrum emulator failed to load')
	}

	let machine = DEFAULT_MACHINE
	let diskSpeed: RetroDiskSpeed = options.diskSpeed ?? 'instant'
	let scheme: SpectrumJoystickScheme = 'qaop'
	let current = { image, fileName }

	// JSSpeccy builds its own canvas inside a container of its choosing, so the scene's
	// canvas steps aside for it rather than being drawn into.
	const host = document.createElement('div')
	host.style.position = 'absolute'
	host.style.inset = '0'
	host.style.display = 'flex'
	const canvasDisplay = canvas.style.display
	canvas.style.display = 'none'
	parent.appendChild(host)

	let audioContext: AudioContext | null = null
	const restoreAudioContext = withAudioContextCapture((context) => {
		audioContext = context
	})

	const { emulator, worker } = withWorkerCapture(() =>
		JSSpeccy(host, {
			machine: Number(machine),
			autoStart: true,
			// The tape loader is loaded by hand below, so the image and the loader are never
			// racing each other into the machine.
			autoLoadTapes: false,
			tapeTrapsEnabled: diskSpeed === 'instant',
			// Every key, real or on-screen, goes through the matrix below instead.
			keyboardEnabled: false,
			uiEnabled: false,
			sandbox: true,
		}),
	)

	/**
	 * Tape bytes are posted straight to the worker, which answers with a `fileOpened` the
	 * host never asked for -- and it would look that id up in its table of pending file
	 * opens and call an undefined resolver. Our ids are negative so they cannot collide
	 * with the host's, and its handler never sees them.
	 */
	const OUR_FILE_ID = -1
	// An authentic-speed tape starts rolling only once the machine is sitting in its loader,
	// which arrives as the `fileOpened` for the loader snapshot.
	let startTapeWhenLoaded = false
	const hostOnMessage = worker.onmessage
	worker.onmessage = function (this: Worker, event: MessageEvent) {
		const data = event.data as { message?: string; id?: number; mediaType?: string } | null
		if (data?.message === 'fileOpened') {
			if (data.mediaType === 'snapshot' && startTapeWhenLoaded) {
				startTapeWhenLoaded = false
				worker.postMessage({ message: 'playTape' })
			}
			if (data.id === OUR_FILE_ID) return
		}
		hostOnMessage?.call(this, event)
	}

	await new Promise<void>((resolve) => emulator.onReady(resolve))

	const screen = host.querySelector('canvas')
	if (screen) {
		screen.style.width = '100%'
		screen.style.height = '100%'
		screen.style.objectFit = 'contain'
		screen.style.imageRendering = 'pixelated'
		const appContainer = screen.parentElement
		if (appContainer) {
			appContainer.style.width = '100%'
			appContainer.style.height = '100%'
			appContainer.style.display = 'flex'
			// The only control JSSpeccy renders with its UI switched off is the play button,
			// and the player has its own chrome for that.
			appContainer.querySelectorAll('button').forEach((button) => {
				button.style.display = 'none'
			})
		}
	}

	/**
	 * How many controls are holding each matrix key down.
	 *
	 * CAPS SHIFT is both a cap of its own and half of every cursor key, so two controls can
	 * genuinely hold the same key at once; releasing one of them must not lift it out from
	 * under the other.
	 */
	const holdCounts = new Map<string, number>()

	const hold = (combo: SpectrumCombo, down: boolean) => {
		for (const key of combo) {
			const id = `${key.row}:${key.mask}`
			const count = holdCounts.get(id) ?? 0
			const next = down ? count + 1 : Math.max(0, count - 1)
			holdCounts.set(id, next)
			if (down ? count > 0 : next > 0) continue
			worker.postMessage({
				message: down ? 'keyDown' : 'keyUp',
				row: key.row,
				mask: key.mask,
			})
		}
	}

	// Keyed by what pressed it, holding the combo that went down: the joystick scheme can
	// change while a finger is down, and the release still has to undo what it pressed.
	const pressed = new Map<string, SpectrumCombo>()

	const press = (source: string, combo: SpectrumCombo | null, down: boolean) => {
		if (down) {
			if (!combo || pressed.has(source)) return
			pressed.set(source, combo)
			hold(combo, true)
			return
		}
		const held = pressed.get(source)
		if (!held) return
		pressed.delete(source)
		hold(held, false)
	}

	const releaseAll = () => {
		for (const source of [...pressed.keys()]) {
			press(source, null, false)
		}
	}

	/**
	 * Whether the keystroke belongs to the page rather than the machine. Space and Enter on a
	 * focused button are how a keyboard user works the player's own chrome -- the overlay
	 * editor especially -- and swallowing those would strand them.
	 */
	const isAppControl = (target: EventTarget | null) =>
		target instanceof HTMLElement &&
		(target.isContentEditable ||
			['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName))

	const onKeyDown = (event: KeyboardEvent) => {
		const combo = physicalKeyCombo(event.code)
		if (!combo || isAppControl(event.target)) return
		event.preventDefault()
		if (event.repeat) return
		press(`code:${event.code}`, combo, true)
	}

	const onKeyUp = (event: KeyboardEvent) => {
		if (!physicalKeyCombo(event.code)) return
		// Not gated on the focus check: a key pressed over the playfield and released after
		// tabbing into the chrome still has to come back up on the machine.
		event.preventDefault()
		press(`code:${event.code}`, null, false)
	}

	// Alt-tabbing away mid-jump must not leave the key down for the rest of the session.
	const onBlur = () => releaseAll()

	/**
	 * Any gesture lifts the autoplay block, and a Spectrum is played on the keyboard:
	 * a session that reaches the player without ever clicking would otherwise stay
	 * silent for as long as it lasts.
	 */
	const unlockAudio = () => {
		if (audioContext?.state === 'running') return
		void audioContext?.resume().catch(() => undefined)
	}

	window.addEventListener('keydown', onKeyDown)
	window.addEventListener('keyup', onKeyUp)
	window.addEventListener('blur', onBlur)
	window.addEventListener('pointerdown', unlockAudio, true)
	window.addEventListener('keydown', unlockAudio, true)

	const blobUrls: string[] = []

	const loadImage = (bytes: ArrayBuffer, name?: string) => {
		const extension = extensionOf(name)

		if (TAPE_EXTENSIONS.includes(extension)) {
			worker.postMessage({
				message: extension === 'tzx' ? 'openTZXFile' : 'openTAPFile',
				id: OUR_FILE_ID,
				data: bytes,
			})
			// Boot to the tape-loading prompt; with traps on, the LOAD finishes instantly.
			const loaders = TAPE_LOADERS[machine] ?? DEFAULT_TAPE_LOADERS
			startTapeWhenLoaded = diskSpeed === 'authentic'
			emulator.openUrl(startTapeWhenLoaded ? loaders.realtime : loaders.trapped)
			return
		}

		if (!SNAPSHOT_EXTENSIONS.includes(extension)) {
			throw new Error(`Unsupported ZX Spectrum file type: .${extension || '?'}`)
		}

		// Only the bundle can parse .z80/.sna/.szx, and its one entry point picks the parser
		// off the URL's extension -- which a blob URL does not have. The fragment gives it
		// one; the fetch that follows resolves the blob without it.
		const url = URL.createObjectURL(new Blob([bytes]))
		blobUrls.push(url)
		emulator.openUrl(`${url}#image.${extension}`)
	}

	loadImage(image, fileName)

	return {
		destroy: () => {
			window.removeEventListener('keydown', onKeyDown)
			window.removeEventListener('keyup', onKeyUp)
			window.removeEventListener('blur', onBlur)
			window.removeEventListener('pointerdown', unlockAudio, true)
			window.removeEventListener('keydown', unlockAudio, true)
			restoreAudioContext()
			emulator.exit()
			host.remove()
			canvas.style.display = canvasDisplay
			blobUrls.forEach((url) => URL.revokeObjectURL(url))
			blobUrls.length = 0
		},
		mountImage: async (nextImage, nextFileName) => {
			releaseAll()
			current = { image: nextImage, fileName: nextFileName || current.fileName }
			loadImage(current.image, current.fileName)
		},
		reset: () => {
			releaseAll()
			worker.postMessage({ message: 'reset' })
			loadImage(current.image, current.fileName)
		},
		setDiskSpeed: (speed) => {
			diskSpeed = speed
			worker.postMessage({ message: 'setTapeTraps', value: speed === 'instant' })
		},
		sendKey: (target, down) => {
			if (typeof target !== 'string') return
			press(`overlay:${target}`, overlayCombo(target as OverlayKeyId, scheme), down)
		},
		machines: MACHINES,
		get machine() {
			return machine
		},
		setMachine: async (id) => {
			if (!MACHINES.some((option) => option.id === id) || id === machine) return
			releaseAll()
			machine = id
			emulator.setMachine(Number(id))
			// Switching machine wipes RAM, so the game has to go back in.
			loadImage(current.image, current.fileName)
		},
		joystickSchemes: JOYSTICK_SCHEMES,
		get joystickScheme() {
			return scheme
		},
		setJoystickScheme: (id) => {
			const next = SPECTRUM_JOYSTICK_SCHEMES.find((option) => option === id)
			if (!next) return
			releaseAll()
			scheme = next
		},
	}
}

const module: RetroEmulatorModule = {
	platform: 'spectrum',
	label: 'ZX Spectrum',
	create,
}

export default module
