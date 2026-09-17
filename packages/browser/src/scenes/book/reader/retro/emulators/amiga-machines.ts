import type { RetroOption } from './types'

export const AMIGA_KICKSTART_FILES = ['kick33180.A500', 'kick34005.A500'] as const

export const AMIGA_OPTIONAL_KICKSTART_FILES = ['kick39106.A1200', 'kick40068.A1200'] as const

export type AmigaHardware = {
	agnus: string
	denise: string
	chip: string
	slow: string
	fast: string
	cpu: string
	clock: string
}

export type AmigaMachine = RetroOption & {
	kickstart: string
	hardware: AmigaHardware
}

const A500: AmigaHardware = {
	agnus: 'OCS',
	chip: '512',
	clock: '0',
	cpu: '0',
	denise: 'OCS',
	fast: '0',
	slow: '512',
}

const A1200: AmigaHardware = {
	agnus: 'AGA',
	chip: '2048',
	clock: '2',
	cpu: '2',
	denise: 'AGA',
	fast: '8192',
	slow: '0',
}

export const AMIGA_MACHINES: readonly AmigaMachine[] = [
	{
		hardware: A500,
		id: 'kick34005.A500',
		kickstart: 'kick34005.A500',
		label: 'A500 Kickstart 1.3',
	},
	{
		hardware: A500,
		id: 'kick33180.A500',
		kickstart: 'kick33180.A500',
		label: 'A500 Kickstart 1.2',
	},
	{
		hardware: A1200,
		id: 'kick40068.A1200',
		kickstart: 'kick40068.A1200',
		label: 'A1200 Kickstart 3.1',
	},
	{
		hardware: A1200,
		id: 'kick39106.A1200',
		kickstart: 'kick39106.A1200',
		label: 'A1200 Kickstart 3.0',
	},
]

export const DEFAULT_MACHINE = 'kick34005.A500'

export function availableMachines(firmware?: Record<string, ArrayBuffer>): AmigaMachine[] {
	return AMIGA_MACHINES.filter((machine) => firmware?.[machine.kickstart])
}

export function machineById(id: string): AmigaMachine | undefined {
	return AMIGA_MACHINES.find((machine) => machine.id === id)
}

export function defaultMachineId(
	fileName: string | undefined,
	available: readonly AmigaMachine[],
): string {
	if (!available.length) return DEFAULT_MACHINE
	const hint = (fileName || '').toLowerCase()
	if (/\b(aga|a1200)\b/.test(hint)) {
		const a1200 = available.find((machine) => machine.hardware.agnus === 'AGA')
		if (a1200) return a1200.id
	}
	return available.find((machine) => machine.id === DEFAULT_MACHINE)?.id ?? available[0].id
}

export function hardwareConfigLines(hardware: AmigaHardware): string {
	return [
		`AGNUS_REVISION=${hardware.agnus}`,
		`DENISE_REVISION=${hardware.denise}`,
		`CHIP_RAM=${hardware.chip}`,
		`SLOW_RAM=${hardware.slow}`,
		`FAST_RAM=${hardware.fast}`,
		`CPU_REVISION=${hardware.cpu}`,
		`CPU_OVERCLOCKING=${hardware.clock}`,
	].join('\n')
}
