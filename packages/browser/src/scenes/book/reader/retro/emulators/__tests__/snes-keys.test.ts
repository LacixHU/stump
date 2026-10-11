import {
	isSnesKey,
	keyboardButton,
	maskFor,
	mergeMasks,
	overlayButton,
	readGamepad,
	SNES_BITS,
	SNES_BUTTONS,
} from '../snes-keys'

const pad = (pressed: number[] = [], axes: number[] = [0, 0, 0, 0]) => ({
	axes,
	buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i) })),
})

describe('SNES pad bits', () => {
	it('matches the layout the Snes9x shim expects', () => {
		expect(SNES_BITS).toEqual({
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
		})
	})

	it('gives every control its own bit', () => {
		expect(SNES_BUTTONS).toHaveLength(12)
		expect(new Set(Object.values(SNES_BITS)).size).toBe(12)
		expect(maskFor(Object.fromEntries(SNES_BUTTONS.map((b) => [b, true])))).toBe(0b111111111111)
	})

	it('builds a mask from held buttons and ignores the rest', () => {
		expect(maskFor({})).toBe(0)
		expect(maskFor({ b: true })).toBe(1)
		expect(maskFor({ a: true, start: true })).toBe((1 << 8) | (1 << 3))
		expect(maskFor({ a: false, b: true })).toBe(1)
	})
})

describe('SNES overlay mapping', () => {
	it('maps the pad buttons straight through', () => {
		for (const id of ['a', 'b', 'x', 'y', 'l', 'r', 'start', 'select']) {
			expect(overlayButton(id as never)).toBe(id)
		}
	})

	it('treats the overlay joystick directions as the D-pad', () => {
		expect(overlayButton('up')).toBe('up')
		expect(overlayButton('left')).toBe('left')
	})

	it('ignores ids that are not on this pad', () => {
		expect(overlayButton('return')).toBeNull()
		expect(overlayButton('cup')).toBeNull()
		expect(overlayButton({ code: 'KeyA', key: 'a' })).toBeNull()
	})
})

describe('SNES keyboard mapping', () => {
	it('puts the face buttons on the diamond S/X/A/Z', () => {
		expect(keyboardButton('KeyS')).toBe('a')
		expect(keyboardButton('KeyX')).toBe('b')
		expect(keyboardButton('KeyA')).toBe('x')
		expect(keyboardButton('KeyZ')).toBe('y')
	})

	it('maps the arrows, shoulders, Start and either Shift as Select', () => {
		expect(keyboardButton('ArrowUp')).toBe('up')
		expect(keyboardButton('ArrowRight')).toBe('right')
		expect(keyboardButton('KeyQ')).toBe('l')
		expect(keyboardButton('KeyW')).toBe('r')
		expect(keyboardButton('Enter')).toBe('start')
		expect(keyboardButton('ShiftLeft')).toBe('select')
		expect(keyboardButton('ShiftRight')).toBe('select')
	})

	it('claims only the keys it uses', () => {
		expect(isSnesKey('ArrowDown')).toBe(true)
		expect(isSnesKey('KeyS')).toBe(true)
		expect(isSnesKey('F5')).toBe(false)
		expect(isSnesKey('Escape')).toBe(false)
		expect(isSnesKey('KeyR')).toBe(false)
	})
})

describe('readGamepad', () => {
	it('rotates the diamond: bottom is B, right is A, left is Y, top is X', () => {
		expect(readGamepad(pad([0]))).toBe(maskFor({ b: true }))
		expect(readGamepad(pad([1]))).toBe(maskFor({ a: true }))
		expect(readGamepad(pad([2]))).toBe(maskFor({ y: true }))
		expect(readGamepad(pad([3]))).toBe(maskFor({ x: true }))
	})

	it('maps the bumpers, Select and Start', () => {
		expect(readGamepad(pad([4, 5, 8, 9]))).toBe(
			maskFor({ l: true, r: true, select: true, start: true }),
		)
	})

	it('maps the D-pad buttons', () => {
		expect(readGamepad(pad([12, 15]))).toBe(maskFor({ up: true, right: true }))
		expect(readGamepad(pad([13, 14]))).toBe(maskFor({ down: true, left: true }))
	})

	it('treats the left stick as a D-pad past 40%', () => {
		expect(readGamepad(pad([], [0.8, 0]))).toBe(maskFor({ right: true }))
		expect(readGamepad(pad([], [-0.8, 0]))).toBe(maskFor({ left: true }))
		// the pad's y is positive down
		expect(readGamepad(pad([], [0, -0.9]))).toBe(maskFor({ up: true }))
		expect(readGamepad(pad([], [0, 0.9]))).toBe(maskFor({ down: true }))
		expect(readGamepad(pad([], [0.3, -0.3]))).toBe(0)
	})

	it('copes with a pad that reports fewer buttons or axes', () => {
		expect(readGamepad({ axes: [], buttons: [{ pressed: true }] })).toBe(maskFor({ b: true }))
		expect(readGamepad({ axes: [], buttons: [] })).toBe(0)
	})
})

describe('mergeMasks', () => {
	it('ORs every surface together', () => {
		expect(mergeMasks([maskFor({ a: true }), maskFor({ up: true }), 0])).toBe(
			maskFor({ a: true, up: true }),
		)
		expect(mergeMasks([])).toBe(0)
	})
})
