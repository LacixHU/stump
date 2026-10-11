import { packN64Save, unpackN64Save } from '../n64-saves'

const gzip = (...rest: number[]) => new Uint8Array([0x1f, 0x8b, 0x08, ...rest])

describe('N64 save states', () => {
	it('round-trips the core state byte for byte', () => {
		const state = gzip(1, 2, 3, 4, 5)
		expect(Array.from(unpackN64Save(packN64Save(state)))).toEqual(Array.from(state))
	})

	it('starts with a header that names the platform', () => {
		const packed = new Uint8Array(packN64Save(gzip(9)))
		expect(String.fromCharCode(...packed.slice(0, 8))).toBe('STUMPN64')
		expect(packed[8]).toBe(1)
	})

	it('refuses to pack something that is not a gzip stream', () => {
		expect(() => packN64Save(new Uint8Array([1, 2, 3]))).toThrow('unexpected save state')
		expect(() => packN64Save(new Uint8Array())).toThrow('unexpected save state')
	})

	it('refuses a save from another platform or a truncated upload', () => {
		const dos = Uint8Array.from('STUMPDOS\u0003payload', (c) => c.charCodeAt(0))
		expect(() => unpackN64Save(dos.buffer)).toThrow('not an N64 save state')
		expect(() => unpackN64Save(new Uint8Array([1, 2]).buffer)).toThrow('not an N64 save state')
		const headerOnly = new Uint8Array(packN64Save(gzip(1))).slice(0, 9)
		expect(() => unpackN64Save(headerOnly.buffer)).toThrow('not an N64 save state')
	})

	it('refuses a version it does not know', () => {
		const packed = new Uint8Array(packN64Save(gzip(1)))
		packed[8] = 2
		expect(() => unpackN64Save(packed.buffer)).toThrow('Unsupported N64 save state version')
	})
})
