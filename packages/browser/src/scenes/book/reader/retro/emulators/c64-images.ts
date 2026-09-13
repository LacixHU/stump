/**
 * Readers for the C64 container formats we serve (.d64 disks, .t64 tapes).
 *
 * The emulated 1541 is cycle-accurate, so a real `LOAD"*",8,1` costs the same
 * two minutes it did in 1984 — even under warp. Pulling the first program out
 * of the container ourselves lets the player inject it straight into RAM,
 * which is what "instant" disk speed is supposed to mean.
 */

export type C64Program = {
	/** Directory name, decoded from PETSCII for display */
	name: string
	/** PRG bytes: 2-byte little-endian load address followed by the payload */
	prg: Uint8Array
	/** Load address taken from the PRG header */
	loadAddress: number
}

/** Address a BASIC program (and therefore anything `RUN` can start) lives at. */
export const BASIC_START = 0x0801

/** .d64 comes in 35/40-track variants, each with an optional trailing error map. */
const D64_SIZES = new Set([174848, 175531, 196608, 197376])
const D64_DIR_TRACK = 18
const D64_DIR_SECTOR = 1
const D64_ENTRIES_PER_SECTOR = 8
const D64_ENTRY_SIZE = 32
const D64_FILE_TYPE_PRG = 2
const D64_FILE_TYPE_CLOSED = 0x80

const T64_HEADER_SIZE = 0x40
const T64_ENTRY_SIZE = 0x20

export function isD64Size(byteLength: number): boolean {
	return D64_SIZES.has(byteLength)
}

/**
 * Every .t64 opens with a 32-byte signature — "C64 tape image file", "C64S tape
 * file" and friends. Matching on "C64" alone is not enough: a .crt cartridge
 * starts with "C64 CARTRIDGE   ".
 */
export function looksLikeT64(bytes: Uint8Array): boolean {
	if (bytes.length <= T64_HEADER_SIZE) return false
	let signature = ''
	for (let i = 0; i < 32; i += 1) {
		signature += String.fromCharCode(byteAt(bytes, i))
	}
	signature = signature.toUpperCase()
	return signature.startsWith('C64') && signature.includes('TAPE')
}

/** A .prg is already what the emulator wants; it just needs its header read. */
export function programFromPrg(bytes: Uint8Array, name = ''): C64Program | null {
	return toProgram(name, bytes)
}

function sectorsPerTrack(track: number): number {
	if (track <= 17) return 21
	if (track <= 24) return 19
	if (track <= 30) return 18
	return 17
}

function sectorOffset(track: number, sector: number): number {
	let offset = 0
	for (let t = 1; t < track; t += 1) {
		offset += sectorsPerTrack(t) * 256
	}
	return offset + sector * 256
}

/** Every call site bounds-checks first; the fallback only satisfies noUncheckedIndexedAccess. */
function byteAt(image: Uint8Array, index: number): number {
	return image[index] ?? 0
}

function decodePetscii(bytes: Uint8Array): string {
	let out = ''
	for (const byte of bytes) {
		// 0xa0 pads directory names, 0x20 pads tape names
		if (byte === 0xa0 || byte === 0x00) continue
		const code = byte >= 0xc1 && byte <= 0xda ? byte - 0x80 : byte
		out += code >= 0x20 && code <= 0x7e ? String.fromCharCode(code) : ' '
	}
	return out.trim()
}

function toProgram(name: string, prg: Uint8Array): C64Program | null {
	if (prg.length < 3) return null
	return { name, prg, loadAddress: byteAt(prg, 0) | (byteAt(prg, 1) << 8) }
}

