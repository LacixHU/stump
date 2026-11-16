import { Button, IconButton, Label, NativeSelect, Text } from '@stump/components'
import { useLocaleContext } from '@stump/i18n'
import { Minus, Pause, Play, Plus } from 'lucide-react'
import { useMemo } from 'react'

import type { ReadAloudEngine, ReadAloudVoiceOption } from './useReadAloud'

const clampRate = (value: number) => Math.min(2, Math.max(0.5, Math.round(value * 10) / 10))
const clampPitch = (value: number) => Math.min(2, Math.max(0, Math.round(value * 10) / 10))

export type ReadAloudSettingsPanelProps = {
	supported: boolean
	serverAvailable: boolean
	engine: ReadAloudEngine
	voices: ReadAloudVoiceOption[]
	voiceUri: string | null
	rate: number
	pitch: number
	isActive: boolean
	isPaused: boolean
	currentSentence?: string | null
	onSetEngine: (engine: ReadAloudEngine) => void
	onSetVoiceUri: (voiceUri: string | null) => void
	onSetRate: (rate: number) => void
	onSetPitch: (pitch: number) => void
	onPause: () => void
	onResume: () => void
}

/**
 * Read aloud settings (engine, voice, rate, pitch) and playback, shared by the readers
 */
export default function ReadAloudSettingsPanel({
	supported,
	serverAvailable,
	engine,
	voices,
	voiceUri,
	rate,
	pitch,
	isActive,
	isPaused,
	currentSentence,
	onSetEngine,
	onSetVoiceUri,
	onSetRate,
	onSetPitch,
	onPause,
	onResume,
}: ReadAloudSettingsPanelProps) {
	const { t } = useLocaleContext()

	const engineOptions = useMemo(() => {
		const options = [{ label: t('reader.browserEngine'), value: 'browser' }]
		if (serverAvailable) {
			options.push({ label: t('reader.serverEngine'), value: 'server' })
		}
		return options
	}, [serverAvailable, t])

	const voiceOptions = useMemo(
		() => [{ label: t('reader.defaultVoice'), value: '' }, ...voices],
		[voices, t],
	)

	if (!supported) {
		return (
			<div className="space-y-1.5 py-1.5">
				<Label>{t('reader.readAloud')}</Label>
				<Text size="sm" variant="muted">
					{t('reader.toasts.readAloudUnsupported')}
				</Text>
			</div>
		)
	}

	return (
		<div className="gap-y-3 py-1.5 flex flex-col">
			<Label>{t('reader.readAloud')}</Label>

			{serverAvailable && (
				<div className="space-y-1">
					<Label htmlFor="read-aloud-engine">{t('reader.engine')}</Label>
					<NativeSelect
						id="read-aloud-engine"
						size="sm"
						options={engineOptions}
						value={engine}
						onChange={(e) => onSetEngine(e.target.value === 'server' ? 'server' : 'browser')}
					/>
				</div>
			)}

			<div className="space-y-1">
				<Label htmlFor="read-aloud-voice">{t('reader.voice')}</Label>
				<NativeSelect
					id="read-aloud-voice"
					size="sm"
					options={voiceOptions}
					value={voiceUri || ''}
					onChange={(e) => onSetVoiceUri(e.target.value || null)}
				/>
			</div>

			<div className="gap-y-2 flex flex-col">
				<Label>{t('reader.rate')}</Label>
				<div className="gap-x-2 flex items-center">
					<IconButton variant="ghost" size="xs" onClick={() => onSetRate(clampRate(rate - 0.1))}>
						<Minus className="h-4 w-4" />
					</IconButton>
					<Text size="sm" className="min-w-10 text-center">
						{rate.toFixed(1)}x
					</Text>
					<IconButton variant="ghost" size="xs" onClick={() => onSetRate(clampRate(rate + 0.1))}>
						<Plus className="h-4 w-4" />
					</IconButton>
				</div>
			</div>

			{engine === 'browser' && (
				<div className="gap-y-2 flex flex-col">
					<Label>{t('reader.pitch')}</Label>
					<div className="gap-x-2 flex items-center">
						<IconButton
							variant="ghost"
							size="xs"
							onClick={() => onSetPitch(clampPitch(pitch - 0.1))}
						>
							<Minus className="h-4 w-4" />
						</IconButton>
						<Text size="sm" className="min-w-10 text-center">
							{pitch.toFixed(1)}
						</Text>
						<IconButton
							variant="ghost"
							size="xs"
							onClick={() => onSetPitch(clampPitch(pitch + 0.1))}
						>
							<Plus className="h-4 w-4" />
						</IconButton>
					</div>
				</div>
			)}

			<div className="gap-x-2 flex items-center">
				<Button disabled={!isActive || isPaused} size="sm" variant="ghost" onClick={onPause}>
					<Pause className="h-4 w-4" />
					Pause
				</Button>
				<Button disabled={!isActive || !isPaused} size="sm" variant="ghost" onClick={onResume}>
					<Play className="h-4 w-4" />
					Resume
				</Button>
			</div>

			{currentSentence && (
				<Text size="xs" variant="muted" className="line-clamp-2 italic">
					{currentSentence}
				</Text>
			)}
		</div>
	)
}
