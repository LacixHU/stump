import { useLocaleContext } from '@stump/i18n'
import { Fullscreen, Shrink } from 'lucide-react'
import { useEffect } from 'react'
import { useFullscreen } from 'rooks'

import { useEpubReaderControls } from '../context'
import ControlButton from './ControlButton'

export default function FullScreenToggle() {
	const { t } = useLocaleContext()
	const { fullscreen, setFullscreen } = useEpubReaderControls()
	const { isFullscreenAvailable, isFullscreenEnabled, toggleFullscreen } = useFullscreen()

	useEffect(() => {
		if (isFullscreenAvailable) {
			setFullscreen(isFullscreenEnabled)
		}
	}, [isFullscreenAvailable, isFullscreenEnabled, setFullscreen])

	const isActive = isFullscreenAvailable ? isFullscreenEnabled : fullscreen
	const FullScreenIcon = isActive ? Shrink : Fullscreen

	const handleClick = () => {
		if (isFullscreenAvailable) {
			void toggleFullscreen()
			return
		}

		setFullscreen(!fullscreen)
	}

	return (
		<ControlButton
			title={isActive ? t('reader.exitFullscreen') : t('reader.enterFullscreen')}
			onClick={handleClick}
		>
			<FullScreenIcon className="h-4 w-4" />
		</ControlButton>
	)
}
