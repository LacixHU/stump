import type { RetroEmulatorHandle, RetroOption } from './emulators'

/**
 * What the player chrome offers, asked of the running emulator rather than assumed from
 * the platform.
 *
 * The machines differ in more than their key layout: a C64 has two joystick ports and a
 * 1541 to race past, a Spectrum has neither but three machine variants and no snapshot
 * writer. Reading the handle keeps that knowledge in the emulator module that owns it, and
 * keeps a control from appearing above an emulator that would ignore it.
 */
export type RetroPlayerCapabilities = {
	inputMode: boolean
	joystickPort: boolean
	loadSpeed: boolean
	reset: boolean
	saveState: boolean
	machines: readonly RetroOption[]
	joystickSchemes: readonly RetroOption[]
}

export const NO_CAPABILITIES: RetroPlayerCapabilities = {
	inputMode: false,
	joystickPort: false,
	joystickSchemes: [],
	loadSpeed: false,
	machines: [],
	reset: false,
	saveState: false,
}

export function describeCapabilities(handle: RetroEmulatorHandle): RetroPlayerCapabilities {
	return {
		inputMode: !!handle.setInputMode,
		joystickPort: !!handle.setJoystickPort,
		joystickSchemes: handle.setJoystickScheme ? (handle.joystickSchemes ?? []) : [],
		loadSpeed: !!handle.setDiskSpeed,
		machines: handle.setMachine ? (handle.machines ?? []) : [],
		reset: !!handle.reset,
		saveState: !!handle.saveState && !!handle.loadState,
	}
}

/** Whether the settings menu would have anything in it at all. */
export function hasSettings(
	capabilities: RetroPlayerCapabilities,
	canEditOverlay: boolean,
): boolean {
	return (
		capabilities.inputMode ||
		capabilities.joystickPort ||
		capabilities.loadSpeed ||
		capabilities.machines.length > 0 ||
		capabilities.joystickSchemes.length > 0 ||
		canEditOverlay
	)
}
