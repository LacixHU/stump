import {
	availableMachines,
	defaultMachineId,
	hardwareConfigLines,
	machineById,
} from '../amiga-machines'

const empty = new ArrayBuffer(0)

describe('Amiga machines', () => {
	it('hides A1200 until its Kickstart is present', () => {
		const machines = availableMachines({
			'kick33180.A500': empty,
			'kick34005.A500': empty,
		})
		expect(machines.map((machine) => machine.id)).toEqual(['kick34005.A500', 'kick33180.A500'])
	})

	it('lists A1200 Kickstarts when those files were fetched', () => {
		const machines = availableMachines({
			'kick33180.A500': empty,
			'kick34005.A500': empty,
			'kick40068.A1200': empty,
		})
		expect(machines.some((machine) => machine.id === 'kick40068.A1200')).toBe(true)
	})

	it('boots A1200 for AGA dumps when that Kickstart is available', () => {
		const machines = availableMachines({
			'kick34005.A500': empty,
			'kick40068.A1200': empty,
		})
		expect(defaultMachineId('Aladdin (1994)(Virgin)(AGA)(Disk 1 of 3).adf', machines)).toBe(
			'kick40068.A1200',
		)
	})

	it('keeps A500 as the default when the dump is not AGA', () => {
		const machines = availableMachines({
			'kick34005.A500': empty,
			'kick40068.A1200': empty,
		})
		expect(defaultMachineId('Lemmings.adf', machines)).toBe('kick34005.A500')
	})

	it('configures AGA chipset, 2MB chip, and 68020 for A1200', () => {
		const hardware = machineById('kick40068.A1200')?.hardware
		expect(hardware).toMatchObject({
			agnus: 'AGA',
			chip: '2048',
			cpu: '2',
			denise: 'AGA',
			fast: '8192',
			slow: '0',
		})
		expect(hardwareConfigLines(hardware!)).toContain('AGNUS_REVISION=AGA')
	})
})
