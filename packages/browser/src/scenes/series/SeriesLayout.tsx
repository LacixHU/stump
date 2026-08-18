import { PREFETCH_STALE_TIME, useSDK, useSuspenseGraphQL } from '@stump/client'
import { Breadcrumbs, cn } from '@stump/components'
import { graphql } from '@stump/graphql'
import { useQueryClient } from '@tanstack/react-query'
import { Suspense, useEffect, useMemo } from 'react'
import { Outlet, useNavigate, useParams } from 'react-router'

import { SceneContainer } from '@/components/container'
import { usePreferences } from '@/hooks'
import { usePaths } from '@/paths'

import { SeriesContext } from './context'
import SeriesHeader from './SeriesHeader'

const query = graphql(`
	query SeriesLayout($id: ID!) {
		seriesById(id: $id) {
			id
			path
			library {
				id
				name
			}
			resolvedName
			resolvedDescription
			childCount
			descendantMediaCount
			ancestors {
				id
				resolvedName
			}
			children(take: 50) {
				id
				resolvedName
				mediaCount
				childCount
				descendantMediaCount
				percentageCompleted
				status
				thumbnail {
					url
					metadata {
						averageColor
						thumbhash
						colors {
							color
							percentage
						}
					}
				}
			}
			stats {
				bookCount
				completedBooks
				inProgressBooks
				totalBytes
				totalReadingTimeSeconds
			}
			tags {
				id
				name
			}
			thumbnail {
				url
				metadata {
					averageColor
					thumbhash
					colors {
						color
						percentage
					}
				}
			}
			createdAt
			updatedAt
		}
	}
`)

export const usePrefetchSeries = () => {
	const { sdk } = useSDK()

	const client = useQueryClient()
	return (id: string) =>
		client.prefetchQuery({
			queryKey: ['seriesById', id],
			queryFn: async () => {
				const response = await sdk.execute(query, {
					id,
				})
				return response
			},
			staleTime: PREFETCH_STALE_TIME,
		})
}

export default function SeriesLayout() {
	const navigate = useNavigate()
	const paths = usePaths()
	const { sdk } = useSDK()

	const { id } = useParams()
	const seriesId = id || ''
	const {
		data: { seriesById: series },
	} = useSuspenseGraphQL(query, sdk.cacheKey('seriesById', [seriesId]), {
		id: seriesId,
	})
	const {
		preferences: { enableHideScrollbar },
	} = usePreferences()

	useEffect(() => {
		if (!series) {
			navigate('/404')
		}
	}, [series, navigate])

	const breadcrumbs = useMemo(() => {
		if (!series) return []
		return [
			{ label: series.library.name, to: paths.librarySeries(series.library.id) },
			...series.ancestors.map((ancestor) => ({
				label: ancestor.resolvedName,
				to: paths.seriesOverview(ancestor.id),
			})),
			{
				label: series.resolvedName,
				to: paths.seriesOverview(series.id),
			},
		]
	}, [series, paths])

	if (!series) return null

	return (
		<SeriesContext.Provider value={{ series }}>
			{/* key forces a full refresh when navigating parent â†’ child series */}
			<div key={series.id} className="relative flex flex-1 flex-col">
				{breadcrumbs.length > 1 && (
					<div className="px-4 pt-3 md:px-6">
						<Breadcrumbs segments={breadcrumbs} trailingSlash />
					</div>
				)}
				<SeriesHeader />

				<SceneContainer
					className={cn('gap-4 p-0 md:pb-0 relative flex flex-1 flex-col', {
						'md:hide-scrollbar': !!enableHideScrollbar,
					})}
				>
					<Suspense fallback={null}>
						<Outlet />
					</Suspense>
				</SceneContainer>
			</div>
		</SeriesContext.Provider>
	)
}
