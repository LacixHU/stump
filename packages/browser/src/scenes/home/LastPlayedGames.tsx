import { PREFETCH_STALE_TIME, useInfiniteSuspenseGraphQL, useSDK } from '@stump/client'
import { Text } from '@stump/components'
import { FragmentType, graphql, useFragment } from '@stump/graphql'
import { useLocaleContext } from '@stump/i18n'
import { useQueryClient } from '@tanstack/react-query'
import { formatDistanceToNow } from 'date-fns'
import { memo, Suspense, useCallback, useEffect, useMemo } from 'react'
import { useMediaMatch } from 'rooks'

import HorizontalCardList from '@/components/HorizontalCardList'
import { ThumbnailImage } from '@/components/thumbnail/ThumbnailImage'
import { ThumbnailPlaceholderData } from '@/components/thumbnail/ThumbnailPlaceholder'
import { Link } from '@/context'
import { usePreferences } from '@/hooks/usePreferences'
import { usePaths } from '@/paths'

const IMAGE_WIDTH_MOBILE = 200
const IMAGE_WIDTH_TABLET = 220

const LastPlayedGameFragment = graphql(`
	fragment LastPlayedGameBook on Media {
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
`)

const query = graphql(`
	query LastPlayedGames($pagination: Pagination!) {
		lastPlayedGames(pagination: $pagination) {
			nodes {
				lastPlayedAt
				media {
					id
					...LastPlayedGameBook
				}
			}
			pageInfo {
				__typename
				... on OffsetPaginationInfo {
					currentPage
					totalPages
					pageSize
					pageOffset
					zeroBased
				}
			}
		}
	}
`)

export const usePrefetchLastPlayedGames = () => {
	const { sdk } = useSDK()
	const client = useQueryClient()
	return useCallback(() => {
		return client.prefetchInfiniteQuery({
			queryKey: ['lastPlayedGames'],
			initialPageParam: {
				offset: {
					pageSize: 20,
					page: 1,
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

function LastPlayedGames({ onEmptyChange }: SectionProps) {
	const { t } = useLocaleContext()
	const {
		preferences: { thumbnailRatio },
	} = usePreferences()
	const isAtLeastMedium = useMediaMatch('(min-width: 768px)')
	const imageWidth = isAtLeastMedium ? IMAGE_WIDTH_TABLET : IMAGE_WIDTH_MOBILE
	const listHeight = imageWidth / thumbnailRatio + 17

	const { data, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteSuspenseGraphQL(
		query,
		['lastPlayedGames'],
		{
			pagination: { offset: { pageSize: 20, page: 1 } },
		},
	)
	const nodes = data.pages.flatMap((page) => page.lastPlayedGames.nodes)

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
		<HorizontalCardList
			title={t('homeScene.lastPlayedGames.title')}
			items={nodes.map((node) => (
				<LastPlayedGameCard
					key={node.media.id}
					fragment={node.media}
					lastPlayedAt={node.lastPlayedAt}
				/>
			))}
			height={listHeight}
			onFetchMore={handleFetchMore}
		/>
	)
}

export default function LastPlayedGamesContainer({ onEmptyChange }: SectionProps) {
	return (
		<Suspense>
			<LastPlayedGames onEmptyChange={onEmptyChange} />
		</Suspense>
	)
}

type LastPlayedGameCardProps = {
	fragment: FragmentType<typeof LastPlayedGameFragment>
	lastPlayedAt: string
}

const LastPlayedGameCard = memo(function LastPlayedGameCard({
	fragment,
	lastPlayedAt,
}: LastPlayedGameCardProps) {
	const data = useFragment(LastPlayedGameFragment, fragment)
	const paths = usePaths()
	const isAtLeastMedium = useMediaMatch('(min-width: 768px)')
	const cardWidth = isAtLeastMedium ? IMAGE_WIDTH_TABLET : IMAGE_WIDTH_MOBILE
	const {
		preferences: { thumbnailRatio },
	} = usePreferences()

	const placeholderData: ThumbnailPlaceholderData | undefined = useMemo(() => {
		const meta = data.thumbnail.metadata
		if (!meta) return undefined
		return {
			averageColor: meta.averageColor,
			colors: meta.colors,
			thumbhash: meta.thumbhash,
		}
	}, [data.thumbnail.metadata])

	return (
		<Link
			to={paths.bookReader(data.id, { isRetro: true })}
			className="group relative block shrink-0 rounded-thumbnail transition-opacity hover:opacity-90"
			style={{ width: cardWidth }}
		>
			<ThumbnailImage
				src={data.thumbnail.url}
				alt={data.resolvedName}
				size={{ width: cardWidth, height: cardWidth / thumbnailRatio }}
				placeholderData={placeholderData}
				gradient={{
					colors: ['transparent', 'transparent', 'rgba(0, 0, 0, 0.4)', 'rgba(0, 0, 0, 0.85)'],
					direction: 'to bottom',
				}}
				borderAndShadowStyle={{
					shadowColor: 'rgba(0, 0, 0, 0.2)',
					shadowRadius: 2,
				}}
			/>
			<div className="bottom-0 left-0 right-0 p-2 pointer-events-none absolute z-30">
				<Text
					className="text-sm font-semibold leading-tight text-white line-clamp-2 text-wrap!"
					style={{ textShadow: '1px 1px 2px rgba(0, 0, 0, 0.5)' }}
				>
					{data.resolvedName}
				</Text>
				<Text
					className="mt-0.5 text-xs text-gray-200"
					style={{ textShadow: '1px 1px 2px rgba(0, 0, 0, 0.5)' }}
				>
					{formatDistanceToNow(new Date(lastPlayedAt), { addSuffix: true })}
				</Text>
			</div>
		</Link>
	)
})
