import { cx } from '@stump/components'
import { useLocaleContext } from '@stump/i18n'
import { Bookmark } from 'lucide-react'

import ControlButton from './ControlButton'
import { useEpubBookmark } from './useEpubBookmark'

export default function BookmarkToggle() {
	const { t } = useLocaleContext()
	const {
		createBookmark,
		deleteBookmark,
		isUnknownCfiRange,
		canBookmarkCurrent,
		currentIsBookmarked,
	} = useEpubBookmark()

	const handleClick = async () => {
		if (currentIsBookmarked) {
			deleteBookmark()
		} else if (canBookmarkCurrent) {
			createBookmark()
		}
	}

	const isDisabled = isUnknownCfiRange

	return (
		<ControlButton
			disabled={isDisabled}
			onClick={handleClick}
			title={currentIsBookmarked ? t('reader.removeBookmark') : t('reader.addBookmark')}
		>
			<Bookmark className={cx('h-4 w-4', { 'fill-current': currentIsBookmarked })} />
		</ControlButton>
	)
}
