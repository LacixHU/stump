import { packSnesSave, unpackSnesSave } from '../snes-saves'

describe('SNES save states', () => {
	it('round-trips the core state byte for byte', () => {
		const state = Uint8Array.from([0, 1, 2, 3, 250, 251, 252])
		expect(Array.from(unpackSnesSave(packSnesSave(state)))).toEqual(Array.from(state))
	})

	it('starts with a header that names the platform', () => {
		const packed = new Uint8Array(packSnesSave(Uint8Array.from([9])))
		expect(String.fromCharCode(...packed.slice(0, 8))).toBe('STUMPSNS')
		expect(packed[8]).toBe(1)
	})

	it('refuses to pack an empty state', () => {
		expect(() => packSnesSave(new Uint8Array())).toThrow('empty save state')
	})

	it('refuses a save from another platform or a truncated upload', () => {
		const n64 = Uint8Array.from('STUMPN64\u0001payload', (c) => c.charCodeAt(0))
		expect(() => unpackSnesSave(n64.buffer)).toThrow('not a Super Nintendo save state')
		expect(() => unpackSnesSave(new Uint8Array([1, 2]).buffer)).toThrow('not a Super Nintendo')
		const headerOnly = new Uint8Array(packSnesSave(Uint8Array.from([1]))).slice(0, 9)
		expect(() => unpackSnesSave(headerOnly.buffer)).toThrow('not a Super Nintendo')
	})

	it('refuses a version it does not know', () => {
		const packed = new Uint8Array(packSnesSave(Uint8Array.from([1])))
		packed[8] = 2
		expect(() => unpackSnesSave(packed.buffer)).toThrow(
			'Unsupported Super Nintendo save state version',
		)
	})
})
