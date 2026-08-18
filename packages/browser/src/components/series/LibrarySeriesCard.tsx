import { FileStatus, ImageRef } from '@stump/graphql'
import { memo, useEffect, useRef, useState } from 'react'

import { StackedSeriesCard } from './StackedSeriesCard'

import pluralizeStat from '../../utils/pluralize'

export type LibrarySeriesCardData = {
	id: string
	resolvedName: string
	mediaCount: number
	childCount?: number | null
	descendantMediaCount?: number | null
	status: FileStatus | string
	thumbnail: ImageRef
	media: Array<{ thumbnail: ImageRef }>
}

type Props = {
	data: LibrarySeriesCardData
}

const LibrarySeriesCard = memo(function LibrarySeriesCard({ data }: Props) {
	const containerRef = useRef<HTMLDivElement>(null)
	const [width, setWidth] = useState<number | null>(null)

	useEffect(() => {
		if (!containerRef.current) return

		const observer = new ResizeObserver((entries) => {
			const entry = entries[0]
			if (entry) {
				setWidth(entry.contentRect.width)
			}
		})

		observer.observe(containerRef.current)
		setWidth(containerRef.current.offsetWidth)

		return () => observer.disconnect()
	}, [])

	const thumbnailData = [data.thumbnail, ...data.media.map((m) => m.thumbnail)]
	const bookLabel = pluralizeStat(
		'book',
		data.descendantMediaCount != null && data.descendantMediaCount > data.mediaCount
			? data.descendantMediaCount
			: data.mediaCount,
	)
	const childLabel =
		data.childCount != null && data.childCount > 0
			? ` · ${pluralizeStat('series', data.childCount)}`
			: ''

	return (
		<div ref={containerRef}>
			{width != null && (
				<StackedSeriesCard
					id={data.id}
					name={data.resolvedName}
					subtitle={`${bookLabel}${childLabel}`}
					isMissing={data.status === 'MISSING'}
					width={width}
					thumbnailData={thumbnailData}
				/>
			)}
		</div>
	)
})

export default LibrarySeriesCard
