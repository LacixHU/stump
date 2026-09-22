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

export function dosTouchMoveScale(canvasWidth: number, canvasHeight: number) {
	const x = canvasWidth > 0 && canvasWidth < 480 ? 640 / canvasWidth : 1
	const y = canvasHeight > 240 && canvasHeight < 420 ? 400 / canvasHeight : 2
	return { x, y }
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
	const scale = dosTouchMoveScale(cw, ch)
	const sens = Number.isFinite(sensitivity) ? sensitivity : 1
	return {
		dx: fingerDx * (cw / box.width) * scale.x * sens,
		dy: fingerDy * (ch / box.height) * scale.y * sens,
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
