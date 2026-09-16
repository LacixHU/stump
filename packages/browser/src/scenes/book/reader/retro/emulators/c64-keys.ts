/**
 * Laptop keys that reach the C64 in mixed mode.
 *
 * c64-ready maps matrix keys off `event.key` and joystick keys off `event.code`. Its
 * default mixed map consumes `KeyZ` / `KeyX` / `KeyC` as fire, so the key next to Shift
 * (Z on QWERTY, Y on QWERTZ) never reaches the CIA. `setKeyboardJoystickMap` can drop
 * `KeyZ`, but it always merges `KeyX`/`KeyC` back in, so those two still have to be
 * rewritten onto a code the joystick map will not claim.
 */

/** JoystickInput values from c64-ready `KEY_TO_JOYSTICK`: arrows + Left Ctrl as fire. */
export const C64_KEYBOARD_JOYSTICK_MAP: Record<string, number> = {
	ArrowDown: 2,
	ArrowLeft: 4,
	ArrowRight: 8,
	ArrowUp: 1,
	ControlLeft: 16,
}

export const C64_MIXED_LETTER_JOYSTICK_CODES = new Set(['KeyC', 'KeyX', 'KeyZ'])

export function isC64MixedLetterJoystickCode(code: string): boolean {
	return C64_MIXED_LETTER_JOYSTICK_CODES.has(code)
}

/**
 * Stop a physical Z/X/C (or QWERTZ Y sitting on `KeyZ`) from being read as fire, and
 * replay it with a code mixed mode will send to the keyboard matrix.
 */
export function retargetC64MixedLetterKey(event: KeyboardEvent): boolean {
	if (!isC64MixedLetterJoystickCode(event.code)) return false
	event.preventDefault()
	event.stopImmediatePropagation()
	window.dispatchEvent(
		new KeyboardEvent(event.type, {
			altKey: event.altKey,
			bubbles: true,
			cancelable: true,
			code: `C64_${event.code}`,
			ctrlKey: event.ctrlKey,
			key: event.key,
			metaKey: event.metaKey,
			repeat: event.repeat,
			shiftKey: event.shiftKey,
		}),
	)
	return true
}
