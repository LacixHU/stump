import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { cn, IconButton, Text } from '@stump/components'
import { HomeSectionKind } from '@stump/graphql'
import { useLocaleContext } from '@stump/i18n'
import { Eye, EyeOff } from 'lucide-react'

type Props = {
	kind: HomeSectionKind
	visible: boolean
	onChangeVisibility: () => void
	disabled?: boolean
}

export default function HomeArrangementItem({
	kind,
	visible,
	onChangeVisibility,
	disabled,
}: Props) {
	const { t } = useLocaleContext()
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		disabled,
		id: kind,
		transition: {
			duration: 250,
			easing: 'cubic-bezier(0.25, 1, 0.5, 1)',
		},
	})
	const VisibilityIcon = visible ? Eye : EyeOff

	return (
		<div
			ref={setNodeRef}
			style={{
				transform: CSS.Transform.toString(transform),
				transition,
			}}
			{...attributes}
			{...listeners}
			className={cn(
				'flex cursor-grab items-center justify-between rounded-md bg-secondary/80 outline-none focus-visible:ring-2 focus-visible:ring-ring',
				{
					'cursor-not-allowed': disabled,
					'bg-secondary/40': !visible,
					'cursor-grabbing': isDragging,
				},
			)}
		>
			<div className={cn('py-4 pl-4 flex-1 shrink-0', { 'opacity-60': !visible })}>
				<Text size="sm">{t(labelKey(kind))}</Text>
			</div>
			<div className="pr-4">
				<IconButton size="xs" disabled={disabled} onClick={onChangeVisibility}>
					<VisibilityIcon className="h-4 w-4" />
				</IconButton>
			</div>
		</div>
	)
}

function labelKey(kind: HomeSectionKind) {
	switch (kind) {
		case HomeSectionKind.InProgressBooks:
			return 'homeScene.continueReading.title'
		case HomeSectionKind.LastPlayedGames:
			return 'homeScene.lastPlayedGames.title'
		case HomeSectionKind.OnDeck:
			return 'homeScene.onDeck.title'
		case HomeSectionKind.RecentlyAddedBooks:
			return 'homeScene.recentlyAddedBooks.title'
		case HomeSectionKind.RecentlyAddedSeries:
			return 'homeScene.recentlyAddedSeries.title'
		default:
			return 'homeScene.emptyFallback.link'
	}
}
