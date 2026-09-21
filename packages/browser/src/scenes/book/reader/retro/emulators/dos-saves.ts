const MAGIC = new Uint8Array([0x53, 0x54, 0x55, 0x4d, 0x50, 0x44, 0x4f, 0x53])
const VERSION = 1
const SKIP_PREFIXES = ['/dev', '/proc', '/tmp']

export type DosSaveFile = { path: string; data: Uint8Array }

export type DosFsStamp = { size: number; mtimeMs: number }

export function shouldSkipDosPath(path: string): boolean {
	const normalized = path.replace(/\\/g, '/')
	if (normalized === '/state.fs' || normalized.endsWith('/state.fs')) return true
	return SKIP_PREFIXES.some(
		(prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
	)
}

export function isDosFileChanged(previous: DosFsStamp | undefined, next: DosFsStamp): boolean {
	return !previous || previous.size !== next.size || previous.mtimeMs !== next.mtimeMs
}

export function selectChangedPaths(
	baseline: Map<string, DosFsStamp>,
	current: Map<string, DosFsStamp>,
): string[] {
	const changed: string[] = []
	for (const [path, stamp] of current) {
		if (isDosFileChanged(baseline.get(path), stamp)) changed.push(path)
	}
	return changed
}

export type DosSaveV1 = { version: 1; files: DosSaveFile[] }
export type DosSaveV2 = {
	files: DosSaveFile[]
	heapGzip: Uint8Array
	heapLen: number
	sdlTicks?: number
	version: 2
}
export type DosSaveV3 = {
	files: DosSaveFile[]
	heapGzip: Uint8Array
	heapLen: number
	sdlTicks: number
	version: 3
}
export type DosSave = DosSaveV1 | DosSaveV2 | DosSaveV3

export function encodeDosSave(files: DosSaveFile[]): ArrayBuffer {
	const encoder = new TextEncoder()
	const encodedPaths = files.map((file) => encoder.encode(file.path))
	let size = 8 + 1 + 4
	for (let i = 0; i < files.length; i += 1) {
		const path = encodedPaths[i]!
		if (path.byteLength > 0xffff) {
			throw new Error('DOS save state path is too long')
		}
		size += 2 + path.byteLength + 4 + files[i]!.data.byteLength
	}

	const out = new Uint8Array(size)
	const view = new DataView(out.buffer)
	out.set(MAGIC, 0)
	out[8] = VERSION
	view.setUint32(9, files.length, true)

	let offset = 13
	for (let i = 0; i < files.length; i += 1) {
		const path = encodedPaths[i]!
		const data = files[i]!.data
		view.setUint16(offset, path.byteLength, true)
		offset += 2
		out.set(path, offset)
		offset += path.byteLength
		view.setUint32(offset, data.byteLength, true)
		offset += 4
		out.set(data, offset)
		offset += data.byteLength
	}

	return out.buffer
}

function assertMagic(bytes: Uint8Array) {
	if (bytes.byteLength < 9) {
		throw new Error('Invalid DOS save state')
	}
	for (let i = 0; i < MAGIC.byteLength; i += 1) {
		if (bytes[i] !== MAGIC[i]) {
			throw new Error('Invalid DOS save state')
		}
	}
}

function readFiles(
	bytes: Uint8Array,
	view: DataView,
	start: number,
	count: number,
): { files: DosSaveFile[]; offset: number } {
	const decoder = new TextDecoder()
	const files: DosSaveFile[] = []
	let offset = start
	for (let i = 0; i < count; i += 1) {
		if (offset + 2 > bytes.byteLength) {
			throw new Error('Invalid DOS save state')
		}
		const pathLen = view.getUint16(offset, true)
		offset += 2
		if (offset + pathLen + 4 > bytes.byteLength) {
			throw new Error('Invalid DOS save state')
		}
		const path = decoder.decode(bytes.subarray(offset, offset + pathLen))
		offset += pathLen
		const dataLen = view.getUint32(offset, true)
		offset += 4
		if (offset + dataLen > bytes.byteLength) {
			throw new Error('Invalid DOS save state')
		}
		files.push({ path, data: bytes.slice(offset, offset + dataLen) })
		offset += dataLen
	}
	return { files, offset }
}

export function packDosSaveV2(
	heapLen: number,
	heapGzip: Uint8Array,
	files: DosSaveFile[],
	sdlTicks = 0,
): ArrayBuffer {
	const overlay = new Uint8Array(encodeDosSave(files))
	const size = 8 + 1 + 4 + 4 + heapGzip.byteLength + overlay.byteLength - 9 + 4
	const out = new Uint8Array(size)
	const view = new DataView(out.buffer)
	out.set(MAGIC, 0)
	out[8] = 2
	view.setUint32(9, heapLen, true)
	view.setUint32(13, heapGzip.byteLength, true)
	out.set(heapGzip, 17)
	const overlayStart = 17 + heapGzip.byteLength
	out.set(overlay.subarray(9), overlayStart)
	view.setUint32(overlayStart + overlay.byteLength - 9, sdlTicks, true)
	return out.buffer
}

export function packDosSaveV3(
	heapLen: number,
	heapGzip: Uint8Array,
	files: DosSaveFile[],
	sdlTicks: number,
): ArrayBuffer {
	const overlay = new Uint8Array(encodeDosSave(files))
	const size = 8 + 1 + 4 + 4 + 4 + heapGzip.byteLength + overlay.byteLength - 9
	const out = new Uint8Array(size)
	const view = new DataView(out.buffer)
	out.set(MAGIC, 0)
	out[8] = 3
	view.setUint32(9, heapLen, true)
	view.setUint32(13, heapGzip.byteLength, true)
	view.setUint32(17, sdlTicks, true)
	out.set(heapGzip, 21)
	out.set(overlay.subarray(9), 21 + heapGzip.byteLength)
	return out.buffer
}

export function unpackDosSave(data: ArrayBuffer): DosSave {
	const bytes = new Uint8Array(data)
	assertMagic(bytes)
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const version = bytes[8]
	if (version === 1) {
		if (bytes.byteLength < 13) {
			throw new Error('Invalid DOS save state')
		}
		const count = view.getUint32(9, true)
		return { files: readFiles(bytes, view, 13, count).files, version: 1 }
	}
	if (version === 2) {
		if (bytes.byteLength < 17) {
			throw new Error('Invalid DOS save state')
		}
		const heapLen = view.getUint32(9, true)
		const gzipLen = view.getUint32(13, true)
		const gzipStart = 17
		const gzipEnd = gzipStart + gzipLen
		if (gzipEnd + 4 > bytes.byteLength) {
			throw new Error('Invalid DOS save state')
		}
		const count = view.getUint32(gzipEnd, true)
		const { files, offset } = readFiles(bytes, view, gzipEnd + 4, count)
		return {
			files,
			heapGzip: bytes.slice(gzipStart, gzipEnd),
			heapLen,
			sdlTicks: offset + 4 <= bytes.byteLength ? view.getUint32(offset, true) : undefined,
			version: 2,
		}
	}
	if (version !== 3) {
		throw new Error('Unsupported DOS save state version')
	}
	if (bytes.byteLength < 21) {
		throw new Error('Invalid DOS save state')
	}
	const heapLen = view.getUint32(9, true)
	const gzipLen = view.getUint32(13, true)
	const sdlTicks = view.getUint32(17, true)
	const gzipStart = 21
	const gzipEnd = gzipStart + gzipLen
	if (gzipEnd + 4 > bytes.byteLength) {
		throw new Error('Invalid DOS save state')
	}
	const count = view.getUint32(gzipEnd, true)
	return {
		files: readFiles(bytes, view, gzipEnd + 4, count).files,
		heapGzip: bytes.slice(gzipStart, gzipEnd),
		heapLen,
		sdlTicks,
		version: 3,
	}
}

export function decodeDosSave(data: ArrayBuffer): DosSaveFile[] {
	const unpacked = unpackDosSave(data)
	if (unpacked.version !== 1) {
		throw new Error('Unsupported DOS save state version')
	}
	return unpacked.files
}
