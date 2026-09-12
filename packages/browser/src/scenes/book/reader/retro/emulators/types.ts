import type { RetroPlatform } from '@stump/client'

export type EmulatorMountOptions = {
	canvas: HTMLCanvasElement
	image: ArrayBuffer
	/** Original filename or extension hint (e.g. game.d64) for format detection */
	fileName?: string
	/** Optional firmware buffers keyed by expected filename (Amiga) */
	firmware?: Record<string, ArrayBuffer>
}

export type RetroEmulatorHandle = {
	/** Stop audio/raf and free resources */
	destroy: () => void
	/** Optional: capture save state bytes */
	saveState?: () => Promise<ArrayBuffer | null>
	/** Optional: restore save state */
	loadState?: (data: ArrayBuffer) => Promise<void>
	/** Optional: hot-swap disk image; may reboot */
	mountImage?: (image: ArrayBuffer) => Promise<void>
}

export type RetroEmulatorModule = {
	platform: RetroPlatform
	/** Human label for UI */
	label: string
	/** Firmware basenames required before play (Amiga Kickstart, etc.) */
	requiredFirmware?: string[]
	create: (options: EmulatorMountOptions) => Promise<RetroEmulatorHandle>
}
