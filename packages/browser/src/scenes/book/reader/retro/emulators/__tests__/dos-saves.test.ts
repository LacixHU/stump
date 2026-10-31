import { TextDecoder, TextEncoder } from 'util'

import {
	decodeDosSave,
	encodeDosSave,
	isDosFileChanged,
	packDosSaveV2,
	packDosSaveV3,
	packDosSaveV4,
	selectChangedPaths,
	shouldSkipDosPath,
	unpackDosSave,
} from '../dos-saves'

Object.assign(global, { TextDecoder, TextEncoder })

describe('DOS save overlay', () => {
	it('skips emscripten device paths and the js-dos marker', () => {
		expect(shouldSkipDosPath('/dev/tty')).toBe(true)
		expect(shouldSkipDosPath('/tmp/foo')).toBe(true)
		expect(shouldSkipDosPath('/proc')).toBe(true)
		expect(shouldSkipDosPath('/state.fs')).toBe(true)
		expect(shouldSkipDosPath('/game/state.fs')).toBe(true)
		expect(shouldSkipDosPath('/DOOM.SAV')).toBe(false)
		expect(shouldSkipDosPath('/GAMES/PRINCE.SAV')).toBe(false)
	})

	it('treats new or resized files as changed', () => {
		expect(isDosFileChanged(undefined, { size: 10, mtimeMs: 1 })).toBe(true)
		expect(isDosFileChanged({ size: 10, mtimeMs: 1 }, { size: 10, mtimeMs: 1 })).toBe(false)
		expect(isDosFileChanged({ size: 10, mtimeMs: 1 }, { size: 11, mtimeMs: 1 })).toBe(true)
		expect(isDosFileChanged({ size: 10, mtimeMs: 1 }, { size: 10, mtimeMs: 2 })).toBe(true)
	})

	it('selects only paths that differ from the baseline', () => {
		const baseline = new Map([
			['/GAME.EXE', { size: 100, mtimeMs: 1 }],
			['/DOOM.SAV', { size: 20, mtimeMs: 1 }],
		])
		const current = new Map([
			['/GAME.EXE', { size: 100, mtimeMs: 1 }],
			['/DOOM.SAV', { size: 24, mtimeMs: 2 }],
			['/NEW.SAV', { size: 8, mtimeMs: 3 }],
		])
		expect(selectChangedPaths(baseline, current).sort()).toEqual(['/DOOM.SAV', '/NEW.SAV'])
	})

	it('round-trips overlay files', () => {
		const files = [
			{ path: '/DOOM.SAV', data: new Uint8Array([1, 2, 3, 4]) },
			{ path: '/GAMES/HI.SCO', data: new Uint8Array([9, 8]) },
		]
		const decoded = decodeDosSave(encodeDosSave(files))
		expect(decoded.map((file) => file.path)).toEqual(['/DOOM.SAV', '/GAMES/HI.SCO'])
		expect(Array.from(decoded[0]!.data)).toEqual([1, 2, 3, 4])
		expect(Array.from(decoded[1]!.data)).toEqual([9, 8])
	})

	it('rejects truncated or foreign bytes', () => {
		expect(() => decodeDosSave(new ArrayBuffer(4))).toThrow('Invalid DOS save state')
		expect(() =>
			decodeDosSave(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]).buffer),
		).toThrow('Invalid DOS save state')
	})

	it('round-trips a memory snapshot plus overlay files', () => {
		const gzip = new Uint8Array([0x1f, 0x8b, 1, 2, 3])
		const files = [{ path: '/DOOM.SAV', data: new Uint8Array([9, 8, 7]) }]
		const unpacked = unpackDosSave(packDosSaveV3(64, gzip, files, 12345))
		expect(unpacked.version).toBe(3)
		if (unpacked.version !== 3) return
		expect(unpacked.heapLen).toBe(64)
		expect(unpacked.sdlTicks).toBe(12345)
		expect(Array.from(unpacked.heapGzip)).toEqual([0x1f, 0x8b, 1, 2, 3])
		expect(unpacked.files[0]!.path).toBe('/DOOM.SAV')
		expect(Array.from(unpacked.files[0]!.data)).toEqual([9, 8, 7])
	})

	it('round-trips the SDL screen and surface pointers with a snapshot', () => {
		const gzip = new Uint8Array([0x1f, 0x8b, 4, 5])
		const files = [{ path: '/LORE.SAV', data: new Uint8Array([1, 2, 3, 4]) }]
		const video = { screen: 446614312, surfaces: [446662296, 31216280] }
		const unpacked = unpackDosSave(packDosSaveV4(128, gzip, files, 777, video))
		expect(unpacked.version).toBe(4)
		if (unpacked.version !== 4) return
		expect(unpacked.heapLen).toBe(128)
		expect(unpacked.sdlTicks).toBe(777)
		expect(unpacked.video).toEqual(video)
		expect(Array.from(unpacked.heapGzip)).toEqual([0x1f, 0x8b, 4, 5])
		expect(unpacked.files[0]!.path).toBe('/LORE.SAV')
		expect(Array.from(unpacked.files[0]!.data)).toEqual([1, 2, 3, 4])
	})

	it('round-trips a v4 snapshot that has no surfaces', () => {
		const unpacked = unpackDosSave(
			packDosSaveV4(8, new Uint8Array([1]), [], 5, { screen: 0, surfaces: [] }),
		)
		expect(unpacked.version).toBe(4)
		if (unpacked.version !== 4) return
		expect(unpacked.video).toEqual({ screen: 0, surfaces: [] })
		expect(unpacked.files).toEqual([])
	})

	it('rejects a truncated v4 snapshot', () => {
		const packed = new Uint8Array(
			packDosSaveV4(8, new Uint8Array([1, 2, 3]), [], 5, { screen: 9, surfaces: [1, 2] }),
		)
		const cut = packed.subarray(0, 30)
		expect(() =>
			unpackDosSave(cut.buffer.slice(cut.byteOffset, cut.byteOffset + cut.byteLength)),
		).toThrow('Invalid DOS save state')
	})

	it('still reads a v2 snapshot with trailing ticks', () => {
		const unpacked = unpackDosSave(packDosSaveV2(64, new Uint8Array([0x1f, 0x8b, 1]), [], 99))
		expect(unpacked.version).toBe(2)
		if (unpacked.version !== 2) return
		expect(unpacked.sdlTicks).toBe(99)
	})

	it('treats a v2 snapshot without ticks as legacy', () => {
		const packed = new Uint8Array(packDosSaveV2(8, new Uint8Array([1, 2]), []))
		const legacy = packed.subarray(0, packed.byteLength - 4)
		const unpacked = unpackDosSave(
			legacy.buffer.slice(legacy.byteOffset, legacy.byteOffset + legacy.byteLength),
		)
		expect(unpacked.version).toBe(2)
		if (unpacked.version !== 2) return
		expect(unpacked.sdlTicks).toBeUndefined()
	})
})
