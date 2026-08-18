import { useGraphQL, useSDK } from '@stump/client'
import { Heading, Text } from '@stump/components'
import { graphql } from '@stump/graphql'
import { useLocaleContext } from '@stump/i18n'

import { BookCard } from '@/components/book'
import { DynamicCardGrid } from '@/components/container'
import { useSearchMediaFilter } from '@/components/filters/useFilterScene'
import { Link } from '@/context'
import { usePaths } from '@/paths'

const query = graphql(`
	query LibrarySeriesSearchBooks($filter: MediaFilterInput!, $pagination: Pagination!) {
		media(filter: $filter, pagination: $pagination) {
			nodes {
				id
				...BookCard
			}
			pageInfo {
				__typename
				... on OffsetPaginationInfo {
					totalItems
				}
			}
		}
	}
`)

type Props = {
	libraryId: string
	search: string
}

export default function LibrarySearchBooks({ libraryId, search }: Props) {
	const { t } = useLocaleContext()
	const { sdk } = useSDK()
	const paths = usePaths()
	const searchFilter = useSearchMediaFilter(search)

	const { data } = useGraphQL(
		query,
		['librarySeriesSearchBooks', libraryId, search],
		{
			filter: {
				series: {
					libraryId: { eq: libraryId },
				},
				_or: searchFilter,
			},
			pagination: {
				offset: {
					page: 1,
					pageSize: 20,
				},
			},
		},
		{ enabled: !!search },
	)

	const books = data?.media.nodes ?? []
	const totalItems =
		data?.media.pageInfo.__typename === 'OffsetPaginationInfo'
			? data.media.pageInfo.totalItems
			: books.length

	if (!search || books.length === 0) return null

	const booksHref = `${paths.libraryBooks(libraryId)}?search=${encodeURIComponent(search)}`

	return (
		<div className="gap-3 px-4 pt-4 flex flex-col">
			<div className="gap-3 flex items-end justify-between">
				<div>
					<Heading size="sm">{t('seriesHeader.tabs.books')}</Heading>
					<Text size="sm" variant="muted">
						{t('librarySeriesScene.searchBooks.count', { count: totalItems })}
					</Text>
				</div>
				{totalItems > books.length && (
					<Link to={booksHref} className="text-sm text-muted-foreground hover:text-foreground">
						{t('navigation.seeAll')}
					</Link>
				)}
			</div>
			<DynamicCardGrid
				count={books.length}
				renderItem={(index) => <BookCard key={books[index]!.id} fragment={books[index]!} />}
			/>
		</div>
	)
}
