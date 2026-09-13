import type { RetroPlatform } from '@stump/client'

export type RetroDiskSpeed = 'authentic' | 'instant'

export type EmulatorMountOptions = {
	canvas: HTMLCanvasElement
	image: ArrayBuffer
	/** Original filename or extension hint (e.g. game.d64) for format detection */
	fileName?: string
	/** Optional firmware buffers keyed by expected filename (Amiga) */
	firmware?: Record<string, ArrayBuffer>
	/** Initial disk/tape speed preference; decides whether loading is emulated or skipped */
	diskSpeed?: RetroDiskSpeed
}

export type RetroInputMode = 'mixed' | 'keyboard' | 'joystick'

export type RetroEmulatorHandle = {
	/** Stop audio/raf and free resources */
	destroy: () => void
	/** Optional: capture save state bytes */
	saveState?: () => Promise<ArrayBuffer | null>
	/** Optional: restore save state */
	loadState?: (data: ArrayBuffer) => Promise<void>
	/** Optional: insert a new disk/tape without destroying the session */
	mountImage?: (image: ArrayBuffer, fileName?: string) => Promise<void>
	/** Optional: hard-reset the machine (disk stays inserted) */
	reset?: () => void
	setInputMode?: (mode: RetroInputMode) => void
	setJoystickPort?: (port: 1 | 2) => void
	setDiskSpeed?: (speed: RetroDiskSpeed) => void
}

export type RetroEmulatorModule = {
	platform: RetroPlatform
	/** Human label for UI */
	label: string
	/** Firmware basenames required before play (Amiga Kickstart, etc.) */
	requiredFirmware?: string[]
	create: (options: EmulatorMountOptions) => Promise<RetroEmulatorHandle>
}
