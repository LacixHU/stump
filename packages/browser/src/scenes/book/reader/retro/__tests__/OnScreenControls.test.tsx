import '@/__mocks__/pointerCapture'

import { fireEvent, render, screen } from '@testing-library/react'

import {
	DEFAULT_OVERLAY_KEYS,
	defaultOverlayKeys,
	joystickDirections,
	OnScreenControls,
	resolveOverlayLayout,
} from '../OnScreenControls'

/**
 * The overlay speaks to the emulator only through synthetic `KeyboardEvent`s on `window`,
 * so the stream of `code`s is the whole of its observable behaviour.
 */
function recordKeys() {
	const events: Array<{ type: string; code: string }> = []
	const listener = (event: Event) => {
		const { type, code } = event as KeyboardEvent
		events.push({ code, type })
	}
	window.addEventListener('keydown', listener)
	window.addEventListener('keyup', listener)
	return {
		events,
		stop: () => {
			window.removeEventListener('keydown', listener)
			window.removeEventListener('keyup', listener)
		},
	}
}

/** jsdom lays nothing out, so the stick needs a box to measure itself against. */
const BOX = { bottom: 100, height: 100, left: 0, right: 100, top: 0, width: 100, x: 0, y: 0 }

function stubLayout() {
	return jest
		.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
		.mockReturnValue({ ...BOX, toJSON: () => BOX } as DOMRect)
}

describe('joystickDirections', () => {
	const RADIUS = 50

	it('holds nothing inside the dead zone', () => {
		expect(joystickDirections(0, 0, RADIUS)).toEqual([])
		expect(joystickDirections(4, -4, RADIUS)).toEqual([])
	})

	it('holds one direction per cardinal throw', () => {
		expect(joystickDirections(0, -40, RADIUS)).toEqual(['up'])
		expect(joystickDirections(0, 40, RADIUS)).toEqual(['down'])
		expect(joystickDirections(-40, 0, RADIUS)).toEqual(['left'])
		expect(joystickDirections(40, 0, RADIUS)).toEqual(['right'])
	})

	it('closes two switches on a diagonal, as a real stick does', () => {
		expect(joystickDirections(30, -30, RADIUS).sort()).toEqual(['right', 'up'])
		expect(joystickDirections(-30, 30, RADIUS).sort()).toEqual(['down', 'left'])
	})

	it('resolves direction by angle, not by how far the finger travels', () => {
		// Just past the dead zone and at full deflection point the same way.
		expect(joystickDirections(0, -14, RADIUS)).toEqual(['up'])
		expect(joystickDirections(0, -200, RADIUS)).toEqual(['up'])
	})

	it('stays on a cardinal while the finger drifts slightly off axis', () => {
		expect(joystickDirections(40, -12, RADIUS)).toEqual(['right'])
	})
})

describe('OnScreenControls', () => {
	let recorder: ReturnType<typeof recordKeys>
	let layout: ReturnType<typeof stubLayout>

	beforeEach(() => {
		recorder = recordKeys()
		layout = stubLayout()
	})

	afterEach(() => {
		recorder.stop()
		layout.mockRestore()
	})

	const stick = () => screen.getByRole('group', { name: 'Joystick' })

	it('places one stick instead of four direction buttons by default', () => {
		render(<OnScreenControls keys={DEFAULT_OVERLAY_KEYS} />)
		expect(stick()).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: 'Joy ↑' })).not.toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Fire' })).toBeInTheDocument()
	})

	it('swaps direction as one finger slides, without ever lifting', () => {
		render(<OnScreenControls keys={DEFAULT_OVERLAY_KEYS} />)
		const base = stick()

		fireEvent.pointerDown(base, { clientX: 50, clientY: 50, pointerId: 1 })
		fireEvent.pointerMove(base, { clientX: 50, clientY: 10, pointerId: 1 })
		fireEvent.pointerMove(base, { clientX: 90, clientY: 50, pointerId: 1 })
		fireEvent.pointerUp(base, { clientX: 90, clientY: 50, pointerId: 1 })

		expect(recorder.events).toEqual([
			{ code: 'ArrowUp', type: 'keydown' },
			{ code: 'ArrowUp', type: 'keyup' },
			{ code: 'ArrowRight', type: 'keydown' },
			{ code: 'ArrowRight', type: 'keyup' },
		])
	})

	it('holds a direction across moves that do not change it', () => {
		render(<OnScreenControls keys={DEFAULT_OVERLAY_KEYS} />)
		const base = stick()

		fireEvent.pointerDown(base, { clientX: 50, clientY: 20, pointerId: 1 })
		fireEvent.pointerMove(base, { clientX: 50, clientY: 5, pointerId: 1 })
		fireEvent.pointerMove(base, { clientX: 56, clientY: 0, pointerId: 1 })

		expect(recorder.events).toEqual([{ code: 'ArrowUp', type: 'keydown' }])
	})

	it('releases every held direction when the stick is let go', () => {
		render(<OnScreenControls keys={DEFAULT_OVERLAY_KEYS} />)
		const base = stick()

		fireEvent.pointerDown(base, { clientX: 85, clientY: 15, pointerId: 1 })
		expect(recorder.events).toEqual([
			{ code: 'ArrowUp', type: 'keydown' },
			{ code: 'ArrowRight', type: 'keydown' },
		])

		fireEvent.pointerUp(base, { clientX: 85, clientY: 15, pointerId: 1 })
		expect(recorder.events.slice(2)).toEqual([
			{ code: 'ArrowUp', type: 'keyup' },
			{ code: 'ArrowRight', type: 'keyup' },
		])
	})

	it('releases held directions when the overlay goes away mid-throw', () => {
		const { unmount } = render(<OnScreenControls keys={DEFAULT_OVERLAY_KEYS} />)
		fireEvent.pointerDown(stick(), { clientX: 50, clientY: 10, pointerId: 1 })
		unmount()

		expect(recorder.events).toEqual([
			{ code: 'ArrowUp', type: 'keydown' },
			{ code: 'ArrowUp', type: 'keyup' },
		])
	})

	it('does not drive the emulator while the layout is being edited', () => {
		render(<OnScreenControls keys={DEFAULT_OVERLAY_KEYS} editing />)
		const base = stick()

		fireEvent.pointerDown(base, { clientX: 50, clientY: 50, pointerId: 1 })
		fireEvent.pointerMove(base, { clientX: 20, clientY: 80, pointerId: 1 })
		fireEvent.pointerUp(base, { clientX: 20, clientY: 80, pointerId: 1 })

		expect(recorder.events).toEqual([])
	})

	it('repositions the stick by dragging it in edit mode', () => {
		const onChangeKeys = jest.fn()
		render(<OnScreenControls keys={DEFAULT_OVERLAY_KEYS} editing onChangeKeys={onChangeKeys} />)
		const base = stick()

		fireEvent.pointerDown(base, { clientX: 50, clientY: 50, pointerId: 1 })
		fireEvent.pointerMove(base, { clientX: 25, clientY: 75, pointerId: 1 })

		expect(onChangeKeys).toHaveBeenCalledWith(
			expect.arrayContaining([{ id: 'joystick', x: 0.25, y: 0.75 }]),
		)
	})
})

