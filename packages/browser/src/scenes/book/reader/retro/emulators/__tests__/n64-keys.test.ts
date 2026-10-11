import {
	applyDeadzone,
	emptyButtons,
	emptyStick,
	isN64Key,
	keyboardButton,
	keyboardStickDirection,
	mergeInputs,
	N64_BUTTONS,
	overlayButton,
	overlayStickDirection,
	readGamepad,
	STICK_DEADZONE,
	stickVector,
} from '../n64-keys'

const pad = (pressedIndexes: number[] = [], axes: number[] = [0, 0, 0, 0]) => ({
	axes,
	buttons: Array.from({ length: 17 }, (_, i) => ({
		pressed: pressedIndexes.includes(i),
		value: 0,
	})),
})

describe('N64 overlay mapping', () => {
	it('maps the pad buttons straight through', () => {
		for (const id of ['a', 'b', 'z', 'l', 'r', 'start', 'cup', 'cdown', 'cleft', 'cright']) {
			expect(overlayButton(id as never)).toBe(id)
		}
	})

	it('treats the overlay joystick directions as the analog stick, not the D-pad', () => {
		expect(overlayStickDirection('up')).toBe('up')
		expect(overlayStickDirection('left')).toBe('left')
		expect(overlayButton('up')).toBeNull()
	})

	it('ignores ids and specs that are not on the pad', () => {
		expect(overlayButton('return')).toBeNull()
		expect(overlayButton({ code: 'KeyA', key: 'a' })).toBeNull()
		expect(overlayStickDirection('fire')).toBeNull()
	})
})

describe('N64 keyboard mapping', () => {
	it('keeps the N64Wasm defaults for the face and C buttons', () => {
		expect(keyboardButton('KeyD')).toBe('a')
		expect(keyboardButton('KeyS')).toBe('b')
		expect(keyboardButton('KeyA')).toBe('z')
		expect(keyboardButton('KeyQ')).toBe('l')
		expect(keyboardButton('KeyE')).toBe('r')
		expect(keyboardButton('Enter')).toBe('start')
		expect(keyboardButton('KeyI')).toBe('cup')
		expect(keyboardButton('KeyK')).toBe('cdown')
		expect(keyboardButton('KeyJ')).toBe('cleft')
		expect(keyboardButton('KeyL')).toBe('cright')
	})

	it('puts the analog stick on the arrows and the D-pad on T/F/G/H', () => {
		expect(keyboardStickDirection('ArrowUp')).toBe('up')
		expect(keyboardStickDirection('ArrowRight')).toBe('right')
		expect(keyboardButton('KeyT')).toBe('up')
		expect(keyboardButton('KeyH')).toBe('right')
	})

	it('claims only the keys it uses', () => {
		expect(isN64Key('ArrowDown')).toBe(true)
		expect(isN64Key('KeyD')).toBe(true)
		expect(isN64Key('F5')).toBe(false)
		expect(isN64Key('Escape')).toBe(false)
		expect(isN64Key('KeyR')).toBe(false)
	})

	it('has a button for every one of the fourteen inputs the host expects', () => {
		expect(N64_BUTTONS).toHaveLength(14)
		expect(Object.keys(emptyButtons()).sort()).toEqual([...N64_BUTTONS].sort())
	})
})

describe('stickVector', () => {
	it('is centred with nothing held', () => {
		expect(stickVector(emptyStick())).toEqual({ x: 0, y: 0 })
	})

	it('reaches full tilt on one axis, with up positive', () => {
		expect(stickVector({ ...emptyStick(), up: true })).toEqual({ x: 0, y: 1 })
		expect(stickVector({ ...emptyStick(), left: true })).toEqual({ x: -1, y: 0 })
	})

	it('cancels opposite directions', () => {
		expect(stickVector({ ...emptyStick(), left: true, right: true })).toEqual({ x: 0, y: 0 })
	})

	it('scales a diagonal to a unit-length push', () => {
		const { x, y } = stickVector({ ...emptyStick(), down: true, right: true })
		expect(x).toBeCloseTo(Math.SQRT1_2)
		expect(y).toBeCloseTo(-Math.SQRT1_2)
		expect(Math.hypot(x, y)).toBeCloseTo(1)
	})
})

