import type { Dispatchable } from '../keys'
import {
	emptyButtons,
	emptyStick,
	isN64Key,
	keyboardButton,
	keyboardStickDirection,
	mergeInputs,
	type N64Button,
	type N64Buttons,
	type N64Input,
	N64_BUTTONS,
	overlayButton,
	overlayStickDirection,
	readGamepad,
	type StickDirection,
	type StickDirections,
	stickVector,
} from './n64-keys'
import { packN64Save, unpackN64Save } from './n64-saves'
import type { EmulatorMountOptions, RetroEmulatorHandle, RetroEmulatorModule } from './types'

/**
 * Versioned: `/retro/*` is served immutable for a year and its files are not hashed, so a new
 * build of the core goes in a new directory (and this constant moves with it).
 */
const PLAYER_URL = '/retro/n64/v1/player.html'
const FRAME_LOAD_TIMEOUT_MS = 15000

/** What `public/retro/n64/v1/player.js` puts on the frame's `window`. */
type N64HostApi = {
	onError: ((message: string) => void) | null
	onStarted: (() => void) | null
	start: (rom: ArrayBuffer, name: string) => Promise<void>
	setButton: (id: N64Button, down: boolean) => void
	setAxis: (x: number, y: number) => void
	releaseAll: () => void
	reset: () => void
	resumeAudio: () => void
	saveState: () => Promise<Uint8Array>
	loadState: (bytes: Uint8Array) => Promise<void>
	destroy: () => void
}

function hostApi(frame: HTMLIFrameElement): N64HostApi | undefined {
	return (frame.contentWindow as (Window & { stumpN64?: N64HostApi }) | null)?.stumpN64
}

function waitForFrame(frame: HTMLIFrameElement): Promise<N64HostApi> {
	return new Promise((resolve, reject) => {
		const timer = window.setTimeout(() => {
			reject(new Error('The N64 emulator did not load'))
		}, FRAME_LOAD_TIMEOUT_MS)
		frame.addEventListener(
			'load',
			() => {
				window.clearTimeout(timer)
				const api = hostApi(frame)
				if (api) resolve(api)
				else reject(new Error('The N64 emulator page is missing its host script'))
			},
			{ once: true },
		)
		frame.addEventListener(
			'error',
			() => {
				window.clearTimeout(timer)
				reject(new Error('The N64 emulator page could not be loaded'))
			},
			{ once: true },
		)
	})
}

function isTypingTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false
	return target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)
}

