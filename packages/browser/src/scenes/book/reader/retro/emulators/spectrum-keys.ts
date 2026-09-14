import type { OverlayKeyId } from '../keys'

/**
 * The ZX Spectrum keyboard as the machine itself sees it: eight half-rows of five keys,
 * each read through one address line. The emulator core takes nothing else -- there is no
 * character layer to hand it -- so every input surface (physical keyboard, the docked
 * VirtualKeyboard, the touch overlay) ends up here.
 */
export type SpectrumMatrixKey = { row: number; mask: number }

/** A keystroke is a set of matrix keys, because half the Spectrum's legends are shifted. */
export type SpectrumCombo = readonly SpectrumMatrixKey[]

const key = (row: number, mask: number): SpectrumMatrixKey => ({ row, mask })

export const CAPS_SHIFT = key(0, 0x01)
export const SYMBOL_SHIFT = key(7, 0x02)

/** Matrix position of every key that has a cap of its own. */
export const SPECTRUM_KEYS = {
	capsshift: CAPS_SHIFT,
	z: key(0, 0x02),
	x: key(0, 0x04),
	c: key(0, 0x08),
	v: key(0, 0x10),

	a: key(1, 0x01),
	s: key(1, 0x02),
	d: key(1, 0x04),
	f: key(1, 0x08),
	g: key(1, 0x10),

	q: key(2, 0x01),
	w: key(2, 0x02),
	e: key(2, 0x04),
	r: key(2, 0x08),
	t: key(2, 0x10),

	'1': key(3, 0x01),
	'2': key(3, 0x02),
	'3': key(3, 0x04),
	'4': key(3, 0x08),
	'5': key(3, 0x10),

	'0': key(4, 0x01),
	'9': key(4, 0x02),
	'8': key(4, 0x04),
	'7': key(4, 0x08),
	'6': key(4, 0x10),

	p: key(5, 0x01),
	o: key(5, 0x02),
	i: key(5, 0x04),
	u: key(5, 0x08),
	y: key(5, 0x10),

	return: key(6, 0x01),
	l: key(6, 0x02),
	k: key(6, 0x04),
	j: key(6, 0x08),
	h: key(6, 0x10),

	space: key(7, 0x01),
	symbolshift: SYMBOL_SHIFT,
	m: key(7, 0x04),
	n: key(7, 0x08),
	b: key(7, 0x10),
} as const satisfies Record<string, SpectrumMatrixKey>

export type SpectrumKeyName = keyof typeof SPECTRUM_KEYS

const caps = (name: SpectrumKeyName): SpectrumCombo => [CAPS_SHIFT, SPECTRUM_KEYS[name]]
const sym = (name: SpectrumKeyName): SpectrumCombo => [SYMBOL_SHIFT, SPECTRUM_KEYS[name]]

/**
 * Cursor keys, DELETE and BREAK are all CAPS SHIFT plus a key on the real machine, which
 * is also how a game reads them -- so they are sent as the pair, never as a key of their own.
 */
const CURSOR_UP = caps('7')
const CURSOR_DOWN = caps('6')
const CURSOR_LEFT = caps('5')
const CURSOR_RIGHT = caps('8')
const DELETE = caps('0')
const BREAK = caps('space')

/**
 * The Spectrum has no joystick port of its own, and JSSpeccy's core does not emulate a
 * Kempston interface (a read of port 0x1f always comes back idle), so a stick has to press
 * whatever keys the game was written for. These are the three schemes worth offering:
 *
 * - `qaop`: Q/A/O/P plus space, the de-facto default for keyboard-only games
 * - `cursor`: the Protek / AGF convention, CAPS SHIFT + 5-8 with 0 to fire
 * - `sinclair`: Interface 2 right-hand stick, keys 6-0
 */
export const SPECTRUM_JOYSTICK_SCHEMES = ['qaop', 'cursor', 'sinclair'] as const

export type SpectrumJoystickScheme = (typeof SPECTRUM_JOYSTICK_SCHEMES)[number]

export const SPECTRUM_JOYSTICK_LABELS: Record<SpectrumJoystickScheme, string> = {
	qaop: 'Q/A/O/P + Space',
	cursor: 'Cursor keys',
	sinclair: 'Sinclair (6-0)',
}

