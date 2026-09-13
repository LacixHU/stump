import {
	BASIC_START,
	firstD64Program,
	firstT64Program,
	isD64Size,
	looksLikeT64,
	programFromPrg,
} from '../c64-images'

const D64_SIZE = 174848

const sectorsPerTrack = (track: number) =>
	track <= 17 ? 21 : track <= 24 ? 19 : track <= 30 ? 18 : 17

function sectorOffset(track: number, sector: number) {
	let offset = 0
	for (let t = 1; t < track; t += 1) offset += sectorsPerTrack(t) * 256
	return offset + sector * 256
}

/** Minimal .d64 holding a single PRG, chained across data sectors on track 1+. */
function buildD64(prg: Uint8Array, name = 'TEST') {
	const image = new Uint8Array(D64_SIZE)

	const chunks: Uint8Array[] = []
	for (let i = 0; i < prg.length; i += 254) chunks.push(prg.subarray(i, i + 254))

	const slots: Array<[number, number]> = []
	for (let track = 1; track <= 17 && slots.length < chunks.length; track += 1) {
		for (
			let sector = 0;
			sector < sectorsPerTrack(track) && slots.length < chunks.length;
			sector++
		) {
			slots.push([track, sector])
		}
	}

	chunks.forEach((chunk, index) => {
		const [track, sector] = slots[index] as [number, number]
		const offset = sectorOffset(track, sector)
		const next = slots[index + 1]
		if (next) {
			image[offset] = next[0]
			image[offset + 1] = next[1]
		} else {
			image[offset] = 0
			image[offset + 1] = chunk.length + 1
		}
		image.set(chunk, offset + 2)
	})

	// Directory sector 18/1 with one closed PRG entry
	const dir = sectorOffset(18, 1)
	image[dir] = 0
	image[dir + 1] = 0xff
	const entry = dir + 2
	image[entry] = 0x82
	const [firstTrack, firstSector] = slots[0] as [number, number]
	image[entry + 1] = firstTrack
	image[entry + 2] = firstSector
	image.fill(0xa0, entry + 3, entry + 19)
	for (let i = 0; i < name.length; i += 1) image[entry + 3 + i] = name.charCodeAt(i)

	return image
}

function prgWithLoadAddress(address: number, payload: number[]) {
	return Uint8Array.from([address & 0xff, (address >> 8) & 0xff, ...payload])
}

/** Minimal .t64 holding a single PRG entry, laid out the way real rips are. */
function buildT64(
	prg: Uint8Array,
	{
		name = 'TAPETEST',
		maxEntries = 30,
		signature = 'C64 tape image file',
	}: { name?: string; maxEntries?: number; signature?: string } = {},
) {
	const dataOffset = 0x40 + maxEntries * 0x20
	const image = new Uint8Array(dataOffset + prg.length - 2)
	const view = new DataView(image.buffer)
	for (let i = 0; i < signature.length; i += 1) image[i] = signature.charCodeAt(i)
	image.fill(0x20, signature.length, 0x20)

	const loadAddress = prg[0]! | (prg[1]! << 8)
	view.setUint16(0x22, maxEntries, true) // max entries
	view.setUint16(0x24, 1, true) // used entries
	const entry = 0x40
	image[entry] = 1 // normal tape file
	image[entry + 1] = 0x82 // PRG
	view.setUint16(entry + 2, loadAddress, true)
	view.setUint16(entry + 4, loadAddress + prg.length - 2, true)
	view.setUint32(entry + 8, dataOffset, true)
	image.fill(0x20, entry + 16, entry + 32)
	for (let i = 0; i < name.length; i += 1) image[entry + 16 + i] = name.charCodeAt(i)
	image.set(prg.subarray(2), dataOffset)

	return image
}

/** First 16 bytes of a .crt cartridge, which also begin with "C64". */
function crtHeader() {
	const image = new Uint8Array(0x100)
	const signature = 'C64 CARTRIDGE   '
	for (let i = 0; i < signature.length; i += 1) image[i] = signature.charCodeAt(i)
	return image
}

describe('isD64Size', () => {
	it('accepts the 35- and 40-track variants, with and without an error map', () => {
		for (const size of [174848, 175531, 196608, 197376]) {
			expect(isD64Size(size)).toBe(true)
		}
	})

	it('rejects anything else', () => {
		expect(isD64Size(0)).toBe(false)
		expect(isD64Size(174847)).toBe(false)
	})
})

