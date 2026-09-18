import type { Dispatchable } from '../keys'
import {
	clampMouseSensitivity,
	createMouseDeltaRemainder,
	DEFAULT_MOUSE_SENSITIVITY,
	takeScaledMouseDelta,
} from '../mouse-sensitivity'
import {
	basenameOf,
	dosboxConfMainArgs,
	extensionOf,
	findDosboxConf,
	isZipBytes,
	pickRunnable,
	STUMP_DOS_MOUNT_CONF,
	STUMP_DOS_MOUNT_CONF_BODY,
	toDos83,
	zipEntryNames,
} from './dos-images'
import { dispatchableKeyCode, swallowDosKeyRepeat } from './dos-keys'
import {
	type DosFsStamp,
	type DosSaveFile,
	packDosSaveV2,
	selectChangedPaths,
	shouldSkipDosPath,
	unpackDosSave,
} from './dos-saves'
import {
	createTouchMouseState,
	LONG_PRESS_MS,
	onTouchMouseCancel,
	onTouchMouseDown,
	onTouchMouseLongPress,
	onTouchMouseMove,
	onTouchMouseUp,
	type TouchMouseCommand,
} from './retro-touch-mouse'
import type { EmulatorMountOptions, RetroEmulatorHandle, RetroEmulatorModule } from './types'

const ASSET_BASE = '/retro/dos'
const SCRIPT_URL = `${ASSET_BASE}/js-dos.js`
const WDOSBOX_URL = `${ASSET_BASE}/wdosbox.js`

type EmscriptenFS = {
	readdir: (path: string) => string[]
	stat: (path: string) => { mode: number; size: number; mtime: Date | number }
	isDir: (mode: number) => boolean
	isFile: (mode: number) => boolean
	readFile: (path: string, opts?: { encoding: string }) => Uint8Array
	writeFile: (path: string, data: Uint8Array, opts?: { encoding: string }) => void
	mkdir: (path: string) => void
}

type DosSdlAudio = {
	caller?: () => void
	nextPlayTime?: number
	numAudioTimersPending?: number
	paused?: boolean
	timer?: number
}

type DosEmscriptenModule = {
	Asyncify?: { currData: unknown; state: number }
	FS?: EmscriptenFS
	HEAPU8?: Uint8Array
	SDL?: {
		audio?: DosSdlAudio
		audioContext?: AudioContext
	}
	wasmMemory?: WebAssembly.Memory
}

type DosFS = {
	createFile: (file: string, body: ArrayBuffer | Uint8Array | string) => void
	em?: DosEmscriptenModule
	extract: (url: string, mountPoint?: string) => Promise<void>
	fs?: EmscriptenFS
}

type DosCommandInterface = {
	exit: () => number
	simulateKeyEvent: (keyCode: number, pressed: boolean) => void
}

type DosRuntime = {
	fs: DosFS
	main: (args?: string[]) => Promise<DosCommandInterface>
}

type DosFactory = (
	canvas: HTMLCanvasElement,
	options?: Record<string, unknown>,
) => Promise<DosRuntime>

declare global {
	interface Window {
		Dos?: DosFactory
	}
}

let scriptPromise: Promise<DosFactory> | null = null

function loadDos(): Promise<DosFactory> {
	if (window.Dos) return Promise.resolve(window.Dos)
	scriptPromise ??= new Promise<DosFactory>((resolve, reject) => {
		const element = document.createElement('script')
		element.src = SCRIPT_URL
		element.async = true
		element.addEventListener('error', () => {
			scriptPromise = null
			element.remove()
			reject(new Error('Failed to load the DOS emulator'))
		})
		element.addEventListener('load', () => {
			if (window.Dos) resolve(window.Dos)
			else {
				scriptPromise = null
				reject(new Error('DOS emulator failed to load'))
			}
		})
		document.head.appendChild(element)
	})
	return scriptPromise
}

function isCompatTouchMouse(event: MouseEvent): boolean {
	const caps = (event as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } })
		.sourceCapabilities
	return !!caps?.firesTouchEvents
}

function isTouchPointer(event: PointerEvent): boolean {
	return event.pointerType === 'touch' || event.pointerType === 'pen'
}

