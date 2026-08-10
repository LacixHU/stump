import { PREFETCH_STALE_TIME, useSDK, useSuspenseGraphQL } from '@stump/client'
import { Breadcrumbs, cn, Heading, Text } from '@stump/components'
import { graphql } from '@stump/graphql'
import { useQueryClient } from '@tanstack/react-query'
import { Suspense, useEffect, useMemo } from 'react'
import { Outlet, useNavigate, useParams } from 'react-router'

import { SceneContainer } from '@/components/container'
import { Link } from '@/context'
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

	const hasChildren = (series.childCount ?? 0) > 0

	// TODO: conditional render header, conform to library layout patterns (e.g., settings header + settings sidebar, etc)
	return (
		<SeriesContext.Provider value={{ series }}>
			{/* key forces a full refresh when navigating parent → child series */}
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
					{hasChildren && (
						<div className="gap-3 px-4 md:px-6 flex flex-col">
							<div>
								<Heading size="sm">Sub-series</Heading>
								<Text size="sm" variant="muted">
									{series.childCount} nested series
									{series.descendantMediaCount != null
										? ` · ${series.descendantMediaCount} books in tree`
										: null}
								</Text>
							</div>
							<div className="gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 grid grid-cols-2">
								{series.children.map((child) => (
									<Link
										key={child.id}
										to={paths.seriesOverview(child.id)}
										className="gap-2 group flex flex-col"
									>
										<div className="bg-background-surface aspect-[2/3] overflow-hidden rounded-md">
											{child.thumbnail?.url ? (
												<img
													src={child.thumbnail.url}
													alt={child.resolvedName}
													className="h-full w-full object-cover transition-opacity group-hover:opacity-90"
												/>
											) : null}
										</div>
										<div>
											<Text size="sm" className="font-medium line-clamp-2">
												{child.resolvedName}
											</Text>
											<Text size="xs" variant="muted">
												{child.mediaCount} books
												{child.childCount > 0 ? ` · ${child.childCount} sub-series` : ''}
											</Text>
										</div>
									</Link>
								))}
							</div>
						</div>
					)}
					<Suspense fallback={null}>
						<Outlet />
					</Suspense>
				</SceneContainer>
			</div>
		</SeriesContext.Provider>
	)
}