async function create(options: EmulatorMountOptions): Promise<RetroEmulatorHandle> {
	const { canvas, image, fileName } = options
	const parent = canvas.parentElement
	if (!parent) throw new Error('The N64 player has nowhere to mount')

	// The core owns a WebGL2 canvas of its own inside the frame, so the scene's canvas (which
	// another platform may already have given a 2d context) stays untouched under it. The
	// frame ignores the pointer: clicks stay with the scene, so it never takes keyboard
	// focus, and the scene's overlay sits above it.
	const frame = document.createElement('iframe')
	frame.src = PLAYER_URL
	frame.title = 'Nintendo 64'
	frame.tabIndex = -1
	frame.setAttribute('aria-hidden', 'true')
	frame.allow = 'autoplay; gamepad; fullscreen'
	frame.className = 'absolute inset-0 h-full w-full border-0 bg-black pointer-events-none'
	parent.insertBefore(frame, canvas.nextSibling)

	let api: N64HostApi | undefined
	let alive = true

	const removeFrame = () => {
		try {
			api?.destroy()
		} catch {
			// the frame may already be gone
		}
		frame.remove()
	}

	try {
		const loaded = waitForFrame(frame)
		api = await loaded
		await api.start(image, fileName ?? 'game')
	} catch (error) {
		alive = false
		removeFrame()
		throw error instanceof Error ? error : new Error(String(error))
	}
	const host = api

	// ------------------------------------------------------------------ input

	const keyboardButtons = emptyButtons()
	const keyboardStick: StickDirections = emptyStick()
	const overlayButtons = emptyButtons()
	const overlayStick: StickDirections = emptyStick()
	let pad: N64Input | null = null
	let sent: N64Buttons = emptyButtons()
	let sentStick = { x: 0, y: 0 }

	const push = () => {
		if (!alive) return
		const merged = mergeInputs([
			{ buttons: keyboardButtons, stick: stickVector(keyboardStick) },
			{ buttons: overlayButtons, stick: stickVector(overlayStick) },
			...(pad ? [pad] : []),
		])
		for (const id of N64_BUTTONS) {
			if (merged.buttons[id] !== sent[id]) host.setButton(id, merged.buttons[id])
		}
		if (merged.stick.x !== sentStick.x || merged.stick.y !== sentStick.y) {
			host.setAxis(merged.stick.x, merged.stick.y)
		}
		sent = merged.buttons
		sentStick = merged.stick
	}

	const resumeAudio = () => host.resumeAudio()

	const onKey = (down: boolean) => (event: KeyboardEvent) => {
		if (!isN64Key(event.code) || isTypingTarget(event.target)) return
		// The page would otherwise scroll on the arrows and repeat the held key
		event.preventDefault()
		if (event.repeat) return
		const button = keyboardButton(event.code)
		if (button) keyboardButtons[button] = down
		const direction = keyboardStickDirection(event.code)
		if (direction) keyboardStick[direction] = down
		if (down) resumeAudio()
		push()
	}
	const onKeyDown = onKey(true)
	const onKeyUp = onKey(false)

	const releaseAll = () => {
		for (const id of N64_BUTTONS) {
			keyboardButtons[id] = false
			overlayButtons[id] = false
		}
		Object.assign(keyboardStick, emptyStick())
		Object.assign(overlayStick, emptyStick())
		host.releaseAll()
		sent = emptyButtons()
		sentStick = { x: 0, y: 0 }
		push()
	}

	window.addEventListener('keydown', onKeyDown, true)
	window.addEventListener('keyup', onKeyUp, true)
	window.addEventListener('blur', releaseAll)
	window.addEventListener('pointerdown', resumeAudio, true)

	// Gamepads have no events for their buttons, so they are polled once a frame
	let raf = 0
	let padWasActive = false
	const poll = () => {
		if (!alive) return
		const pads = navigator.getGamepads?.() ?? []
		const connected = pads.find((p): p is Gamepad => !!p && p.connected && p.buttons.length > 0)
		pad = connected ? readGamepad(connected) : null
		const active =
			!!pad &&
			(N64_BUTTONS.some((id) => pad!.buttons[id]) || pad.stick.x !== 0 || pad.stick.y !== 0)
		// Audio can only start after a gesture, and a pad press is the only one a player on a
		// pad ever makes
		if (active && !padWasActive) resumeAudio()
		if (active || padWasActive) push()
		padWasActive = active
		raf = window.requestAnimationFrame(poll)
	}
	raf = window.requestAnimationFrame(poll)

	host.onError = (message) => console.error('[n64]', message)
	resumeAudio()

	return {
		destroy: () => {
			alive = false
			window.cancelAnimationFrame(raf)
			window.removeEventListener('keydown', onKeyDown, true)
			window.removeEventListener('keyup', onKeyUp, true)
			window.removeEventListener('blur', releaseAll)
			window.removeEventListener('pointerdown', resumeAudio, true)
			removeFrame()
		},
		loadState: async (data) => {
			await host.loadState(unpackN64Save(data))
		},
		reset: () => host.reset(),
		saveState: async () => packN64Save(await host.saveState()),
		sendKey: (target: Dispatchable, down) => {
			const button = overlayButton(target)
			if (button) overlayButtons[button] = down
			const direction: StickDirection | null = overlayStickDirection(target)
			if (direction) overlayStick[direction] = down
			if (button || direction) {
				if (down) resumeAudio()
				push()
			}
		},
	}
}

const module: RetroEmulatorModule = {
	create,
	label: 'Nintendo 64',
	platform: 'n64',
}

export default module