describe('looksLikeT64', () => {
	it.each(['C64 tape image file', 'C64S tape image file', 'C64S tape file', 'C64 tape file'])(
		'matches a tape signed %j',
		(signature) => {
			expect(
				looksLikeT64(buildT64(prgWithLoadAddress(BASIC_START, [1, 2, 3]), { signature })),
			).toBe(true)
		},
	)

	it('does not match a disk image', () => {
		expect(looksLikeT64(buildD64(prgWithLoadAddress(BASIC_START, [1, 2, 3])))).toBe(false)
	})

	it('does not match a cartridge, which also starts with "C64"', () => {
		expect(looksLikeT64(crtHeader())).toBe(false)
	})
})

describe('programFromPrg', () => {
	it('reads the load address out of the header', () => {
		expect(programFromPrg(prgWithLoadAddress(0xc000, [1, 2, 3]))?.loadAddress).toBe(0xc000)
		expect(programFromPrg(prgWithLoadAddress(BASIC_START, [1]))?.loadAddress).toBe(BASIC_START)
	})

	it('rejects a file too short to hold a load address and a byte', () => {
		expect(programFromPrg(new Uint8Array([0x01, 0x08]))).toBeNull()
	})
})

describe('firstD64Program', () => {
	it('reads the program the drive would load, across a multi-sector chain', () => {
		const payload = Array.from({ length: 900 }, (_, i) => i & 0xff)
		const image = buildD64(prgWithLoadAddress(BASIC_START, payload), 'ELITE')

		const program = firstD64Program(image)

		expect(program).not.toBeNull()
		expect(program?.name).toBe('ELITE')
		expect(program?.loadAddress).toBe(BASIC_START)
		expect(Array.from(program?.prg.subarray(2) ?? [])).toEqual(payload)
	})

	it('reports a load address outside BASIC so the caller can decline to inject', () => {
		const image = buildD64(prgWithLoadAddress(0xc000, [1, 2, 3]))
		expect(firstD64Program(image)?.loadAddress).toBe(0xc000)
	})

	it('returns null rather than throwing on malformed images', () => {
		expect(firstD64Program(new Uint8Array(0))).toBeNull()
		expect(firstD64Program(new Uint8Array(10))).toBeNull()
		expect(firstD64Program(new Uint8Array(D64_SIZE))).toBeNull()
		expect(firstD64Program(new Uint8Array(D64_SIZE).fill(0xff))).toBeNull()
		expect(
			firstD64Program(buildD64(prgWithLoadAddress(BASIC_START, [1])).subarray(0, 90000)),
		).toBeNull()
	})

	it('terminates on a sector chain that points at itself', () => {
		const image = buildD64(prgWithLoadAddress(BASIC_START, Array(600).fill(7)))
		const firstDataSector = sectorOffset(1, 0)
		image[firstDataSector] = 1
		image[firstDataSector + 1] = 0

		expect(firstD64Program(image)).toBeNull()
	})
})

describe('firstT64Program', () => {
	it('rebuilds a PRG from the tape directory', () => {
		const payload = [0x0b, 0x08, 0x0a, 0x00, 0x99, 0x00, 0x00, 0x00]
		const program = firstT64Program(
			buildT64(prgWithLoadAddress(BASIC_START, payload), { name: 'HERO' }),
		)

		expect(program?.name).toBe('HERO')
		expect(program?.loadAddress).toBe(BASIC_START)
		expect(Array.from(program?.prg.subarray(2) ?? [])).toEqual(payload)
	})

	it('reads a machine-code tape, which is most of them', () => {
		const payload = [0xa9, 0x01, 0x8d, 0x00, 0x04, 0x60]
		const program = firstT64Program(
			buildT64(prgWithLoadAddress(0xc000, payload), { name: 'MLGAME' }),
		)

		expect(program?.loadAddress).toBe(0xc000)
		expect(Array.from(program?.prg.subarray(2) ?? [])).toEqual(payload)
	})

	it('clamps a payload whose declared end address runs past the file', () => {
		const payload = [1, 2, 3, 4]
		const image = buildT64(prgWithLoadAddress(BASIC_START, payload))
		new DataView(image.buffer).setUint16(0x44, 0xc3c6, true) // bogus end address

		expect(firstT64Program(image)?.prg.subarray(2).length).toBe(payload.length)
	})

	it('returns null for anything that is not a tape image', () => {
		expect(firstT64Program(new Uint8Array(0))).toBeNull()
		expect(firstT64Program(new Uint8Array(D64_SIZE))).toBeNull()
		expect(firstT64Program(buildD64(prgWithLoadAddress(BASIC_START, [1, 2])))).toBeNull()
		expect(firstT64Program(crtHeader())).toBeNull()
	})
})
