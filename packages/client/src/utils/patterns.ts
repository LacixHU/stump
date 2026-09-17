export const ARCHIVE_EXTENSION = /cbr|cbz|zip|rar/
export const EBOOK_EXTENSION = /epub/
export const PDF_EXTENSION = /pdf/

/** Retro computer disk/tape image extensions (C64, Spectrum, Amiga, DOS). */
export const RETRO_EXTENSIONS = [
	'd64',
	't64',
	'prg',
	'g64',
	'tap',
	'tzx',
	'z80',
	'sna',
	'adf',
	'adz',
	'img',
	'ima',
	'exe',
	'com',
	'dosz',
] as const

export type RetroExtension = (typeof RETRO_EXTENSIONS)[number]

export const RETRO_EXTENSION = new RegExp(`^(?:${RETRO_EXTENSIONS.join('|')})$`, 'i')

export type RetroPlatform = 'c64' | 'spectrum' | 'amiga' | 'dos'

const UNIQUE_EXT_PLATFORM: Record<string, RetroPlatform> = {
	d64: 'c64',
	t64: 'c64',
	prg: 'c64',
	g64: 'c64',
	tzx: 'spectrum',
	z80: 'spectrum',
	sna: 'spectrum',
	adf: 'amiga',
	adz: 'amiga',
	img: 'dos',
	ima: 'dos',
	exe: 'dos',
	com: 'dos',
	dosz: 'dos',
}

/**
 * Resolve retro platform from extension and optional path.
 * Mirrors Rust `resolve_retro_platform` / `resolve_retro_platform_with_series`.
 */
export function resolveRetroPlatform(
	extension: string,
	path?: string,
	seriesTags?: string[],
): RetroPlatform {
	const ext = extension.replace(/^\./, '').toLowerCase()
	const unique = UNIQUE_EXT_PLATFORM[ext]
	if (unique) return unique

	if (ext === 'tap') {
		const fromPath = platformFromPathHints(path)
		if (fromPath) return fromPath
		const fromTags = platformFromSeriesTags(seriesTags)
		if (fromTags) return fromTags
		return 'c64'
	}

	return 'c64'
}

export function isRetroExtension(extension: string): boolean {
	const ext = extension.replace(/^\./, '').toLowerCase()
	return RETRO_EXTENSIONS.includes(ext as RetroExtension)
}

function platformFromPathHints(path?: string): RetroPlatform | undefined {
	if (!path) return undefined
	const lower = path.replace(/\\/g, '/').toLowerCase()
	const segments = lower.split('/').filter(Boolean)

	for (let i = segments.length - 1; i >= 0; i--) {
		const segment = segments[i]
		if (
			segment === 'c64' ||
			segment === 'commodore' ||
			segment.startsWith('c64') ||
			segment.includes('commodore')
		) {
			return 'c64'
		}
		if (
			segment === 'spectrum' ||
			segment === 'zx' ||
			segment === 'sinclair' ||
			segment.includes('spectrum') ||
			segment.includes('sinclair')
		) {
			return 'spectrum'
		}
		if (segment === 'amiga' || segment.includes('amiga')) {
			return 'amiga'
		}
		if (
			segment === 'dos' ||
			segment === 'msdos' ||
			segment === 'pc' ||
			segment.includes('msdos') ||
			segment.includes('ms-dos')
		) {
			return 'dos'
		}
	}
	return undefined
}

function platformFromSeriesTags(tags?: string[]): RetroPlatform | undefined {
	if (!tags?.length) return undefined
	for (const tag of tags) {
		const lower = tag.toLowerCase()
		if (lower === 'platform:c64') return 'c64'
		if (lower === 'platform:spectrum') return 'spectrum'
		if (lower === 'platform:amiga') return 'amiga'
		if (lower === 'platform:dos') return 'dos'
	}
	return undefined
}
