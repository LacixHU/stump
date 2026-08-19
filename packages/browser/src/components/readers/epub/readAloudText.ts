export function normalizeReaderWhitespace(text: string): string {
	return text
		.replace(/\r\n?/g, '\n')
		.replace(/[^\S\n]+/g, ' ')
		.replace(/ *\n */g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim()
}

export function splitIntoSentences(text: string): string[] {
	const normalized = normalizeReaderWhitespace(text)
	if (!normalized) {
		return []
	}

	const sentences: string[] = []
	for (const block of normalized.split(/\n+/)) {
		const matches = block.match(/[^.!?…]+[.!?…]+|[^.!?…]+$/g) || []
		for (const sentence of matches) {
			const cleaned = sentence.replace(/\s+/g, ' ').trim()
			if (cleaned) {
				sentences.push(cleaned)
			}
		}
	}

	return sentences
}

export function elementReadableText(node: Element): string {
	const html = node as HTMLElement
	return html.innerText || html.textContent || ''
}
