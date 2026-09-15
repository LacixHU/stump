import type { Dispatchable, OverlayKeyId } from '../keys'
import {
	AMIGA_KEY_CODES,
	isPhysicalJoystickCode,
	joystickCommand,
	overlayJoystickEvent,
	overlayKeyCode,
	physicalJoystickEvent,
} from './amiga-keys'
import { containPoint, palDisplayHeight, TPP } from './amiga-video'
import type {
	EmulatorMountOptions,
	RetroDiskSpeed,
	RetroEmulatorHandle,
	RetroEmulatorModule,
	RetroInputMode,
	RetroOption,
} from './types'

const ASSET_BASE = '/retro/amiga'
const SCRIPT_URL = `${ASSET_BASE}/vAmiga.js`

export const AMIGA_KICKSTART_FILES = ['kick33180.A500', 'kick34005.A500'] as const

const MACHINES: readonly RetroOption[] = [
	{ id: 'kick34005.A500', label: 'A500 Kickstart 1.3' },
	{ id: 'kick33180.A500', label: 'A500 Kickstart 1.2' },
]
const DEFAULT_MACHINE = 'kick34005.A500'

const HBLANK_MIN = 0x12 * TPP
const HPIXELS = 912 * TPP
const VPIXELS = 313
const CATCHUP_MAX = 8
const AUDIO_SAMPLE_RATE = 44100

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
	const buffer = firmware[machine] || firmware[DEFAULT_MACHINE]
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

	let machine = DEFAULT_MACHINE
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

	const applyWarp = () => {
		module._wasm_set_warp(diskSpeed === 'instant' ? 1 : 0)
	}

	const insertDisk = (bytes: ArrayBuffer, fileName?: string) => {
		loadFile(module, diskName(fileName), new Uint8Array(bytes), 0)
	}

	const boot = (kick: Uint8Array, disk: ArrayBuffer, fileName?: string) => {
		loadFile(module, 'kick.rom_file', kick)
		insertDisk(disk, fileName)
		module._wasm_reset()
		module._wasm_run()
		applyWarp()
	}

	const roms = firmware as Record<string, ArrayBuffer>
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
		const node = context.createScriptProcessor(1024, 0, 2)
		node.onaudioprocess = (event) => {
			const left = event.outputBuffer.getChannelData(0)
			const right = event.outputBuffer.getChannelData(1)
			const samples = module._wasm_copy_into_sound_buffer()
			if (samples < 1024) {
				left.fill(0)
				right.fill(0)
				return
			}
			const addr = module._wasm_get_sound_buffer_address()
			const heap = new Float32Array(module.HEAPF32.buffer, addr, 2048)
			left.set(heap.subarray(0, 1024))
			right.set(heap.subarray(1024, 2048))
		}
		node.connect(context.destination)
		audio = {
			resume: () => {
				void context.resume()
			},
			destroy: () => {
				node.disconnect()
				void context.close()
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
	const onBlur = () => {
		wasmJoystick(joystickCommand(joystickPort, 'RELEASE_X'))
		wasmJoystick(joystickCommand(joystickPort, 'RELEASE_Y'))
		wasmJoystick(joystickCommand(joystickPort, 'RELEASE_FIRE'))
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
		if (document.pointerLockElement === canvas) {
			module._wasm_mouse(1, event.movementX, event.movementY)
			return
		}
		const point = framebufferFromEvent(event)
		if (!point) {
			lastMouse = null
			return
		}
		if (lastMouse) {
			module._wasm_mouse(1, Math.round(point.x - lastMouse.x), Math.round(point.y - lastMouse.y))
		}
		lastMouse = point
	}
	const onMouseDown = (event: MouseEvent) => {
		unlockAudio()
		canvas.focus()
		if (document.pointerLockElement !== canvas) {
			void canvas.requestPointerLock?.()
		}
		const button = event.button === 2 ? 3 : 1
		module._wasm_mouse_button(1, button, 1)
	}
	const onMouseUp = (event: MouseEvent) => {
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
			canvas.removeEventListener('contextmenu', onContextMenu)
			document.removeEventListener('pointerlockchange', onPointerLockChange)
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
			applyWarp()
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
		setDiskSpeed: (speed) => {
			diskSpeed = speed
			applyWarp()
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
		machines: MACHINES,
		get machine() {
			return machine
		},
		setMachine: async (id) => {
			if (!MACHINES.some((option) => option.id === id) || id === machine) return
			machine = id
			const roms = firmware as Record<string, ArrayBuffer>
			boot(kickstartOf(machine, roms), current.image, current.fileName)
		},
	}
}

const module: RetroEmulatorModule = {
	platform: 'amiga',
	label: 'Commodore Amiga',
	requiredFirmware: [...AMIGA_KICKSTART_FILES],
	create,
}

export default module
