import {
	clampMouseSensitivity,
	createMouseDeltaRemainder,
	DEFAULT_MOUSE_SENSITIVITY,
	getMouseSensitivity,
	MAX_MOUSE_SENSITIVITY,
	MIN_MOUSE_SENSITIVITY,
	MOUSE_SENSITIVITY_STORAGE_KEY,
	setMouseSensitivity,
	takeScaledMouseDelta,
} from '../mouse-sensitivity'

function memoryStorage(initial: Record<string, string> = {}): Storage {
	const data = { ...initial }
	return {
		get length() {
			return Object.keys(data).length
		},
		clear() {
			for (const key of Object.keys(data)) delete data[key]
		},
		getItem(key: string) {
			return data[key] ?? null
		},
		key() {
			return null
		},
		removeItem(key: string) {
			delete data[key]
		},
		setItem(key: string, value: string) {
			data[key] = value
		},
	}
}

describe('mouse sensitivity', () => {
	it('clamps and snaps to the slider step', () => {
		expect(clampMouseSensitivity(Number.NaN)).toBe(DEFAULT_MOUSE_SENSITIVITY)
		expect(clampMouseSensitivity(0)).toBe(MIN_MOUSE_SENSITIVITY)
		expect(clampMouseSensitivity(99)).toBe(MAX_MOUSE_SENSITIVITY)
		expect(clampMouseSensitivity(1.12)).toBe(1)
		expect(clampMouseSensitivity(1.13)).toBe(1.25)
	})

	it('accumulates sub-pixel moves at low sensitivity', () => {
		const remainder = createMouseDeltaRemainder()
		expect(takeScaledMouseDelta(remainder, 1, 0, 0.25)).toEqual({ dx: 0, dy: 0 })
		expect(takeScaledMouseDelta(remainder, 1, 0, 0.25)).toEqual({ dx: 0, dy: 0 })
		expect(takeScaledMouseDelta(remainder, 1, 0, 0.25)).toEqual({ dx: 0, dy: 0 })
		expect(takeScaledMouseDelta(remainder, 1, 0, 0.25)).toEqual({ dx: 1, dy: 0 })
	})

	it('doubles integer deltas at 2×', () => {
		const remainder = createMouseDeltaRemainder()
		expect(takeScaledMouseDelta(remainder, 3, -2, 2)).toEqual({ dx: 6, dy: -4 })
	})

	it('stores a value per user and per game', () => {
		const storage = memoryStorage()
		setMouseSensitivity('alice', 'game-a', 2, storage)
		setMouseSensitivity('alice', 'game-b', 0.5, storage)
		setMouseSensitivity('bob', 'game-a', 3, storage)

		expect(getMouseSensitivity('alice', 'game-a', storage)).toBe(2)
		expect(getMouseSensitivity('alice', 'game-b', storage)).toBe(0.5)
		expect(getMouseSensitivity('bob', 'game-a', storage)).toBe(3)
		expect(getMouseSensitivity('alice', 'game-c', storage)).toBe(DEFAULT_MOUSE_SENSITIVITY)
		expect(getMouseSensitivity('carol', 'game-a', storage)).toBe(DEFAULT_MOUSE_SENSITIVITY)
	})

	it('drops a game back to the default instead of storing 1×', () => {
		const storage = memoryStorage()
		setMouseSensitivity('alice', 'game-a', 2, storage)
		setMouseSensitivity('alice', 'game-a', 1, storage)
		expect(storage.getItem(MOUSE_SENSITIVITY_STORAGE_KEY)).toBe('{}')
		expect(getMouseSensitivity('alice', 'game-a', storage)).toBe(DEFAULT_MOUSE_SENSITIVITY)
	})
})
