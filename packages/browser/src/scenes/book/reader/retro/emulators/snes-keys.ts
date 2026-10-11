import type { Dispatchable } from '../keys'

/**
 * The SNES pad as the Snes9x shim sees it: one active-high bit per control in the mask handed
 * to `_s9xwasm_input(pad, mask)`. This module is the pure part -- how the keyboard, the
 * on-screen overlay and a gamepad each map onto that mask -- so it can be tested without a
 * core. The bit layout is the shim's `BTN_*` enum and must not drift from it.
 */
export const SNES_BITS = {
	a: 8,
	b: 0,
	down: 5,
	l: 10,
	left: 6,
	r: 11,
	right: 7,
	select: 2,
	start: 3,
	up: 4,
	x: 9,
	y: 1,
} as const

export type SnesButton = keyof typeof SNES_BITS

export const SNES_BUTTONS = Object.keys(SNES_BITS) as SnesButton[]

const bit = (button: SnesButton) => 1 << SNES_BITS[button]

/**
 * The overlay's ids are machine-neutral caps: the joystick resolves into `up`/`down`/`left`/
 * `right`, which here are the D-pad, and the rest are the pad's own buttons.
 */
export function overlayButton(target: Dispatchable): SnesButton | null {
	if (typeof target !== 'string') return null
	return target in SNES_BITS ? (target as SnesButton) : null
}

/** Physical keys, by layout-independent `KeyboardEvent.code`. The face buttons form the pad's diamond. */
const KEYBOARD_BUTTONS: Partial<Record<string, SnesButton>> = {
	ArrowDown: 'down',
	ArrowLeft: 'left',
	ArrowRight: 'right',
	ArrowUp: 'up',
	Enter: 'start',
	KeyA: 'x',
	KeyQ: 'l',
	KeyS: 'a',
	KeyW: 'r',
	KeyX: 'b',
	KeyZ: 'y',
	ShiftLeft: 'select',
	ShiftRight: 'select',
}

export function keyboardButton(code: string): SnesButton | null {
	return KEYBOARD_BUTTONS[code] ?? null
}

/** Keys the player may swallow while it runs (so the arrows do not scroll the page). */
export function isSnesKey(code: string): boolean {
	return keyboardButton(code) !== null
}

export type SnesHeld = Partial<Record<SnesButton, boolean>>

/** The mask for a set of held buttons. */
export function maskFor(held: SnesHeld): number {
	let mask = 0
	for (const button of SNES_BUTTONS) {
		if (held[button]) mask |= bit(button)
	}
	return mask
}

export type GamepadLike = {
	axes: readonly number[]
	buttons: readonly { pressed: boolean; value?: number }[]
}

const STICK_THRESHOLD = 0.4

/**
 * A pad in the browser's "standard" layout. The SNES diamond is rotated against a modern pad:
 * the bottom and right face buttons are B and A, the left and top ones Y and X, which is where
 * those four sit on a real SNES pad. The left stick is a D-pad past a 40% threshold.
 */
export function readGamepad(pad: GamepadLike): number {
	const down = (index: number) => !!pad.buttons[index]?.pressed
	const axis = (index: number) => pad.axes[index] ?? 0
	return maskFor({
		a: down(1),
		b: down(0),
		down: down(13) || axis(1) > STICK_THRESHOLD,
		l: down(4),
		left: down(14) || axis(0) < -STICK_THRESHOLD,
		r: down(5),
		right: down(15) || axis(0) > STICK_THRESHOLD,
		select: down(8),
		start: down(9),
		up: down(12) || axis(1) < -STICK_THRESHOLD,
		x: down(3),
		y: down(2),
	})
}

/** Every surface can be held at once (keyboard and pad, or a thumb on the overlay): OR them. */
export function mergeMasks(masks: readonly number[]): number {
	return masks.reduce((all, mask) => all | mask, 0)
}