async function mountImage(fs: DosFS, image: ArrayBuffer, fileName?: string): Promise<string[]> {
	const bytes = new Uint8Array(image)
	const name = basenameOf(fileName)
	const ext = extensionOf(name)
	const dosName = toDos83(name)

	if (ext === 'img' || ext === 'ima') {
		fs.createFile(dosName, bytes)
		return ['-c', `imgmount a ${dosName} -t floppy`, '-c', 'a:']
	}

	if (ext === 'exe' || ext === 'com') {
		fs.createFile(dosName, bytes)
		return ['-c', dosName]
	}

	if (ext === 'dosz' || isZipBytes(bytes)) {
		const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }))
		try {
			await fs.extract(url, '/')
		} finally {
			URL.revokeObjectURL(url)
		}
		const names = zipEntryNames(bytes)
		const conf = findDosboxConf(names)
		if (conf) {
			fs.createFile(STUMP_DOS_MOUNT_CONF, STUMP_DOS_MOUNT_CONF_BODY)
			return dosboxConfMainArgs(conf)
		}
		const stem = name.replace(/\.[^.]+$/, '')
		const runnable = pickRunnable(names, stem)
		return runnable ? ['-c', runnable] : []
	}

	fs.createFile(dosName, bytes)
	return ['-c', dosName]
}

function emscriptenFs(fs: DosFS): EmscriptenFS | null {
	const inner = fs.fs ?? fs.em?.FS
	if (!inner?.readdir || !inner.readFile || !inner.writeFile || !inner.stat) return null
	return inner
}

function stampOf(stat: { size: number; mtime: Date | number }): DosFsStamp {
	return {
		mtimeMs: typeof stat.mtime === 'number' ? stat.mtime : stat.mtime.getTime(),
		size: stat.size,
	}
}

function walkDosFs(fs: EmscriptenFS, dir: string, stamps: Map<string, DosFsStamp>) {
	let names: string[]
	try {
		names = fs.readdir(dir)
	} catch {
		return
	}
	for (const name of names) {
		if (name === '.' || name === '..') continue
		const path = dir === '/' ? `/${name}` : `${dir}/${name}`
		if (shouldSkipDosPath(path)) continue
		let stat: { mode: number; size: number; mtime: Date | number }
		try {
			stat = fs.stat(path)
		} catch {
			continue
		}
		if (fs.isDir(stat.mode)) {
			walkDosFs(fs, path, stamps)
			continue
		}
		if (!fs.isFile(stat.mode)) continue
		stamps.set(path, stampOf(stat))
	}
}

function snapshotDosFs(fs: EmscriptenFS): Map<string, DosFsStamp> {
	const stamps = new Map<string, DosFsStamp>()
	walkDosFs(fs, '/', stamps)
	return stamps
}

function readDosFile(fs: EmscriptenFS, path: string): Uint8Array {
	const raw = fs.readFile(path, { encoding: 'binary' })
	return raw instanceof Uint8Array ? raw.slice() : new Uint8Array(raw)
}

function collectChangedFiles(fs: EmscriptenFS, baseline: Map<string, DosFsStamp>): DosSaveFile[] {
	const current = snapshotDosFs(fs)
	return selectChangedPaths(baseline, current).map((path) => ({
		data: readDosFile(fs, path),
		path,
	}))
}

function ensureParentDir(fs: EmscriptenFS, filePath: string) {
	const parts = filePath.split('/').filter(Boolean)
	parts.pop()
	let current = ''
	for (const part of parts) {
		current += `/${part}`
		try {
			const stat = fs.stat(current)
			if (!fs.isDir(stat.mode)) {
				throw new Error(`Cannot restore ${filePath}`)
			}
		} catch (error) {
			if (error instanceof Error && error.message.startsWith('Cannot restore')) throw error
			fs.mkdir(current)
		}
	}
}

function restoreDosFiles(fs: EmscriptenFS, files: DosSaveFile[]) {
	for (const file of files) {
		ensureParentDir(fs, file.path)
		fs.writeFile(file.path, file.data, { encoding: 'binary' })
	}
}

async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
	if (typeof CompressionStream === 'undefined') {
		throw new Error('This browser cannot compress a DOS save state')
	}
	const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))
	return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function gunzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
	if (typeof DecompressionStream === 'undefined') {
		throw new Error('This browser cannot decompress a DOS save state')
	}
	const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
	return new Uint8Array(await new Response(stream).arrayBuffer())
}

function liveHeap(em: DosEmscriptenModule | undefined): Uint8Array | null {
	if (em?.HEAPU8?.byteLength) return em.HEAPU8
	const buffer = em?.wasmMemory?.buffer
	if (!buffer || buffer.byteLength < 1) return null
	return new Uint8Array(buffer)
}

function freezeDosRuntime(em: DosEmscriptenModule) {
	const audio = em.SDL?.audio
	if (audio) {
		audio.paused = true
		if (audio.timer != null) {
			window.clearTimeout(audio.timer)
			audio.timer = undefined
			audio.numAudioTimersPending = 0
		}
		audio.nextPlayTime = 0
	}
	void em.SDL?.audioContext?.suspend?.()
}