/** Walk a file's sector chain. Returns null on a malformed or looping chain. */
function readD64File(
	image: Uint8Array,
	firstTrack: number,
	firstSector: number,
): Uint8Array | null {
	const chunks: Uint8Array[] = []
	const seen = new Set<number>()
	let total = 0
	let track = firstTrack
	let sector = firstSector

	while (track >= 1 && track <= 40) {
		if (sector >= sectorsPerTrack(track)) return null
		const key = track * 256 + sector
		if (seen.has(key)) return null
		seen.add(key)

		const start = sectorOffset(track, sector)
		if (start + 256 > image.length) return null

		const nextTrack = byteAt(image, start)
		const nextSector = byteAt(image, start + 1)
		if (nextTrack === 0) {
			// Last sector: the link's low byte is the offset of the final used byte.
			const used = Math.min(Math.max(nextSector - 1, 0), 254)
			chunks.push(image.subarray(start + 2, start + 2 + used))
			total += used
			const out = new Uint8Array(total)
			let at = 0
			for (const chunk of chunks) {
				out.set(chunk, at)
				at += chunk.length
			}
			return out
		}

		chunks.push(image.subarray(start + 2, start + 256))
		total += 254
		track = nextTrack
		sector = nextSector
	}

	return null
}

/**
 * First program in the directory — the file `LOAD"*",8,1` would pick up.
 */
export function firstD64Program(image: Uint8Array): C64Program | null {
	let track = D64_DIR_TRACK
	let sector = D64_DIR_SECTOR
	const seen = new Set<number>()

	while (track >= 1 && track <= 40) {
		if (sector >= sectorsPerTrack(track)) return null
		const key = track * 256 + sector
		if (seen.has(key)) return null
		seen.add(key)

		const start = sectorOffset(track, sector)
		if (start + 256 > image.length) return null

		for (let i = 0; i < D64_ENTRIES_PER_SECTOR; i += 1) {
			const entry = start + 2 + i * D64_ENTRY_SIZE
			const fileType = byteAt(image, entry)
			if (!(fileType & D64_FILE_TYPE_CLOSED)) continue
			if ((fileType & 0x0f) !== D64_FILE_TYPE_PRG) continue

			const data = readD64File(image, byteAt(image, entry + 1), byteAt(image, entry + 2))
			if (!data) continue
			const program = toProgram(decodePetscii(image.subarray(entry + 3, entry + 19)), data)
			if (program) return program
		}

		track = byteAt(image, start)
		sector = byteAt(image, start + 1)
	}

	return null
}

/**
 * First program on a tape image. Many .t64 files in the wild carry a bogus end
 * address, so each entry is also bounded by wherever the next one starts.
 */
export function firstT64Program(image: Uint8Array): C64Program | null {
	if (!looksLikeT64(image)) return null

	const view = new DataView(image.buffer, image.byteOffset, image.byteLength)
	const maxEntries = view.getUint16(0x22, true)
	const usedEntries = view.getUint16(0x24, true)
	const capacity = Math.floor((image.length - T64_HEADER_SIZE) / T64_ENTRY_SIZE)
	const count = Math.min(Math.max(usedEntries, maxEntries) || capacity, capacity)

	const offsets: number[] = []
	for (let i = 0; i < count; i += 1) {
		const entry = T64_HEADER_SIZE + i * T64_ENTRY_SIZE
		if (byteAt(image, entry) === 0) continue
		offsets.push(view.getUint32(entry + 8, true))
	}
	offsets.sort((a, b) => a - b)

	for (let i = 0; i < count; i += 1) {
		const entry = T64_HEADER_SIZE + i * T64_ENTRY_SIZE
		if (byteAt(image, entry) === 0) continue

		const loadAddress = view.getUint16(entry + 2, true)
		const endAddress = view.getUint16(entry + 4, true)
		const dataStart = view.getUint32(entry + 8, true)
		if (dataStart >= image.length) continue

		const nextStart = offsets.find((offset) => offset > dataStart) ?? image.length
		const declared = endAddress > loadAddress ? endAddress - loadAddress : 0
		const available = Math.min(nextStart, image.length) - dataStart
		const length = declared > 0 ? Math.min(declared, available) : available
		if (length <= 0) continue

		const prg = new Uint8Array(length + 2)
		prg[0] = loadAddress & 0xff
		prg[1] = (loadAddress >> 8) & 0xff
		prg.set(image.subarray(dataStart, dataStart + length), 2)

		const program = toProgram(decodePetscii(image.subarray(entry + 16, entry + 32)), prg)
		if (program) return program
	}

	return null
}
