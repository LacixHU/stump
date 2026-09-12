import type { EmulatorMountOptions, RetroEmulatorHandle, RetroEmulatorModule } from './types'

/** Served from packages/browser/public/retro/c64 (copied from c64-ready). */
const C64_ASSET_BASE = '/retro/c64'
const WASM_URL = `${C64_ASSET_BASE}/c64.wasm`
const WORKLET_URL = `${C64_ASSET_BASE}/audio-worklet-processor.js`

type C64LoadType = 'prg' | 'd64' | 'crt' | 'snapshot'

function inferLoadType(byteLength: number, hintName?: string): C64LoadType {
	const name = (hintName || '').toLowerCase()
	if (name.endsWith('.prg')) return 'prg'
	if (name.endsWith('.crt')) return 'crt'
	if (name.endsWith('.d64') || name.endsWith('.t64') || name.endsWith('.g64')) return 'd64'
	if (name.endsWith('.c64') || name.endsWith('.s64') || name.endsWith('.snapshot')) {
		return 'snapshot'
	}
	if (byteLength === 174848 || byteLength === 196608) return 'd64'
	if (byteLength < 65536) return 'prg'
	return 'd64'
}

/**
 * C64 emulator via c64-ready (WASM, MIT; based on c64.js / lvllvl).
 * Fully dynamic import so React/main bundle never share its graph.
 */
async function create(options: EmulatorMountOptions): Promise<RetroEmulatorHandle> {
	const { canvas, image, fileName } = options
	const loadType = inferLoadType(image.byteLength, fileName)

	const { CanvasRenderer, C64Player } = await import('c64-ready')

	canvas.width = 384
	canvas.height = 272
	canvas.tabIndex = 0
	canvas.style.outline = 'none'
	canvas.focus()

	const renderer = new CanvasRenderer(canvas)
	const player = new C64Player({
		wasmUrl: WASM_URL,
		gameUrl: 'null',
		gameData: image,
		gameType: loadType,
		gameSource: `stump-play-file.${loadType}`,
		renderer,
		audio: {
			workletUrl: WORKLET_URL,
			assetBaseUrl: C64_ASSET_BASE,
		},
		onProgress: (percent, label) => {
			renderer.setProgress(percent, label)
		},
	})

	await player.start()
	void player.audio.resume().catch(() => undefined)
	player.setInputMode('mixed')

	return {
		destroy: () => {
			void player.destroy()
		},
		saveState: async () => {
			const snap = player.getSnapshot()
			if (!snap?.byteLength) return null
			return snap.buffer.slice(snap.byteOffset, snap.byteOffset + snap.byteLength)
		},
		loadState: async (data) => {
			await player.loadGameData(data, 'snapshot', 'stump-save-state')
		},
		mountImage: async (nextImage) => {
			const nextType = inferLoadType(nextImage.byteLength, fileName)
			await player.loadGameData(nextImage, nextType, `stump-disk.${nextType}`)
		},
	}
}

const module: RetroEmulatorModule = {
	platform: 'c64',
	label: 'Commodore 64',
	create,
}

export default module
