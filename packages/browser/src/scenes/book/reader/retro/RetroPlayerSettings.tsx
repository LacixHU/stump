import { Button, Dropdown } from '@stump/components'
import { Settings } from 'lucide-react'
import { Fragment, type ReactNode } from 'react'

import type { RetroPlayerCapabilities } from './capabilities'
import type { RetroDiskSpeed, RetroInputMode } from './emulators'

type RetroPlayerSettingsProps = {
	/** Which sections the running emulator can actually act on. */
	capabilities: RetroPlayerCapabilities
	inputMode: RetroInputMode
	joystickPort: 1 | 2
	onInputMode: (mode: RetroInputMode) => void
	onJoystickPort: (port: 1 | 2) => void
	diskSpeed: RetroDiskSpeed
	onDiskSpeed: (speed: RetroDiskSpeed) => void
	machine?: string
	onMachine: (id: string) => void
	joystickScheme?: string
	onJoystickScheme: (id: string) => void
	canEditOverlay?: boolean
	onEditOverlay?: () => void
	t: (key: string, options?: Record<string, unknown>) => string
}

export function RetroPlayerSettings({
	capabilities,
	inputMode,
	joystickPort,
	onInputMode,
	onJoystickPort,
	diskSpeed,
	onDiskSpeed,
	machine,
	onMachine,
	joystickScheme,
	onJoystickScheme,
	canEditOverlay,
	onEditOverlay,
	t,
}: RetroPlayerSettingsProps) {
	// Every section is optional, so the separators are drawn between whichever ones
	// survived rather than being part of any of them.
	const sections: Array<{ key: string; content: ReactNode }> = []

	if (capabilities.machines.length > 0) {
		sections.push({
			content: (
				<>
					<Dropdown.Label>{t('reader.retro.machine', { defaultValue: 'Machine' })}</Dropdown.Label>
					<Dropdown.RadioGroup value={machine ?? ''} onValueChange={onMachine}>
						{capabilities.machines.map((option) => (
							<Dropdown.RadioItem key={option.id} value={option.id}>
								{option.label}
							</Dropdown.RadioItem>
						))}
					</Dropdown.RadioGroup>
				</>
			),
			key: 'machine',
		})
	}

	if (capabilities.inputMode) {
		sections.push({
			content: (
				<>
					<Dropdown.Label>
						{t('reader.retro.inputMode', { defaultValue: 'Input mode' })}
					</Dropdown.Label>
					<Dropdown.RadioGroup
						value={inputMode}
						onValueChange={(value: string) => onInputMode(value as RetroInputMode)}
					>
						<Dropdown.RadioItem value="mixed">
							{t('reader.retro.inputModeMixed', { defaultValue: 'Mixed' })}
						</Dropdown.RadioItem>
						<Dropdown.RadioItem value="keyboard">
							{t('reader.retro.inputModeKeyboard', { defaultValue: 'Keyboard' })}
						</Dropdown.RadioItem>
						<Dropdown.RadioItem value="joystick">
							{t('reader.retro.inputModeJoystick', { defaultValue: 'Joystick' })}
						</Dropdown.RadioItem>
					</Dropdown.RadioGroup>
				</>
			),
			key: 'input-mode',
		})
	}

	if (capabilities.joystickPort) {
		sections.push({
			content: (
				<>
					<Dropdown.Label>
						{t('reader.retro.joystickPort', { defaultValue: 'Joystick port' })}
					</Dropdown.Label>
					<Dropdown.RadioGroup
						value={String(joystickPort)}
						onValueChange={(value: string) => onJoystickPort(value === '1' ? 1 : 2)}
					>
						<Dropdown.RadioItem value="1">
							{t('reader.retro.port1', { defaultValue: 'Port 1' })}
						</Dropdown.RadioItem>
						<Dropdown.RadioItem value="2">
							{t('reader.retro.port2', { defaultValue: 'Port 2' })}
						</Dropdown.RadioItem>
					</Dropdown.RadioGroup>
				</>
			),
			key: 'joystick-port',
		})
	}

	if (capabilities.joystickSchemes.length > 0) {
		sections.push({
			content: (
				<>
					{/* A Spectrum has no joystick port at all: the stick presses whichever keys the
					    game was written for. */}
					<Dropdown.Label>
						{t('reader.retro.joystickKeys', { defaultValue: 'Joystick keys' })}
					</Dropdown.Label>
					<Dropdown.RadioGroup value={joystickScheme ?? ''} onValueChange={onJoystickScheme}>
						{capabilities.joystickSchemes.map((option) => (
							<Dropdown.RadioItem key={option.id} value={option.id}>
								{option.label}
							</Dropdown.RadioItem>
						))}
					</Dropdown.RadioGroup>
				</>
			),
			key: 'joystick-keys',
		})
	}

	if (capabilities.loadSpeed) {
		sections.push({
			content: (
				<>
					<Dropdown.Label>
						{t('reader.retro.loadSpeed', { defaultValue: 'Loading speed' })}
					</Dropdown.Label>
					<Dropdown.RadioGroup
						value={diskSpeed}
						onValueChange={(value: string) => onDiskSpeed(value as RetroDiskSpeed)}
					>
						<Dropdown.RadioItem value="instant">
							{t('reader.retro.diskSpeedInstant', { defaultValue: 'Instant' })}
						</Dropdown.RadioItem>
						<Dropdown.RadioItem value="authentic">
							{t('reader.retro.diskSpeedAuthentic', { defaultValue: 'Authentic' })}
						</Dropdown.RadioItem>
					</Dropdown.RadioGroup>
				</>
			),
			key: 'load-speed',
		})
	}

	if (canEditOverlay) {
		sections.push({
			content: (
				<Dropdown.Item onSelect={() => onEditOverlay?.()}>
					{t('reader.retro.editOverlay', { defaultValue: 'Edit overlay' })}
				</Dropdown.Item>
			),
			key: 'edit-overlay',
		})
	}

	return (
		<Dropdown modal={false}>
			<Dropdown.Trigger asChild>
				<Button
					size="sm"
					variant="ghost"
					title={t('reader.retro.settings', { defaultValue: 'Settings' })}
				>
					<Settings className="h-4 w-4" />
				</Button>
			</Dropdown.Trigger>
			<Dropdown.Content align="end" className="w-52">
				{sections.map((section, index) => (
					<Fragment key={section.key}>
						{index > 0 ? <Dropdown.Separator /> : null}
						{section.content}
					</Fragment>
				))}
			</Dropdown.Content>
		</Dropdown>
	)
}
