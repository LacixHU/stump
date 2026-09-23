import {
	createDosMouseEvent,
	DOS_TOUCH_CURSOR_START,
	dosContainBox,
	dosLockedMouseBase,
	dosTouchMickeys,
	dosTouchMoveScale,
	isCompatTouchMouse,
	isTouchPointer,
	seedDosLockedMouse,
	stepDosTouchCursor,
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
	it('keeps the touch cursor on the canvas so swiping back moves it at once', () => {
		let cursor = DOS_TOUCH_CURSOR_START
		for (let i = 0; i < 50; i++) cursor = stepDosTouchCursor(cursor, 40, 40, 320, 200)
		expect(cursor).toEqual({ x: 319 / 320, y: 199 / 200 })
		cursor = stepDosTouchCursor(cursor, -32, -20, 320, 200)
		expect(cursor.x * 320).toBeCloseTo(287)
		expect(cursor.y * 200).toBeCloseTo(179)
		for (let i = 0; i < 50; i++) cursor = stepDosTouchCursor(cursor, -40, -40, 320, 200)
		expect(cursor).toEqual({ x: 0, y: 0 })
	})

	it('holds the touch cursor still while the canvas has no size', () => {
		expect(stepDosTouchCursor({ x: 0.25, y: 0.75 }, 10, 10, 0, 0)).toEqual({ x: 0.25, y: 0.75 })
	})

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

	it('seeds pointer-lock position in canvas pixels from the click', () => {
		expect(
			seedDosLockedMouse(410, 220, { height: 400, left: 10, top: 20, width: 800 }, 320, 200),
		).toEqual({ x: 160, y: 100 })
	})

	it('publishes a base so SDL.mouse + movement lands on the scaled canvas position', () => {
		const rect = { height: 400, left: 10, top: 20, width: 800 }
		const stepped = dosLockedMouseBase({ x: 100, y: 50 }, 8, -4, rect, 320, 200)
		expect(stepped.base.x + 8).toBeCloseTo(stepped.next.x)
		expect(stepped.base.y + -4).toBeCloseTo(stepped.next.y)
		expect(stepped.next.x).toBeCloseTo(100 + 8 * (320 / 800))
		expect(stepped.next.y).toBeCloseTo(50 + -4 * (200 / 400))
	})

	it('clamps locked motion so the cursor can leave the edge it was pinned to', () => {
		const rect = { height: 200, left: 0, top: 0, width: 320 }
		const pinned = dosLockedMouseBase({ x: 319, y: 0 }, 40, -10, rect, 320, 200)
		expect(pinned.next).toEqual({ x: 319, y: 0 })
		expect(pinned.base.x + 40).toBeCloseTo(319)
		const back = dosLockedMouseBase(pinned.next, -8, 4, rect, 320, 200)
		expect(back.next).toEqual({ x: 311, y: 4 })
		expect(back.base.x + -8).toBeCloseTo(back.next.x)
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
