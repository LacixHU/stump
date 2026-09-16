import {
	applyGamepadJoystick,
	firstConnectedGamepad,
	hatAxisDirections,
	IDLE_GAMEPAD_JOYSTICK,
	readAllGamepads,
	readGamepadJoystick,
} from '../gamepad'

function button(pressed: boolean, value = pressed ? 1 : 0): GamepadButton {
	return { pressed, touched: pressed, value }
}

function pad(partial: { axes?: number[]; buttons?: Array<GamepadButton | undefined> }) {
	const buttons = partial.buttons ?? []
	const axes = partial.axes ?? [0, 0]
	return { axes, buttons }
}

describe('readGamepadJoystick', () => {
	it('holds nothing at rest', () => {
		expect(readGamepadJoystick(pad({}))).toEqual({ directions: [], fire: false })
	})

	it('reads the standard D-pad as four digital switches', () => {
		const buttons: GamepadButton[] = []
		buttons[12] = button(true)
		expect(readGamepadJoystick(pad({ buttons })).directions).toEqual(['up'])

		buttons[12] = button(false)
		buttons[15] = button(true)
		expect(readGamepadJoystick(pad({ buttons })).directions).toEqual(['right'])
	})

	it('digitises the left stick with the same dead zone as the overlay', () => {
		expect(readGamepadJoystick(pad({ axes: [0.1, -0.1] })).directions).toEqual([])
		expect(readGamepadJoystick(pad({ axes: [0, -0.8] })).directions).toEqual(['up'])
		expect(readGamepadJoystick(pad({ axes: [0.7, -0.7] })).directions.sort()).toEqual([
			'right',
			'up',
		])
	})

	it('ORs the D-pad and the analog stick', () => {
		const buttons: GamepadButton[] = []
		buttons[14] = button(true)
		expect(readGamepadJoystick(pad({ axes: [0, -0.9], buttons })).directions).toEqual([
			'up',
			'left',
		])
	})

	it('treats any face button as fire', () => {
		expect(readGamepadJoystick(pad({ buttons: [button(true)] })).fire).toBe(true)
		expect(readGamepadJoystick(pad({ buttons: [button(false), button(true)] })).fire).toBe(true)
		expect(
			readGamepadJoystick(pad({ buttons: [button(false), button(false), button(true)] })).fire,
		).toBe(true)
		expect(readGamepadJoystick(pad({ buttons: [button(false), button(false)] })).fire).toBe(false)
	})

	it('reads a DualShock-style hat axis', () => {
		const axes = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0.14]
		expect(readGamepadJoystick(pad({ axes })).directions).toEqual(['down'])
	})

	it('treats an analog trigger-style face button as held past halfway', () => {
		expect(readGamepadJoystick(pad({ buttons: [button(false, 0.6)] })).fire).toBe(true)
		expect(readGamepadJoystick(pad({ buttons: [button(false, 0.2)] })).fire).toBe(false)
	})
})

describe('applyGamepadJoystick', () => {
	it('edge-triggers sendKey and stays silent while a direction is held', () => {
		const sendKey = jest.fn()

		applyGamepadJoystick(IDLE_GAMEPAD_JOYSTICK, { directions: ['up'], fire: false }, sendKey)
		applyGamepadJoystick(
			{ directions: ['up'], fire: false },
			{ directions: ['up'], fire: false },
			sendKey,
		)
		applyGamepadJoystick(
			{ directions: ['up'], fire: false },
			{ directions: ['right'], fire: true },
			sendKey,
		)
		applyGamepadJoystick({ directions: ['right'], fire: true }, IDLE_GAMEPAD_JOYSTICK, sendKey)

		expect(sendKey.mock.calls).toEqual([
			['up', true],
			['up', false],
			['right', true],
			['fire', true],
			['right', false],
			['fire', false],
		])
	})
})

describe('hatAxisDirections', () => {
	it('ignores idle sentinels and unused zeroes', () => {
		expect(hatAxisDirections(3.2857)).toEqual([])
		expect(hatAxisDirections(-1)).toEqual([])
		expect(hatAxisDirections(0)).toEqual([])
	})
})

describe('firstConnectedGamepad', () => {
	it('skips empty slots and disconnected pads', () => {
		const connected = { connected: true } as Gamepad
		expect(firstConnectedGamepad([null, { connected: false } as Gamepad, connected])).toBe(
			connected,
		)
		expect(firstConnectedGamepad([null, null])).toBeNull()
	})

	it('accepts a pad that omits the connected flag', () => {
		const pad = { axes: [0, 0], buttons: [] } as unknown as Gamepad
		expect(firstConnectedGamepad([pad])).toBe(pad)
	})
})

describe('readAllGamepads', () => {
	it('does not let a dummy pad in slot 0 hide a real pad', () => {
		const dummy = { axes: [], buttons: [], connected: true } as unknown as Gamepad
		const buttons: GamepadButton[] = []
		buttons[12] = button(true)
		const real = { axes: [0, 0], buttons, connected: true } as unknown as Gamepad
		expect(readAllGamepads([dummy, real])).toEqual({ directions: ['up'], fire: false })
	})
})