describe('applyDeadzone', () => {
	it('zeroes drift inside the dead zone', () => {
		expect(applyDeadzone(STICK_DEADZONE / 2, 0)).toEqual({ x: 0, y: 0 })
	})

	it('still reaches full tilt at the rim', () => {
		const { x, y } = applyDeadzone(1, 0)
		expect(x).toBeCloseTo(1)
		expect(y).toBeCloseTo(0)
	})

	it('keeps the direction of a diagonal push and never exceeds 1', () => {
		const { x, y } = applyDeadzone(1, 1)
		expect(Math.hypot(x, y)).toBeCloseTo(1)
		expect(x).toBeCloseTo(y)
	})
})

describe('readGamepad', () => {
	it('puts A on the bottom face button and B on the left one', () => {
		expect(readGamepad(pad([0])).buttons.a).toBe(true)
		expect(readGamepad(pad([2])).buttons.b).toBe(true)
		expect(readGamepad(pad([1])).buttons.b).toBe(false)
	})

	it('maps bumpers to L and R, either trigger to Z, and Start', () => {
		const { buttons } = readGamepad(pad([4, 5, 7, 9]))
		expect(buttons.l && buttons.r && buttons.z && buttons.start).toBe(true)
		expect(readGamepad(pad([6])).buttons.z).toBe(true)
	})

	it('maps the D-pad buttons', () => {
		const { buttons } = readGamepad(pad([12, 15]))
		expect(buttons.up && buttons.right).toBe(true)
		expect(buttons.down || buttons.left).toBe(false)
	})

	it('treats an analog trigger past halfway as pressed', () => {
		const analog = pad()
		analog.buttons[6] = { pressed: false, value: 0.8 }
		expect(readGamepad(analog).buttons.z).toBe(true)
		analog.buttons[6] = { pressed: false, value: 0.2 }
		expect(readGamepad(analog).buttons.z).toBe(false)
	})

	it('reads the left stick as the analog stick with up positive', () => {
		// Gamepad y is positive down, so a push up arrives as a negative axis
		const { stick } = readGamepad(pad([], [0, -1, 0, 0]))
		expect(stick.x).toBeCloseTo(0)
		expect(stick.y).toBeCloseTo(1)
		expect(readGamepad(pad([], [-1, 0, 0, 0])).stick.x).toBeCloseTo(-1)
	})

	it('ignores stick drift', () => {
		expect(readGamepad(pad([], [0.08, -0.06, 0, 0])).stick).toEqual({ x: 0, y: 0 })
	})

	it('reads the right stick as the C buttons', () => {
		expect(readGamepad(pad([], [0, 0, 0, -0.9])).buttons.cup).toBe(true)
		expect(readGamepad(pad([], [0, 0, 0, 0.9])).buttons.cdown).toBe(true)
		expect(readGamepad(pad([], [-0.9, 0, -0.9, 0])).buttons.cleft).toBe(true)
		expect(readGamepad(pad([], [0, 0, 0.9, 0])).buttons.cright).toBe(true)
		expect(readGamepad(pad([], [0, 0, 0.3, 0.3])).buttons.cright).toBe(false)
	})

	it('copes with a pad that reports fewer buttons or axes', () => {
		const { buttons, stick } = readGamepad({ axes: [], buttons: [{ pressed: true }] })
		expect(buttons.a).toBe(true)
		expect(buttons.start).toBe(false)
		expect(stick).toEqual({ x: 0, y: 0 })
	})
})

describe('mergeInputs', () => {
	it('ORs buttons from every surface', () => {
		const keyboard = { buttons: { ...emptyButtons(), a: true }, stick: { x: 0, y: 0 } }
		const overlay = { buttons: { ...emptyButtons(), z: true }, stick: { x: 0, y: 0 } }
		const { buttons } = mergeInputs([keyboard, overlay])
		expect(buttons.a && buttons.z).toBe(true)
		expect(buttons.b).toBe(false)
	})

	it('lets the biggest stick push win, so an idle keyboard does not cancel a pad', () => {
		const idle = { buttons: emptyButtons(), stick: { x: 0, y: 0 } }
		const analog = { buttons: emptyButtons(), stick: { x: 0.4, y: -0.2 } }
		const full = { buttons: emptyButtons(), stick: { x: 1, y: 0 } }
		expect(mergeInputs([idle, analog]).stick).toEqual({ x: 0.4, y: -0.2 })
		expect(mergeInputs([analog, full]).stick).toEqual({ x: 1, y: 0 })
	})

	it('is neutral with no inputs', () => {
		expect(mergeInputs([])).toEqual({ buttons: emptyButtons(), stick: { x: 0, y: 0 } })
	})
})
