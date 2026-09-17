import '@/__mocks__/pointerCapture'

import { fireEvent, render, screen } from '@testing-library/react'

import { hasVirtualKeyboard, VirtualKeyboard } from '../VirtualKeyboard'

/**
 * The keyboard speaks to the emulator only through synthetic `KeyboardEvent`s on
 * `window`, so that is the whole of its observable behaviour.
 */
function recordKeys() {
	const events: Array<{ type: string; key: string; shiftKey: boolean }> = []
	const listener = (event: Event) => {
		const { type, key, shiftKey } = event as KeyboardEvent
		events.push({ key, shiftKey, type })
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

function tap(name: string) {
	const cap = screen.getByRole('button', { name })
	fireEvent.pointerDown(cap, { pointerId: 1 })
	fireEvent.pointerUp(cap, { pointerId: 1 })
}

describe('hasVirtualKeyboard', () => {
	it('offers a layout for the C64', () => {
		expect(hasVirtualKeyboard('c64')).toBe(true)
	})

	it('offers a layout for the Spectrum', () => {
		expect(hasVirtualKeyboard('spectrum')).toBe(true)
	})

	it('offers a layout for the Amiga', () => {
		expect(hasVirtualKeyboard('amiga')).toBe(true)
	})

	it('offers a layout for DOS', () => {
		expect(hasVirtualKeyboard('dos')).toBe(true)
	})
})

describe('VirtualKeyboard', () => {
	let recorder: ReturnType<typeof recordKeys>

	beforeEach(() => {
		recorder = recordKeys()
	})

	afterEach(() => {
		recorder.stop()
	})

	it('lines every row up into the same columns', () => {
		const { container } = render(<VirtualKeyboard platform="c64" />)
		const rows = Array.from(container.firstElementChild?.children ?? [])
		expect(rows).toHaveLength(5)

		// 16 cap units of main block plus the 1.5-unit function column. A row that adds
		// up to anything else silently stretches its caps out of alignment.
		for (const row of rows) {
			const units = Array.from(row.children).reduce(
				(total, cap) => total + Number((cap as HTMLElement).style.flexGrow),
				0,
			)
			expect(units).toBeCloseTo(17.5)
		}
	})

	it('prints the shifted legend above the unshifted one, as on the keycap', () => {
		render(<VirtualKeyboard platform="c64" />)
		const cap = screen.getByRole('button', { name: '1' })

		expect(cap).toHaveTextContent('!1')
	})

	it("prints legends in the machine's keycap typeface, in bold", () => {
		const { container } = render(<VirtualKeyboard platform="c64" />)
		const panel = container.firstElementChild as HTMLElement

		expect(panel).toHaveClass('font-bold')
		expect(panel.style.fontFamily).toMatch(/Arial Narrow/)
		expect(panel.style.fontStretch).toBe('condensed')
	})

	it('sends a keydown on press and a keyup on release', () => {
		render(<VirtualKeyboard platform="c64" />)
		tap('A')

		expect(recorder.events).toEqual([
			{ key: 'a', shiftKey: false, type: 'keydown' },
			{ key: 'a', shiftKey: false, type: 'keyup' },
		])
	})

	it('hands focus back to the canvas once the keystroke completes', () => {
		const onReleased = jest.fn()
		render(<VirtualKeyboard platform="c64" onReleased={onReleased} />)
		tap('A')

		expect(onReleased).toHaveBeenCalledTimes(1)
	})

	it('uses codes the emulator will not mistake for joystick input', () => {
		// Arrow codes are still joystick directions in mixed mode. Z/X/C used to be fire
		// too, so letter caps keep a fake code in case that mapping comes back.
		const codes: string[] = []
		const listener = (event: Event) => codes.push((event as KeyboardEvent).code)
		window.addEventListener('keydown', listener)
		render(<VirtualKeyboard platform="c64" />)
		tap('Z')
		tap('Cursor up and down')
		window.removeEventListener('keydown', listener)

		expect(codes).toEqual(['C64_z', 'C64_cursordown'])
	})

	describe('sticky modifiers', () => {
		it('shifts the next keystroke and then lets go', () => {
			render(<VirtualKeyboard platform="c64" />)
			tap('Shift left')
			tap('1')
			tap('1')

			expect(recorder.events).toEqual([
				{ key: '1', shiftKey: true, type: 'keydown' },
				{ key: '1', shiftKey: true, type: 'keyup' },
				{ key: '1', shiftKey: false, type: 'keydown' },
				{ key: '1', shiftKey: false, type: 'keyup' },
			])
		})

		it('never sends a SHIFT keystroke of its own', () => {
			render(<VirtualKeyboard platform="c64" />)
			tap('Shift left')

			expect(recorder.events).toEqual([])
		})

		it('keeps shift down until SHIFT LOCK is tapped again', () => {
			render(<VirtualKeyboard platform="c64" />)
			tap('Shift lock')
			tap('A')
			tap('B')
			tap('Shift lock')
			tap('C')

			expect(recorder.events.filter((e) => e.type === 'keydown')).toEqual([
				{ key: 'a', shiftKey: true, type: 'keydown' },
				{ key: 'b', shiftKey: true, type: 'keydown' },
				{ key: 'c', shiftKey: false, type: 'keydown' },
			])
		})

		it('sends the shifted character itself where the emulator would clear shift', () => {
			// c64-ready releases shift inside its `:` case, so `SHIFT` + `:` would type a
			// plain colon rather than the `[` printed on the cap.
			render(<VirtualKeyboard platform="c64" />)
			tap('Shift left')
			tap(':')

			expect(recorder.events).toEqual([
				{ key: '[', shiftKey: false, type: 'keydown' },
				{ key: '[', shiftKey: false, type: 'keyup' },
			])
		})

		it('holds C= down across the keystroke it modifies, then releases it', () => {
			render(<VirtualKeyboard platform="c64" />)
			tap('Commodore')
			tap('A')

			expect(recorder.events).toEqual([
				{ key: 'Control', shiftKey: false, type: 'keydown' },
				{ key: 'a', shiftKey: false, type: 'keydown' },
				{ key: 'a', shiftKey: false, type: 'keyup' },
				{ key: 'Control', shiftKey: false, type: 'keyup' },
			])
		})

		it('releases a latched modifier when tapped a second time', () => {
			render(<VirtualKeyboard platform="c64" />)
			tap('CTRL')
			tap('CTRL')

			expect(recorder.events).toEqual([
				{ key: 'Tab', shiftKey: false, type: 'keydown' },
				{ key: 'Tab', shiftKey: false, type: 'keyup' },
			])
		})

		it('releases a latched modifier when the keyboard goes away mid-chord', () => {
			const { unmount } = render(<VirtualKeyboard platform="c64" />)
			tap('Commodore')
			unmount()

			expect(recorder.events).toEqual([
				{ key: 'Control', shiftKey: false, type: 'keydown' },
				{ key: 'Control', shiftKey: false, type: 'keyup' },
			])
		})
	})
})

describe('VirtualKeyboard (Spectrum)', () => {
	/**
	 * JSSpeccy takes input through an API rather than window events, so the Spectrum
	 * keyboard is handed a `sendKey` and its whole observable behaviour is what it calls.
	 */
	function renderSpectrum() {
		const sendKey = jest.fn()
		render(<VirtualKeyboard platform="spectrum" sendKey={sendKey} />)
		return sendKey
	}

	it('draws the rubber keyboard: four rows of ten', () => {
		const { container } = render(<VirtualKeyboard platform="spectrum" />)
		const rows = Array.from(container.firstElementChild?.children ?? [])

		expect(rows).toHaveLength(4)
		for (const row of rows) {
			expect(row.children).toHaveLength(10)
		}
	})

	it('prints the symbol-shift character above the letter, as on the keycap', () => {
		render(<VirtualKeyboard platform="spectrum" />)

		expect(screen.getByRole('button', { name: 'P' })).toHaveTextContent('"P')
	})

	it('prints legends in Helvetica Bold, as on a 48K rubber key', () => {
		const { container } = render(<VirtualKeyboard platform="spectrum" />)
		const panel = container.firstElementChild as HTMLElement

		expect(panel).toHaveClass('font-bold')
		expect(panel.style.fontFamily).toMatch(/^Helvetica/)
	})

	it('sends a press and a release through the emulator handle', () => {
		const sendKey = renderSpectrum()
		tap('A')

		expect(sendKey.mock.calls).toEqual([
			['a', true, { shiftKey: false }],
			['a', false, { shiftKey: false }],
		])
	})

	it('holds CAPS SHIFT down across the keystroke it modifies', () => {
		// CAPS SHIFT is a key of the matrix like any other: a game reading the cursor keys
		// is reading CAPS SHIFT and 5 held together, not a shift flag.
		const sendKey = renderSpectrum()
		tap('Caps shift')
		tap('7')

		expect(sendKey.mock.calls).toEqual([
			['capsshift', true],
			['7', true, { shiftKey: false }],
			['7', false, { shiftKey: false }],
			['capsshift', false],
		])
	})

	it('releases a latched shift when the keyboard goes away mid-chord', () => {
		const sendKey = jest.fn()
		const { unmount } = render(<VirtualKeyboard platform="spectrum" sendKey={sendKey} />)
		tap('Symbol shift')
		unmount()

		expect(sendKey.mock.calls).toEqual([
			['symbolshift', true],
			['symbolshift', false],
		])
	})
})

describe('VirtualKeyboard (Amiga)', () => {
	function renderAmiga() {
		const sendKey = jest.fn()
		render(<VirtualKeyboard platform="amiga" sendKey={sendKey} />)
		return sendKey
	}

	it('draws the A500 keyboard: six rows of 15 cap units', () => {
		const { container } = render(<VirtualKeyboard platform="amiga" />)
		const rows = Array.from(container.firstElementChild?.children ?? [])

		expect(rows).toHaveLength(6)
		for (const row of rows) {
			const units = Array.from(row.children).reduce(
				(total, cap) => total + Number((cap as HTMLElement).style.flexGrow),
				0,
			)
			expect(units).toBeCloseTo(15)
		}
	})

	it('prints the shifted legend above the unshifted one, as on the keycap', () => {
		render(<VirtualKeyboard platform="amiga" />)

		expect(screen.getByRole('button', { name: '2' })).toHaveTextContent('@2')
	})

	it('prints legends in Helvetica Bold, as on an A500 cap', () => {
		const { container } = render(<VirtualKeyboard platform="amiga" />)
		const panel = container.firstElementChild as HTMLElement

		expect(panel).toHaveClass('font-bold')
		expect(panel.style.fontFamily).toMatch(/^Helvetica/)
	})

	it('sends a press and a release through the emulator handle', () => {
		const sendKey = renderAmiga()
		tap('A')

		expect(sendKey.mock.calls).toEqual([
			['a', true, { shiftKey: false }],
			['a', false, { shiftKey: false }],
		])
	})

	it('holds SHIFT down across the keystroke it modifies', () => {
		const sendKey = renderAmiga()
		tap('Shift left')
		tap('1')

		expect(sendKey.mock.calls).toEqual([
			['shift', true],
			['1', true, { shiftKey: false }],
			['1', false, { shiftKey: false }],
			['shift', false],
		])
	})

	it('holds Amiga down across the keystroke it modifies', () => {
		const sendKey = renderAmiga()
		tap('Amiga')
		tap('Q')

		expect(sendKey.mock.calls).toEqual([
			['commodore', true],
			['q', true, { shiftKey: false }],
			['q', false, { shiftKey: false }],
			['commodore', false],
		])
	})

	it('releases a latched modifier when the keyboard goes away mid-chord', () => {
		const sendKey = jest.fn()
		const { unmount } = render(<VirtualKeyboard platform="amiga" sendKey={sendKey} />)
		tap('Alt')
		unmount()

		expect(sendKey.mock.calls).toEqual([
			['alt', true],
			['alt', false],
		])
	})
})

describe('VirtualKeyboard (DOS)', () => {
	it('draws a PC keyboard: six rows of 15 cap units', () => {
		const { container } = render(<VirtualKeyboard platform="dos" />)
		const rows = Array.from(container.firstElementChild?.children ?? [])

		expect(rows).toHaveLength(6)
		for (const row of rows) {
			const units = Array.from(row.children).reduce(
				(total, cap) => total + Number((cap as HTMLElement).style.flexGrow),
				0,
			)
			expect(units).toBeCloseTo(15)
		}
	})

	it('sends Enter and Esc through the emulator handle', () => {
		const sendKey = jest.fn()
		render(<VirtualKeyboard platform="dos" sendKey={sendKey} />)
		tap('Enter')
		tap('Escape')

		expect(sendKey.mock.calls).toEqual([
			['return', true, { shiftKey: false }],
			['return', false, { shiftKey: false }],
			['runstop', true, { shiftKey: false }],
			['runstop', false, { shiftKey: false }],
		])
	})
})
