import type { PdfTextSpan } from '@stump/sdk'

import { buildPdfSentences, sentenceRects } from '../pdfReadAloudText'

const span = (text: string, x: number, y: number, size = 10, width = text.length * 5) =>
	({ text, x, y, size, angle: 0, width }) satisfies PdfTextSpan

describe('buildPdfSentences', () => {
	it('splits sentences across runs and lines', () => {
		const spans = [
			span('First sentence. Second', 10, 20),
			span('one goes on', 10, 32),
			span('here! Third', 70, 32),
		]
		const sentences = buildPdfSentences(spans)
		expect(sentences.map((s) => s.text)).toEqual([
			'First sentence.',
			'Second one goes on here!',
			'Third',
		])
		expect(sentences[1]!.parts).toEqual([
			{ span: 0, start: 16, end: 22 },
			{ span: 1, start: 0, end: 11 },
			{ span: 2, start: 0, end: 5 },
		])
	})

	it('joins words hyphenated across lines', () => {
		const sentences = buildPdfSentences([span('a long exam-', 10, 20), span('ple of it.', 10, 32)])
		expect(sentences.map((s) => s.text)).toEqual(['a long example of it.'])
	})

	it('does not split decimals and breaks on headings', () => {
		const sentences = buildPdfSentences([
			span('Chapter 1', 10, 20, 24),
			span('It costs 1.5 dollars', 10, 50),
		])
		expect(sentences.map((s) => s.text)).toEqual(['Chapter 1', 'It costs 1.5 dollars'])
	})

	it('does not end a sentence before a lowercase word', () => {
		const sentences = buildPdfSentences([span('Write “Hello, world!” program. Then stop.', 10, 20)])
		expect(sentences.map((s) => s.text)).toEqual(['Write “Hello, world!” program.', 'Then stop.'])
	})

	it('skips runs without words and splits very long sentences', () => {
		expect(buildPdfSentences([span('— · —', 10, 20)])).toEqual([])
		const long = 'word, '.repeat(30).trim()
		const sentences = buildPdfSentences([span(long, 10, 20)], 50)
		expect(sentences.length).toBeGreaterThan(1)
		expect(sentences.every((s) => s.text.length <= 50)).toBe(true)
		expect(sentences.map((s) => s.text).join(' ')).toBe(long)
	})
})

describe('sentenceRects', () => {
	it('places the piece of a run in page percentages', () => {
		const spans = [span('Hello world', 100, 200, 10, 110)]
		const [sentence] = buildPdfSentences(spans)
		const [rect] = sentenceRects(
			{ ...sentence!, parts: [{ span: 0, start: 6, end: 11 }] },
			spans,
			1000,
			500,
		)
		expect(rect!.left).toBeCloseTo(16)
		expect(rect!.top).toBeCloseTo(((200 - 8.5) / 500) * 100)
		expect(rect!.width).toBeCloseTo(5)
		expect(rect!.height).toBeCloseTo((11 / 500) * 100)
	})

	it('uses the exact character offsets when the server sends them', () => {
		const spans = [{ ...span('Wi', 0, 100, 10, 30), offsets: [0, 25] }]
		const [rect] = sentenceRects(
			{ text: 'i', parts: [{ span: 0, start: 1, end: 2 }] },
			spans,
			100,
			100,
		)
		expect(rect!.left).toBeCloseTo(25)
		expect(rect!.width).toBeCloseTo(5)
	})
})
