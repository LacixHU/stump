import {
	basenameOf,
	dosboxConfMainArgs,
	extensionOf,
	findDosboxConf,
	isZipBytes,
	pickRunnable,
	STUMP_DOS_MOUNT_CONF,
	toDos83,
	zipDirectories,
	zipEntryNames,
} from '../dos-images'

describe('DOS image helpers', () => {
	it('normalises 8.3 names', () => {
		expect(toDos83('Prince of Persia.exe')).toBe('PRINCEOF.EXE')
		expect(toDos83('game.ima')).toBe('GAME.IMA')
		expect(toDos83('DOOM.EXE')).toBe('DOOM.EXE')
	})

	it('reads basename and extension', () => {
		expect(basenameOf('C:\\GAMES\\DOOM.EXE')).toBe('DOOM.EXE')
		expect(extensionOf('pack.dosz')).toBe('dosz')
	})

	it('derives the directories a zip only implies, outermost first', () => {
		expect(zipDirectories(['CWSDPMI.EXE', 'ID1/CONFIG.CFG', 'ID1/PAK0.PAK', 'QUAKE.EXE'])).toEqual([
			'ID1',
		])
		expect(zipDirectories(['a/b/c/game.exe', 'a/readme.txt'])).toEqual(['a', 'a/b', 'a/b/c'])
		expect(zipDirectories(['GAME.EXE'])).toEqual([])
	})

	it('picks AUTOEXEC.BAT over a random EXE', () => {
		expect(pickRunnable(['GAME.EXE', 'AUTOEXEC.BAT'], 'pack')).toBe('AUTOEXEC.BAT')
	})

	it('picks the archive stem when several EXEs exist', () => {
		expect(pickRunnable(['SETUP.EXE', 'DOOM.EXE', 'IPXSETUP.EXE'], 'doom')).toBe('DOOM.EXE')
	})

	it('detects zip magic and lists central-directory names', () => {
		expect(isZipBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe(true)
		const name = 'GAME.EXE'
		const header = new Uint8Array(46 + name.length)
		header[0] = 0x50
		header[1] = 0x4b
		header[2] = 0x01
		header[3] = 0x02
		header[28] = name.length
		header[29] = 0
		for (let i = 0; i < name.length; i += 1) header[46 + i] = name.charCodeAt(i)
		expect(zipEntryNames(header)).toEqual(['GAME.EXE'])
	})

	it('prefers .jsdos/dosbox.conf then a root dosbox.conf', () => {
		expect(findDosboxConf(['GAME.EXE', '.jsdos/dosbox.conf', 'dosbox.conf'])).toBe(
			'.jsdos/dosbox.conf',
		)
		expect(findDosboxConf(['GAME.EXE', 'dosbox.conf'])).toBe('dosbox.conf')
		expect(findDosboxConf(['game/dosbox.conf', 'game/DOOM.EXE'])).toBe('game/dosbox.conf')
		expect(findDosboxConf(['GAME.EXE', 'AUTOEXEC.BAT'])).toBeNull()
	})

	it('loads a mount conf before the bundle dosbox.conf so autoexec sees C:', () => {
		expect(dosboxConfMainArgs('dosbox.conf')).toEqual([
			'-conf',
			STUMP_DOS_MOUNT_CONF,
			'-conf',
			'dosbox.conf',
		])
	})
})
