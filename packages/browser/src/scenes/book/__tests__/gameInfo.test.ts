import { summarizePlatforms } from '../gameInfo'

describe('summarizePlatforms', () => {
	it('lists a few platforms in full', () => {
		expect(summarizePlatforms(['Commodore 64', 'ZX Spectrum'])).toBe('Commodore 64, ZX Spectrum')
		expect(summarizePlatforms([])).toBe('')
	})

	it('counts the rest of a long list', () => {
		expect(summarizePlatforms(['DOS', 'SNES', 'Jaguar', '3DO', 'Xbox 360', 'Linux'])).toBe(
			'DOS, SNES, Jaguar, 3DO +2',
		)
	})
})
