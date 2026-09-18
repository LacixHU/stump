import type { Dispatchable, OverlayKeyId } from '../keys'
import {
	clampMouseSensitivity,
	createMouseDeltaRemainder,
	DEFAULT_MOUSE_SENSITIVITY,
	takeScaledMouseDelta,
} from '../mouse-sensitivity'
import {
	AUDIO_FRAMES,
	AUDIO_GAIN,
	AUDIO_SAMPLE_RATE,
	enqueueSoundChunks,
	writeSoundOutput,
} from './amiga-audio'
import {
	AMIGA_KEY_CODES,
	isPhysicalJoystickCode,
	joystickCommand,
	overlayJoystickEvent,
	overlayKeyCode,
	physicalJoystickEvent,
} from './amiga-keys'
import {
	AMIGA_KICKSTART_FILES,
	AMIGA_OPTIONAL_KICKSTART_FILES,
	availableMachines,
	defaultMachineId,
	hardwareConfigLines,
	machineById,
} from './amiga-machines'
import { createAmigaTouchMouse, longPressMs, type TouchMouseCommand } from './amiga-touch-mouse'
import { containPoint, palDisplayHeight, TPP } from './amiga-video'
import type {
	EmulatorMountOptions,
	RetroDiskSpeed,
	RetroEmulatorHandle,
	RetroEmulatorModule,
	RetroInputMode,
} from './types'

export { AMIGA_KICKSTART_FILES, AMIGA_OPTIONAL_KICKSTART_FILES } from './amiga-machines'

const ASSET_BASE = '/retro/amiga'
const SCRIPT_URL = `${ASSET_BASE}/vAmiga.js`

const HBLANK_MIN = 0x12 * TPP
const HPIXELS = 912 * TPP
const VPIXELS = 313
const CATCHUP_MAX = 8

type VAmigaModule = {
	ccall: (name: string, returnType: string, argTypes: string[], args: unknown[]) => unknown
	cwrap: (name: string, returnType: string, argTypes?: string[]) => (...args: never[]) => unknown
	_malloc: (size: number) => number
	_free: (ptr: number) => void
	HEAPU8: Uint8Array
	HEAPF32: Float32Array
	_wasm_draw_one_frame: (now: number) => number
	_wasm_execute: () => void
	_wasm_pixel_buffer: () => number
	_wasm_run: () => void
	_wasm_halt: () => void
	_wasm_reset: () => void
	_wasm_key: (code: number, pressed: number) => void
	_wasm_set_warp: (on: number) => void
	_wasm_get_sound_buffer_address: () => number
	_wasm_copy_into_sound_buffer: () => number
	_wasm_set_sample_rate: (rate: number) => void
	_wasm_mouse: (port: number, x: number, y: number) => void
	_wasm_mouse_button: (port: number, button: number, pressed: number) => void
}

type Clip = { xOff: number; yOff: number; width: number; height: number }

declare global {
	interface Window {
		Module?: VAmigaModule & { locateFile?: (path: string) => string }
		message_handler?: (msg: string, data1?: number, data2?: number) => void
		js_set_display?: (xOff: number, yOff: number, width: number, height: number) => void
		scaleVMCanvas?: () => void
		use_ntsc_pixel?: boolean
	}
}

let scriptPromise: Promise<VAmigaModule> | null = null
const clip: Clip = {
	xOff: HBLANK_MIN,
	yOff: 32,
	width: HPIXELS - HBLANK_MIN - 8 * TPP,
	height: VPIXELS - 32,
}

function installGlobals() {
	window.use_ntsc_pixel = false
	window.scaleVMCanvas = () => undefined
	window.message_handler = () => undefined
	window.js_set_display = (xOff, yOff, width, height) => {
		clip.xOff = xOff * TPP - HBLANK_MIN * 4
		clip.yOff = yOff
		clip.width = width
		let nextHeight = height
		if (nextHeight % 2 !== 0) nextHeight += 1
		if (nextHeight + yOff > VPIXELS) nextHeight = (VPIXELS - yOff) & 0xfffe
		clip.height = nextHeight
	}
}