function thawDosRuntime(em: DosEmscriptenModule, reset = false) {
	if (reset && em.Asyncify) {
		em.Asyncify.currData = null
		em.Asyncify.state = 0
	}
	const sdl = em.SDL
	if (reset && sdl?.audioContext) {
		void sdl.audioContext.close()
		sdl.audioContext = new AudioContext()
	}
	const audio = sdl?.audio
	if (audio) {
		audio.nextPlayTime = 0
		audio.numAudioTimersPending = 0
		audio.paused = false
		if (audio.caller) {
			audio.numAudioTimersPending = 1
			audio.timer = window.setTimeout(audio.caller, 1)
		}
	}
	void sdl?.audioContext?.resume?.()
}

function withFrozenRuntime<T>(em: DosEmscriptenModule, fn: () => T, reset = false): T {
	freezeDosRuntime(em)
	try {
		return fn()
	} finally {
		thawDosRuntime(em, reset)
	}
}

async function create(options: EmulatorMountOptions): Promise<RetroEmulatorHandle> {
	const { canvas, image, fileName } = options
	const Dos = await loadDos()
	let mouseSensitivity = DEFAULT_MOUSE_SENSITIVITY
	const mouseRemainder = createMouseDeltaRemainder()
	const onHostMouseMove = (event: MouseEvent) => {
		if (!event.isTrusted || isCompatTouchMouse(event)) return
		const locked = document.pointerLockElement === canvas
		if (!locked && event.target !== canvas) return
		if (mouseSensitivity === DEFAULT_MOUSE_SENSITIVITY) return
		event.stopImmediatePropagation()
		const scaled = takeScaledMouseDelta(
			mouseRemainder,
			event.movementX,
			event.movementY,
			mouseSensitivity,
		)
		if (!scaled.dx && !scaled.dy) return
		canvas.dispatchEvent(
			new MouseEvent('mousemove', {
				bubbles: true,
				button: event.button,
				buttons: event.buttons,
				cancelable: true,
				clientX: event.clientX,
				clientY: event.clientY,
				movementX: scaled.dx,
				movementY: scaled.dy,
			}),
		)
	}
	window.addEventListener('mousemove', onHostMouseMove, true)

	const runtime = await Dos(canvas, {
		autolock: false,
		cycles: 'max',
		onerror: (message: string) => {
			console.error(message)
		},
		onprogress: () => undefined,
		wdosboxUrl: WDOSBOX_URL,
	})
	const args = await mountImage(runtime.fs, image, fileName)
	const em = runtime.fs.em
	const memfs = emscriptenFs(runtime.fs)
	let baseline = memfs ? snapshotDosFs(memfs) : new Map<string, DosFsStamp>()
	const ci = await runtime.main(args)

	canvas.tabIndex = 0
	canvas.focus()

	const touch = createTouchMouseState()
	let longPressTimer: number | null = null
	const virtual = { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 }

	const clearLongPress = () => {
		if (longPressTimer !== null) {
			window.clearTimeout(longPressTimer)
			longPressTimer = null
		}
	}

	const dispatchMouse = (type: string, button: number, dx = 0, dy = 0) => {
		const rect = canvas.getBoundingClientRect()
		canvas.dispatchEvent(
			new MouseEvent(type, {
				bubbles: true,
				button,
				buttons: type === 'mousedown' ? (button === 2 ? 2 : 1) : 0,
				cancelable: true,
				clientX: rect.left + virtual.x,
				clientY: rect.top + virtual.y,
				movementX: dx,
				movementY: dy,
			}),
		)
	}

	const applyTouch = (command: TouchMouseCommand) => {
		if (command.type === 'move') {
			const width = canvas.clientWidth || 1
			const height = canvas.clientHeight || 1
			virtual.x = Math.min(width, Math.max(0, virtual.x + command.dx))
			virtual.y = Math.min(height, Math.max(0, virtual.y + command.dy))
			dispatchMouse('mousemove', 0, command.dx, command.dy)
			return
		}
		const button = command.button === 3 ? 2 : 0
		dispatchMouse('mousedown', button)
		window.setTimeout(() => dispatchMouse('mouseup', button), 40)
	}

	const onPointerDown = (event: PointerEvent) => {
		if (!isTouchPointer(event)) return
		event.preventDefault()
		canvas.setPointerCapture(event.pointerId)
		onTouchMouseDown(touch, event.pointerId, event.clientX, event.clientY)
		clearLongPress()
		longPressTimer = window.setTimeout(() => {
			const command = onTouchMouseLongPress(touch)
			if (command) applyTouch(command)
		}, LONG_PRESS_MS)
	}
	const onPointerMove = (event: PointerEvent) => {
		if (!isTouchPointer(event)) return
		event.preventDefault()
		const command = onTouchMouseMove(touch, event.pointerId, event.clientX, event.clientY)
		if (command) {
			clearLongPress()
			applyTouch(command)
		}
	}
	const onPointerUp = (event: PointerEvent) => {
		if (!isTouchPointer(event)) return
		event.preventDefault()
		clearLongPress()
		const command = onTouchMouseUp(touch, event.pointerId)
		if (command) applyTouch(command)
	}
	const onPointerCancel = (event: PointerEvent) => {
		if (!isTouchPointer(event)) return
		clearLongPress()
		onTouchMouseCancel(touch, event.pointerId)
	}
	const onCompatMouse = (event: MouseEvent) => {
		if (isCompatTouchMouse(event)) {
			event.stopImmediatePropagation()
			return
		}
		if (event.type === 'mousedown' && document.pointerLockElement !== canvas) {
			void canvas.requestPointerLock?.()
		}
	}
	const onContextMenu = (event: Event) => event.preventDefault()

	canvas.addEventListener('pointerdown', onPointerDown)
	canvas.addEventListener('pointermove', onPointerMove)
	canvas.addEventListener('pointerup', onPointerUp)
	canvas.addEventListener('pointercancel', onPointerCancel)
	canvas.addEventListener('mousedown', onCompatMouse, true)
	canvas.addEventListener('mouseup', onCompatMouse, true)
	canvas.addEventListener('mousemove', onCompatMouse, true)
	canvas.addEventListener('contextmenu', onContextMenu)
	window.addEventListener('keydown', swallowDosKeyRepeat, true)

	return {
		destroy: () => {
			clearLongPress()
			window.removeEventListener('mousemove', onHostMouseMove, true)
			window.removeEventListener('keydown', swallowDosKeyRepeat, true)
			if (document.pointerLockElement === canvas) document.exitPointerLock()
			canvas.removeEventListener('pointerdown', onPointerDown)
			canvas.removeEventListener('pointermove', onPointerMove)
			canvas.removeEventListener('pointerup', onPointerUp)
			canvas.removeEventListener('pointercancel', onPointerCancel)
			canvas.removeEventListener('mousedown', onCompatMouse, true)
			canvas.removeEventListener('mouseup', onCompatMouse, true)
			canvas.removeEventListener('mousemove', onCompatMouse, true)
			canvas.removeEventListener('contextmenu', onContextMenu)
			ci.exit()
		},
		saveState: async () => {
			if (!em) {
				throw new Error('DOS memory snapshot is not available')
			}
			const snapshot = withFrozenRuntime(em, () => {
				const heap = liveHeap(em)
				if (!heap) {
					throw new Error('DOS memory snapshot is not available')
				}
				return {
					files: memfs ? collectChangedFiles(memfs, baseline) : [],
					heap: heap.slice(),
				}
			})
			return packDosSaveV2(snapshot.heap.byteLength, await gzipBytes(snapshot.heap), snapshot.files)
		},
		loadState: async (data) => {
			const unpacked = unpackDosSave(data)
			if (unpacked.version !== 2) {
				throw new Error('This DOS save cannot rewind the game. Save again, then load.')
			}
			const restored = await gunzipBytes(unpacked.heapGzip)
			if (!em) {
				throw new Error('DOS memory snapshot is not available')
			}
			withFrozenRuntime(
				em,
				() => {
					const heap = liveHeap(em)
					if (!heap) {
						throw new Error('DOS memory snapshot is not available')
					}
					if (restored.byteLength !== unpacked.heapLen || restored.byteLength !== heap.byteLength) {
						throw new Error('DOS save state does not match this emulator session')
					}
					heap.set(restored)
					if (memfs) {
						restoreDosFiles(memfs, unpacked.files)
						baseline = snapshotDosFs(memfs)
					}
				},
				true,
			)
		},
		sendKey: (target: Dispatchable, down) => {
			const code = dispatchableKeyCode(target)
			if (code === null) return
			ci.simulateKeyEvent(code, down)
		},
		setMouseSensitivity: (value) => {
			mouseSensitivity = clampMouseSensitivity(value)
			mouseRemainder.x = 0
			mouseRemainder.y = 0
		},
	}
}

const module: RetroEmulatorModule = {
	create,
	label: 'DOS',
	platform: 'dos',
}

export default module
