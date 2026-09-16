import { JOYSTICK_DIRECTIONS, type JoystickDirection, type OverlayKeyId } from './keys'
import { joystickDirections } from './OnScreenControls'

/**
 * What a USB/Bluetooth pad looks like to the retro player: the same four directions and
 * fire the on-screen stick already speaks. The Gamepad API is analog and noisy; this is
 * the digital CIA-style stick the machines actually have.
 */
export type GamepadJoystickButtons = {
	directions: JoystickDirection[]
	fire: boolean
}

export const IDLE_GAMEPAD_JOYSTICK: GamepadJoystickButtons = { directions: [], fire: false }

/**
 * Face buttons that count as fire. 0–3 covers South/East/West/North on the standard
 * mapping (A/B/X/Y, Cross/Circle/Square/Triangle) and the same four on a raw DualShock,
 * where Cross is 1 rather than 0.
 */
const FIRE_BUTTONS = [0, 1, 2, 3] as const

/** Standard-mapping D-pad: up, down, left, right. */
const DPAD_BUTTONS: Record<JoystickDirection, number> = {
	up: 12,
	down: 13,
	left: 14,
	right: 15,
}

type GamepadSnapshot = {
	axes: ArrayLike<number>
	buttons: ArrayLike<GamepadButton | number | undefined>
}

function buttonHeld(
	buttons: ArrayLike<GamepadButton | number | undefined>,
	index: number,
): boolean {
	const button = buttons[index]
	if (button == null) return false
	if (typeof button === 'number') return button >= 0.5
	return button.pressed || button.value >= 0.5
}

/**
 * DirectInput POV hats are one axis. Idle is either -1 or a sentinel > 1 (Chrome's DualShock
 * reports ~3.29). The rest of the range is the 8-way angle, -1 = up going clockwise to 1.
 */
export function hatAxisDirections(value: number): JoystickDirection[] {
	if (!Number.isFinite(value) || Math.abs(value) < 0.1 || value < -0.95 || value > 1.05) {
		return []
	}
	const theta = ((value + 1) / 2) * (7 / 8) * 2 * Math.PI
	return joystickDirections(Math.sin(theta), -Math.cos(theta), 1)
}

/**
 * Digitise one pad into the overlay stick's vocabulary. The D-pad, left stick and (on a
 * non-standard mapping) hat axis are OR'd: a real CIA port is just four switches.
 */
export function readGamepadJoystick(pad: GamepadSnapshot): GamepadJoystickButtons {
	const analog = joystickDirections(Number(pad.axes[0]) || 0, Number(pad.axes[1]) || 0, 1)
	const hat = pad.axes.length > 9 ? hatAxisDirections(Number(pad.axes[9])) : []
	const directions = JOYSTICK_DIRECTIONS.filter(
		(direction) =>
			buttonHeld(pad.buttons, DPAD_BUTTONS[direction]) ||
			analog.includes(direction) ||
			hat.includes(direction),
	)
	const fire = FIRE_BUTTONS.some((index) => buttonHeld(pad.buttons, index))
	return { directions, fire }
}

export function firstConnectedGamepad(pads: ArrayLike<Gamepad | null>): Gamepad | null {
	for (let i = 0; i < pads.length; i += 1) {
		const pad = pads[i]
		if (pad && pad.connected !== false) return pad
	}
	return null
}

/**
 * Fold every live pad into one stick. Slot 0 is often a silent Steam/vJoy dummy, so taking
 * only the first connected pad would ignore the Xbox/PS pad sitting in slot 1.
 */
export function readAllGamepads(pads: ArrayLike<Gamepad | null>): GamepadJoystickButtons {
	const held = new Set<JoystickDirection>()
	let fire = false
	for (let i = 0; i < pads.length; i += 1) {
		const pad = pads[i]
		if (!pad || pad.connected === false) continue
		if (pad.buttons.length === 0 && pad.axes.length === 0) continue
		const next = readGamepadJoystick(pad)
		for (const direction of next.directions) held.add(direction)
		fire = fire || next.fire
	}
	return {
		directions: JOYSTICK_DIRECTIONS.filter((direction) => held.has(direction)),
		fire,
	}
}

type GamepadNavigator = Navigator & { webkitGetGamepads?: () => ArrayLike<Gamepad | null> }

export function listGamepads(): ArrayLike<Gamepad | null> {
	const nav = navigator as GamepadNavigator
	const fn = nav.getGamepads || nav.webkitGetGamepads
	if (typeof fn !== 'function') return []
	return fn.call(nav) ?? []
}

export function hasGamepadApi(): boolean {
	const nav = navigator as GamepadNavigator
	return typeof (nav.getGamepads || nav.webkitGetGamepads) === 'function'
}

/**
 * Edge-trigger `sendKey` the way the overlay stick does: release what dropped, then press
 * what appeared, and stay silent while a direction is held. Repeating keydown every frame
 * would hammer c64-ready's mixed-mode fire mapping.
 */
export function applyGamepadJoystick(
	prev: GamepadJoystickButtons,
	next: GamepadJoystickButtons,
	sendKey: (target: OverlayKeyId, down: boolean) => void,
) {
	for (const direction of JOYSTICK_DIRECTIONS) {
		const was = prev.directions.includes(direction)
		const now = next.directions.includes(direction)
		if (was && !now) sendKey(direction, false)
		if (!was && now) sendKey(direction, true)
	}
	if (prev.fire && !next.fire) sendKey('fire', false)
	if (!prev.fire && next.fire) sendKey('fire', true)
}
