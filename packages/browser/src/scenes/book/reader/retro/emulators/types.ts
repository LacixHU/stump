import type { RetroPlatform } from '@stump/client'

import type { Dispatchable, KeyModifiers } from '../keys'

export type RetroDiskSpeed = 'authentic' | 'instant'

/** One entry in a machine-specific choice the player chrome renders as a radio group. */
export type RetroOption = { id: string; label: string }

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
	/**
	 * Press or release a control from one of the touch surfaces.
	 *
	 * Emulators that listen for `KeyboardEvent`s on `window` (c64-ready) need nothing here:
	 * `dispatchKey` already reaches them. This is for the ones that take input through an
	 * API of their own, where a synthetic event would go nowhere.
	 */
	sendKey?: (target: Dispatchable, down: boolean, modifiers?: KeyModifiers) => void
	/** Machine variants of the same platform (Spectrum 48K/128K/Pentagon). */
	machines?: readonly RetroOption[]
	/** Id of the variant currently running, from `machines`. */
	machine?: string
	/** Switching restarts the machine, so the image is reloaded with it. */
	setMachine?: (id: string) => Promise<void>
	/** Key schemes an on-screen stick can drive, for machines with no joystick port. */
	joystickSchemes?: readonly RetroOption[]
	/** Id of the scheme currently in use, from `joystickSchemes`. */
	joystickScheme?: string
	setJoystickScheme?: (id: string) => void
}

export type RetroEmulatorModule = {
	platform: RetroPlatform
	/** Human label for UI */
	label: string
	/** Firmware basenames required before play (Amiga Kickstart, etc.) */
	requiredFirmware?: string[]
	/** Extra firmware fetched when present; missing files are skipped (A1200 Kickstart). */
	optionalFirmware?: string[]
	create: (options: EmulatorMountOptions) => Promise<RetroEmulatorHandle>
}
