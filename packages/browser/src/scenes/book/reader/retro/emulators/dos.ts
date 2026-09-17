import type { Dispatchable } from '../keys'
import { dispatchableKeyCode } from './dos-keys'
import {
	basenameOf,
	extensionOf,
	isZipBytes,
	pickRunnable,
	toDos83,
	zipEntryNames,
} from './dos-images'
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

type DosFS = {
	createFile: (file: string, body: ArrayBuffer | Uint8Array | string) => void
	extract: (url: string, mountPoint?: string) => Promise<void>
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
		const stem = name.replace(/\.[^.]+$/, '')
		const runnable = pickRunnable(zipEntryNames(bytes), stem)
		return runnable ? ['-c', runnable] : []
	}

	fs.createFile(dosName, bytes)
	return ['-c', dosName]
}

async function create(options: EmulatorMountOptions): Promise<RetroEmulatorHandle> {
	const { canvas, image, fileName } = options
	const Dos = await loadDos()
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
	const ci = await runtime.main(args)

	canvas.tabIndex = 0
	canvas.focus()

	const touch = createTouchMouseState()
	let longPressTimer: number | null = null
	let virtual = { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 }

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
		if (isCompatTouchMouse(event)) event.stopImmediatePropagation()
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

	return {
		destroy: () => {
			clearLongPress()
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
		sendKey: (target: Dispatchable, down) => {
			const code = dispatchableKeyCode(target)
			if (code === null) return
			ci.simulateKeyEvent(code, down)
		},
	}
}

const module: RetroEmulatorModule = {
	create,
	label: 'DOS',
	platform: 'dos',
}

export default module
