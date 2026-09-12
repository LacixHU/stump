import type { EmulatorMountOptions, RetroEmulatorHandle, RetroEmulatorModule } from './types'

/** Expected Kickstart basenames for the pinned Amiga WASM (document in NOTICE). */
export const AMIGA_KICKSTART_FILES = ['kick33180.A500', 'kick34005.A500'] as const

/**
 * Amiga shell (lazy route-split). Requires firmware from STUMP_FIRMWARE_DIR.
 * Pin vAmiga-class WASM in a follow-up.
 */
async function create(options: EmulatorMountOptions): Promise<RetroEmulatorHandle> {
	const { canvas, image, firmware } = options
	const missing = AMIGA_KICKSTART_FILES.filter((name) => !firmware?.[name])
	if (missing.length) {
		throw new Error(
			`Missing Amiga Kickstart firmware: ${missing.join(', ')}. Place files in STUMP_FIRMWARE_DIR.`,
		)
	}

	const ctx = canvas.getContext('2d')
	if (!ctx) {
		throw new Error('Canvas 2D context unavailable')
	}

	canvas.width = 640
	canvas.height = 400

	let raf = 0
	let destroyed = false

	const draw = () => {
		if (destroyed) return
		ctx.fillStyle = '#1a1a2e'
		ctx.fillRect(0, 0, canvas.width, canvas.height)
		ctx.fillStyle = '#e94560'
		ctx.font = '14px monospace'
		ctx.fillText('Amiga · Stump retro player', 16, 32)
		ctx.fillText(`ADF: ${(image.byteLength / 1024).toFixed(1)} KiB`, 16, 56)
		ctx.fillText('Kickstart present · WASM not pinned yet', 16, 80)
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
	platform: 'amiga',
	label: 'Commodore Amiga',
	requiredFirmware: [...AMIGA_KICKSTART_FILES],
	create,
}

export default module
