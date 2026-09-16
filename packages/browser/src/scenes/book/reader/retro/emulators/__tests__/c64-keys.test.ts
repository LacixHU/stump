import { keySpec } from '../../keys'
import {
	C64_KEYBOARD_JOYSTICK_MAP,
	isC64MixedLetterJoystickCode,
	retargetC64MixedLetterKey,
} from '../c64-keys'

describe('C64 mixed-mode letter keys', () => {
	it('drives the stick with arrows and Left Ctrl, not Z/X/C', () => {
		expect(Object.keys(C64_KEYBOARD_JOYSTICK_MAP).sort()).toEqual([
			'ArrowDown',
			'ArrowLeft',
			'ArrowRight',
			'ArrowUp',
			'ControlLeft',
		])
		expect(C64_KEYBOARD_JOYSTICK_MAP.ControlLeft).toBe(16)
	})

	it('treats the US-position Z/X/C codes as letters mixed mode would steal', () => {
		expect(isC64MixedLetterJoystickCode('KeyZ')).toBe(true)
		expect(isC64MixedLetterJoystickCode('KeyX')).toBe(true)
		expect(isC64MixedLetterJoystickCode('KeyC')).toBe(true)
		expect(isC64MixedLetterJoystickCode('KeyY')).toBe(false)
		expect(isC64MixedLetterJoystickCode('ControlLeft')).toBe(false)
	})

	it('replays QWERTZ Y and QWERTY Z onto a code mixed mode will not claim as fire', () => {
		const events: Array<{ code: string; key: string }> = []
		const listener = (event: Event) => {
			const { code, key } = event as KeyboardEvent
			events.push({ code, key })
		}
		window.addEventListener('keydown', listener)

		const qwertzY = new KeyboardEvent('keydown', { bubbles: true, code: 'KeyZ', key: 'y' })
		const qwertyZ = new KeyboardEvent('keydown', { bubbles: true, code: 'KeyZ', key: 'z' })
		expect(retargetC64MixedLetterKey(qwertzY)).toBe(true)
		expect(retargetC64MixedLetterKey(qwertyZ)).toBe(true)
		expect(
			retargetC64MixedLetterKey(
				new KeyboardEvent('keydown', { bubbles: true, code: 'KeyY', key: 'z' }),
			),
		).toBe(false)

		window.removeEventListener('keydown', listener)
		expect(events).toEqual([
			{ code: 'C64_KeyZ', key: 'y' },
			{ code: 'C64_KeyZ', key: 'z' },
		])
	})

	it('sends overlay fire as Left Ctrl so it still reaches the stick', () => {
		expect(keySpec('fire')).toEqual({ code: 'ControlLeft', key: 'Control' })
	})
})
