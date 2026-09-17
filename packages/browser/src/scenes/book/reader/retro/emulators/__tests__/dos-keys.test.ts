import { dispatchableKeyCode, DOS_KEY_CODES, overlayKeyCode } from '../dos-keys'

describe('DOS key codes', () => {
	it('maps a QWERTY row to JS keyCodes', () => {
		expect(DOS_KEY_CODES.KeyQ).toBe(81)
		expect(DOS_KEY_CODES.Space).toBe(32)
		expect(DOS_KEY_CODES.Enter).toBe(13)
		expect(DOS_KEY_CODES.Escape).toBe(27)
		expect(DOS_KEY_CODES.ControlLeft).toBe(17)
	})

	it('maps overlay ids onto the same codes', () => {
		expect(overlayKeyCode('space')).toBe(32)
		expect(overlayKeyCode('return')).toBe(13)
		expect(overlayKeyCode('runstop')).toBe(27)
		expect(overlayKeyCode('q')).toBe(81)
		expect(overlayKeyCode('fire')).toBe(17)
		expect(overlayKeyCode('cursorup')).toBe(38)
		expect(overlayKeyCode('1')).toBe(49)
	})

	it('resolves a physical KeySpec', () => {
		expect(dispatchableKeyCode({ code: 'ArrowLeft', key: 'ArrowLeft' })).toBe(37)
	})
})
