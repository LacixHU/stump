import type { OverlayKeyId } from '../keys'

/** vAmiga KeyCode values (Amiga raw key codes). */
export const AMIGA_KEY_CODES: Record<string, number> = {
	Backquote: 0,
	Digit1: 1,
	Digit2: 2,
	Digit3: 3,
	Digit4: 4,
	Digit5: 5,
	Digit6: 6,
	Digit7: 7,
	Digit8: 8,
	Digit9: 9,
	Digit0: 10,
	Minus: 0x0b,
	Equal: 0x0c,
	Backslash: 0x0d,
	KeyQ: 0x10,
	KeyW: 0x11,
	KeyE: 0x12,
	KeyR: 0x13,
	KeyT: 0x14,
	KeyY: 0x15,
	KeyU: 0x16,
	KeyI: 0x17,
	KeyO: 0x18,
	KeyP: 0x19,
	BracketLeft: 0x1a,
	BracketRight: 0x1b,
	KeyA: 0x20,
	KeyS: 0x21,
	KeyD: 0x22,
	KeyF: 0x23,
	KeyG: 0x24,
	KeyH: 0x25,
	KeyJ: 0x26,
	KeyK: 0x27,
	KeyL: 0x28,
	Semicolon: 0x29,
	Quote: 0x2a,
	KeyZ: 0x31,
	KeyX: 0x32,
	KeyC: 0x33,
	KeyV: 0x34,
	KeyB: 0x35,
	KeyN: 0x36,
	KeyM: 0x37,
	Comma: 0x38,
	Period: 0x39,
	Slash: 0x3a,
	Space: 0x40,
	Backspace: 0x41,
	Tab: 0x42,
	NumpadEnter: 0x43,
	Enter: 0x44,
	Escape: 0x45,
	Delete: 0x46,
	ArrowUp: 0x4c,
	ArrowDown: 0x4d,
	ArrowRight: 0x4e,
	ArrowLeft: 0x4f,
	F1: 0x50,
	F2: 0x51,
	F3: 0x52,
	F4: 0x53,
	F5: 0x54,
	F6: 0x55,
	F7: 0x56,
	F8: 0x57,
	F9: 0x58,
	F10: 0x59,
	ShiftLeft: 0x60,
	ShiftRight: 0x61,
	CapsLock: 0x62,
	ControlLeft: 0x63,
	ControlRight: 0x63,
	AltLeft: 0x64,
	AltRight: 0x65,
	MetaLeft: 0x66,
	OSLeft: 0x66,
	MetaRight: 0x67,
	OSRight: 0x67,
	Help: 0x5f,
}

const OVERLAY_TO_CODE: Partial<Record<OverlayKeyId, number>> = {
	space: 0x40,
	return: 0x44,
	runstop: 0x45,
	instdel: 0x41,
	ctrl: 0x63,
	shift: 0x60,
	shiftright: 0x61,
	commodore: 0x66,
	f1: 0x50,
	f2: 0x51,
	f3: 0x52,
	f4: 0x53,
	f5: 0x54,
	f6: 0x55,
	f7: 0x56,
	f8: 0x57,
	a: 0x20,
	b: 0x35,
	c: 0x33,
	d: 0x22,
	e: 0x12,
	f: 0x23,
	g: 0x24,
	h: 0x25,
	i: 0x17,
	j: 0x26,
	k: 0x27,
	l: 0x28,
	m: 0x37,
	n: 0x36,
	o: 0x18,
	p: 0x19,
	q: 0x10,
	r: 0x13,
	s: 0x21,
	t: 0x14,
	u: 0x16,
	v: 0x34,
	w: 0x11,
	x: 0x32,
	y: 0x15,
	z: 0x31,
	'0': 10,
	'1': 1,
	'2': 2,
	'3': 3,
	'4': 4,
	'5': 5,
	'6': 6,
	'7': 7,
	'8': 8,
	'9': 9,
	comma: 0x38,
	period: 0x39,
	slash: 0x3a,
	minus: 0x0b,
	equals: 0x0c,
	semicolon: 0x29,
	backslash: 0x0d,
	bracketleft: 0x1a,
	bracketright: 0x1b,
	quote: 0x2a,
	backquote: 0,
	tab: 0x42,
	alt: 0x64,
	help: 0x5f,
	delete: 0x46,
	capslock: 0x62,
	f9: 0x58,
	f10: 0x59,
	cursorup: 0x4c,
	cursordown: 0x4d,
	cursorright: 0x4e,
	cursorleft: 0x4f,
}

export const JOYSTICK_OVERLAY_IDS = new Set<OverlayKeyId>(['up', 'down', 'left', 'right', 'fire'])

const JOYSTICK_PHYSICAL = new Set([
	'ArrowUp',
	'ArrowDown',
	'ArrowLeft',
	'ArrowRight',
	'ControlLeft',
])

export type JoystickEvent =
	| 'PULL_UP'
	| 'PULL_DOWN'
	| 'PULL_LEFT'
	| 'PULL_RIGHT'
	| 'PRESS_FIRE'
	| 'RELEASE_X'
	| 'RELEASE_Y'
	| 'RELEASE_FIRE'

export function joystickCommand(port: 1 | 2, event: JoystickEvent): string {
	return `${port}${event}`
}

export function physicalJoystickEvent(code: string, down: boolean): JoystickEvent | null {
	switch (code) {
		case 'ArrowUp':
			return down ? 'PULL_UP' : 'RELEASE_Y'
		case 'ArrowDown':
			return down ? 'PULL_DOWN' : 'RELEASE_Y'
		case 'ArrowLeft':
			return down ? 'PULL_LEFT' : 'RELEASE_X'
		case 'ArrowRight':
			return down ? 'PULL_RIGHT' : 'RELEASE_X'
		case 'ControlLeft':
			return down ? 'PRESS_FIRE' : 'RELEASE_FIRE'
		default:
			return null
	}
}

export function overlayJoystickEvent(id: OverlayKeyId, down: boolean): JoystickEvent | null {
	switch (id) {
		case 'up':
			return down ? 'PULL_UP' : 'RELEASE_Y'
		case 'down':
			return down ? 'PULL_DOWN' : 'RELEASE_Y'
		case 'left':
			return down ? 'PULL_LEFT' : 'RELEASE_X'
		case 'right':
			return down ? 'PULL_RIGHT' : 'RELEASE_X'
		case 'fire':
			return down ? 'PRESS_FIRE' : 'RELEASE_FIRE'
		default:
			return null
	}
}

export function overlayKeyCode(id: OverlayKeyId): number | null {
	return OVERLAY_TO_CODE[id] ?? null
}

export function isPhysicalJoystickCode(code: string): boolean {
	return JOYSTICK_PHYSICAL.has(code)
}
