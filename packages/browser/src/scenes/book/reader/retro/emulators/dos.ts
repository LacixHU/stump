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
	zipDirectories,
	zipEntryNames,
} from './dos-images'
import { dispatchableKeyCode, swallowDosKeyRepeat } from './dos-keys'
import {
	createDosMouseEvent,
	type DosLockedMouse,
	dosLockedMouseBase,
	dosTouchMickeys,
	isCompatTouchMouse,
	isTouchPointer,
	seedDosLockedMouse,
} from './dos-mouse'
import {
	type DosFsStamp,
	type DosSaveFile,
	packDosSaveV3,
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
	queueNewAudioData?: () => void
	timer?: number
}

type DosSdl = {
	audio?: DosSdlAudio
	audioContext?: AudioContext
	mouseX?: number
	mouseY?: number
	receiveEvent?: EventListener
	startTime?: number | null
}

type DosEmscriptenModule = {
	Asyncify?: { currData: unknown; state: number }
	FS?: EmscriptenFS
	HEAPU8?: Uint8Array
	pauseMainLoop?: () => void
	preMainLoop?: () => boolean | void
	SDL?: DosSdl
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

/**
 * Lay down the directories a zip only implies.
 *
 * The js-dos extractor opens each entry without creating its parent, and one failed open
 * aborts the whole DOSBox runtime with `exit(101)` — the mount never settles. Zips written
 * without explicit directory entries are the common case, so the tree goes down first.
 */
function ensureZipDirs(fs: DosFS, names: string[]) {
	const memfs = emscriptenFs(fs)
	if (!memfs) return
	for (const dir of zipDirectories(names)) {
		try {
			memfs.mkdir(`/${dir}`)
		} catch {
			// Already present, or taken by a file — extraction reports the real failure.
		}
	}
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
		const names = zipEntryNames(bytes)
		ensureZipDirs(fs, names)
		const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }))
		try {
			await fs.extract(url, '/')
		} finally {
			URL.revokeObjectURL(url)
		}
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

const DOS_RUNTIME_IDLE_MS = 250

function atMainLoopBoundary<T>(em: DosEmscriptenModule, fn: () => T): Promise<T> {
	return new Promise((resolve, reject) => {
		const previous = em.preMainLoop
		let settled = false
		const finish = () => {
			if (settled) return
			settled = true
			window.clearTimeout(timeout)
			em.preMainLoop = previous
			try {
				resolve(fn())
			} catch (error) {
				reject(error)
			}
		}
		const timeout = window.setTimeout(finish, DOS_RUNTIME_IDLE_MS)
		em.preMainLoop = () => {
			if (settled) return previous?.()
			finish()
			return false
		}
	})
}

function freezeDosAudio(em: DosEmscriptenModule): (() => void) | undefined {
	const audio = em.SDL?.audio
	if (!audio) return undefined
	const queue = audio.queueNewAudioData
	audio.paused = true
	audio.queueNewAudioData = () => undefined
	if (audio.timer != null) {
		window.clearTimeout(audio.timer)
		audio.timer = undefined
		audio.numAudioTimersPending = 0
	}
	audio.nextPlayTime = 0
	void em.SDL?.audioContext?.suspend?.()
	return queue
}

function thawDosAudio(em: DosEmscriptenModule, queue: (() => void) | undefined) {
	const audio = em.SDL?.audio
	if (audio) {
		if (queue) audio.queueNewAudioData = queue
		else delete audio.queueNewAudioData
		audio.nextPlayTime = 0
		audio.numAudioTimersPending = 0
		audio.paused = false
		if (audio.caller) {
			audio.numAudioTimersPending = 1
			audio.timer = window.setTimeout(audio.caller, 1)
		}
	}
	void em.SDL?.audioContext?.resume?.()
}

function sdlTicksNow(em: DosEmscriptenModule): number {
	const start = em.SDL?.startTime
	if (start == null) return 0
	return (Date.now() - start) | 0
}

