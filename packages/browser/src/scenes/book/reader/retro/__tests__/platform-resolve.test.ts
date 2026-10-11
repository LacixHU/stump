import { isRetroExtension, resolveRetroPlatform } from '@stump/client'

/**
 * `resolveRetroPlatform` is a hand-kept mirror of the Rust resolver in
 * `core/src/filesystem/media/format/retro.rs`: there is no generated binding, so a
 * disagreement between the two means the server catalogues a game under one platform and the
 * player boots another machine's emulator. These are the same cases as the Rust tests.
 */
describe('resolveRetroPlatform', () => {
	it.each([
		['d64', 'c64'],
		['crt', 'c64'],
		['tzx', 'spectrum'],
		['adf', 'amiga'],
		['dosz', 'dos'],
		['z64', 'n64'],
		['n64', 'n64'],
		['V64', 'n64'],
		['sfc', 'snes'],
		['smc', 'snes'],
		['.SFC', 'snes'],
	])('puts .%s on %s', (extension, platform) => {
		expect(resolveRetroPlatform(extension)).toBe(platform)
	})

	it('knows which extensions are retro, and leaves the generic ones alone', () => {
		for (const ext of ['sfc', 'smc', 'z64', 'n64', 'v64', 'd64']) {
			expect(isRetroExtension(ext)).toBe(true)
		}
		for (const ext of ['rom', 'bin', 'zip', 'cbz', 'fig', 'swc']) {
			expect(isRetroExtension(ext)).toBe(false)
		}
	})

	it('resolves a series tag for the new platforms', () => {
		expect(resolveRetroPlatform('tap', undefined, ['platform:snes'])).toBe('snes')
		expect(resolveRetroPlatform('tap', undefined, ['platform:n64'])).toBe('n64')
	})

	it('reads a SNES folder name, in every spelling', () => {
		for (const folder of ['SNES', 'Super Nintendo', 'Super Famicom', 'SFC']) {
			expect(resolveRetroPlatform('tap', `/Retro/${folder}/x.tap`)).toBe('snes')
		}
	})

	it('keeps the two Nintendo consoles apart', () => {
		expect(resolveRetroPlatform('tap', '/Retro/Super Nintendo/x.tap')).toBe('snes')
		expect(resolveRetroPlatform('tap', '/Retro/Nintendo 64/x.tap')).toBe('n64')
		expect(resolveRetroPlatform('tap', '/Retro/Nintendo64/x.tap')).toBe('n64')
		expect(resolveRetroPlatform('tap', '/Retro/N64/x.tap')).toBe('n64')
		// a bare "Nintendo" folder names neither, so it falls back to the C64 default
		expect(resolveRetroPlatform('tap', '/Retro/Nintendo/x.tap')).toBe('c64')
	})
})