function loadModule(): Promise<VAmigaModule> {
	if (window.Module?._wasm_run) return Promise.resolve(window.Module as VAmigaModule)
	scriptPromise ??= new Promise<VAmigaModule>((resolve, reject) => {
		installGlobals()
		const existing = (window.Module || {}) as VAmigaModule & {
			locateFile?: (path: string) => string
			onRuntimeInitialized?: () => void
		}
		existing.locateFile = (path: string) => `${ASSET_BASE}/${path}`
		existing.onRuntimeInitialized = () => {
			const loaded = window.Module
			if (loaded?._wasm_run) resolve(loaded)
			else reject(new Error('Amiga emulator failed to initialise'))
		}
		window.Module = existing
		const element = document.createElement('script')
		element.src = SCRIPT_URL
		element.async = true
		element.addEventListener('error', () => {
			scriptPromise = null
			element.remove()
			reject(new Error('Failed to load the Amiga emulator'))
		})
		document.head.appendChild(element)
	})
	return scriptPromise
}

function loadFile(module: VAmigaModule, name: string, data: Uint8Array, drive = 0): string {
	const ptr = module._malloc(data.byteLength)
	module.HEAPU8.set(data, ptr)
	try {
		return module.ccall(
			'wasm_loadFile',
			'string',
			['string', 'number', 'number', 'number'],
			[name, ptr, data.byteLength, drive],
		) as string
	} finally {
		module._free(ptr)
	}
}

function diskName(fileName?: string): string {
	const name = (fileName || 'game.adf').split(/[/\\]/).pop() || 'game.adf'
	return /\.(adf|adz)$/i.test(name) ? name : `${name}.adf`
}

function kickstartOf(machine: string, firmware: Record<string, ArrayBuffer>): Uint8Array {
	const profile = machineById(machine)
	const buffer = firmware[profile?.kickstart || machine]
	if (!buffer) {
		throw new Error(`Missing Amiga Kickstart firmware: ${machine}`)
	}
	return new Uint8Array(buffer)
}

