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

	it('stays silent for platforms without an authentic layout yet', () => {
		expect(hasVirtualKeyboard('amiga')).toBe(false)
		expect(hasVirtualKeyboard('spectrum')).toBe(false)
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

	it('renders nothing for a platform without a layout', () => {
		const { container } = render(<VirtualKeyboard platform="amiga" />)
		expect(container).toBeEmptyDOMElement()
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
		// KeyZ/KeyX/KeyC and the arrow codes are joystick fire and directions in mixed
		// mode, so a cap sending the real code would never reach the keyboard matrix.
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