function restoreSdlTicks(em: DosEmscriptenModule, sdlTicks: number) {
	if (!em.SDL) return
	em.SDL.startTime = Date.now() - sdlTicks
}

function resetDosAudioGraph(em: DosEmscriptenModule) {
	const sdl = em.SDL
	if (!sdl) return
	if (sdl.audioContext) {
		void sdl.audioContext.close()
		sdl.audioContext = new AudioContext()
	}
	const audio = sdl.audio
	if (audio) {
		audio.nextPlayTime = 0
		audio.numAudioTimersPending = 0
	}
}

async function withFrozenRuntime<T>(
	em: DosEmscriptenModule,
	fn: () => T,
	resetAudio = false,
): Promise<T> {
	return atMainLoopBoundary(em, () => {
		const queue = freezeDosAudio(em)
		try {
			const result = fn()
			if (resetAudio) resetDosAudioGraph(em)
			return result
		} finally {
			thawDosAudio(em, queue)
		}
	})
}

const DOS_CANVAS_EVENTS = [
	'touchstart',
	'touchend',
	'touchmove',
	'mousedown',
	'mouseup',
	'mousemove',
	'DOMMouseScroll',
	'mousewheel',
	'wheel',
	'mouseout',
] as const

function detachDosRuntime(em: DosEmscriptenModule | undefined, canvas: HTMLCanvasElement) {
	if (!em) return
	try {
		em.pauseMainLoop?.()
	} catch {
		// The loop already stopped.
	}
	const receive = em.SDL?.receiveEvent
	if (receive) {
		for (const type of DOS_CANVAS_EVENTS) {
			canvas.removeEventListener(type, receive, true)
		}
		document.removeEventListener('keydown', receive)
		document.removeEventListener('keyup', receive)
		document.removeEventListener('keypress', receive)
		document.removeEventListener('visibilitychange', receive)
		window.removeEventListener('focus', receive)
		window.removeEventListener('blur', receive)
		window.removeEventListener('unload', receive)
	}
	const audio = em.SDL?.audio
	if (audio?.timer != null) {
		window.clearTimeout(audio.timer)
		audio.timer = undefined
	}
	const ctx = em.SDL?.audioContext
	if (ctx && ctx.state !== 'closed') void ctx.close()
}