describe('resolveOverlayLayout', () => {
	it('accepts a saved stick', () => {
		expect(resolveOverlayLayout({ keys: [{ id: 'Joystick', x: 0.2, y: 0.8 }] })).toEqual([
			{ id: 'joystick', x: 0.2, y: 0.8 },
		])
	})

	it('keeps honouring layouts saved with separate direction buttons', () => {
		const saved = { keys: [{ id: 'up', x: 0.1, y: 0.5 }] }
		expect(resolveOverlayLayout(saved)).toEqual([{ id: 'up', x: 0.1, y: 0.5 }])
	})
})

describe('OnScreenControls (Spectrum)', () => {
	let layout: ReturnType<typeof stubLayout>

	beforeEach(() => {
		layout = stubLayout()
	})

	afterEach(() => {
		layout.mockRestore()
	})

	const renderSpectrum = (keys = defaultOverlayKeys('spectrum'), editing = false) => {
		const sendKey = jest.fn()
		render(<OnScreenControls keys={keys} platform="spectrum" sendKey={sendKey} editing={editing} />)
		return sendKey
	}

	it('starts with a stick, a fire button and the keys games ask for', () => {
		renderSpectrum()

		expect(screen.getByRole('group', { name: 'Joystick' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Fire' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: '1' })).toBeInTheDocument()
		// A Spectrum has no RUN/STOP, so the C64's default has no place here.
		expect(screen.queryByRole('button', { name: 'R/S' })).not.toBeInTheDocument()
	})

	it('legends the shared ids the way this machine prints them', () => {
		renderSpectrum([{ id: 'return', x: 0.5, y: 0.5 }])

		expect(screen.getByRole('button', { name: 'ENTER' })).toBeInTheDocument()
	})

	it('presses through the emulator handle rather than a window event', () => {
		const sendKey = renderSpectrum([{ id: '1', x: 0.5, y: 0.5 }])
		const button = screen.getByRole('button', { name: '1' })
		fireEvent.pointerDown(button, { pointerId: 1 })
		fireEvent.pointerUp(button, { pointerId: 1 })

		expect(sendKey.mock.calls).toEqual([
			['1', true],
			['1', false],
		])
	})

	it('offers this machine’s keys in the editor, and not another’s', () => {
		renderSpectrum(defaultOverlayKeys('spectrum'), true)

		expect(screen.getByRole('button', { name: 'CAPS' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'SYM' })).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: 'C=' })).not.toBeInTheDocument()
		expect(screen.queryByRole('button', { name: 'F1' })).not.toBeInTheDocument()
	})

	it('falls back to this machine’s default when a layout cannot be read', () => {
		expect(resolveOverlayLayout({ keys: [] }, 'spectrum')).toEqual(defaultOverlayKeys('spectrum'))
		expect(resolveOverlayLayout(null, 'c64')).toEqual(DEFAULT_OVERLAY_KEYS)
	})
})
