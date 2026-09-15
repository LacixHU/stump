export const TPP = 2
const NTSC_PIXEL_RATIO = 52 / 44

export function palDisplayHeight(framebufferHeight: number, ntsc: boolean) {
	let height = framebufferHeight * 2 * TPP
	if (ntsc) height = Math.round(height * NTSC_PIXEL_RATIO)
	return height & ~1
}

export function containPoint(
	clientX: number,
	clientY: number,
	canvasWidth: number,
	canvasHeight: number,
	rect: { left: number; top: number; width: number; height: number },
) {
	const scale = Math.min(rect.width / canvasWidth, rect.height / canvasHeight)
	const drawnWidth = canvasWidth * scale
	const drawnHeight = canvasHeight * scale
	const left = rect.left + (rect.width - drawnWidth) / 2
	const top = rect.top + (rect.height - drawnHeight) / 2
	if (
		drawnWidth <= 0 ||
		drawnHeight <= 0 ||
		clientX < left ||
		clientY < top ||
		clientX > left + drawnWidth ||
		clientY > top + drawnHeight
	) {
		return null
	}
	return {
		x: ((clientX - left) / drawnWidth) * canvasWidth,
		y: ((clientY - top) / drawnHeight) * canvasHeight,
	}
}
