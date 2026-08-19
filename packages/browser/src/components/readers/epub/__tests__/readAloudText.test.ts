import { normalizeReaderWhitespace, splitIntoSentences } from '../readAloudText'

describe('normalizeReaderWhitespace', () => {
	it('keeps newlines while collapsing spaces', () => {
		expect(normalizeReaderWhitespace('Első   bekezdés\n\n  Második\tbekezdés  ')).toBe(
			'Első bekezdés\n\nMásodik bekezdés',
		)
	})

	it('normalizes windows line endings', () => {
		expect(normalizeReaderWhitespace('egy\r\nketto\rharom')).toBe('egy\nketto\nharom')
	})
})

describe('splitIntoSentences', () => {
	it('splits on punctuation', () => {
		expect(splitIntoSentences('Első mondat. Második mondat!')).toEqual([
			'Első mondat.',
			'Második mondat!',
		])
	})

	it('treats newlines as sentence boundaries', () => {
		expect(splitIntoSentences('Első bekezdés címe\nSzöveg folytatása.')).toEqual([
			'Első bekezdés címe',
			'Szöveg folytatása.',
		])
	})

	it('treats blank lines as paragraph breaks', () => {
		expect(splitIntoSentences('Első.\n\nMásodik')).toEqual(['Első.', 'Második'])
	})

	it('treats ellipsis as a sentence end', () => {
		expect(splitIntoSentences('Várt… Aztán ment.')).toEqual(['Várt…', 'Aztán ment.'])
	})
})
