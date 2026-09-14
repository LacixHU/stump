/**
 * The key vocabulary shared by the two retro input surfaces: the draggable joystick
 * overlay (`OnScreenControls`) and the docked machine keyboard (`VirtualKeyboard`).
 *
 * Both talk to the emulator the same way -- by dispatching synthetic `KeyboardEvent`s on
 * `window`, which is where c64-ready installs its listeners. It maps matrix keys off
 * `event.key` and joystick keys off `event.code`, so the `code` values below are
 * deliberately nonsense (`C64_z`): a real `KeyZ` would be swallowed as joystick fire in
 * mixed mode instead of reaching the keyboard matrix.
 */

export const OVERLAY_KEY_IDS = [
	'up',
	'down',
	'left',
	'right',
	'fire',
	'runstop',
	'space',
	'return',
	'commodore',
	'ctrl',
	'shift',
	'shiftright',
	'restore',
	'instdel',
	'home',
	'f1',
	'f2',
	'f3',
	'f4',
	'f5',
	'f6',
	'f7',
	'f8',
	'pound',
	'at',
	'star',
	'plus',
	'minus',
	'equals',
	'colon',
	'semicolon',
	'comma',
	'period',
	'slash',
	'arrowleft',
	'arrowup',
	'cursorup',
	'cursordown',
	'cursorleft',
	'cursorright',
	'a',
	'b',
	'c',
	'd',
	'e',
	'f',
	'g',
	'h',
	'i',
	'j',
	'k',
	'l',
	'm',
	'n',
	'o',
	'p',
	'q',
	'r',
	's',
	't',
	'u',
	'v',
	'w',
	'x',
	'y',
	'z',
	'0',
	'1',
	'2',
	'3',
	'4',
	'5',
	'6',
	'7',
	'8',
	'9',
] as const

export type OverlayKeyId = (typeof OVERLAY_KEY_IDS)[number]

export type KeySpec = { key: string; code: string }

export function keySpec(id: OverlayKeyId): KeySpec {
	switch (id) {
		case 'up':
			return { key: 'ArrowUp', code: 'ArrowUp' }
		case 'down':
			return { key: 'ArrowDown', code: 'ArrowDown' }
		case 'left':
			return { key: 'ArrowLeft', code: 'ArrowLeft' }
		case 'right':
			return { key: 'ArrowRight', code: 'ArrowRight' }
		case 'fire':
			return { key: 'z', code: 'KeyZ' }
		case 'runstop':
			return { key: 'Escape', code: 'Escape' }
		case 'space':
			return { key: ' ', code: 'Space' }
		case 'return':
			return { key: 'Enter', code: 'Enter' }
		case 'commodore':
			return { key: 'Control', code: 'ControlRight' }
		case 'ctrl':
			return { key: 'Tab', code: 'Tab' }
		case 'shift':
		case 'shiftright':
			return { key: 'Shift', code: 'ShiftLeft' }
		case 'restore':
			return { key: 'PageUp', code: 'PageUp' }
		case 'instdel':
			return { key: 'Backspace', code: 'Backspace' }
		case 'home':
			return { key: 'Home', code: 'Home' }
		case 'f1':
			return { key: 'F1', code: 'C64_f1' }
		case 'f2':
			return { key: 'F2', code: 'C64_f2' }
		case 'f3':
			return { key: 'F3', code: 'C64_f3' }
		case 'f4':
			return { key: 'F4', code: 'C64_f4' }
		case 'f5':
			return { key: 'F5', code: 'C64_f5' }
		case 'f6':
			return { key: 'F6', code: 'C64_f6' }
		case 'f7':
			return { key: 'F7', code: 'C64_f7' }
		case 'f8':
			return { key: 'F8', code: 'C64_f8' }
		case 'pound':
			return { key: '\\', code: 'C64_pound' }
		case 'at':
			return { key: '@', code: 'C64_at' }
		case 'star':
			return { key: '*', code: 'C64_star' }
		case 'plus':
			return { key: '+', code: 'C64_plus' }
		case 'minus':
			return { key: '-', code: 'C64_minus' }
		case 'equals':
			return { key: '=', code: 'C64_equals' }
		case 'colon':
			return { key: ':', code: 'C64_colon' }
		case 'semicolon':
			return { key: ';', code: 'C64_semicolon' }
		case 'comma':
			return { key: ',', code: 'C64_comma' }
		case 'period':
			return { key: '.', code: 'C64_period' }
		case 'slash':
			return { key: '/', code: 'C64_slash' }
		case 'arrowleft':
			return { key: '`', code: 'C64_arrowleft' }
		case 'arrowup':
			return { key: '^', code: 'C64_arrowup' }
		case 'cursorup':
			return { key: 'ArrowUp', code: 'C64_cursorup' }
		case 'cursordown':
			return { key: 'ArrowDown', code: 'C64_cursordown' }
		case 'cursorleft':
			return { key: 'ArrowLeft', code: 'C64_cursorleft' }
		case 'cursorright':
			return { key: 'ArrowRight', code: 'C64_cursorright' }
		default:
			return { key: id, code: `C64_${id}` }
	}
}

