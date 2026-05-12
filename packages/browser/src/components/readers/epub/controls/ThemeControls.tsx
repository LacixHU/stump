import { Dialog, Heading } from '@stump/components'
import { Paintbrush } from 'lucide-react'

import ControlButton from './ControlButton'
import FontFamily from './FontFamily'
import FontSizeControl from './FontSizeControl'
import LineHeightControl from './LineHeightControl'
import ReadAloudSettings from './ReadAloudSettings'
import ReadingDirection from './ReadingDirection'
import ReadingMode from './ReadingMode'

export default function ThemeControls() {
	return (
		<Dialog>
			<Dialog.Trigger asChild>
				<ControlButton title="Theme and options">
					<Paintbrush className="h-4 w-4" />
				</ControlButton>
			</Dialog.Trigger>

			<Dialog.Content size="md" className="gap-4 z-101 flex flex-col bg-background-surface">
				<Heading size="md">Appearance</Heading>

				<FontFamily />
				<FontSizeControl />
				<LineHeightControl />
				<ReadingDirection />
				<ReadingMode />

				<Heading size="md">Read aloud</Heading>
				<ReadAloudSettings />
			</Dialog.Content>
		</Dialog>
	)
}
