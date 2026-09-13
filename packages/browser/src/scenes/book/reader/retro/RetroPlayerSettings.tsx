import { Button, Dropdown } from '@stump/components'
import { Settings } from 'lucide-react'

import type { RetroDiskSpeed, RetroInputMode } from './emulators'

type RetroPlayerSettingsProps = {
	inputMode: RetroInputMode
	joystickPort: 1 | 2
	onInputMode: (mode: RetroInputMode) => void
	onJoystickPort: (port: 1 | 2) => void
	diskSpeed: RetroDiskSpeed
	onDiskSpeed: (speed: RetroDiskSpeed) => void
	canEditOverlay?: boolean
	onEditOverlay?: () => void
	t: (key: string, options?: Record<string, unknown>) => string
}

export function RetroPlayerSettings({
	inputMode,
	joystickPort,
	onInputMode,
	onJoystickPort,
	diskSpeed,
	onDiskSpeed,
	canEditOverlay,
	onEditOverlay,
	t,
}: RetroPlayerSettingsProps) {
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
				<Dropdown.Separator />
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
				<Dropdown.Separator />
				<Dropdown.Label>
					{t('reader.retro.diskSpeed', { defaultValue: 'Disk speed' })}
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
				{canEditOverlay ? (
					<>
						<Dropdown.Separator />
						<Dropdown.Item onSelect={() => onEditOverlay?.()}>
							{t('reader.retro.editOverlay', { defaultValue: 'Edit overlay' })}
						</Dropdown.Item>
					</>
				) : null}
			</Dropdown.Content>
		</Dropdown>
	)
}
