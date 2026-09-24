export function isCompatTouchMouse(event: MouseEvent): boolean {
	const caps = (event as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } })
		.sourceCapabilities
	return !!caps?.firesTouchEvents
}

export function isTouchPointer(event: PointerEvent): boolean {
	return event.pointerType === 'touch' || event.pointerType === 'pen'
}

export type DosClientBox = { left: number; top: number; width: number; height: number }

export function dosContainBox(
	rect: DosClientBox,
	canvasWidth: number,
	canvasHeight: number,
): DosClientBox {
	const scale = Math.min(rect.width / canvasWidth, rect.height / canvasHeight)
	const width = canvasWidth * scale
	const height = canvasHeight * scale
	return {
		height,
		left: rect.left + (rect.width - width) / 2,
		top: rect.top + (rect.height - height) / 2,
		width,
	}
}

/**
 * One gain for both axes: the picture is drawn at a uniform scale, so any difference
 * between them makes vertical swipes move faster or slower than horizontal ones.
 */
export function dosTouchMoveScale(canvasWidth: number) {
	return canvasWidth > 0 && canvasWidth < 480 ? 640 / canvasWidth : 1
}

export function dosTouchMickeys(
	fingerDx: number,
	fingerDy: number,
	rect: DosClientBox,
	canvasWidth: number,
	canvasHeight: number,
	sensitivity = 1,
): { dx: number; dy: number } {
	const cw = canvasWidth > 0 ? canvasWidth : rect.width
	const ch = canvasHeight > 0 ? canvasHeight : rect.height
	if (!rect.width || !rect.height || !cw || !ch) return { dx: 0, dy: 0 }
	const box = dosContainBox(rect, cw, ch)
	if (!box.width || !box.height) return { dx: 0, dy: 0 }
	const scale = dosTouchMoveScale(cw)
	const sens = Number.isFinite(sensitivity) ? sensitivity : 1
	return {
		dx: fingerDx * (cw / box.width) * scale * sens,
		dy: fingerDy * (ch / box.height) * scale * sens,
	}
}

/** Virtual touch cursor as a fraction of the canvas, so video mode changes keep its place. */
export type DosTouchCursor = { x: number; y: number }

export const DOS_TOUCH_CURSOR_START: DosTouchCursor = { x: 0.5, y: 0.5 }

/**
 * The cursor is not clamped to the canvas. Unlocked SDL turns position changes into the
 * motion deltas, and games that steer their own pointer from those deltas (Fate of
 * Atlantis) drift away from the virtual cursor: a cursor held at the edge stops the
 * motion and strands their pointer short of it. Games that read the absolute position
 * pin at the edge instead, and a swipe back first walks the cursor onto the canvas.
 */
export function stepDosTouchCursor(
	current: DosTouchCursor,
	dx: number,
	dy: number,
	canvasWidth: number,
	canvasHeight: number,
): DosTouchCursor {
	if (canvasWidth <= 0 || canvasHeight <= 0) return current
	const x = current.x + dx / canvasWidth
	const y = current.y + dy / canvasHeight
	return {
		x: Number.isFinite(x) ? x : current.x,
		y: Number.isFinite(y) ? y : current.y,
	}
}

export type DosLockedMouse = { x: number; y: number }

function clampDosAxis(value: number, max: number) {
	if (!Number.isFinite(value)) return 0
	if (max < 0) return 0
	return Math.min(max, Math.max(0, value))
}

export function seedDosLockedMouse(
	clientX: number,
	clientY: number,
	rect: DosClientBox,
	canvasWidth: number,
	canvasHeight: number,
): DosLockedMouse {
	const cw = canvasWidth > 0 ? canvasWidth : rect.width
	const ch = canvasHeight > 0 ? canvasHeight : rect.height
	if (!rect.width || !rect.height || !cw || !ch) return { x: 0, y: 0 }
	return {
		x: clampDosAxis((clientX - rect.left) * (cw / rect.width), cw - 1),
		y: clampDosAxis((clientY - rect.top) * (ch / rect.height), ch - 1),
	}
}

export function dosLockedMouseBase(
	current: DosLockedMouse,
	movementX: number,
	movementY: number,
	rect: DosClientBox,
	canvasWidth: number,
	canvasHeight: number,
): { base: DosLockedMouse; next: DosLockedMouse } {
	const dx = Number.isFinite(movementX) ? movementX : 0
	const dy = Number.isFinite(movementY) ? movementY : 0
	const cw = canvasWidth > 0 ? canvasWidth : rect.width
	const ch = canvasHeight > 0 ? canvasHeight : rect.height
	if (!rect.width || !rect.height || !cw || !ch) {
		return {
			base: { x: current.x - dx, y: current.y - dy },
			next: { x: current.x + dx, y: current.y + dy },
		}
	}
	const next = {
		x: clampDosAxis(current.x + dx * (cw / rect.width), cw - 1),
		y: clampDosAxis(current.y + dy * (ch / rect.height), ch - 1),
	}
	return {
		base: { x: next.x - dx, y: next.y - dy },
		next,
	}
}

export function createDosMouseEvent(
	type: string,
	init: {
		button?: number
		buttons?: number
		clientX: number
		clientY: number
		movementX?: number
		movementY?: number
		view?: Window | null
	},
): MouseEvent {
	const view = init.view ?? (typeof window === 'undefined' ? null : window)
	const scrollX = view?.scrollX ?? 0
	const scrollY = view?.scrollY ?? 0
	const pageX = init.clientX + scrollX
	const pageY = init.clientY + scrollY
	const movementX = init.movementX ?? 0
	const movementY = init.movementY ?? 0
	const event = new MouseEvent(type, {
		bubbles: true,
		button: init.button ?? 0,
		buttons: init.buttons ?? 0,
		cancelable: true,
		clientX: init.clientX,
		clientY: init.clientY,
		movementX,
		movementY,
		view: view ?? undefined,
	})
	const needsPage = event.pageX !== pageX || event.pageY !== pageY
	const needsMovement = event.movementX !== movementX || event.movementY !== movementY
	if (!needsPage && !needsMovement) return event
	const props: PropertyDescriptorMap = {}
	if (needsPage) {
		props.pageX = { configurable: true, enumerable: true, value: pageX }
		props.pageY = { configurable: true, enumerable: true, value: pageY }
	}
	if (needsMovement) {
		props.movementX = { configurable: true, enumerable: true, value: movementX }
		props.movementY = { configurable: true, enumerable: true, value: movementY }
	}
	try {
		Object.defineProperties(event, props)
	} catch {
		return event
	}
	return event
}
