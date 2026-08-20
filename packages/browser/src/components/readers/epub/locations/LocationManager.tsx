import { Dialog, Tabs, Text } from '@stump/components'
import { useLocaleContext } from '@stump/i18n'
import { List } from 'lucide-react'
import { useCallback, useState } from 'react'

import ControlButton from '../controls/ControlButton'
import Bookmarks from './Bookmarks'
import TableOfContents from './TableOfContents'

type LocationTab = 'contents' | 'annotations' | 'bookmarks'

export default function LocationManager() {
	const { t } = useLocaleContext()
	const [isOpen, setIsOpen] = useState(false)
	const [activeTab, setActiveTab] = useState<LocationTab>('contents')

	const handleTabChange = (tab: LocationTab) => setActiveTab(tab)
	const handleLocationChanged = useCallback(() => {
		setIsOpen(false)
	}, [])

	const renderTabContent = () => {
		if (activeTab === 'contents') {
			return <TableOfContents onLocationChanged={handleLocationChanged} />
		} else if (activeTab === 'annotations') {
			return null
		} else if (activeTab === 'bookmarks') {
			return <Bookmarks onLocationChanged={handleLocationChanged} />
		}

		return null
	}

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<Dialog.Trigger asChild>
				<ControlButton title={t('reader.locationManager')}>
					<List className="h-4 w-4" />
				</ControlButton>
			</Dialog.Trigger>
			<Dialog.Content size="md">
				<Dialog.Header>
					<Tabs value={activeTab} variant="primary" activeOnHover>
						<Tabs.List className="border-none">
							<Tabs.Trigger value="contents" asChild onClick={() => handleTabChange('contents')}>
								<Text className="cursor-pointer truncate">{t('reader.contents')}</Text>
							</Tabs.Trigger>

							<Tabs.Trigger value="bookmarks" asChild onClick={() => handleTabChange('bookmarks')}>
								<Text className="cursor-pointer truncate">{t('reader.bookmarks')}</Text>
							</Tabs.Trigger>

							<Tabs.Trigger
								value="annotations"
								asChild
								onClick={() => handleTabChange('annotations')}
								disabled
							>
								<Text className="cursor-pointer truncate">{t('reader.annotations')}</Text>
							</Tabs.Trigger>
						</Tabs.List>
					</Tabs>

					<Dialog.Close onClick={() => setIsOpen(false)} />
				</Dialog.Header>
				<div className="scrollbar-hide h-[300px] overflow-y-auto">{renderTabContent()}</div>
			</Dialog.Content>
		</Dialog>
	)
}
