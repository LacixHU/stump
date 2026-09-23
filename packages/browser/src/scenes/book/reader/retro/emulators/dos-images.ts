const RUN_BAT = ['autoexec.bat', 'start.bat', 'run.bat', 'play.bat']

export function basenameOf(fileName?: string): string {
	return (fileName || 'GAME.EXE').split(/[/\\]/).pop() || 'GAME.EXE'
}

export function extensionOf(fileName?: string): string {
	const name = basenameOf(fileName)
	const dot = name.lastIndexOf('.')
	return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function toDos83(fileName: string): string {
	const name = basenameOf(fileName)
	const dot = name.lastIndexOf('.')
	const rawStem = (dot >= 0 ? name.slice(0, dot) : name).toUpperCase()
	const rawExt = (dot >= 0 ? name.slice(dot + 1) : '').toUpperCase()
	const stem = (rawStem.replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'GAME').padEnd(1)
	const ext = rawExt.replace(/[^A-Z0-9]/g, '').slice(0, 3)
	return ext ? `${stem}.${ext}` : stem
}

export function isZipBytes(bytes: Uint8Array): boolean {
	return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
}

export function zipEntryNames(bytes: Uint8Array): string[] {
	const names: string[] = []
	let offset = 0
	while (offset + 46 < bytes.length) {
		if (
			bytes[offset] !== 0x50 ||
			bytes[offset + 1] !== 0x4b ||
			bytes[offset + 2] !== 0x01 ||
			bytes[offset + 3] !== 0x02
		) {
			offset += 1
			continue
		}
		const nameLen = bytes[offset + 28]! | (bytes[offset + 29]! << 8)
		const extraLen = bytes[offset + 30]! | (bytes[offset + 31]! << 8)
		const commentLen = bytes[offset + 32]! | (bytes[offset + 33]! << 8)
		const nameStart = offset + 46
		const nameEnd = nameStart + nameLen
		if (nameEnd > bytes.length) break
		const name = String.fromCharCode(...bytes.subarray(nameStart, nameEnd)).replace(/\\/g, '/')
		if (name && !name.endsWith('/')) names.push(name)
		offset = nameEnd + extraLen + commentLen
	}
	return names
}

/**
 * Directories implied by `names`, outermost first.
 *
 * Most zips carry no explicit directory entries, and the js-dos extractor opens every file
 * without creating its parent, so the tree has to exist before extraction starts.
 */
export function zipDirectories(names: string[]): string[] {
	const dirs = new Set<string>()
	for (const name of names) {
		const parts = name.split('/').filter(Boolean)
		parts.pop()
		let current = ''
		for (const part of parts) {
			current = current ? `${current}/${part}` : part
			dirs.add(current)
		}
	}
	return [...dirs].sort((a, b) => a.split('/').length - b.split('/').length)
}

export function findDosboxConf(names: string[]): string | null {
	const confs = names
		.map((name) => name.replace(/\\/g, '/').replace(/^\.\//, ''))
		.filter((name) => basenameOf(name).toLowerCase() === 'dosbox.conf')
	if (!confs.length) return null
	const jsdos = confs.find((name) => {
		const lower = name.toLowerCase()
		return lower === '.jsdos/dosbox.conf' || lower === 'jsdos/dosbox.conf'
	})
	if (jsdos) return jsdos
	const root = confs.find((name) => !name.includes('/'))
	if (root) return root
	return [...confs].sort((a, b) => a.split('/').length - b.split('/').length)[0] ?? null
}

/** Written before a bundle `dosbox.conf` so `[autoexec]` runs after `C:` is mounted. */
export const STUMP_DOS_MOUNT_CONF = 'stump-mount.conf'

export const STUMP_DOS_MOUNT_CONF_BODY = '[autoexec]\nmount c .\nc:\n'

export const STUMP_DOS_INPUT_CONF = 'stump-input.conf'

/**
 * Bundles made for desktop DOSBox often ship `autolock=true`. DOSBox then drops every mouse
 * motion until a click captures the mouse, and releases it again on blur — touch drags never
 * reach the game, and the unlocked absolute path the player drives is switched off.
 */
export const STUMP_DOS_INPUT_CONF_BODY = '[sdl]\nautolock=false\n'

/**
 * js-dos always appends `-c mount c . -c c:` *after* conf `[autoexec]`.
 * A first `-conf` whose autoexec mounts `C:` runs before the bundle conf.
 * Later confs override earlier ones, so the input conf goes last.
 */
export function dosboxConfMainArgs(confPath: string): string[] {
	return ['-conf', STUMP_DOS_MOUNT_CONF, '-conf', confPath, '-conf', STUMP_DOS_INPUT_CONF]
}

export function pickRunnable(names: string[], archiveStem?: string): string | null {
	const files = names
		.map((name) => name.split('/').pop() || name)
		.filter((name) => !name.startsWith('.'))
	const lower = files.map((name) => name.toLowerCase())
	for (const bat of RUN_BAT) {
		const index = lower.indexOf(bat)
		if (index >= 0) return toDos83(files[index]!)
	}
	const programs = files.filter((name) => /\.(exe|com)$/i.test(name))
	if (programs.length === 1) return toDos83(programs[0]!)
	if (archiveStem) {
		const stem = archiveStem.replace(/[^A-Za-z0-9]/g, '').toLowerCase()
		const match = programs.find((name) =>
			name
				.replace(/\.(exe|com)$/i, '')
				.replace(/[^A-Za-z0-9]/g, '')
				.toLowerCase()
				.startsWith(stem.slice(0, 8)),
		)
		if (match) return toDos83(match)
	}
	if (programs[0]) return toDos83(programs[0])
	return null
}
