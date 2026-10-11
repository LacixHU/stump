import { CRT_ASPECT, frameGeometry, PRESENT_HEIGHT } from '../snes-video'

describe('frameGeometry', () => {
	it('shows a 224-line frame whole', () => {
		const g = frameGeometry(256, 224)
		expect(g.srcY).toBe(0)
		expect(g.srcH).toBe(224)
	})

	it('crops the garbage rows off a 239-line frame by default', () => {
		const g = frameGeometry(256, 239)
		expect(g.srcY).toBe(7)
		expect(g.srcH).toBe(224)
	})

	it('can show all 239 lines', () => {
		const g = frameGeometry(256, 239, '4:3', false)
		expect(g.srcY).toBe(0)
		expect(g.srcH).toBe(239)
	})

	it('keeps the interlaced modes at twice the height when cropping', () => {
		expect(frameGeometry(512, 478)).toMatchObject({ srcY: 14, srcH: 448 })
		expect(frameGeometry(512, 448)).toMatchObject({ srcY: 0, srcH: 448 })
	})

	it('presents at the CRT shape, 4:3, at a constant height', () => {
		const g = frameGeometry(256, 224)
		expect(g.canvasH).toBe(PRESENT_HEIGHT)
		expect(g.canvasW / g.canvasH).toBeCloseTo(CRT_ASPECT, 2)
	})

	it('does not resize the canvas when a game switches between lo-res and hi-res or interlace', () => {
		const sizes = [
			frameGeometry(256, 224),
			frameGeometry(512, 224),
			frameGeometry(256, 239),
			frameGeometry(512, 448),
		].map((g) => `${g.canvasW}x${g.canvasH}`)
		expect(new Set(sizes).size).toBe(1)
	})

	it('keeps square pixels on request', () => {
		const g = frameGeometry(256, 224, '1:1')
		expect(g.canvasW / g.canvasH).toBeCloseTo(256 / 224, 2)
	})
})
