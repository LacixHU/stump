import { Dialog, Heading } from '@stump/components'
import { useLocaleContext } from '@stump/i18n'
import { Paintbrush } from 'lucide-react'

import ControlButton from './ControlButton'
import FontFamily from './FontFamily'
import FontSizeControl from './FontSizeControl'
import LineHeightControl from './LineHeightControl'
import ReadAloudSettings from './ReadAloudSettings'
import ReadingDirection from './ReadingDirection'
import ReadingMode from './ReadingMode'

export default function ThemeControls() {
	const { t } = useLocaleContext()

	return (
		<Dialog>
			<Dialog.Trigger asChild>
				<ControlButton title={t('reader.themeAndOptions')}>
					<Paintbrush className="h-4 w-4" />
				</ControlButton>
			</Dialog.Trigger>

			{/* taller than the window: the options scroll, the header stays put */}
			<Dialog.Content
				size="md"
				className="gap-4 z-101 flex max-h-[calc(100dvh-2rem)] flex-col bg-dialog"
			>
				<Dialog.Header className="flex items-center justify-between">
					<Heading size="md">{t('reader.appearance')}</Heading>
					<Dialog.Close />
				</Dialog.Header>

				<div className="-mx-6 px-6 gap-4 min-h-0 flex flex-1 flex-col overflow-y-auto">
					<FontFamily />
					<FontSizeControl />
					<LineHeightControl />
					<ReadingDirection />
					<ReadingMode />

					<Heading size="md">{t('reader.readAloud')}</Heading>
					<ReadAloudSettings />
				</div>
			</Dialog.Content>
		</Dialog>
	)
}
