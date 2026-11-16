import type { PdfTextSpan } from '@stump/sdk'

/** A piece of one span: characters `start..end` of its text */
export type PdfSentencePart = { span: number; start: number; end: number }

/** A sentence to speak, and where its text sits on the page */
export type PdfSentence = { text: string; parts: PdfSentencePart[] }

/** Matches the ascent the page HTML uses for its text layer */
const ASCENT = 0.85
const DESCENT = 0.25
/** Long sentences are spoken in chunks, which keeps server TTS requests small */
const MAX_SENTENCE_CHARS = 280

const SENTENCE_END = /[.!?…]/
const CLOSING = /["'”’»)\]]/
const HYPHENS = /[-­‐]$/
const HAS_WORD = /[\p{L}\p{N}]/u

type Separator = ' ' | '\n' | 'join'

/** How the text of `next` continues the text of `prev` */
function separator(prev: PdfTextSpan, next: PdfTextSpan): Separator {
	const dx = next.x - prev.x
	const dy = next.y - prev.y
	// distance of `next` below the baseline of `prev`
	const below = -dx * Math.sin(prev.angle) + dy * Math.cos(prev.angle)
	const size = Math.max(prev.size, next.size)

	const sameLine = Math.abs(next.angle - prev.angle) < 0.05 && Math.abs(below) < size * 0.5
	if (sameLine) return ' '

	const sizeChange = Math.max(prev.size, next.size) / Math.max(1e-3, Math.min(prev.size, next.size))
	// a new column (moving up), a wide gap or a heading starts a new paragraph
	if (below < 0 || below > size * 2 || sizeChange > 1.3) return '\n'
	if (HYPHENS.test(prev.text) && /^\p{Ll}/u.test(next.text)) return 'join'
	return ' '
}

/**
 * Turns the text runs of a page into sentences, keeping track of which characters of
 * which runs each sentence came from so it can be highlighted while it is spoken.
 * Words hyphenated across lines are joined.
 */
export function buildPdfSentences(
	spans: PdfTextSpan[],
	maxChars = MAX_SENTENCE_CHARS,
): PdfSentence[] {
	const chars: string[] = []
	const origins: Array<[number, number] | null> = []

	spans.forEach((span, index) => {
		const prev = spans[index - 1]
		if (prev) {
			const sep = separator(prev, span)
			if (sep === 'join') {
				chars.pop()
				origins.pop()
			} else {
				chars.push(sep)
				origins.push(null)
			}
		}
		for (let offset = 0; offset < span.text.length; offset++) {
			chars.push(span.text[offset]!)
			origins.push([index, offset])
		}
	})

	const ranges: Array<[number, number]> = []
	let start = 0
	for (let i = 0; i < chars.length; i++) {
		const char = chars[i]!
		if (char === '\n') {
			ranges.push([start, i])
			start = i + 1
		} else if (SENTENCE_END.test(char)) {
			let end = i + 1
			while (end < chars.length && (SENTENCE_END.test(chars[end]!) || CLOSING.test(chars[end]!))) {
				end++
			}
			// "1.5" does not end a sentence, nor does "world!" in `"Hello, world!" program`
			if (end === chars.length || (/\s/.test(chars[end]!) && !continuesLowercase(chars, end))) {
				ranges.push([start, end])
				start = end
				i = end - 1
			}
		}
	}
	ranges.push([start, chars.length])

	const sentences: PdfSentence[] = []
	for (const range of ranges) {
		for (const [from, to] of splitLong(chars, range, maxChars)) {
			const sentence = toSentence(chars, origins, from, to)
			if (sentence) sentences.push(sentence)
		}
	}
	return sentences
}

/** Whether the next word after `index` starts with a lowercase letter */
function continuesLowercase(chars: string[], index: number) {
	while (index < chars.length && chars[index] === ' ') index++
	return index < chars.length && /\p{Ll}/u.test(chars[index]!)
}

/** Splits `[from, to)` into chunks of at most `maxChars`, preferably after punctuation */
function splitLong(chars: string[], [from, to]: [number, number], maxChars: number) {
	const chunks: Array<[number, number]> = []
	while (to - from > maxChars) {
		let cut = -1
		for (let i = from + maxChars; i > from + maxChars / 3; i--) {
			if (/\s/.test(chars[i]!) && /[,;:]/.test(chars[i - 1]!)) {
				cut = i
				break
			}
		}
		if (cut < 0) {
			for (let i = from + maxChars; i > from; i--) {
				if (/\s/.test(chars[i]!)) {
					cut = i
					break
				}
			}
		}
		if (cut < 0) cut = from + maxChars
		chunks.push([from, cut])
		from = cut
	}
	chunks.push([from, to])
	return chunks
}

function toSentence(
	chars: string[],
	origins: Array<[number, number] | null>,
	from: number,
	to: number,
): PdfSentence | null {
	while (from < to && /\s/.test(chars[from]!)) from++
	while (to > from && /\s/.test(chars[to - 1]!)) to--
	const text = chars.slice(from, to).join('').replace(/\s+/g, ' ')
	if (!HAS_WORD.test(text)) return null

	const parts: PdfSentencePart[] = []
	for (let i = from; i < to; i++) {
		const origin = origins[i]
		if (!origin) continue
		const [span, offset] = origin
		const last = parts.at(-1)
		if (last && last.span === span && last.end === offset) {
			last.end = offset + 1
		} else {
			parts.push({ span, start: offset, end: offset + 1 })
		}
	}
	return { text, parts }
}

/** Distance along the baseline where code unit `index` of the span starts */
function offsetOf(span: PdfTextSpan, index: number) {
	if (index >= span.text.length) return span.width
	const offset = span.offsets?.[index]
	return offset ?? (index / span.text.length) * span.width
}

/** A box on the page in percentages of its size, rotated around its top-left corner */
export type PdfHighlightRect = {
	left: number
	top: number
	width: number
	height: number
	angle: number
}

/** The boxes covering a sentence on a page of `pageWidth` × `pageHeight` points */
export function sentenceRects(
	sentence: PdfSentence,
	spans: PdfTextSpan[],
	pageWidth: number,
	pageHeight: number,
): PdfHighlightRect[] {
	if (pageWidth <= 0 || pageHeight <= 0) return []
	return sentence.parts.flatMap(({ span: index, start, end }) => {
		const span = spans[index]
		if (!span || !span.text.length) return []
		const from = offsetOf(span, start)
		const to = offsetOf(span, end)
		if (to <= from) return []
		const cos = Math.cos(span.angle)
		const sin = Math.sin(span.angle)
		// start of the piece on the baseline, then up by the ascent
		const x = span.x + cos * from + sin * ASCENT * span.size
		const y = span.y + sin * from - cos * ASCENT * span.size
		return [
			{
				left: (x / pageWidth) * 100,
				top: (y / pageHeight) * 100,
				width: ((to - from) / pageWidth) * 100,
				height: (((ASCENT + DESCENT) * span.size) / pageHeight) * 100,
				angle: span.angle,
			},
		]
	})
}
