import {
	createDosMouseEvent,
	dosContainBox,
	dosTouchMickeys,
	dosTouchMoveScale,
	isCompatTouchMouse,
	isTouchPointer,
} from '../dos-mouse'

function withWindowScroll(x: number, y: number, run: () => void) {
	const restoreX = Object.getOwnPropertyDescriptor(window, 'scrollX')
	const restoreY = Object.getOwnPropertyDescriptor(window, 'scrollY')
	Object.defineProperty(window, 'scrollX', { configurable: true, value: x })
	Object.defineProperty(window, 'scrollY', { configurable: true, value: y })
	try {
		run()
	} finally {
		if (restoreX) Object.defineProperty(window, 'scrollX', restoreX)
		else Object.defineProperty(window, 'scrollX', { configurable: true, value: 0 })
		if (restoreY) Object.defineProperty(window, 'scrollY', restoreY)
		else Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 })
	}
}

describe('DOS mouse events', () => {
	it('sets pageX/pageY from client plus scroll so unlocked SDL does not snap to 0,0', () => {
		withWindowScroll(40, 80, () => {
			const event = createDosMouseEvent('mousemove', {
				clientX: 120,
				clientY: 60,
				movementX: 4,
				movementY: -3,
				view: window,
			})
			expect(event.clientX).toBe(120)
			expect(event.clientY).toBe(60)
			expect(event.pageX).toBe(160)
			expect(event.pageY).toBe(140)
			expect(event.movementX).toBe(4)
			expect(event.movementY).toBe(-3)
			expect(event.view).toBe(window)
		})
	})

	it('keeps page coordinates when the virtual cursor is on the canvas origin', () => {
		withWindowScroll(24, 16, () => {
			const event = createDosMouseEvent('mousedown', {
				button: 0,
				buttons: 1,
				clientX: 0,
				clientY: 0,
				view: window,
			})
			expect(event.pageX).toBe(24)
			expect(event.pageY).toBe(16)
		})
	})

	it('scales a 320x200 picture so a finger swipe crosses the DOS mouse range', () => {
		expect(dosTouchMoveScale(320, 200)).toEqual({ x: 2, y: 2 })
		expect(dosTouchMoveScale(640, 400)).toEqual({ x: 1, y: 1 })
		expect(dosTouchMoveScale(640, 480)).toEqual({ x: 1, y: 2 })
		const rect = { height: 360, left: 0, top: 0, width: 800 }
		const box = dosContainBox(rect, 320, 200)
		const across = dosTouchMickeys(box.width, box.height, rect, 320, 200)
		expect(across.dx).toBeCloseTo(640)
		expect(across.dy).toBeCloseTo(400)
		const step = dosTouchMickeys(50, 40, rect, 320, 200)
		expect(step.dx * (box.width / 640)).toBeCloseTo(50)
		expect(step.dy * (box.height / 400)).toBeCloseTo(40)
	})

	it('detects touch-generated mouse and touch/pen pointers', () => {
		const mouse = new MouseEvent('mousedown')
		expect(isCompatTouchMouse(mouse)).toBe(false)
		const touchMouse = new MouseEvent('mousedown')
		Object.defineProperty(touchMouse, 'sourceCapabilities', {
			value: { firesTouchEvents: true },
		})
		expect(isCompatTouchMouse(touchMouse)).toBe(true)
		expect(isTouchPointer({ pointerType: 'touch' } as PointerEvent)).toBe(true)
		expect(isTouchPointer({ pointerType: 'pen' } as PointerEvent)).toBe(true)
		expect(isTouchPointer({ pointerType: 'mouse' } as PointerEvent)).toBe(false)
	})
})
