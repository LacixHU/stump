export const DEFAULT_MOUSE_SENSITIVITY = 1
export const MIN_MOUSE_SENSITIVITY = 0.25
export const MAX_MOUSE_SENSITIVITY = 4
export const MOUSE_SENSITIVITY_STEP = 0.25
export const MOUSE_SENSITIVITY_STORAGE_KEY = 'stump-retro-mouse-sensitivity'

export type MouseDeltaRemainder = { x: number; y: number }

type SensitivityStore = Record<string, Record<string, number>>

type ReadableStorage = Pick<Storage, 'getItem'>
type WritableStorage = Pick<Storage, 'getItem' | 'setItem'>

function storageUserId(userId: string | undefined): string {
	return userId || '_'
}

export function clampMouseSensitivity(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_MOUSE_SENSITIVITY
	const stepped = Math.round(value / MOUSE_SENSITIVITY_STEP) * MOUSE_SENSITIVITY_STEP
	return Math.min(
		MAX_MOUSE_SENSITIVITY,
		Math.max(MIN_MOUSE_SENSITIVITY, Number(stepped.toFixed(2))),
	)
}

export function createMouseDeltaRemainder(): MouseDeltaRemainder {
	return { x: 0, y: 0 }
}

export function takeScaledMouseDelta(
	remainder: MouseDeltaRemainder,
	dx: number,
	dy: number,
	sensitivity: number,
): { dx: number; dy: number } {
	const factor = clampMouseSensitivity(sensitivity)
	remainder.x += dx * factor
	remainder.y += dy * factor
	const outX = Math.trunc(remainder.x)
	const outY = Math.trunc(remainder.y)
	remainder.x -= outX
	remainder.y -= outY
	return { dx: outX, dy: outY }
}

function readStore(storage: ReadableStorage | null): SensitivityStore {
	if (!storage) return {}
	try {
		const raw = storage.getItem(MOUSE_SENSITIVITY_STORAGE_KEY)
		if (!raw) return {}
		const parsed: unknown = JSON.parse(raw)
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
		return parsed as SensitivityStore
	} catch {
		return {}
	}
}

export function getMouseSensitivity(
	userId: string | undefined,
	mediaId: string,
	storage: ReadableStorage | null = typeof window !== 'undefined' ? window.localStorage : null,
): number {
	const value = readStore(storage)[storageUserId(userId)]?.[mediaId]
	return typeof value === 'number' ? clampMouseSensitivity(value) : DEFAULT_MOUSE_SENSITIVITY
}

export function setMouseSensitivity(
	userId: string | undefined,
	mediaId: string,
	value: number,
	storage: WritableStorage | null = typeof window !== 'undefined' ? window.localStorage : null,
): number {
	const next = clampMouseSensitivity(value)
	if (!storage) return next
	const store = readStore(storage)
	const uid = storageUserId(userId)
	const games = { ...(store[uid] ?? {}) }
	if (next === DEFAULT_MOUSE_SENSITIVITY) delete games[mediaId]
	else games[mediaId] = next
	const nextStore = { ...store }
	if (Object.keys(games).length === 0) delete nextStore[uid]
	else nextStore[uid] = games
	try {
		storage.setItem(MOUSE_SENSITIVITY_STORAGE_KEY, JSON.stringify(nextStore))
	} catch {
		return next
	}
	return next
}
