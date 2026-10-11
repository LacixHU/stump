/**
 * What goes to the server as an N64 save state: the core's own `savestate.gz`, behind a
 * small header, so a file from another platform (or a corrupt upload) is refused with a
 * message instead of being fed to the core.
 *
 * Layout: 8 bytes `STUMPN64`, 1 byte version, then the core's gzip stream verbatim.
 */

const MAGIC = new Uint8Array([0x53, 0x54, 0x55, 0x4d, 0x50, 0x4e, 0x36, 0x34])
const VERSION = 1
const HEADER_BYTES = MAGIC.byteLength + 1
const GZIP_MAGIC = [0x1f, 0x8b]

export function packN64Save(state: Uint8Array): ArrayBuffer {
	if (state.byteLength < GZIP_MAGIC.length || GZIP_MAGIC.some((byte, i) => state[i] !== byte)) {
		throw new Error('The emulator produced an unexpected save state')
	}
	const out = new Uint8Array(HEADER_BYTES + state.byteLength)
	out.set(MAGIC, 0)
	out[MAGIC.byteLength] = VERSION
	out.set(state, HEADER_BYTES)
	return out.buffer
}

export function unpackN64Save(data: ArrayBuffer): Uint8Array {
	const bytes = new Uint8Array(data)
	if (bytes.byteLength <= HEADER_BYTES || MAGIC.some((byte, i) => bytes[i] !== byte)) {
		throw new Error('This is not an N64 save state')
	}
	if (bytes[MAGIC.byteLength] !== VERSION) {
		throw new Error('Unsupported N64 save state version')
	}
	return bytes.slice(HEADER_BYTES)
}
