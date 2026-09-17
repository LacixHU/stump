import type { RetroPlatform } from '@stump/client'

import type { RetroEmulatorModule } from './types'

/** Lazy-load platform emulator; never imported from comic/EPUB/PDF routes. */
export async function loadEmulator(platform: RetroPlatform): Promise<RetroEmulatorModule> {
	switch (platform) {
		case 'c64':
			return (await import('./c64')).default
		case 'spectrum':
			return (await import('./spectrum')).default
		case 'amiga':
			return (await import('./amiga')).default
		case 'dos':
			return (await import('./dos')).default
		default: {
			const _exhaustive: never = platform
			throw new Error(`Unsupported retro platform: ${_exhaustive}`)
		}
	}
}

export type {
	EmulatorMountOptions,
	RetroDiskSpeed,
	RetroEmulatorHandle,
	RetroEmulatorModule,
	RetroInputMode,
	RetroOption,
} from './types'
