import { PREFETCH_STALE_TIME, useInfiniteSuspenseGraphQL, useSDK } from '@stump/client'
import {
	RecentlyAddedSeriesQuery,
	RecentlyAddedSeriesQueryVariables,
	TypedDocumentString,
} from '@stump/graphql'
import { useLocaleContext } from '@stump/i18n'
import { useQueryClient } from '@tanstack/react-query'
import { formatDistanceToNow } from 'date-fns'
import { Suspense, useCallback, useEffect, useMemo } from 'react'
import { useMediaMatch } from 'rooks'

import MultiRowHorizontalCardList from '@/components/MultiRowHorizontalCardList'
import { StackedSeriesCard } from '@/components/series'
import { usePreferences } from '@/hooks/usePreferences'

const query = new TypedDocumentString(`
	query RecentlyAddedSeries($pagination: Pagination!) {
		recentlyAddedSeries(pagination: $pagination) {
			nodes {
				id
				resolvedName
				mediaCount
				percentageCompleted
				status
				createdAt
				useSingleThumbnail
				media(take: 2, skip: 1, includeDescendants: true) {
					id
					resolvedName
					thumbnail {
						url
						metadata {
							averageColor
							colors {
								color
								percentage
							}
							thumbhash
						}
					}
				}
				thumbnail {
					url
					metadata {
						averageColor
						colors {
							color
							percentage
						}
						thumbhash
					}
				}
			}
			pageInfo {
				__typename
				... on CursorPaginationInfo {
					currentCursor
					nextCursor
					limit
				}
			}
		}
	}
`) as unknown as TypedDocumentString<RecentlyAddedSeriesQuery, RecentlyAddedSeriesQueryVariables>

export const usePrefetchRecentlyAddedSeries = () => {
	const { sdk } = useSDK()
	const client = useQueryClient()
	return useCallback(() => {
		return client.prefetchInfiniteQuery({
			queryKey: ['recentlyAddedSeries2'],
			initialPageParam: {
				cursor: {
					limit: 20,
				},
			},
			queryFn: ({ pageParam }) => {
				return sdk.execute(query, {
					pagination: pageParam,
				})
			},
			staleTime: PREFETCH_STALE_TIME,
		})
	}, [sdk, client])
}

type SectionProps = {
	onEmptyChange?: (empty: boolean) => void
}

function RecentlyAddedSeries({ onEmptyChange }: SectionProps) {
	const { t } = useLocaleContext()
	const {
		preferences: { thumbnailRatio },
	} = usePreferences()

	const isAtLeastMedium = useMediaMatch('(min-width: 768px)')

	const cardWidth = isAtLeastMedium ? 200 : 160

	const cardHeight = useMemo(() => {
		const baseThumbnailWidth = cardWidth * 0.7
		const baseThumbnailHeight = baseThumbnailWidth / thumbnailRatio
		return baseThumbnailHeight + 100 // Extra space between thumbs and title text
	}, [cardWidth, thumbnailRatio])

	const { data, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteSuspenseGraphQL(
		query,
		['recentlyAddedSeries2'],
		{
			pagination: { cursor: { limit: 20 } },
		},
	)
	const nodes = data.pages.flatMap((page) => page.recentlyAddedSeries.nodes)

	const handleFetchMore = useCallback(() => {
		if (hasNextPage && !isFetchingNextPage) {
			fetchNextPage()
		}
	}, [hasNextPage, isFetchingNextPage, fetchNextPage])

	useEffect(() => {
		onEmptyChange?.(nodes.length === 0)
	}, [nodes.length, onEmptyChange])

	if (!nodes.length) {
		return null
	}

	return (
		<MultiRowHorizontalCardList
			title={t('homeScene.recentlyAddedSeries.title')}
			items={nodes}
			keyExtractor={(series) => series.id}
			renderItem={(series) => (
				<StackedSeriesCard
					id={series.id}
					name={series.resolvedName}
					subtitle={formatDistanceToNow(new Date(series.createdAt), { addSuffix: true })}
					isMissing={series.status === 'MISSING'}
					width={cardWidth}
					thumbnailData={
						(series as { useSingleThumbnail?: boolean }).useSingleThumbnail
							? [series.thumbnail]
							: [series.thumbnail, ...series.media.map((m) => m.thumbnail)]
					}
				/>
			)}
			cardHeight={cardHeight}
			cardWidth={cardWidth}
			onFetchMore={handleFetchMore}
		/>
	)
}

export default function RecentlyAddedSeries2Container({ onEmptyChange }: SectionProps) {
	return (
		<Suspense>
			<RecentlyAddedSeries onEmptyChange={onEmptyChange} />
		</Suspense>
	)
}
