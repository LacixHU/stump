/**
 * What goes to the server as a SNES save state: the core's own snapshot behind a small header,
 * so a file from another platform (or a corrupt upload) is refused with a message instead of
 * being fed to the core.
 *
 * Layout: 8 bytes `STUMPSNS`, 1 byte version, then the core's state verbatim.
 */

const MAGIC = new Uint8Array([0x53, 0x54, 0x55, 0x4d, 0x50, 0x53, 0x4e, 0x53])
const VERSION = 1
const HEADER_BYTES = MAGIC.byteLength + 1

export function packSnesSave(state: Uint8Array): ArrayBuffer {
	if (state.byteLength === 0) {
		throw new Error('The emulator produced an empty save state')
	}
	const out = new Uint8Array(HEADER_BYTES + state.byteLength)
	out.set(MAGIC, 0)
	out[MAGIC.byteLength] = VERSION
	out.set(state, HEADER_BYTES)
	return out.buffer
}

export function unpackSnesSave(data: ArrayBuffer): Uint8Array {
	const bytes = new Uint8Array(data)
	if (bytes.byteLength <= HEADER_BYTES || MAGIC.some((byte, i) => bytes[i] !== byte)) {
		throw new Error('This is not a Super Nintendo save state')
	}
	if (bytes[MAGIC.byteLength] !== VERSION) {
		throw new Error('Unsupported Super Nintendo save state version')
	}
	return bytes.slice(HEADER_BYTES)
}
