import { Button, Heading, Text } from '@stump/components'
import { useLocaleContext } from '@stump/i18n'
import { useCallback, useState } from 'react'

import { useURLKeywordSearch } from '@/components/filters/useFilterScene'
import { Link } from '@/context'
import { usePaths } from '@/paths'

import { useSeriesContext } from './context'

const collapsedKey = (seriesId: string) => `stump.series.subSeries.collapsed.${seriesId}`

export default function SeriesSubSeries() {
	const { t } = useLocaleContext()
	const { series } = useSeriesContext()
	const { search } = useURLKeywordSearch()
	const paths = usePaths()

	const [collapsed, setCollapsed] = useState(() => {
		if (typeof window === 'undefined') return false
		return window.localStorage.getItem(collapsedKey(series.id)) === '1'
	})

	const toggleCollapsed = useCallback(() => {
		setCollapsed((current) => {
			const next = !current
			window.localStorage.setItem(collapsedKey(series.id), next ? '1' : '0')
			return next
		})
	}, [series.id])

	if ((series.childCount ?? 0) === 0 || search) return null

	return (
		<div className="gap-3 px-4 pt-4 md:px-6 flex flex-col">
			<div className="gap-3 flex items-start justify-between">
				<div>
					<Heading size="sm">{t('seriesHeader.subSeries.heading')}</Heading>
					{!collapsed && (
						<Text size="sm" variant="muted">
							{t('seriesHeader.subSeries.nestedCount', { count: series.childCount })}
							{series.descendantMediaCount != null
								? ` · ${t('seriesHeader.subSeries.booksInTree', { count: series.descendantMediaCount })}`
								: null}
						</Text>
					)}
				</div>
				<Button variant="ghost" size="sm" onClick={toggleCollapsed}>
					{collapsed ? t('seriesHeader.subSeries.show') : t('seriesHeader.subSeries.hide')}
				</Button>
			</div>
			{!collapsed && (
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
									{t('seriesHeader.subSeries.bookCount', { count: child.mediaCount })}
									{child.childCount > 0
										? ` · ${t('seriesHeader.subSeries.childCount', { count: child.childCount })}`
										: ''}
								</Text>
							</div>
						</Link>
					))}
				</div>
			)}
		</div>
	)
}
