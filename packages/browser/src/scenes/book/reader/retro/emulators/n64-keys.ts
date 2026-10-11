import type { Dispatchable } from '../keys'

/**
 * The N64 pad as the emulator host (`public/retro/n64/<version>/player.js`) knows it: which
 * of the fourteen digital buttons are down, plus an analog stick with `y` positive up. This
 * module is the pure part of that -- how each input surface maps onto it -- so it can be
 * tested without a core.
 */

export const N64_BUTTONS = [
	'up',
	'down',
	'left',
	'right',
	'a',
	'b',
	'start',
	'z',
	'l',
	'r',
	'cup',
	'cdown',
	'cleft',
	'cright',
] as const

export type N64Button = (typeof N64_BUTTONS)[number]

export type N64Buttons = Record<N64Button, boolean>

export type StickDirection = 'up' | 'down' | 'left' | 'right'

export type StickDirections = Record<StickDirection, boolean>

/** An analog stick position, each axis in -1..1, `y` positive up (as the core expects). */
export type StickVector = { x: number; y: number }

export type N64Input = { buttons: N64Buttons; stick: StickVector }

export function emptyButtons(): N64Buttons {
	return {
		a: false,
		b: false,
		cdown: false,
		cleft: false,
		cright: false,
		cup: false,
		down: false,
		l: false,
		left: false,
		r: false,
		right: false,
		start: false,
		up: false,
		z: false,
	}
}

export function emptyStick(): StickDirections {
	return { down: false, left: false, right: false, up: false }
}

const OVERLAY_BUTTONS: Partial<Record<string, N64Button>> = {
	a: 'a',
	b: 'b',
	cdown: 'cdown',
	cleft: 'cleft',
	cright: 'cright',
	cup: 'cup',
	l: 'l',
	r: 'r',
	start: 'start',
	z: 'z',
}

/**
 * The overlay's `up`/`down`/`left`/`right` are what its joystick holds as a finger slides
 * across it, so on this machine they are the analog stick, not the D-pad.
 */
const OVERLAY_STICK: Partial<Record<string, StickDirection>> = {
	down: 'down',
	left: 'left',
	right: 'right',
	up: 'up',
}

export function overlayButton(target: Dispatchable): N64Button | null {
	return typeof target === 'string' ? (OVERLAY_BUTTONS[target] ?? null) : null
}

export function overlayStickDirection(target: Dispatchable): StickDirection | null {
	return typeof target === 'string' ? (OVERLAY_STICK[target] ?? null) : null
}

/** Physical keys, by layout-independent `KeyboardEvent.code`. */
const KEYBOARD_BUTTONS: Partial<Record<string, N64Button>> = {
	Enter: 'start',
	KeyA: 'z',
	KeyD: 'a',
	KeyE: 'r',
	KeyF: 'left',
	KeyG: 'down',
	KeyH: 'right',
	KeyI: 'cup',
	KeyJ: 'cleft',
	KeyK: 'cdown',
	KeyL: 'cright',
	KeyQ: 'l',
	KeyS: 'b',
	KeyT: 'up',
}

const KEYBOARD_STICK: Partial<Record<string, StickDirection>> = {
	ArrowDown: 'down',
	ArrowLeft: 'left',
	ArrowRight: 'right',
	ArrowUp: 'up',
}

export function keyboardButton(code: string): N64Button | null {
	return KEYBOARD_BUTTONS[code] ?? null
}

export function keyboardStickDirection(code: string): StickDirection | null {
	return KEYBOARD_STICK[code] ?? null
}

/** Keys the player is allowed to swallow while it runs (so arrows do not scroll the page). */
export function isN64Key(code: string): boolean {
	return keyboardButton(code) !== null || keyboardStickDirection(code) !== null
}

/**
 * Held directions as a stick position. A diagonal is scaled to a unit-length push rather than
 * a full tilt on both axes, which is what a thumb on the real stick's octagonal gate reaches.
 */
export function stickVector(held: StickDirections): StickVector {
	const x = (held.right ? 1 : 0) - (held.left ? 1 : 0)
	const y = (held.up ? 1 : 0) - (held.down ? 1 : 0)
	if (x !== 0 && y !== 0) return { x: x * Math.SQRT1_2, y: y * Math.SQRT1_2 }
	return { x, y }
}

export const STICK_DEADZONE = 0.15

/** Radial dead zone with the remaining travel rescaled to 0..1, so the stick still reaches full tilt. */
export function applyDeadzone(x: number, y: number, deadzone = STICK_DEADZONE): StickVector {
	const magnitude = Math.hypot(x, y)
	if (magnitude <= deadzone) return { x: 0, y: 0 }
	const scaled = Math.min(1, (magnitude - deadzone) / (1 - deadzone))
	return { x: (x / magnitude) * scaled, y: (y / magnitude) * scaled }
}

export type GamepadLike = {
	axes: readonly number[]
	buttons: readonly { pressed: boolean; value?: number }[]
}

const TRIGGER_THRESHOLD = 0.5
const C_STICK_THRESHOLD = 0.5

function pressed(pad: GamepadLike, index: number): boolean {
	const button = pad.buttons[index]
	if (!button) return false
	return button.pressed || (button.value ?? 0) > TRIGGER_THRESHOLD
}

/**
 * A pad in the browser's "standard" layout: the left stick is the N64 stick, the right stick
 * is the four C buttons, the bumpers are L and R and either trigger is Z. A is the bottom
 * face button and B the left one, which is where they sit on the real pad.
 */
export function readGamepad(pad: GamepadLike): N64Input {
	const buttons = emptyButtons()
	buttons.a = pressed(pad, 0)
	buttons.b = pressed(pad, 2)
	buttons.l = pressed(pad, 4)
	buttons.r = pressed(pad, 5)
	buttons.z = pressed(pad, 6) || pressed(pad, 7)
	buttons.start = pressed(pad, 9)
	buttons.up = pressed(pad, 12)
	buttons.down = pressed(pad, 13)
	buttons.left = pressed(pad, 14)
	buttons.right = pressed(pad, 15)

	const cx = pad.axes[2] ?? 0
	const cy = pad.axes[3] ?? 0
	buttons.cleft = cx < -C_STICK_THRESHOLD
	buttons.cright = cx > C_STICK_THRESHOLD
	buttons.cup = cy < -C_STICK_THRESHOLD
	buttons.cdown = cy > C_STICK_THRESHOLD

	// Gamepad `y` is positive down; the core wants positive up
	const stick = applyDeadzone(pad.axes[0] ?? 0, -(pad.axes[1] ?? 0))
	return { buttons, stick }
}

/**
 * Several surfaces can be held at once (a keyboard and a pad, or a thumb on the overlay).
 * Buttons are OR-ed; for the stick the largest push wins, so a pad's analog tilt is not
 * overridden by an idle keyboard and a key still works with a pad plugged in.
 */
export function mergeInputs(inputs: readonly N64Input[]): N64Input {
	const buttons = emptyButtons()
	let stick: StickVector = { x: 0, y: 0 }
	for (const input of inputs) {
		for (const id of N64_BUTTONS) {
			if (input.buttons[id]) buttons[id] = true
		}
		if (Math.hypot(input.stick.x, input.stick.y) > Math.hypot(stick.x, stick.y)) {
			stick = input.stick
		}
	}
	return { buttons, stick }
}
