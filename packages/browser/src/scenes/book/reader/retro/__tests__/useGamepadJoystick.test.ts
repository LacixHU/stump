import { act, renderHook } from '@testing-library/react'

import { useGamepadJoystick } from '../useGamepadJoystick'

function button(pressed: boolean): GamepadButton {
	return { pressed, touched: pressed, value: pressed ? 1 : 0 }
}

describe('useGamepadJoystick', () => {
	const pending = new Map<number, FrameRequestCallback>()
	let nextId = 1
	let pads: Array<Gamepad | null> = []

	beforeEach(() => {
		pending.clear()
		nextId = 1
		pads = []
		jest.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
			const id = nextId
			nextId += 1
			pending.set(id, cb)
			return id
		})
		jest.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
			pending.delete(id)
		})
		Object.defineProperty(navigator, 'getGamepads', {
			configurable: true,
			value: () => pads,
		})
	})

	afterEach(() => {
		jest.restoreAllMocks()
	})

	const flush = () => {
		const queued = [...pending.values()]
		pending.clear()
		act(() => {
			for (const frame of queued) frame(0)
		})
	}

	it('presses and releases through sendKey as the pad changes', () => {
		const sendKey = jest.fn()
		const buttons: GamepadButton[] = []
		pads = [{ axes: [0, 0], buttons, connected: true } as unknown as Gamepad]

		const { unmount } = renderHook(() => useGamepadJoystick({ enabled: true, sendKey }))
		flush()
		expect(sendKey).not.toHaveBeenCalled()

		buttons[12] = button(true)
		flush()
		expect(sendKey.mock.calls).toEqual([['up', true]])

		buttons[12] = button(false)
		buttons[0] = button(true)
		flush()
		expect(sendKey.mock.calls).toEqual([
			['up', true],
			['up', false],
			['fire', true],
		])

		unmount()
		expect(sendKey.mock.calls.at(-1)).toEqual(['fire', false])
	})

	it('reads a pad that is not in slot 0', () => {
		const sendKey = jest.fn()
		const buttons: GamepadButton[] = []
		buttons[0] = button(true)
		pads = [
			{ axes: [], buttons: [], connected: true } as unknown as Gamepad,
			{ axes: [0, 0], buttons, connected: true } as unknown as Gamepad,
		]

		renderHook(() => useGamepadJoystick({ enabled: true, sendKey }))
		flush()
		expect(sendKey.mock.calls).toEqual([['fire', true]])
	})

	it('does not poll while disabled, and releases if it was holding', () => {
		const sendKey = jest.fn()
		const buttons: GamepadButton[] = []
		buttons[12] = button(true)
		pads = [{ axes: [0, 0], buttons, connected: true } as unknown as Gamepad]

		const { rerender } = renderHook(
			({ enabled }: { enabled: boolean }) => useGamepadJoystick({ enabled, sendKey }),
			{ initialProps: { enabled: true } },
		)
		flush()
		expect(sendKey.mock.calls).toEqual([['up', true]])

		rerender({ enabled: false })
		expect(sendKey.mock.calls.at(-1)).toEqual(['up', false])
		sendKey.mockClear()
		flush()
		expect(sendKey).not.toHaveBeenCalled()
	})
})
