import { Button, IconButton, Label, NativeSelect, Text } from '@stump/components'
import { useLocaleContext } from '@stump/i18n'
import { Minus, Pause, Play, Plus } from 'lucide-react'
import { useMemo } from 'react'

import { useEpubReaderControls } from '../context'

const clampRate = (value: number) => Math.min(2, Math.max(0.5, Math.round(value * 10) / 10))
const clampPitch = (value: number) => Math.min(2, Math.max(0, Math.round(value * 10) / 10))

export default function ReadAloudSettings() {
	const { t } = useLocaleContext()
	const {
		isReadAloudActive,
		isReadAloudPaused,
		onPauseReadAloud,
		onResumeReadAloud,
		onSetReadAloudEngine,
		onSetReadAloudPitch,
		onSetReadAloudRate,
		onSetReadAloudVoiceUri,
		readAloudCurrentSentence,
		readAloudEngine,
		readAloudPitch,
		readAloudRate,
		readAloudServerAvailable,
		readAloudSupported,
		readAloudVoiceUri,
		readAloudVoices,
	} = useEpubReaderControls()

	const engineOptions = useMemo(() => {
		const options = [{ label: t('reader.browserEngine'), value: 'browser' }]
		if (readAloudServerAvailable) {
			options.push({ label: t('reader.serverEngine'), value: 'server' })
		}
		return options
	}, [readAloudServerAvailable, t])

	const voiceOptions = useMemo(
		() => [{ label: t('reader.defaultVoice'), value: '' }, ...readAloudVoices],
		[readAloudVoices, t],
	)

	if (!readAloudSupported) {
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

			{readAloudServerAvailable && (
				<div className="space-y-1">
					<Label htmlFor="read-aloud-engine">{t('reader.engine')}</Label>
					<NativeSelect
						id="read-aloud-engine"
						size="sm"
						options={engineOptions}
						value={readAloudEngine}
						onChange={(e) =>
							onSetReadAloudEngine(e.target.value === 'server' ? 'server' : 'browser')
						}
					/>
				</div>
			)}

			<div className="space-y-1">
				<Label htmlFor="read-aloud-voice">{t('reader.voice')}</Label>
				<NativeSelect
					id="read-aloud-voice"
					size="sm"
					options={voiceOptions}
					value={readAloudVoiceUri || ''}
					onChange={(e) => onSetReadAloudVoiceUri(e.target.value || null)}
				/>
			</div>

			<div className="gap-y-2 flex flex-col">
				<Label>{t('reader.rate')}</Label>
				<div className="gap-x-2 flex items-center">
					<IconButton
						variant="ghost"
						size="xs"
						onClick={() => onSetReadAloudRate(clampRate(readAloudRate - 0.1))}
					>
						<Minus className="h-4 w-4" />
					</IconButton>
					<Text size="sm" className="min-w-10 text-center">
						{readAloudRate.toFixed(1)}x
					</Text>
					<IconButton
						variant="ghost"
						size="xs"
						onClick={() => onSetReadAloudRate(clampRate(readAloudRate + 0.1))}
					>
						<Plus className="h-4 w-4" />
					</IconButton>
				</div>
			</div>

			{readAloudEngine === 'browser' && (
				<div className="gap-y-2 flex flex-col">
					<Label>{t('reader.pitch')}</Label>
					<div className="gap-x-2 flex items-center">
						<IconButton
							variant="ghost"
							size="xs"
							onClick={() => onSetReadAloudPitch(clampPitch(readAloudPitch - 0.1))}
						>
							<Minus className="h-4 w-4" />
						</IconButton>
						<Text size="sm" className="min-w-10 text-center">
							{readAloudPitch.toFixed(1)}
						</Text>
						<IconButton
							variant="ghost"
							size="xs"
							onClick={() => onSetReadAloudPitch(clampPitch(readAloudPitch + 0.1))}
						>
							<Plus className="h-4 w-4" />
						</IconButton>
					</div>
				</div>
			)}

			<div className="gap-x-2 flex items-center">
				<Button
					disabled={!isReadAloudActive || isReadAloudPaused}
					size="sm"
					variant="ghost"
					onClick={onPauseReadAloud}
				>
					<Pause className="h-4 w-4" />
					Pause
				</Button>
				<Button
					disabled={!isReadAloudActive || !isReadAloudPaused}
					size="sm"
					variant="ghost"
					onClick={onResumeReadAloud}
				>
					<Play className="h-4 w-4" />
					Resume
				</Button>
			</div>

			{readAloudCurrentSentence && (
				<Text size="xs" variant="muted" className="line-clamp-2 italic">
					{readAloudCurrentSentence}
				</Text>
			)}
		</div>
	)
}
