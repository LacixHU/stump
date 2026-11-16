import { Dialog, Tabs } from '@stump/components'
import { useLocaleContext } from '@stump/i18n'
import { Settings2 } from 'lucide-react'
import { useState } from 'react'

import { useImageBaseReaderContext } from '../context'
import ControlButton from './ControlButton'
import ReaderSettings from './ReaderSettings'

export default function SettingsDialog() {
	const { book, currentPage, extension } = useImageBaseReaderContext()
	const { t } = useLocaleContext()

	const [modality, setModality] = useState<'book' | 'global'>('book')

	return (
		<Dialog>
			<Dialog.Trigger asChild>
				<ControlButton>
					<Settings2 className="h-4 w-4" />
				</ControlButton>
			</Dialog.Trigger>

			<Dialog.Content
				size="md"
				// taller than the window: the settings scroll, the tabs and close button stay put
				className="gap-4 z-101 flex max-h-[calc(100dvh-2rem)] flex-col bg-dialog text-dialog-foreground"
			>
				<Dialog.Header className="flex items-center justify-end">
					<Dialog.Close />
				</Dialog.Header>

				<Tabs
					value={modality}
					defaultValue="book"
					onValueChange={(value) => setModality(value as 'book' | 'global')}
				>
					<Tabs.List>
						<Tabs.Trigger value="book">{t('reader.tabs.book')}</Tabs.Trigger>
						<Tabs.Trigger value="global">{t('reader.tabs.global')}</Tabs.Trigger>
					</Tabs.List>
				</Tabs>

				<div className="-mx-6 px-6 gap-4 min-h-0 flex flex-1 flex-col overflow-y-auto">
					<ReaderSettings
						forBook={modality === 'book' ? book.id : undefined}
						currentPage={modality === 'book' ? currentPage : undefined}
					/>

					{extension?.settings}
				</div>
			</Dialog.Content>
		</Dialog>
	)
}
