import {
	closestCenter,
	DndContext,
	DragEndEvent,
	KeyboardSensor,
	PointerSensor,
	useSensor,
	useSensors,
} from '@dnd-kit/core'
import {
	arrayMove,
	SortableContext,
	sortableKeyboardCoordinates,
	verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { useGraphQLMutation, useSDK, useSuspenseGraphQL } from '@stump/client'
import { Button, cn, NewCard, Sheet } from '@stump/components'
import { graphql, HomeSectionKind } from '@stump/graphql'
import { useLocaleContext } from '@stump/i18n'
import { useQueryClient } from '@tanstack/react-query'
import { Lock, Unlock } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import HomeArrangementItem from './HomeArrangementItem'

const DEFAULT_ORDER = [
	HomeSectionKind.InProgressBooks,
	HomeSectionKind.LastPlayedGames,
	HomeSectionKind.OnDeck,
	HomeSectionKind.RecentlyAddedBooks,
	HomeSectionKind.RecentlyAddedSeries,
]

const KNOWN_KINDS = new Set<string>(Object.values(HomeSectionKind))

const query = graphql(`
	query HomeArrangement {
		me {
			preferences {
				homeArrangement {
					locked
					sections {
						kind
						visible
					}
				}
			}
		}
	}
`)

const updateMutation = graphql(`
	mutation HomeArrangementUpdate($input: HomeArrangementInput!) {
		updateHomeArrangement(input: $input) {
			locked
			sections {
				kind
				visible
			}
		}
	}
`)

const lockMutation = graphql(`
	mutation HomeArrangementUpdateLockStatus($locked: Boolean!) {
		updateHomeArrangementLock(locked: $locked) {
			locked
		}
	}
`)

type Section = {
	kind: HomeSectionKind
	visible: boolean
}

function normalizeSections(sections: Array<{ kind: string; visible: boolean }>): Section[] {
	const seen = new Set<string>()
	const kept: Section[] = []
	for (const section of sections) {
		if (!KNOWN_KINDS.has(section.kind) || seen.has(section.kind)) continue
		seen.add(section.kind)
		kept.push({ kind: section.kind as HomeSectionKind, visible: section.visible })
	}
	for (const kind of DEFAULT_ORDER) {
		if (seen.has(kind)) continue
		kept.splice(Math.min(DEFAULT_ORDER.indexOf(kind), kept.length), 0, {
			kind,
			visible: true,
		})
		seen.add(kind)
	}
	return kept
}

export default function HomeArrangementRow() {
	const { t } = useLocaleContext()
	return (
		<NewCard.Row label={t(getKey('label'))} description={t(getKey('description'))}>
			<HomeArrangementSheet />
		</NewCard.Row>
	)
}

export function HomeArrangementSheet() {
	const { t } = useLocaleContext()
	const { sdk } = useSDK()
	const {
		data: {
			me: {
				preferences: { homeArrangement },
			},
		},
	} = useSuspenseGraphQL(query, sdk.cacheKey('homeArrangement'))
	const client = useQueryClient()
	const sensors = useSensors(
		useSensor(PointerSensor, {
			activationConstraint: {
				distance: 5,
			},
		}),
		useSensor(KeyboardSensor, {
			coordinateGetter: sortableKeyboardCoordinates,
		}),
	)
	const [localArrangement, setLocalArrangement] = useState(() => ({
		locked: homeArrangement.locked,
		sections: normalizeSections(homeArrangement.sections),
	}))

	useEffect(() => {
		setLocalArrangement({
			locked: homeArrangement.locked,
			sections: normalizeSections(homeArrangement.sections),
		})
	}, [homeArrangement])

	const refetch = useCallback(() => {
		client.refetchQueries({ queryKey: sdk.cacheKey('homeArrangement') })
		client.refetchQueries({ queryKey: sdk.cacheKey('homeSceneArrangement') })
	}, [client, sdk])

	const { mutate: updateArrangement } = useGraphQLMutation(updateMutation, {
		onSuccess: () => {
			refetch()
		},
	})
	const { mutate: updateLockStatus } = useGraphQLMutation(lockMutation, {
		onSuccess: (_, { locked }) => {
			setLocalArrangement((current) => ({ ...current, locked }))
			refetch()
		},
	})

	const handleDragEnd = (event: DragEndEvent) => {
		const { active, over } = event
		if (!over?.id || active.id === over.id || localArrangement.locked) return

		const oldIndex = localArrangement.sections.findIndex((section) => section.kind === active.id)
		const newIndex = localArrangement.sections.findIndex((section) => section.kind === over.id)
		if (oldIndex < 0 || newIndex < 0) return

		const sections = arrayMove(localArrangement.sections, oldIndex, newIndex)
		setLocalArrangement((current) => ({ ...current, sections }))
		updateArrangement({
			input: {
				sections,
			},
		})
	}

	const onChangeVisibility = useCallback(
		(index: number, visible: boolean) => {
			if (localArrangement.locked) return
			const sections = localArrangement.sections.map((section, sectionIndex) =>
				sectionIndex === index ? { ...section, visible } : section,
			)
			setLocalArrangement((current) => ({ ...current, sections }))
			updateArrangement({
				input: {
					sections,
				},
			})
		},
		[localArrangement, updateArrangement],
	)

	const identifiers = useMemo(
		() => localArrangement.sections.map((section) => section.kind),
		[localArrangement.sections],
	)
	const Icon = localArrangement.locked ? Lock : Unlock

	return (
		<Sheet
			title={t(getKey('label'))}
			description={t(getKey('description'))}
			trigger={
				<Button size="sm" variant="outline">
					{t('common.edit')}
				</Button>
			}
		>
			<div className="px-4">
				<div className="flex w-full flex-col overflow-hidden rounded-xl border border-border">
					<header className="px-4 py-0.5 flex items-center justify-end bg-muted/50">
						<Button
							size="icon"
							aria-label={localArrangement.locked ? t(getKey('unlock')) : t(getKey('lock'))}
							onClick={() => updateLockStatus({ locked: !localArrangement.locked })}
							variant="ghost"
						>
							<Icon className="h-4 w-4 text-muted-foreground" />
						</Button>
					</header>
					<div
						className={cn('gap-2 px-4 py-3.5 flex w-full flex-col', {
							'pointer-events-none cursor-not-allowed opacity-60 select-none':
								localArrangement.locked,
						})}
					>
						<DndContext
							sensors={sensors}
							collisionDetection={closestCenter}
							onDragEnd={handleDragEnd}
						>
							<SortableContext items={identifiers} strategy={verticalListSortingStrategy}>
								{localArrangement.sections.map((section, index) => (
									<HomeArrangementItem
										key={section.kind}
										kind={section.kind}
										visible={section.visible}
										disabled={localArrangement.locked}
										onChangeVisibility={() => onChangeVisibility(index, !section.visible)}
									/>
								))}
							</SortableContext>
						</DndContext>
					</div>
				</div>
			</div>
		</Sheet>
	)
}

const LOCALE_BASE = 'settingsScene.app/preferences.sections.homeArrangement'
const getKey = (key: string) => `${LOCALE_BASE}.${key}`