export const OVERLAY_LABELS: Record<OverlayKeyId, string> = {
	up: 'Joy ↑',
	down: 'Joy ↓',
	left: 'Joy ←',
	right: 'Joy →',
	fire: 'Fire',
	runstop: 'R/S',
	space: 'Space',
	return: 'Return',
	commodore: 'C=',
	ctrl: 'Ctrl',
	shift: 'Shift',
	shiftright: 'Shift',
	restore: 'Rest',
	instdel: 'Del',
	home: 'Clr',
	f1: 'F1',
	f2: 'F2',
	f3: 'F3',
	f4: 'F4',
	f5: 'F5',
	f6: 'F6',
	f7: 'F7',
	f8: 'F8',
	pound: '£',
	at: '@',
	star: '*',
	plus: '+',
	minus: '-',
	equals: '=',
	colon: ':',
	semicolon: ';',
	comma: ',',
	period: '.',
	slash: '/',
	arrowleft: '←',
	arrowup: '↑',
	cursorup: 'Cr ↑',
	cursordown: 'Cr ↓',
	cursorleft: 'Cr ←',
	cursorright: 'Cr →',
	a: 'A',
	b: 'B',
	c: 'C',
	d: 'D',
	e: 'E',
	f: 'F',
	g: 'G',
	h: 'H',
	i: 'I',
	j: 'J',
	k: 'K',
	l: 'L',
	m: 'M',
	n: 'N',
	o: 'O',
	p: 'P',
	q: 'Q',
	r: 'R',
	s: 'S',
	t: 'T',
	u: 'U',
	v: 'V',
	w: 'W',
	x: 'X',
	y: 'Y',
	z: 'Z',
	'0': '0',
	'1': '1',
	'2': '2',
	'3': '3',
	'4': '4',
	'5': '5',
	'6': '6',
	'7': '7',
	'8': '8',
	'9': '9',
}

/** Modifier state to stamp onto a synthetic event. */
export type KeyModifiers = {
	/**
	 * Sets `shiftKey` on the event rather than holding the C64 SHIFT down ourselves.
	 * c64-ready reads the flag and presses matrix SHIFT before the keystroke, which is what
	 * turns `1` into `!`, `HOME` into `CLR` and `F1` into `F2` -- and it cannot leave SHIFT
	 * stuck, since every unshifted keydown releases it again.
	 */
	shiftKey?: boolean
}

/**
 * Either a key from the shared vocabulary, or a one-off spec for a keystroke that has no
 * id of its own -- the vocabulary is also the server's allow-list for `controls.json`,
 * so it is not the place for characters that only ever exist as a shifted legend.
 */
export type Dispatchable = OverlayKeyId | KeySpec

export function dispatchKey(target: Dispatchable, down: boolean, modifiers: KeyModifiers = {}) {
	const spec = typeof target === 'string' ? keySpec(target) : target
	window.dispatchEvent(
		new KeyboardEvent(down ? 'keydown' : 'keyup', {
			bubbles: true,
			cancelable: true,
			code: spec.code,
			key: spec.key,
			shiftKey: modifiers.shiftKey ?? false,
		}),
	)
}
