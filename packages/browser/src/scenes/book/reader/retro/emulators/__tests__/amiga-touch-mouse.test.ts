import { createAmigaTouchMouse, longPressMs, slopPx } from '../amiga-touch-mouse'

const pointer = (pointerId: number, clientX: number, clientY: number) => ({
	pointerId,
	clientX,
	clientY,
})

describe('Amiga touch mouse', () => {
	it('taps inside slop before 500 ms as one left click with no move', () => {
		const mouse = createAmigaTouchMouse()
		expect(mouse.down(pointer(1, 10, 10), 0)).toEqual([])
		expect(mouse.move(pointer(1, 10 + slopPx - 1, 10))).toEqual([])
		expect(mouse.up(pointer(1, 10 + slopPx - 1, 10), 200)).toEqual([{ type: 'click', button: 1 }])
	})

	it('right-clicks after a still 500 ms hold and does not left-click on lift', () => {
		const mouse = createAmigaTouchMouse()
		mouse.down(pointer(1, 0, 0), 0)
		expect(mouse.longPress(longPressMs - 1)).toEqual([])
		expect(mouse.longPress(longPressMs)).toEqual([{ type: 'click', button: 3 }])
		expect(mouse.move(pointer(1, 4, 0))).toEqual([])
		expect(mouse.up(pointer(1, 4, 0), longPressMs + 40)).toEqual([])
	})

	it('moves past slop without clicking on pointerup', () => {
		const mouse = createAmigaTouchMouse()
		mouse.down(pointer(1, 0, 0), 0)
		expect(mouse.move(pointer(1, slopPx - 1, 0))).toEqual([])
		expect(mouse.move(pointer(1, slopPx, 0))).toEqual([{ type: 'move', dx: slopPx, dy: 0 }])
		expect(mouse.move(pointer(1, slopPx + 7, 4))).toEqual([{ type: 'move', dx: 7, dy: 4 }])
		expect(mouse.up(pointer(1, slopPx + 7, 4), 40)).toEqual([])
		expect(mouse.longPress(longPressMs)).toEqual([])
	})

	it('ignores a second pointer', () => {
		const mouse = createAmigaTouchMouse()
		mouse.down(pointer(1, 0, 0), 0)
		expect(mouse.down(pointer(2, 10, 10), 10)).toEqual([])
		expect(mouse.move(pointer(2, 40, 10))).toEqual([])
		expect(mouse.up(pointer(2, 10, 10), 30)).toEqual([])
		expect(mouse.up(pointer(1, 0, 0), 40)).toEqual([{ type: 'click', button: 1 }])
	})

	it('drops the gesture on pointercancel with no click', () => {
		const mouse = createAmigaTouchMouse()
		mouse.down(pointer(1, 0, 0), 0)
		expect(mouse.cancel(pointer(1, 0, 0))).toEqual([])
		expect(mouse.up(pointer(1, 0, 0), 20)).toEqual([])
		expect(mouse.longPress(longPressMs)).toEqual([])
	})
})
