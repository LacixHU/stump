export function isCompatTouchMouse(event: MouseEvent): boolean {
	const caps = (event as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } })
		.sourceCapabilities
	return !!caps?.firesTouchEvents
}

export function isTouchPointer(event: PointerEvent): boolean {
	return event.pointerType === 'touch' || event.pointerType === 'pen'
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