async function create(options: EmulatorMountOptions): Promise<RetroEmulatorHandle> {
	const { canvas, image, fileName } = options
	const imageBytes = image.slice(0)
	const Dos = await loadDos()
	let mouseSensitivity = DEFAULT_MOUSE_SENSITIVITY
	const mouseRemainder = createMouseDeltaRemainder()
	let lockedPoint: DosLockedMouse = { x: 0, y: 0 }
	let sdl: DosSdl | null = null
	let alive = true
	let resetting = false
	let ci: DosCommandInterface | null = null
	let em: DosEmscriptenModule | undefined
	let memfs: EmscriptenFS | null = null
	let baseline = new Map<string, DosFsStamp>()
	const dosOptions = {
		autolock: false,
		cycles: 'max',
		onerror: (message: string) => {
			console.error(message)
		},
		onprogress: () => undefined,
		wdosboxUrl: WDOSBOX_URL,
	}

	const rememberHostMouse = (clientX: number, clientY: number) => {
		lockedPoint = seedDosLockedMouse(
			clientX,
			clientY,
			canvas.getBoundingClientRect(),
			canvas.width,
			canvas.height,
		)
		if (!sdl) return
		sdl.mouseX = lockedPoint.x
		sdl.mouseY = lockedPoint.y
	}

	const publishLockedMouse = (movementX: number, movementY: number) => {
		const stepped = dosLockedMouseBase(
			lockedPoint,
			movementX,
			movementY,
			canvas.getBoundingClientRect(),
			canvas.width,
			canvas.height,
		)
		lockedPoint = stepped.next
		if (!sdl) return
		sdl.mouseX = stepped.base.x
		sdl.mouseY = stepped.base.y
	}

	const dispatchHostMouseMove = (event: MouseEvent, movementX: number, movementY: number) => {
		canvas.dispatchEvent(
			createDosMouseEvent('mousemove', {
				button: event.button,
				buttons: event.buttons,
				clientX: event.clientX,
				clientY: event.clientY,
				movementX,
				movementY,
			}),
		)
	}

	const onHostMouseMove = (event: MouseEvent) => {
		if (!event.isTrusted || isCompatTouchMouse(event)) return
		const locked = document.pointerLockElement === canvas
		if (!locked && event.target !== canvas) return
		if (!locked) {
			rememberHostMouse(event.clientX, event.clientY)
			if (mouseSensitivity === DEFAULT_MOUSE_SENSITIVITY) return
			event.stopImmediatePropagation()
			const scaled = takeScaledMouseDelta(
				mouseRemainder,
				event.movementX,
				event.movementY,
				mouseSensitivity,
			)
			if (!scaled.dx && !scaled.dy) return
			dispatchHostMouseMove(event, scaled.dx, scaled.dy)
			return
		}
		if (mouseSensitivity === DEFAULT_MOUSE_SENSITIVITY) {
			publishLockedMouse(event.movementX, event.movementY)
			return
		}
		event.stopImmediatePropagation()
		const scaled = takeScaledMouseDelta(
			mouseRemainder,
			event.movementX,
			event.movementY,
			mouseSensitivity,
		)
		if (!scaled.dx && !scaled.dy) return
		publishLockedMouse(scaled.dx, scaled.dy)
		dispatchHostMouseMove(event, scaled.dx, scaled.dy)
	}
	window.addEventListener('mousemove', onHostMouseMove, true)

	const bootDos = async () => {
		const runtime = await Dos(canvas, dosOptions)
		if (!alive) {
			detachDosRuntime(runtime.fs.em, canvas)
			return
		}
		const args = await mountImage(runtime.fs, imageBytes.slice(0), fileName)
		if (!alive) {
			detachDosRuntime(runtime.fs.em, canvas)
			return
		}
		const nextCi = await runtime.main(args)
		if (!alive) {
			detachDosRuntime(runtime.fs.em, canvas)
			try {
				nextCi.exit()
			} catch {
				// The new runtime was stopped before it was shown.
			}
			return
		}
		ci = nextCi
		em = runtime.fs.em
		memfs = emscriptenFs(runtime.fs)
		baseline = memfs ? snapshotDosFs(memfs) : new Map()
		sdl = em?.SDL ?? null
	}
	await bootDos()
	if (!ci) throw new Error('Failed to start the DOS emulator')

	canvas.tabIndex = 0
	canvas.focus()

	const pointerOpts: AddEventListenerOptions = { passive: false }
	const touchOpts: AddEventListenerOptions = { capture: true, passive: false }
	const touch = createTouchMouseState()
	let longPressTimer: number | null = null
	let suppressHostMouse = false
	let releaseHostMouseTimer: number | null = null
	const touchRemainder = createMouseDeltaRemainder()
	let sentX = 0
	let sentY = 0

	const clearLongPress = () => {
		if (longPressTimer !== null) {
			window.clearTimeout(longPressTimer)
			longPressTimer = null
		}
	}

	const releaseHostMouseSoon = () => {
		if (releaseHostMouseTimer !== null) window.clearTimeout(releaseHostMouseTimer)
		releaseHostMouseTimer = window.setTimeout(() => {
			releaseHostMouseTimer = null
			suppressHostMouse = false
		}, 0)
	}

	const canvasBox = () => {
		const rect = canvas.getBoundingClientRect()
		return {
			height: rect.height,
			left: rect.left,
			top: rect.top,
			width: rect.width,
		}
	}

	const dispatchMouse = (type: string, button: number, dx = 0, dy = 0) => {
		const rect = canvasBox()
		if (!rect.width || !rect.height) return
		canvas.dispatchEvent(
			createDosMouseEvent(type, {
				button,
				buttons: type === 'mousedown' ? (button === 2 ? 2 : 1) : 0,
				clientX: rect.left + sentX,
				clientY: rect.top + sentY,
				movementX: dx,
				movementY: dy,
			}),
		)
	}

	const moveByFinger = (fingerDx: number, fingerDy: number) => {
		const rect = canvasBox()
		const raw = dosTouchMickeys(
			fingerDx,
			fingerDy,
			rect,
			canvas.width,
			canvas.height,
			mouseSensitivity,
		)
		const stepped = takeScaledMouseDelta(touchRemainder, raw.dx, raw.dy, 1)
		if (!stepped.dx && !stepped.dy) return
		const cw = canvas.width || rect.width || 1
		const ch = canvas.height || rect.height || 1
		sentX += stepped.dx * (rect.width / cw)
		sentY += stepped.dy * (rect.height / ch)
		dispatchMouse('mousemove', 0, stepped.dx, stepped.dy)
	}

	const applyTouch = (command: TouchMouseCommand) => {
		if (command.type === 'move') {
			moveByFinger(command.dx, command.dy)
			return
		}
		const button = command.button === 3 ? 2 : 0
		dispatchMouse('mousedown', button)
		window.setTimeout(() => dispatchMouse('mouseup', button), 40)
	}

	const onPointerDown = (event: PointerEvent) => {
		if (!isTouchPointer(event)) return
		event.preventDefault()
		if (document.pointerLockElement === canvas) document.exitPointerLock()
		suppressHostMouse = true
		if (releaseHostMouseTimer !== null) {
			window.clearTimeout(releaseHostMouseTimer)
			releaseHostMouseTimer = null
		}
		if (touch.pointerId !== null) return
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
		if (touch.pointerId !== event.pointerId) return
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
		releaseHostMouseSoon()
	}
	const onPointerCancel = (event: PointerEvent) => {
		if (!isTouchPointer(event)) return
		clearLongPress()
		onTouchMouseCancel(touch, event.pointerId)
		releaseHostMouseSoon()
	}
	const onCompatMouse = (event: MouseEvent) => {
		if (!event.isTrusted || isCompatTouchMouse(event) || suppressHostMouse) {
			if (event.isTrusted) event.stopImmediatePropagation()
			return
		}
		if (event.type === 'mousedown' && document.pointerLockElement !== canvas) {
			rememberHostMouse(event.clientX, event.clientY)
			void canvas.requestPointerLock?.()
		}
	}
	const onNativeTouch = (event: TouchEvent) => {
		const target = event.target
		if (!(target instanceof Node) || (target !== canvas && !canvas.contains(target))) return
		event.preventDefault()
		event.stopPropagation()
	}
	const onContextMenu = (event: Event) => event.preventDefault()

	canvas.addEventListener('pointerdown', onPointerDown, pointerOpts)
	canvas.addEventListener('pointermove', onPointerMove, pointerOpts)
	canvas.addEventListener('pointerup', onPointerUp, pointerOpts)
	canvas.addEventListener('pointercancel', onPointerCancel, pointerOpts)
	canvas.addEventListener('mousedown', onCompatMouse, true)
	canvas.addEventListener('mouseup', onCompatMouse, true)
	canvas.addEventListener('mousemove', onCompatMouse, true)
	canvas.addEventListener('contextmenu', onContextMenu)
	window.addEventListener('touchstart', onNativeTouch, touchOpts)
	window.addEventListener('touchmove', onNativeTouch, touchOpts)
	window.addEventListener('touchend', onNativeTouch, touchOpts)
	window.addEventListener('touchcancel', onNativeTouch, touchOpts)
	window.addEventListener('keydown', swallowDosKeyRepeat, true)

	const restartDos = async () => {
		if (!alive || resetting) return
		resetting = true
		const previous = em
		ci = null
		em = undefined
		memfs = null
		sdl = null
		try {
			if (document.pointerLockElement === canvas) document.exitPointerLock()
			detachDosRuntime(previous, canvas)
			lockedPoint = { x: 0, y: 0 }
			mouseRemainder.x = 0
			mouseRemainder.y = 0
			touchRemainder.x = 0
			touchRemainder.y = 0
			sentX = 0
			sentY = 0
			await bootDos()
			if (!alive) return
			if (!ci) throw new Error('Failed to restart the DOS emulator')
			canvas.focus()
		} catch (error) {
			console.error(error)
		} finally {
			resetting = false
		}
	}

	return {
		destroy: () => {
			clearLongPress()
			if (releaseHostMouseTimer !== null) window.clearTimeout(releaseHostMouseTimer)
			window.removeEventListener('mousemove', onHostMouseMove, true)
			window.removeEventListener('keydown', swallowDosKeyRepeat, true)
			window.removeEventListener('touchstart', onNativeTouch, touchOpts)
			window.removeEventListener('touchmove', onNativeTouch, touchOpts)
			window.removeEventListener('touchend', onNativeTouch, touchOpts)
			window.removeEventListener('touchcancel', onNativeTouch, touchOpts)
			if (document.pointerLockElement === canvas) document.exitPointerLock()
			canvas.removeEventListener('pointerdown', onPointerDown, pointerOpts)
			canvas.removeEventListener('pointermove', onPointerMove, pointerOpts)
			canvas.removeEventListener('pointerup', onPointerUp, pointerOpts)
			canvas.removeEventListener('pointercancel', onPointerCancel, pointerOpts)
			canvas.removeEventListener('mousedown', onCompatMouse, true)
			canvas.removeEventListener('mouseup', onCompatMouse, true)
			canvas.removeEventListener('mousemove', onCompatMouse, true)
			canvas.removeEventListener('contextmenu', onContextMenu)
			alive = false
			detachDosRuntime(em, canvas)
			try {
				ci?.exit()
			} catch {
				// Already stopped.
			}
		},
		reset: () => {
			void restartDos()
		},
		saveState: async () => {
			const current = em
			const files = memfs
			if (!current) {
				throw new Error('DOS memory snapshot is not available')
			}
			const snapshot = await withFrozenRuntime(current, () => {
				const heap = liveHeap(current)
				if (!heap) {
					throw new Error('DOS memory snapshot is not available')
				}
				return {
					files: files ? collectChangedFiles(files, baseline) : [],
					heap: heap.slice(),
					sdlTicks: sdlTicksNow(current),
				}
			})
			return packDosSaveV3(
				snapshot.heap.byteLength,
				await gzipBytes(snapshot.heap),
				snapshot.files,
				snapshot.sdlTicks,
			)
		},
		loadState: async (data) => {
			const unpacked = unpackDosSave(data)
			if (unpacked.version === 1) {
				throw new Error('This DOS save cannot rewind the game. Save again, then load.')
			}
			const restored = await gunzipBytes(unpacked.heapGzip)
			const current = em
			const files = memfs
			if (!current) {
				throw new Error('DOS memory snapshot is not available')
			}
			await withFrozenRuntime(
				current,
				() => {
					const heap = liveHeap(current)
					if (!heap) {
						throw new Error('DOS memory snapshot is not available')
					}
					if (restored.byteLength !== unpacked.heapLen || restored.byteLength !== heap.byteLength) {
						throw new Error('DOS save state does not match this emulator session')
					}
					heap.set(restored)
					if (unpacked.sdlTicks != null) restoreSdlTicks(current, unpacked.sdlTicks)
					if (files) {
						restoreDosFiles(files, unpacked.files)
						baseline = snapshotDosFs(files)
					}
				},
				true,
			)
		},
		sendKey: (target: Dispatchable, down) => {
			const code = dispatchableKeyCode(target)
			if (code === null || !ci) return
			ci.simulateKeyEvent(code, down)
		},
		setMouseSensitivity: (value) => {
			mouseSensitivity = clampMouseSensitivity(value)
			mouseRemainder.x = 0
			mouseRemainder.y = 0
			touchRemainder.x = 0
			touchRemainder.y = 0
		},
	}
}

const module: RetroEmulatorModule = {
	create,
	label: 'DOS',
	platform: 'dos',
}

export default module
