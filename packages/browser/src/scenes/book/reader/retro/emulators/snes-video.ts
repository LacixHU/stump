/**
 * How a Snes9x frame is cropped and presented. Pure, so the geometry can be tested without a
 * canvas.
 *
 * The core hands back RGBA frames that are 256 or 512 wide (hi-res) and 224 or 239 lines tall,
 * doubled in height when a game turns on interlace. Most games leave the last rows of a
 * 239-line frame as garbage, so by default the picture is cropped to 224 lines.
 */

export const SNES_VISIBLE_LINES = 224
export const SNES_EXTENDED_LINES = 239

/** The canvas is always this tall in device pixels, whatever mode the game is in. */
export const PRESENT_HEIGHT = 896

/** A CRT showed 256x224 on a 4:3 screen, so its pixels were 8:7, not square. */
export const CRT_ASPECT = 4 / 3

export type FrameGeometry = {
	/** First source row to copy (the overscan crop). */
	srcY: number
	/** Source rows to copy. */
	srcH: number
	/** The presented canvas size. */
	canvasW: number
	canvasH: number
}

export type AspectMode = '4:3' | '1:1'

/**
 * Crop and scale a `w` x `h` frame. The canvas is 896 tall whether the frame is 224 lines
 * (scaled 4x) or an interlaced 448 (scaled 2x), so it does not resize mid-game when a title
 * switches mode. `4:3` stretches the width to the CRT's shape; `1:1` keeps square pixels.
 */
export function frameGeometry(
	w: number,
	h: number,
	aspect: AspectMode = '4:3',
	crop = true,
): FrameGeometry {
	let srcY = 0
	let srcH = h
	if (crop) {
		if (h === SNES_EXTENDED_LINES) {
			srcY = 7
			srcH = SNES_VISIBLE_LINES
		} else if (h === SNES_EXTENDED_LINES * 2) {
			srcY = 14
			srcH = SNES_VISIBLE_LINES * 2
		}
	}
	const canvasH = PRESENT_HEIGHT
	const canvasW =
		aspect === '4:3' ? Math.round(canvasH * CRT_ASPECT) : Math.round((canvasH * w) / srcH)
	return { canvasH, canvasW, srcH, srcY }
}
