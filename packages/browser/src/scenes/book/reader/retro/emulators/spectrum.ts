import type { EmulatorMountOptions, RetroEmulatorHandle, RetroEmulatorModule } from './types'

/**
 * ZX Spectrum shell (lazy route-split). Pin JSSpeccy-class WASM in a follow-up.
 */
async function create(options: EmulatorMountOptions): Promise<RetroEmulatorHandle> {
	const { canvas, image } = options
	const ctx = canvas.getContext('2d')
	if (!ctx) {
		throw new Error('Canvas 2D context unavailable')
	}

	canvas.width = 320
	canvas.height = 240

	let raf = 0
	let destroyed = false

	const draw = () => {
		if (destroyed) return
		ctx.fillStyle = '#000000'
		ctx.fillRect(0, 0, canvas.width, canvas.height)
		ctx.fillStyle = '#dcdcdc'
		ctx.font = '14px monospace'
		ctx.fillText('ZX Spectrum · Stump retro player', 12, 28)
		ctx.fillText(`Image: ${(image.byteLength / 1024).toFixed(1)} KiB`, 12, 52)
		ctx.fillText('WASM emulator not pinned yet', 12, 76)
		raf = requestAnimationFrame(draw)
	}
	draw()

	return {
		destroy: () => {
			destroyed = true
			cancelAnimationFrame(raf)
		},
	}
}

const module: RetroEmulatorModule = {
	platform: 'spectrum',
	label: 'ZX Spectrum',
	create,
}

export default module
