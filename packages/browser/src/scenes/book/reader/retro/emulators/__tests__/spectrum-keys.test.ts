import {
	CAPS_SHIFT,
	overlayCombo,
	physicalKeyCombo,
	SPECTRUM_KEYS,
	SYMBOL_SHIFT,
} from '../spectrum-keys'

describe('the keyboard matrix', () => {
	it('places every key in one of eight half-rows of five', () => {
		const positions = Object.values(SPECTRUM_KEYS)
		expect(positions).toHaveLength(40)

		const seen = new Set<string>()
		for (const { row, mask } of positions) {
			expect(row).toBeGreaterThanOrEqual(0)
			expect(row).toBeLessThanOrEqual(7)
			expect([0x01, 0x02, 0x04, 0x08, 0x10]).toContain(mask)
			seen.add(`${row}:${mask}`)
		}
		// Two keys sharing a position would press each other.
		expect(seen.size).toBe(40)
	})

	it('reads the rows outward from the shift keys, as the hardware does', () => {
		// Half-row 4 runs 0-9-8-7-6 and half-row 3 runs 1-2-3-4-5, which is what makes 5
		// and 6 adjacent keys and cursor-left and cursor-down respectively.
		expect(SPECTRUM_KEYS['1']).toEqual({ mask: 0x01, row: 3 })
		expect(SPECTRUM_KEYS['5']).toEqual({ mask: 0x10, row: 3 })
		expect(SPECTRUM_KEYS['6']).toEqual({ mask: 0x10, row: 4 })
		expect(SPECTRUM_KEYS['0']).toEqual({ mask: 0x01, row: 4 })
	})
})

describe('overlayCombo', () => {
	it('presses the keys the chosen joystick scheme names', () => {
		expect(overlayCombo('up', 'qaop')).toEqual([SPECTRUM_KEYS.q])
		expect(overlayCombo('fire', 'qaop')).toEqual([SPECTRUM_KEYS.space])
		expect(overlayCombo('up', 'sinclair')).toEqual([SPECTRUM_KEYS['9']])
		expect(overlayCombo('fire', 'sinclair')).toEqual([SPECTRUM_KEYS['0']])
	})

	it('sends a cursor direction as CAPS SHIFT and a digit, which is what it is', () => {
		expect(overlayCombo('up', 'cursor')).toEqual([CAPS_SHIFT, SPECTRUM_KEYS['7']])
		expect(overlayCombo('left', 'cursor')).toEqual([CAPS_SHIFT, SPECTRUM_KEYS['5']])
	})

	it('maps a plain key to itself whatever the scheme', () => {
		expect(overlayCombo('m', 'cursor')).toEqual([SPECTRUM_KEYS.m])
		expect(overlayCombo('return', 'qaop')).toEqual([SPECTRUM_KEYS.return])
		expect(overlayCombo('symbolshift', 'qaop')).toEqual([SYMBOL_SHIFT])
	})

	it('translates the C64 ids a saved layout might carry, and drops the rest', () => {
		expect(overlayCombo('runstop', 'qaop')).toEqual([CAPS_SHIFT, SPECTRUM_KEYS.space])
		expect(overlayCombo('instdel', 'qaop')).toEqual([CAPS_SHIFT, SPECTRUM_KEYS['0']])
		expect(overlayCombo('commodore', 'qaop')).toBeNull()
		expect(overlayCombo('f7', 'qaop')).toBeNull()
	})
})

describe('physicalKeyCombo', () => {
	it('maps by position, so the letters hold on a non-QWERTY layout', () => {
		expect(physicalKeyCombo('KeyQ')).toEqual([SPECTRUM_KEYS.q])
		expect(physicalKeyCombo('Digit4')).toEqual([SPECTRUM_KEYS['4']])
		expect(physicalKeyCombo('Space')).toEqual([SPECTRUM_KEYS.space])
	})

	it('gives the machine its two shifts', () => {
		expect(physicalKeyCombo('ShiftLeft')).toEqual([CAPS_SHIFT])
		expect(physicalKeyCombo('ControlLeft')).toEqual([SYMBOL_SHIFT])
	})

	it('turns the keys a Spectrum never had into the combinations it did', () => {
		expect(physicalKeyCombo('ArrowLeft')).toEqual([CAPS_SHIFT, SPECTRUM_KEYS['5']])
		expect(physicalKeyCombo('Backspace')).toEqual([CAPS_SHIFT, SPECTRUM_KEYS['0']])
		expect(physicalKeyCombo('Comma')).toEqual([SYMBOL_SHIFT, SPECTRUM_KEYS.n])
	})

	it('ignores a key with no home on the machine', () => {
		expect(physicalKeyCombo('F5')).toBeNull()
		expect(physicalKeyCombo('Tab')).toBeNull()
	})
})
