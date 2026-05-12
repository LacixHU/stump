import { Pause, Volume2, VolumeX } from 'lucide-react'

import { useEpubReaderControls } from '../context'
import ControlButton from './ControlButton'

export default function ReadAloudToggle() {
	const { isReadAloudActive, onToggleReadAloud, readAloudSupported } = useEpubReaderControls()
	const { isReadAloudPaused } = useEpubReaderControls()

	if (!readAloudSupported) {
		return null
	}

	return (
		<ControlButton
			title={isReadAloudActive ? 'Stop read aloud' : 'Read aloud'}
			onClick={onToggleReadAloud}
		>
			{!isReadAloudActive && <Volume2 className="h-4 w-4" />}
			{isReadAloudActive && isReadAloudPaused && <Pause className="h-4 w-4" />}
			{isReadAloudActive && !isReadAloudPaused && <VolumeX className="h-4 w-4" />}
		</ControlButton>
	)
}
