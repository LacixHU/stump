import { PREFETCH_STALE_TIME, useGraphQL, useSDK } from '@stump/client'
import { Heading, Text, usePrevious } from '@stump/components'
import {
	InterfaceLayout,
	OrderDirection,
	SeriesFilterInput,
	SeriesModelOrdering,
	SeriesOrderBy,
} from '@stump/graphql'
import { useLocaleContext } from '@stump/i18n'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo } from 'react'
import { Helmet } from 'react-helmet'
import { useShallow } from 'zustand/react/shallow'

import { BookCard, BookTable } from '@/components/book'
import { defaultBookColumnSort } from '@/components/book/table'
import { DynamicCardGrid, GridSizeSlider } from '@/components/container'
import {
	FilterContext,
	FilterHeader,
	URLFilterContainer,
	URLFilterDrawer,
	URLOrdering,
	useFilterScene,
} from '@/components/filters'
import { Ordering } from '@/components/filters/context'
import {
	DEFAULT_MEDIA_ORDER_BY,
	DEFAULT_SERIES_ORDER_BY,
	useSearchMediaFilter,
	useSearchSeriesFilter,
	useURLKeywordSearch,
	useURLPageParams,
} from '@/components/filters/useFilterScene'
import GenericEmptyState from '@/components/GenericEmptyState'
import { LibrarySeriesCard, SeriesTable } from '@/components/series'
import { defaultSeriesColumnSort } from '@/components/series/table'
import { EntityTableColumnConfiguration } from '@/components/table'
import TableOrGridLayout from '@/components/TableOrGridLayout'
import useIsInView from '@/hooks/useIsInView'
import { libraryBooksQuery } from '@/scenes/library/tabs/books/LibraryBooksScene'
import { librarySeriesQuery } from '@/scenes/library/tabs/series/LibrarySeriesScene'
import { useBooksLayout, useSeriesLayout } from '@/stores/layout'

import { useSeriesContext } from '../../context'

const CACHE_KEY = 'seriesChildSeries'
const BOOKS_CACHE_KEY = 'seriesDirectBooks'

export type UsePrefetchSeriesChildrenParams = {
	page?: number
	pageSize?: number
	filter?: SeriesFilterInput[]
	orderBy: SeriesOrderBy[]
}

export const usePrefetchSeriesChildren = () => {
	const { sdk } = useSDK()
	const { pageSize } = useURLPageParams()
	const { search } = useURLKeywordSearch()
	const searchFilter = useSearchSeriesFilter(search)
	const mediaSearchFilter = useSearchMediaFilter(search)

	const client = useQueryClient()

	return useCallback(
		(
			seriesId: string,
			params: UsePrefetchSeriesChildrenParams = { filter: [], orderBy: DEFAULT_SERIES_ORDER_BY },
		) => {
			const pageParams = { page: params.page || 1, pageSize: params.pageSize || pageSize }
			const filterAnd = params.filter || []
			return Promise.all([
				client.prefetchQuery({
					queryKey: getQueryKey(
						CACHE_KEY,
						seriesId,
						pageParams.page,
						pageParams.pageSize,
						search,
						filterAnd,
						params.orderBy,
					),
					queryFn: async () => {
						const response = await sdk.execute(librarySeriesQuery, {
							filter: {
								parentSeriesId: { eq: seriesId },
								_and: filterAnd,
								_or: searchFilter,
							},
							orderBy: params.orderBy,
							pagination: {
								offset: {
									...pageParams,
								},
							},
						})
						return response
					},
					staleTime: PREFETCH_STALE_TIME,
				}),
				client.prefetchQuery({
					queryKey: [BOOKS_CACHE_KEY, seriesId, pageParams.page, pageParams.pageSize, search],
					queryFn: async () => {
						const response = await sdk.execute(libraryBooksQuery, {
							filter: {
								seriesId: { eq: seriesId },
								_or: mediaSearchFilter,
							},
							orderBy: DEFAULT_MEDIA_ORDER_BY,
							pagination: {
								offset: {
									...pageParams,
								},
							},
						})
						return response
					},
					staleTime: PREFETCH_STALE_TIME,
				}),
			])
		},
		[pageSize, search, searchFilter, mediaSearchFilter, sdk, client],
	)
}

function useSeriesURLOrderBy(ordering: Ordering): SeriesOrderBy[] {
	return useMemo(() => {
		if (!ordering || !ordering.orderBy || !ordering.direction) {
			return DEFAULT_SERIES_ORDER_BY
		}

		return [
			{
				series: {
					field: ordering.orderBy as SeriesModelOrdering,
					direction: ordering.direction as OrderDirection,
				},
			},
		] as SeriesOrderBy[]
	}, [ordering])
}