type JoystickDirectionId = 'up' | 'down' | 'left' | 'right' | 'fire'

const JOYSTICK_COMBOS: Record<
	SpectrumJoystickScheme,
	Record<JoystickDirectionId, SpectrumCombo>
> = {
	qaop: {
		up: [SPECTRUM_KEYS.q],
		down: [SPECTRUM_KEYS.a],
		left: [SPECTRUM_KEYS.o],
		right: [SPECTRUM_KEYS.p],
		fire: [SPECTRUM_KEYS.space],
	},
	cursor: {
		up: CURSOR_UP,
		down: CURSOR_DOWN,
		left: CURSOR_LEFT,
		right: CURSOR_RIGHT,
		fire: [SPECTRUM_KEYS['0']],
	},
	sinclair: {
		up: [SPECTRUM_KEYS['9']],
		down: [SPECTRUM_KEYS['8']],
		left: [SPECTRUM_KEYS['6']],
		right: [SPECTRUM_KEYS['7']],
		fire: [SPECTRUM_KEYS['0']],
	},
}

/**
 * Overlay ids that mean something different on a Spectrum than on a C64, or nothing at
 * all. Anything not listed here and not a plain key name is simply not sent: a layout
 * saved against a C64 game may well contain `commodore` or `f7`.
 */
const OVERLAY_ALIASES: Partial<Record<OverlayKeyId, SpectrumCombo>> = {
	cursorup: CURSOR_UP,
	cursordown: CURSOR_DOWN,
	cursorleft: CURSOR_LEFT,
	cursorright: CURSOR_RIGHT,
	instdel: DELETE,
	runstop: BREAK,
	comma: sym('n'),
	period: sym('m'),
	semicolon: sym('o'),
	colon: sym('z'),
	slash: sym('v'),
	plus: sym('k'),
	minus: sym('j'),
	equals: sym('l'),
	star: sym('b'),
	at: sym('2'),
}

const isSpectrumKeyName = (id: string): id is SpectrumKeyName => id in SPECTRUM_KEYS

/** What the overlay and the docked keyboard press for a given control id. */
export function overlayCombo(
	id: OverlayKeyId,
	scheme: SpectrumJoystickScheme,
): SpectrumCombo | null {
	const joystick = JOYSTICK_COMBOS[scheme][id as JoystickDirectionId]
	if (joystick) return joystick
	if (isSpectrumKeyName(id)) return [SPECTRUM_KEYS[id]]
	return OVERLAY_ALIASES[id] ?? null
}

/**
 * Physical keyboard, by `event.code` rather than `key`, so the mapping holds on a layout
 * where the letters sit elsewhere and does not shift under the user's own modifiers.
 */
const PHYSICAL_KEYS: Record<string, SpectrumCombo> = {
	Enter: [SPECTRUM_KEYS.return],
	NumpadEnter: [SPECTRUM_KEYS.return],
	Space: [SPECTRUM_KEYS.space],
	ShiftLeft: [CAPS_SHIFT],
	ShiftRight: [CAPS_SHIFT],
	ControlLeft: [SYMBOL_SHIFT],
	ControlRight: [SYMBOL_SHIFT],
	AltLeft: [SYMBOL_SHIFT],
	AltRight: [SYMBOL_SHIFT],
	Backspace: DELETE,
	Escape: BREAK,
	ArrowUp: CURSOR_UP,
	ArrowDown: CURSOR_DOWN,
	ArrowLeft: CURSOR_LEFT,
	ArrowRight: CURSOR_RIGHT,
	Comma: sym('n'),
	Period: sym('m'),
	Semicolon: sym('o'),
	Quote: sym('7'),
	Minus: sym('j'),
	Equal: sym('l'),
	Slash: sym('v'),
}

for (const name of Object.keys(SPECTRUM_KEYS) as SpectrumKeyName[]) {
	if (name.length !== 1) continue
	const code = name >= '0' && name <= '9' ? `Digit${name}` : `Key${name.toUpperCase()}`
	PHYSICAL_KEYS[code] = [SPECTRUM_KEYS[name]]
}

export function physicalKeyCombo(code: string): SpectrumCombo | null {
	return PHYSICAL_KEYS[code] ?? null
}
