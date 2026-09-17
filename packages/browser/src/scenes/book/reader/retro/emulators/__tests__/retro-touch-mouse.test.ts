import {
	createTouchMouseState,
	onTouchMouseCancel,
	onTouchMouseDown,
	onTouchMouseLongPress,
	onTouchMouseMove,
	onTouchMouseUp,
	SLOP_PX,
} from '../retro-touch-mouse'

describe('retro touch mouse', () => {
	it('taps inside slop as a left click', () => {
		const state = createTouchMouseState()
		onTouchMouseDown(state, 1, 10, 10)
		expect(onTouchMouseMove(state, 1, 10 + SLOP_PX - 1, 10)).toBeNull()
		expect(onTouchMouseUp(state, 1)).toEqual({ button: 1, type: 'click' })
	})

	it('long-presses as a right click and does not left-click on lift', () => {
		const state = createTouchMouseState()
		onTouchMouseDown(state, 1, 10, 10)
		expect(onTouchMouseLongPress(state)).toEqual({ button: 3, type: 'click' })
		expect(onTouchMouseUp(state, 1)).toBeNull()
	})

	it('moves past slop without clicking', () => {
		const state = createTouchMouseState()
		onTouchMouseDown(state, 1, 10, 10)
		expect(onTouchMouseMove(state, 1, 10 + SLOP_PX + 1, 10)).toEqual({
			dx: SLOP_PX + 1,
			dy: 0,
			type: 'move',
		})
		expect(onTouchMouseUp(state, 1)).toBeNull()
	})

	it('ignores a second pointer', () => {
		const state = createTouchMouseState()
		onTouchMouseDown(state, 1, 10, 10)
		onTouchMouseDown(state, 2, 40, 40)
		expect(onTouchMouseMove(state, 2, 80, 80)).toBeNull()
		expect(onTouchMouseUp(state, 2)).toBeNull()
		expect(onTouchMouseUp(state, 1)).toEqual({ button: 1, type: 'click' })
	})

	it('drops a cancelled gesture without a click', () => {
		const state = createTouchMouseState()
		onTouchMouseDown(state, 1, 10, 10)
		onTouchMouseCancel(state, 1)
		expect(onTouchMouseUp(state, 1)).toBeNull()
	})
})
