import { Blob as NodeBlob } from 'buffer'

import { readWithProgress } from '../readWithProgress'

// jsdom's Blob has no arrayBuffer(), which every browser that runs the player does
Object.assign(global, { Blob: NodeBlob })

const MIB = 1024 * 1024

/** The jsdom environment has no fetch Response, so this fakes the parts the reader touches. */
function streamed(chunks: Uint8Array[], headers: Record<string, string>) {
	let i = 0
	return {
		arrayBuffer: () =>
			Promise.resolve(new Uint8Array(chunks.reduce((n, c) => n + c.length, 0)).buffer),
		body: {
			getReader: () => ({
				read: () =>
					Promise.resolve(
						i < chunks.length
							? { done: false, value: chunks[i++] }
							: { done: true, value: undefined },
					),
			}),
		},
		headers: {
			get: (name: string) => headers[name] ?? null,
			has: (name: string) => name in headers,
		},
	} as unknown as Response
}

describe('readWithProgress', () => {
	it('reports whole percents and returns every byte', async () => {
		const chunks = [10, 10, 10, 10].map((n) => new Uint8Array(n * MIB).fill(n))
		const seen: (number | null)[] = []
		const out = await readWithProgress(
			streamed(chunks, { 'content-length': String(40 * MIB) }),
			(p) => seen.push(p),
		)
		expect(seen).toEqual([25, 50, 75, 100])
		expect(out.byteLength).toBe(40 * MIB)
		const bytes = new Uint8Array(out)
		expect([bytes[0], bytes[10 * MIB], bytes[40 * MIB - 1]]).toEqual([10, 10, 10])
	})

	it('stays silent for a small download', async () => {
		const seen: (number | null)[] = []
		const out = await readWithProgress(
			streamed([new Uint8Array(1024)], { 'content-length': '1024' }),
			(p) => seen.push(p),
		)
		expect(seen).toEqual([])
		expect(out.byteLength).toBe(1024)
	})

	it('goes indeterminate when the length is not trustworthy', async () => {
		const unknown: (number | null)[] = []
		await readWithProgress(streamed([new Uint8Array(8)], {}), (p) => unknown.push(p))
		expect(unknown).toEqual([null])

		const encoded: (number | null)[] = []
		await readWithProgress(
			streamed([new Uint8Array(8)], {
				'content-encoding': 'gzip',
				'content-length': String(9 * MIB),
			}),
			(p) => encoded.push(p),
		)
		expect(encoded).toEqual([null])
	})

	it('never reports past 100', async () => {
		const seen: (number | null)[] = []
		await readWithProgress(
			streamed([new Uint8Array(6 * MIB)], { 'content-length': String(5 * MIB) }),
			(p) => seen.push(p),
		)
		expect(seen).toEqual([100])
	})
})
