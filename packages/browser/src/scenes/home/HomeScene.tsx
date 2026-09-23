import { PREFETCH_STALE_TIME, useSDK, useSuspenseGraphQL } from '@stump/client'
import { Text } from '@stump/components'
import { graphql, HomeSectionKind } from '@stump/graphql'
import { useLocaleContext } from '@stump/i18n'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo, useState } from 'react'
import { Helmet } from 'react-helmet'

import { SceneContainer } from '@/components/container'
import { Link } from '@/context'
import { usePaths } from '@/paths'

import ContinueReadingMedia, { usePrefetchContinueReading } from './ContinueReading'
import {
	homeArrangementSupportQuery,
	LEGACY_HOME_SECTIONS,
	supportsHomeArrangement,
} from './homeArrangementSupport'
import LastPlayedGames, { usePrefetchLastPlayedGames } from './LastPlayedGames'
import NoLibraries from './NoLibraries'
import OnDeck, { usePrefetchOnDeck } from './OnDeck'
import RecentlyAddedMedia, { usePrefetchRecentlyAddedMedia } from './RecentlyAddedMedia'
import RecentlyAddedSeries, { usePrefetchRecentlyAddedSeries } from './RecentlyAddedSeries'

const librariesQuery = graphql(`
	query HomeSceneLibraries {
		numberOfLibraries
	}
`)

const arrangementQuery = graphql(`
	query HomeSceneArrangement {
		me {
			preferences {
				homeArrangement {
					sections {
						kind
						visible
					}
				}
			}
		}
	}
`)

const KNOWN_KINDS = new Set<string>(Object.values(HomeSectionKind))

export function visibleHomeSections(
	sections: Array<{ kind: string; visible: boolean }> | undefined,
): HomeSectionKind[] {
	const seen = new Set<string>()
	const visible: HomeSectionKind[] = []
	for (const section of sections ?? []) {
		if (!section.visible || seen.has(section.kind) || !KNOWN_KINDS.has(section.kind)) continue
		seen.add(section.kind)
		visible.push(section.kind as HomeSectionKind)
	}
	return visible
}

export const usePrefetchHomeScene = () => {
	const { sdk } = useSDK()
	const client = useQueryClient()
	const prefetchRecentMedia = usePrefetchRecentlyAddedMedia()
	const prefetchContinueReading = usePrefetchContinueReading()
	const prefetchRecentSeries = usePrefetchRecentlyAddedSeries()
	const prefetchOnDeck = usePrefetchOnDeck()
	const prefetchLastPlayed = usePrefetchLastPlayedGames()

	return useCallback(async () => {
		const support = await client.fetchQuery({
			queryKey: sdk.cacheKey('homeArrangementSupport'),
			queryFn: () => sdk.execute(homeArrangementSupportQuery),
			staleTime: PREFETCH_STALE_TIME,
		})
		const kinds = supportsHomeArrangement(support)
			? visibleHomeSections(
					(
						await client.fetchQuery({
							queryKey: sdk.cacheKey('homeSceneArrangement'),
							queryFn: () => sdk.execute(arrangementQuery),
							staleTime: PREFETCH_STALE_TIME,
						})
					)?.me?.preferences?.homeArrangement?.sections,
				)
			: LEGACY_HOME_SECTIONS
		const tasks: Array<Promise<unknown>> = []
		if (kinds.includes(HomeSectionKind.InProgressBooks)) tasks.push(prefetchContinueReading())
		if (kinds.includes(HomeSectionKind.LastPlayedGames)) tasks.push(prefetchLastPlayed())
		if (kinds.includes(HomeSectionKind.OnDeck)) tasks.push(prefetchOnDeck())
		if (kinds.includes(HomeSectionKind.RecentlyAddedBooks)) tasks.push(prefetchRecentMedia())
		if (kinds.includes(HomeSectionKind.RecentlyAddedSeries)) tasks.push(prefetchRecentSeries())
		await Promise.all(tasks)
	}, [
		client,
		prefetchContinueReading,
		prefetchLastPlayed,
		prefetchOnDeck,
		prefetchRecentMedia,
		prefetchRecentSeries,
		sdk,
	])
}

export default function HomeScene() {
	const { sdk } = useSDK()
	const { data: support } = useSuspenseGraphQL(
		homeArrangementSupportQuery,
		sdk.cacheKey('homeArrangementSupport'),
	)
	const { data } = useSuspenseGraphQL(librariesQuery, sdk.cacheKey('homeScene'))

	const helmet = (
		<Helmet>
			<title>Stump | {'Home'}</title>
		</Helmet>
	)

	if (!data) {
		return null
	}

	if (data.numberOfLibraries === 0) {
		return (
			<>
				{helmet}
				<NoLibraries />
			</>
		)
	}

	if (!supportsHomeArrangement(support)) {
		return (
			<>
				{helmet}
				<HomeGroups sections={LEGACY_HOME_SECTIONS} />
			</>
		)
	}

	return (
		<>
			{helmet}
			<ArrangedHome />
		</>
	)
}

function ArrangedHome() {
	const { sdk } = useSDK()
	const { data } = useSuspenseGraphQL(arrangementQuery, sdk.cacheKey('homeSceneArrangement'))
	const sections = useMemo(
		() => visibleHomeSections(data?.me?.preferences?.homeArrangement?.sections),
		[data],
	)

	return <HomeGroups sections={sections} />
}

function HomeGroups({ sections }: { sections: readonly HomeSectionKind[] }) {
	const { t } = useLocaleContext()
	const paths = usePaths()
	const [emptyByKind, setEmptyByKind] = useState<Partial<Record<HomeSectionKind, boolean>>>({})
	const reportEmpty = useCallback((kind: HomeSectionKind, empty: boolean) => {
		setEmptyByKind((current) => (current[kind] === empty ? current : { ...current, [kind]: empty }))
	}, [])
	const allReported = sections.every((kind) => emptyByKind[kind] !== undefined)
	const showFallback =
		sections.length === 0 || (allReported && sections.every((kind) => emptyByKind[kind]))

	return (
		<SceneContainer className="gap-6 flex flex-col">
			{sections.map((kind) => (
				<HomeGroup key={kind} kind={kind} onEmptyChange={reportEmpty} />
			))}
			{showFallback ? (
				<Text size="sm" variant="muted">
					<Link to={paths.settings('preferences')}>{t('homeScene.emptyFallback.link')}</Link>
				</Text>
			) : null}
			<div className="pb-5 sm:pb-0" />
		</SceneContainer>
	)
}

function HomeGroup({
	kind,
	onEmptyChange,
}: {
	kind: HomeSectionKind
	onEmptyChange: (kind: HomeSectionKind, empty: boolean) => void
}) {
	const report = useCallback((empty: boolean) => onEmptyChange(kind, empty), [kind, onEmptyChange])

	switch (kind) {
		case HomeSectionKind.InProgressBooks:
			return <ContinueReadingMedia onEmptyChange={report} />
		case HomeSectionKind.LastPlayedGames:
			return <LastPlayedGames onEmptyChange={report} />
		case HomeSectionKind.OnDeck:
			return <OnDeck onEmptyChange={report} />
		case HomeSectionKind.RecentlyAddedBooks:
			return <RecentlyAddedMedia onEmptyChange={report} />
		case HomeSectionKind.RecentlyAddedSeries:
			return <RecentlyAddedSeries onEmptyChange={report} />
		default:
			return null
	}
}
