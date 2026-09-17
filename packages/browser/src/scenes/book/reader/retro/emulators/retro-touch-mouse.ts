export const LONG_PRESS_MS = 500
export const SLOP_PX = 12

export type TouchMouseCommand =
	| { type: 'move'; dx: number; dy: number }
	| { type: 'click'; button: 1 | 3 }

export type TouchMouseState = {
	pointerId: number | null
	startX: number
	startY: number
	lastX: number
	lastY: number
	moved: boolean
	longPressFired: boolean
}

export function createTouchMouseState(): TouchMouseState {
	return {
		lastX: 0,
		lastY: 0,
		longPressFired: false,
		moved: false,
		pointerId: null,
		startX: 0,
		startY: 0,
	}
}

export function onTouchMouseDown(
	state: TouchMouseState,
	pointerId: number,
	x: number,
	y: number,
): void {
	if (state.pointerId !== null) return
	state.pointerId = pointerId
	state.startX = x
	state.startY = y
	state.lastX = x
	state.lastY = y
	state.moved = false
	state.longPressFired = false
}

export function onTouchMouseMove(
	state: TouchMouseState,
	pointerId: number,
	x: number,
	y: number,
): TouchMouseCommand | null {
	if (state.pointerId !== pointerId) return null
	const dx = x - state.lastX
	const dy = y - state.lastY
	state.lastX = x
	state.lastY = y
	if (!state.moved) {
		const totalX = x - state.startX
		const totalY = y - state.startY
		if (totalX * totalX + totalY * totalY < SLOP_PX * SLOP_PX) return null
		state.moved = true
	}
	if (dx === 0 && dy === 0) return null
	return { dx, dy, type: 'move' }
}

export function onTouchMouseLongPress(state: TouchMouseState): TouchMouseCommand | null {
	if (state.pointerId === null || state.moved || state.longPressFired) return null
	state.longPressFired = true
	return { button: 3, type: 'click' }
}

export function onTouchMouseUp(
	state: TouchMouseState,
	pointerId: number,
): TouchMouseCommand | null {
	if (state.pointerId !== pointerId) return null
	const click =
		!state.moved && !state.longPressFired ? ({ button: 1, type: 'click' } as const) : null
	resetTouchMouse(state)
	return click
}

export function onTouchMouseCancel(state: TouchMouseState, pointerId: number): void {
	if (state.pointerId !== pointerId) return
	resetTouchMouse(state)
}

function resetTouchMouse(state: TouchMouseState) {
	state.pointerId = null
	state.moved = false
	state.longPressFired = false
}
