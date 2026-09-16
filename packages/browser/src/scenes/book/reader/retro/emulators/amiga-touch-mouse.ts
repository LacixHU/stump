export const slopPx = 12
export const longPressMs = 500

export type TouchMouseCommand =
	| { type: 'move'; dx: number; dy: number }
	| { type: 'click'; button: 1 | 3 }

export type TouchMousePointer = {
	pointerId: number
	clientX: number
	clientY: number
}

type Session = {
	pointerId: number
	startX: number
	startY: number
	lastX: number
	lastY: number
	startedAt: number
	moved: boolean
	rightClicked: boolean
}

export function createAmigaTouchMouse() {
	let session: Session | null = null

	const isCurrent = (pointerId: number) => session?.pointerId === pointerId

	return {
		get pointerId() {
			return session?.pointerId ?? null
		},
		down(pointer: TouchMousePointer, now: number): TouchMouseCommand[] {
			if (session) return []
			session = {
				pointerId: pointer.pointerId,
				startX: pointer.clientX,
				startY: pointer.clientY,
				lastX: pointer.clientX,
				lastY: pointer.clientY,
				startedAt: now,
				moved: false,
				rightClicked: false,
			}
			return []
		},
		move(pointer: TouchMousePointer): TouchMouseCommand[] {
			if (!session || !isCurrent(pointer.pointerId)) return []
			if (!session.moved) {
				const dist = Math.hypot(pointer.clientX - session.startX, pointer.clientY - session.startY)
				if (dist < slopPx) return []
				session.moved = true
			}
			const dx = pointer.clientX - session.lastX
			const dy = pointer.clientY - session.lastY
			session.lastX = pointer.clientX
			session.lastY = pointer.clientY
			if (dx === 0 && dy === 0) return []
			return [{ type: 'move', dx, dy }]
		},
		up(pointer: TouchMousePointer, now: number): TouchMouseCommand[] {
			if (!session || !isCurrent(pointer.pointerId)) return []
			const { moved, rightClicked, startedAt } = session
			session = null
			if (moved || rightClicked) return []
			if (now - startedAt >= longPressMs) return [{ type: 'click', button: 3 }]
			return [{ type: 'click', button: 1 }]
		},
		cancel(pointer: TouchMousePointer): TouchMouseCommand[] {
			if (!session || !isCurrent(pointer.pointerId)) return []
			session = null
			return []
		},
		longPress(now: number): TouchMouseCommand[] {
			if (!session || session.moved || session.rightClicked) return []
			if (now - session.startedAt < longPressMs) return []
			session.rightClicked = true
			return [{ type: 'click', button: 3 }]
		},
		reset() {
			session = null
		},
	}
}