async function create(options: EmulatorMountOptions): Promise<RetroEmulatorHandle> {
	const { canvas, image, firmware } = options
	const missing = AMIGA_KICKSTART_FILES.filter((name) => !firmware?.[name])
	if (missing.length) {
		throw new Error(
			`Missing Amiga Kickstart firmware: ${missing.join(', ')}. Place files in STUMP_FIRMWARE_DIR.`,
		)
	}

	const ctx = canvas.getContext('2d')
	if (!ctx) {
		throw new Error('Canvas 2D context unavailable')
	}

	installGlobals()
	const module = await loadModule()

	const wasmJoystick = module.cwrap('wasm_joystick', 'undefined', ['string']) as (
		cmd: string,
	) => void
	const wasmEject = module.cwrap('wasm_eject_disk', 'undefined', ['string']) as (
		name: string,
	) => void
	const wasmSnapshot = module.cwrap('wasm_take_user_snapshot', 'string', []) as () => string
	const wasmDeleteSnapshot = module.cwrap(
		'wasm_delete_user_snapshot',
		'undefined',
		[],
	) as () => void

	let diskSpeed: RetroDiskSpeed = options.diskSpeed ?? 'instant'
	let inputMode: RetroInputMode = 'mixed'
	let joystickPort: 1 | 2 = 2
	let current = { image, fileName: options.fileName }
	let destroyed = false
	let frameRaf = 0
	let imageData: ImageData | null = null
	let imageHeight = 0
	const source = document.createElement('canvas')
	const sourceCtx = source.getContext('2d')
	if (!sourceCtx) {
		throw new Error('Canvas 2D context unavailable')
	}
	const previousCursor = canvas.style.cursor
	canvas.style.cursor = 'none'

	const wasmConfigure = module.cwrap('wasm_configure', 'string', ['string', 'string']) as (
		option: string,
		value: string,
	) => string
	const wasmConfigureMulti = module.cwrap('wasm_configure_multi', 'string', ['string']) as (
		config: string,
	) => string

	const roms = firmware as Record<string, ArrayBuffer>
	const machines = availableMachines(roms)
	let machine = defaultMachineId(options.fileName, machines)

	const applyDiskSpeed = () => {
		module._wasm_set_warp(0)
		wasmConfigure('DRIVE_SPEED', diskSpeed === 'instant' ? '-1' : '1')
	}

	const insertDisk = (bytes: ArrayBuffer, fileName?: string) => {
		loadFile(module, diskName(fileName), new Uint8Array(bytes), 0)
	}

	const applyHardware = (id: string) => {
		const hardware = machineById(id)?.hardware
		if (!hardware) return
		const error = wasmConfigureMulti(hardwareConfigLines(hardware))
		if (error) throw new Error(`Amiga hardware config failed: ${error}`)
	}

	const boot = (kick: Uint8Array, disk: ArrayBuffer, fileName?: string) => {
		applyHardware(machine)
		loadFile(module, 'kick.rom_file', kick)
		insertDisk(disk, fileName)
		module._wasm_reset()
		module._wasm_run()
		applyDiskSpeed()
	}

	boot(kickstartOf(machine, roms), current.image, current.fileName)

	const paint = () => {
		const { xOff, yOff, width, height } = clip
		if (width <= 0 || height <= 0) return
		if (!imageData || imageHeight !== height) {
			source.width = HPIXELS
			source.height = height
			imageData = sourceCtx.createImageData(HPIXELS, height)
			imageHeight = height
		}
		const src = module._wasm_pixel_buffer() + yOff * (HPIXELS << 2)
		const pixels = new Uint8Array(module.HEAPU8.buffer, src, HPIXELS * height * 4)
		imageData.data.set(pixels)
		sourceCtx.putImageData(imageData, 0, 0)
		const outHeight = palDisplayHeight(height, !!window.use_ntsc_pixel)
		if (canvas.width !== width || canvas.height !== outHeight) {
			canvas.width = width
			canvas.height = outHeight
		}
		ctx.imageSmoothingEnabled = false
		ctx.clearRect(0, 0, width, outHeight)
		ctx.drawImage(source, xOff, 0, width, height, 0, 0, width, outHeight)
	}

	const loop = (now: number) => {
		if (destroyed) return
		frameRaf = requestAnimationFrame(loop)
		const behind = module._wasm_draw_one_frame(now)
		if (behind < 0) return
		paint()
		for (let i = 0; i < behind && i < CATCHUP_MAX; i += 1) {
			module._wasm_execute()
		}
	}
	frameRaf = requestAnimationFrame(loop)

	let audio: { resume: () => void; destroy: () => void } | null = null
	try {
		const context = new AudioContext({ sampleRate: AUDIO_SAMPLE_RATE })
		module._wasm_set_sample_rate(context.sampleRate)
		const node = context.createScriptProcessor(AUDIO_FRAMES, 0, 2)
		const gain = context.createGain()
		gain.gain.value = AUDIO_GAIN
		const queue: Float32Array[] = []
		node.onaudioprocess = (event) => {
			const left = event.outputBuffer.getChannelData(0)
			const right = event.outputBuffer.getChannelData(1)
			if (context.state === 'running') {
				const samples = module._wasm_copy_into_sound_buffer()
				if (samples >= AUDIO_FRAMES) {
					const addr = module._wasm_get_sound_buffer_address()
					const heap = new Float32Array(module.HEAPF32.buffer, addr, samples * 2)
					if (heap.byteLength) enqueueSoundChunks(heap, samples, queue)
				}
			}
			writeSoundOutput(left, right, queue.shift())
		}
		node.connect(gain)
		gain.connect(context.destination)
		audio = {
			resume: () => {
				void context.resume().catch(() => undefined)
			},
			destroy: () => {
				node.onaudioprocess = null
				node.disconnect()
				gain.disconnect()
				void context.close().catch(() => undefined)
			},
		}
	} catch {
		audio = null
	}

	const unlockAudio = () => audio?.resume()

	const sendJoystick = (event: ReturnType<typeof physicalJoystickEvent>) => {
		if (!event) return
		wasmJoystick(joystickCommand(joystickPort, event))
	}

	const onKey = (event: KeyboardEvent, down: boolean) => {
		if (event.repeat) {
			event.preventDefault()
			return
		}
		const joy = inputMode !== 'keyboard' ? physicalJoystickEvent(event.code, down) : null
		if (joy) {
			event.preventDefault()
			sendJoystick(joy)
			return
		}
		if (inputMode === 'joystick' && isPhysicalJoystickCode(event.code)) return
		const code = AMIGA_KEY_CODES[event.code]
		if (code === undefined) return
		event.preventDefault()
		module._wasm_key(code, down ? 1 : 0)
	}

	const onKeyDown = (event: KeyboardEvent) => onKey(event, true)
	const onKeyUp = (event: KeyboardEvent) => onKey(event, false)

	const touchMouse = createAmigaTouchMouse()
	let longPressTimer: ReturnType<typeof setTimeout> | null = null
	const pointerOpts: AddEventListenerOptions = { passive: false }

	const isTouchPointer = (event: PointerEvent) =>
		event.pointerType === 'touch' || event.pointerType === 'pen'

	const isCompatTouchMouse = (event: MouseEvent) =>
		Boolean(
			(event as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } | null })
				.sourceCapabilities?.firesTouchEvents,
		)

	const stopLongPress = () => {
		if (longPressTimer != null) {
			clearTimeout(longPressTimer)
			longPressTimer = null
		}
	}

	const releaseTouchCapture = (pointerId: number) => {
		if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId)
	}

	const dropTouchGesture = () => {
		stopLongPress()
		const pointerId = touchMouse.pointerId
		if (pointerId != null) releaseTouchCapture(pointerId)
		touchMouse.reset()
	}

	const onBlur = () => {
		wasmJoystick(joystickCommand(joystickPort, 'RELEASE_X'))
		wasmJoystick(joystickCommand(joystickPort, 'RELEASE_Y'))
		wasmJoystick(joystickCommand(joystickPort, 'RELEASE_FIRE'))
		dropTouchGesture()
	}

	let mouseSensitivity = DEFAULT_MOUSE_SENSITIVITY
	const mouseRemainder = createMouseDeltaRemainder()
	const sendRelativeMouse = (dx: number, dy: number) => {
		const scaled = takeScaledMouseDelta(mouseRemainder, dx, dy, mouseSensitivity)
		if (scaled.dx || scaled.dy) module._wasm_mouse(1, scaled.dx, scaled.dy)
	}

	const scaleTouchDelta = (dx: number, dy: number) => {
		if (!canvas.width || !canvas.height || !clip.height) return { dx: 0, dy: 0 }
		const rect = canvas.getBoundingClientRect()
		const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height)
		const drawnWidth = canvas.width * scale
		const drawnHeight = canvas.height * scale
		if (drawnWidth <= 0 || drawnHeight <= 0) return { dx: 0, dy: 0 }
		return {
			dx: Math.round(dx * (canvas.width / drawnWidth)),
			dy: Math.round(dy * (clip.height / drawnHeight)),
		}
	}

	const mouseButtonsHeld: Record<1 | 3, number> = { 1: 0, 3: 0 }
	const pulseMouseButton = (button: 1 | 3) => {
		if (destroyed) return
		if (mouseButtonsHeld[button] === 0) module._wasm_mouse_button(1, button, 1)
		mouseButtonsHeld[button] += 1
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				mouseButtonsHeld[button] = Math.max(0, mouseButtonsHeld[button] - 1)
				if (!destroyed && mouseButtonsHeld[button] === 0) {
					module._wasm_mouse_button(1, button, 0)
				}
			})
		})
	}

	const applyTouchCommands = (commands: TouchMouseCommand[]) => {
		let sawMove = false
		for (const command of commands) {
			if (command.type === 'move') {
				sawMove = true
				const scaled = scaleTouchDelta(command.dx, command.dy)
				if (scaled.dx || scaled.dy) module._wasm_mouse(1, scaled.dx, scaled.dy)
			} else {
				pulseMouseButton(command.button)
			}
		}
		return sawMove
	}

	const startLongPress = () => {
		stopLongPress()
		longPressTimer = setTimeout(() => {
			longPressTimer = null
			applyTouchCommands(touchMouse.longPress(performance.now()))
		}, longPressMs)
	}

	const onPointerDown = (event: PointerEvent) => {
		if (!isTouchPointer(event)) return
		event.preventDefault()
		unlockAudio()
		canvas.focus()
		const commands = touchMouse.down(
			{ pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY },
			performance.now(),
		)
		applyTouchCommands(commands)
		if (touchMouse.pointerId !== event.pointerId) return
		canvas.setPointerCapture(event.pointerId)
		startLongPress()
	}
	const onPointerMove = (event: PointerEvent) => {
		if (!isTouchPointer(event)) return
		event.preventDefault()
		const commands = touchMouse.move({
			pointerId: event.pointerId,
			clientX: event.clientX,
			clientY: event.clientY,
		})
		if (applyTouchCommands(commands)) stopLongPress()
	}
	const onPointerUp = (event: PointerEvent) => {
		if (!isTouchPointer(event)) return
		event.preventDefault()
		stopLongPress()
		const tracked = touchMouse.pointerId === event.pointerId
		const commands = touchMouse.up(
			{ pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY },
			performance.now(),
		)
		applyTouchCommands(commands)
		if (tracked) releaseTouchCapture(event.pointerId)
	}
	const onPointerCancel = (event: PointerEvent) => {
		if (!isTouchPointer(event)) return
		event.preventDefault()
		stopLongPress()
		const tracked = touchMouse.pointerId === event.pointerId
		touchMouse.cancel({
			pointerId: event.pointerId,
			clientX: event.clientX,
			clientY: event.clientY,
		})
		if (tracked) releaseTouchCapture(event.pointerId)
	}

	let lastMouse: { x: number; y: number } | null = null
	const framebufferFromEvent = (event: MouseEvent) => {
		if (!canvas.width || !canvas.height || !clip.height) return null
		const point = containPoint(
			event.clientX,
			event.clientY,
			canvas.width,
			canvas.height,
			canvas.getBoundingClientRect(),
		)
		if (!point) return null
		return { x: point.x, y: (point.y * clip.height) / canvas.height }
	}
	const onMouseMove = (event: MouseEvent) => {
		if (isCompatTouchMouse(event)) return
		if (document.pointerLockElement === canvas) {
			sendRelativeMouse(event.movementX, event.movementY)
			return
		}
		const point = framebufferFromEvent(event)
		if (!point) {
			lastMouse = null
			return
		}
		if (lastMouse) {
			sendRelativeMouse(point.x - lastMouse.x, point.y - lastMouse.y)
		}
		lastMouse = point
	}
	const onMouseDown = (event: MouseEvent) => {
		if (isCompatTouchMouse(event)) return
		unlockAudio()
		canvas.focus()
		if (document.pointerLockElement !== canvas) {
			void canvas.requestPointerLock?.()
		}
		const button = event.button === 2 ? 3 : 1
		module._wasm_mouse_button(1, button, 1)
	}
	const onMouseUp = (event: MouseEvent) => {
		if (isCompatTouchMouse(event)) return
		const button = event.button === 2 ? 3 : 1
		module._wasm_mouse_button(1, button, 0)
	}
	const onContextMenu = (event: Event) => event.preventDefault()
	const onPointerLockChange = () => {
		if (document.pointerLockElement !== canvas) lastMouse = null
	}

	window.addEventListener('keydown', onKeyDown)
	window.addEventListener('keyup', onKeyUp)
	window.addEventListener('blur', onBlur)
	window.addEventListener('pointerdown', unlockAudio, true)
	window.addEventListener('keydown', unlockAudio, true)
	const onMouseLeave = () => {
		if (document.pointerLockElement !== canvas) lastMouse = null
	}
	document.addEventListener('mousemove', onMouseMove)
	canvas.addEventListener('mousedown', onMouseDown)
	canvas.addEventListener('mouseleave', onMouseLeave)
	window.addEventListener('mouseup', onMouseUp)
	canvas.addEventListener('pointerdown', onPointerDown, pointerOpts)
	canvas.addEventListener('pointermove', onPointerMove, pointerOpts)
	canvas.addEventListener('pointerup', onPointerUp, pointerOpts)
	canvas.addEventListener('pointercancel', onPointerCancel, pointerOpts)
	canvas.addEventListener('contextmenu', onContextMenu)
	document.addEventListener('pointerlockchange', onPointerLockChange)
	canvas.tabIndex = 0
	canvas.focus()
	unlockAudio()

	return {
		destroy: () => {
			destroyed = true
			cancelAnimationFrame(frameRaf)
			window.removeEventListener('keydown', onKeyDown)
			window.removeEventListener('keyup', onKeyUp)
			window.removeEventListener('blur', onBlur)
			window.removeEventListener('pointerdown', unlockAudio, true)
			window.removeEventListener('keydown', unlockAudio, true)
			document.removeEventListener('mousemove', onMouseMove)
			canvas.removeEventListener('mousedown', onMouseDown)
			canvas.removeEventListener('mouseleave', onMouseLeave)
			window.removeEventListener('mouseup', onMouseUp)
			canvas.removeEventListener('pointerdown', onPointerDown, pointerOpts)
			canvas.removeEventListener('pointermove', onPointerMove, pointerOpts)
			canvas.removeEventListener('pointerup', onPointerUp, pointerOpts)
			canvas.removeEventListener('pointercancel', onPointerCancel, pointerOpts)
			canvas.removeEventListener('contextmenu', onContextMenu)
			document.removeEventListener('pointerlockchange', onPointerLockChange)
			dropTouchGesture()
			if (mouseButtonsHeld[1]) module._wasm_mouse_button(1, 1, 0)
			if (mouseButtonsHeld[3]) module._wasm_mouse_button(1, 3, 0)
			mouseButtonsHeld[1] = 0
			mouseButtonsHeld[3] = 0
			if (document.pointerLockElement === canvas) document.exitPointerLock()
			canvas.style.cursor = previousCursor
			audio?.destroy()
			audio = null
			onBlur()
			module._wasm_halt()
		},
		saveState: async () => {
			const json = wasmSnapshot()
			if (!json) return null
			try {
				const parsed = JSON.parse(json) as { address?: number; size?: number }
				if (!parsed.address || !parsed.size) return null
				const bytes = new Uint8Array(module.HEAPU8.buffer, parsed.address, parsed.size)
				const copy = bytes.slice()
				wasmDeleteSnapshot()
				return copy.buffer
			} catch {
				return null
			}
		},
		loadState: async (data) => {
			loadFile(module, 'stump.vAmiga', new Uint8Array(data))
			module._wasm_run()
		},
		mountImage: async (nextImage, nextFileName) => {
			current = { image: nextImage, fileName: nextFileName || current.fileName }
			wasmEject('df0')
			insertDisk(current.image, current.fileName)
		},
		reset: () => {
			module._wasm_reset()
			module._wasm_run()
			applyDiskSpeed()
			canvas.focus()
		},
		setInputMode: (mode) => {
			onBlur()
			inputMode = mode
		},
		setJoystickPort: (port) => {
			onBlur()
			joystickPort = port
		},
		setMouseSensitivity: (value) => {
			mouseSensitivity = clampMouseSensitivity(value)
		},
		setDiskSpeed: (speed) => {
			diskSpeed = speed
			applyDiskSpeed()
		},
		sendKey: (target: Dispatchable, down) => {
			if (typeof target !== 'string') return
			const id = target as OverlayKeyId
			const joy = overlayJoystickEvent(id, down)
			if (joy) {
				sendJoystick(joy)
				return
			}
			const code = overlayKeyCode(id)
			if (code === null) return
			module._wasm_key(code, down ? 1 : 0)
		},
		machines,
		get machine() {
			return machine
		},
		setMachine: async (id) => {
			if (!machines.some((option) => option.id === id) || id === machine) return
			machine = id
			boot(kickstartOf(machine, roms), current.image, current.fileName)
		},
	}
}

const module: RetroEmulatorModule = {
	platform: 'amiga',
	label: 'Commodore Amiga',
	optionalFirmware: [...AMIGA_OPTIONAL_KICKSTART_FILES],
	requiredFirmware: [...AMIGA_KICKSTART_FILES],
	create,
}

export default module