function getQueryKey(
	cacheKey: string,
	seriesId: string,
	page: number,
	pageSize: number,
	search: string | undefined,
	filters: SeriesFilterInput[] | undefined,
	orderBy: SeriesOrderBy[] | undefined,
): (string | object | number | SeriesFilterInput[] | SeriesOrderBy[] | undefined)[] {
	return [cacheKey, seriesId, page, pageSize, search, filters, orderBy]
}

export default function SeriesChildrenScene() {
	const { t } = useLocaleContext()
	const { series } = useSeriesContext()
	const {
		filters: seriesFilters,
		ordering,
		pagination: { page, pageSize: pageSizeMaybeUndefined },
		setPage,
		...rest
	} = useFilterScene()
	const pageSize = pageSizeMaybeUndefined || 20
	const filters = seriesFilters as SeriesFilterInput
	const orderBy = useSeriesURLOrderBy(ordering)
	const { search } = useURLKeywordSearch()
	const searchFilter = useSearchSeriesFilter(search)
	const mediaSearchFilter = useSearchMediaFilter(search)

	const previous = usePrevious(search)
	const differentSearch = previous != null && search !== previous
	useEffect(() => {
		if (differentSearch) {
			setPage(1)
		}
	}, [differentSearch, setPage])

	const resolvedFilters = useMemo(() => [filters], [filters])
	const prefetch = usePrefetchSeriesChildren()
	const layoutKey = `series-${series.id}-children`
	const booksLayoutKey = `series-${series.id}-children-books`

	const { layoutMode, setLayout, columns, setColumns } = useSeriesLayout(
		layoutKey,
		useShallow((state) => ({
			columns: state.columns,
			layoutMode: state.layout,
			setColumns: state.setColumns,
			setLayout: state.setLayout,
		})),
	)
	const { columns: bookColumns, setColumns: setBookColumns } = useBooksLayout(
		booksLayoutKey,
		useShallow((state) => ({
			columns: state.columns,
			setColumns: state.setColumns,
		})),
	)

	const { data: childSeriesData, isLoading: isSeriesLoading } = useGraphQL(
		librarySeriesQuery,
		getQueryKey(CACHE_KEY, series.id, page, pageSize, search, resolvedFilters, orderBy),
		{
			filter: {
				parentSeriesId: { eq: series.id },
				_and: resolvedFilters,
				_or: searchFilter,
			},
			orderBy,
			pagination: {
				offset: {
					page,
					pageSize,
				},
			},
		},
	)

	const { data: booksData, isLoading: isBooksLoading } = useGraphQL(
		libraryBooksQuery,
		[BOOKS_CACHE_KEY, series.id, page, pageSize, search],
		{
			filter: {
				seriesId: { eq: series.id },
				_or: mediaSearchFilter,
			},
			orderBy: DEFAULT_MEDIA_ORDER_BY,
			pagination: {
				offset: {
					page,
					pageSize,
				},
			},
		},
	)

	const childSeries = childSeriesData?.series.nodes || []
	const books = booksData?.media.nodes || []
	const isLoading = isSeriesLoading || isBooksLoading
	const seriesPageInfo = childSeriesData?.series.pageInfo
	const booksPageInfo = booksData?.media.pageInfo

	const seriesTotalPages =
		seriesPageInfo?.__typename === 'OffsetPaginationInfo' ? seriesPageInfo.totalPages || 1 : 1
	const booksTotalPages =
		booksPageInfo?.__typename === 'OffsetPaginationInfo' ? booksPageInfo.totalPages || 1 : 1
	const totalPages = Math.max(seriesTotalPages, booksTotalPages)
	const currentPage =
		booksPageInfo?.__typename === 'OffsetPaginationInfo'
			? booksPageInfo.currentPage || page
			: seriesPageInfo?.__typename === 'OffsetPaginationInfo'
				? seriesPageInfo.currentPage || page
				: page

	const gridCount = childSeries.length + books.length
	const [containerRef, isInView] = useIsInView<HTMLDivElement>()

	const previousPage = usePrevious(currentPage)
	const shouldScroll = !!previousPage && previousPage !== currentPage
	useEffect(() => {
		if (!isInView && shouldScroll) {
			containerRef.current?.scrollIntoView({
				behavior: 'smooth',
				block: 'nearest',
				inline: 'start',
			})
		}
	}, [shouldScroll, isInView, containerRef])

	const renderContent = () => {
		if (layoutMode === InterfaceLayout.Grid) {
			return (
				<URLFilterContainer
					currentPage={currentPage}
					pages={totalPages}
					onChangePage={(nextPage) => {
						setPage(nextPage)
					}}
					onPrefetchPage={(nextPage) => {
						prefetch(series.id, {
							page: nextPage,
							pageSize,
							filter: resolvedFilters,
							orderBy,
						})
					}}
				>
					<div className="px-4 pt-4 gap-6 flex flex-1 flex-col">
						{!!gridCount && (
							<DynamicCardGrid
								count={gridCount}
								renderItem={(index) => {
									if (index < childSeries.length) {
										const child = childSeries[index]!
										return <LibrarySeriesCard key={child.id} data={child} />
									}
									const book = books[index - childSeries.length]!
									return <BookCard key={book.id} fragment={book} />
								}}
							/>
						)}
						{!gridCount && !isLoading && (
							<div className="col-span-full grid flex-1 place-self-center">
								<GenericEmptyState
									title={
										Object.keys(filters || {}).length > 0 || search
											? 'No series or books match your search'
											: "It doesn't look like there are any series or books here"
									}
									subtitle={
										Object.keys(filters || {}).length > 0 || search
											? 'Try removing some filters to see more results'
											: 'Sub-series and books in this series will appear here'
									}
								/>
							</div>
						)}
					</div>
				</URLFilterContainer>
			)
		}

		return (
			<div className="gap-6 flex flex-1 flex-col">
				{!!childSeries.length && (
					<div>
						<div className="px-4 pt-2">
							<Heading size="sm">{t('seriesHeader.tabs.series')}</Heading>
							<Text size="sm" variant="muted">
								{childSeries.length}
							</Text>
						</div>
						<SeriesTable
							layoutKey={layoutKey}
							items={childSeries}
							render={(props) => (
								<URLFilterContainer
									currentPage={currentPage}
									pages={totalPages}
									onChangePage={(nextPage) => {
										setPage(nextPage)
									}}
									onPrefetchPage={(nextPage) => {
										prefetch(series.id, {
											page: nextPage,
											pageSize,
											filter: resolvedFilters,
											orderBy,
										})
									}}
									tableControls={
										<EntityTableColumnConfiguration
											entity="series"
											configuration={columns || defaultSeriesColumnSort}
											onSave={setColumns}
										/>
									}
									{...props}
								/>
							)}
						/>
					</div>
				)}
				{!!books.length && (
					<div>
						<div className="px-4 pt-2">
							<Heading size="sm">{t('seriesHeader.tabs.books')}</Heading>
							<Text size="sm" variant="muted">
								{books.length}
							</Text>
						</div>
						<BookTable
							layoutKey={booksLayoutKey}
							items={books}
							render={(props) => (
								<URLFilterContainer
									currentPage={currentPage}
									pages={totalPages}
									onChangePage={(nextPage) => {
										setPage(nextPage)
									}}
									onPrefetchPage={(nextPage) => {
										prefetch(series.id, {
											page: nextPage,
											pageSize,
											filter: resolvedFilters,
											orderBy,
										})
									}}
									tableControls={
										<EntityTableColumnConfiguration
											entity="media"
											configuration={bookColumns || defaultBookColumnSort}
											onSave={setBookColumns}
										/>
									}
									{...props}
								/>
							)}
						/>
					</div>
				)}
				{!gridCount && !isLoading && (
					<div className="px-4 pt-4 flex flex-1">
						<div className="col-span-full grid flex-1 place-self-center">
							<GenericEmptyState
								title={
									Object.keys(filters || {}).length > 0 || search
										? 'No series or books match your search'
										: "It doesn't look like there are any series or books here"
								}
								subtitle={
									Object.keys(filters || {}).length > 0 || search
										? 'Try removing some filters to see more results'
										: 'Sub-series and books in this series will appear here'
								}
							/>
						</div>
					</div>
				)}
			</div>
		)
	}

	return (
		<FilterContext.Provider
			value={{
				filters,
				ordering,
				pagination: { page, pageSize },
				setPage,
				...rest,
			}}
		>
			<div className="pb-4 md:pb-0 flex flex-1 flex-col">
				<Helmet>
					<title>Stump | {series.resolvedName}</title>
				</Helmet>

				<section ref={containerRef} id="grid-top-indicator" className="h-0" />

				<FilterHeader
					isSearching={isLoading}
					layoutControls={<TableOrGridLayout layout={layoutMode} setLayout={setLayout} />}
					orderControls={<URLOrdering entity="series" />}
					filterControls={<URLFilterDrawer entity="series" />}
					sizeControls={layoutMode === InterfaceLayout.Grid ? <GridSizeSlider /> : undefined}
					navOffset
				/>

				{renderContent()}
			</div>
		</FilterContext.Provider>
	)
}
