import { BookImageScaling } from '@stump/client'
import { cn } from '@stump/components'
import { ReadingDirection, ReadingImageScaleFit } from '@stump/graphql'
import React, { forwardRef, useCallback, useMemo } from 'react'

import { EntityImage } from '@/components/entity'
import { useBookPreferences } from '@/scenes/book/reader/useBookPreferences'

import { ImagePageDimensionRef, useImageBaseReaderContext } from '../context'

const TRANSPARENT_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='

type Props = {
	currentPage: number
	getPageUrl: (page: number) => string
}

const PageSet = forwardRef<HTMLDivElement, Props>(({ currentPage, getPageUrl }, ref) => {
	const { setPageSize, book, pageSets } = useImageBaseReaderContext()
	const {
		bookPreferences: { imageScaling, brightness, readingDirection },
	} = useBookPreferences({ book })

	/**
	 * A memoized callback to set the dimensions of a given page
	 */
	const upsertDimensions = useCallback(
		(page: number, dimensions: ImagePageDimensionRef) => {
			setPageSize(page - 1, dimensions)
		},
		[setPageSize],
	)

	const currentSetIdx = useMemo(
		() => pageSets.findIndex((set) => set.includes(currentPage - 1)),
		[currentPage, pageSets],
	)
	const currentSet = pageSets[currentSetIdx] || [currentPage - 1]
	const isAutoDoubleSpread =
		imageScaling.scaleToFit === ReadingImageScaleFit.Auto && currentSet.length > 1

	const nextSetIdx = currentSetIdx + (readingDirection === ReadingDirection.Ltr ? 1 : -1)
	const nextSet = pageSets[nextSetIdx] || []

	return (
		<div
			ref={ref}
			className="flex h-full shrink-0 items-center justify-center"
			style={{
				...styles[imageScaling.scaleToFit].imagesHolder,
				filter: `brightness(${brightness * 100}%)`,
			}}
		>
			<div
				className={cn('relative flex w-full items-center justify-center', {
					'gap-0 mx-auto flex-row': currentSet.length > 1,
				})}
			>
				{currentSet.map((idx) => (
					<Page
						key={`page-${idx + 1}`}
						page={idx + 1}
						getPageUrl={getPageUrl}
						upsertDimensions={upsertDimensions}
						imageScaling={imageScaling}
						style={{
							...styles[imageScaling.scaleToFit].image,
							...(isAutoDoubleSpread ? { maxWidth: '50%' } : {}),
						}}
					/>
				))}
				{nextSet.map((idx) => (
					<Page
						key={`page-${idx + 1}`}
						page={idx + 1}
						getPageUrl={getPageUrl}
						upsertDimensions={() => {}}
						imageScaling={imageScaling}
						style={{
							position: 'fixed',
							maxWidth: 'max-content',
							maxHeight: '100%',
							zIndex: -1,
							opacity: 0,
						}}
					/>
				))}
			</div>
		</div>
	)
})
PageSet.displayName = 'PageSet'

export default PageSet

type PageProps = Omit<Props, 'displayedPages' | 'currentPage'> & {
	page: number
	upsertDimensions: (page: number, dimensions: ImagePageDimensionRef) => void
	imageScaling: BookImageScaling
	style?: React.CSSProperties
}

// TODO(readers): consider exporting/relocating and sharing with the continuous reader(s)
const _Page = ({
	page,
	getPageUrl,
	upsertDimensions,
	imageScaling: { scaleToFit },
	style,
}: PageProps) => {
	return (
		<EntityImage
			key={`page-${page}-scaled-${scaleToFit}`}
			className="pointer-events-none z-30 object-contain"
			style={style}
			src={getPageUrl(page)}
			onLoad={({ height, width }) => {
				upsertDimensions(page, {
					height,
					width,
					ratio: width / height,
				})
			}}
			onError={(err) => {
				// @ts-expect-error: is oke
				err.target.src = TRANSPARENT_IMAGE
			}}
		/>
	)
}
const Page = React.memo(_Page)

/**
 * Styles for the image and page set holder
 */
const styles = {
	[ReadingImageScaleFit.Auto]: {
		imagesHolder: {
			// no min width
			maxWidth: '100%',
			width: '100%',
			// no min height
			height: '100%',
		} as React.CSSProperties,

		image: {
			minWidth: '0%',
			maxWidth: '100%',
			minHeight: '0%',
			// no width, no height — browser picks whichever dimension is the constraint
			maxHeight: '100dvh',
		} as React.CSSProperties,
	},

	[ReadingImageScaleFit.Height]: {
		imagesHolder: {
			minWidth: 'max-content',
			// no max width
			// no width
			// no min height
			height: '100dvh',
		} as React.CSSProperties,

		image: {
			// no min width
			// no max width
			// no width
			// no min height
			// no max height
			height: '100%',
		} as React.CSSProperties,
	},

	[ReadingImageScaleFit.Width]: {
		imagesHolder: {
			// no min width
			// no max width
			width: '100%',
			minHeight: '100dvh',
			// no neight
		} as React.CSSProperties,

		image: {
			minWidth: '0%',
			maxWidth: '100%',
			width: '100%',
			minHeight: '0%',
			maxHeight: '100%',
			// no height
		} as React.CSSProperties,
	},

	[ReadingImageScaleFit.None]: {
		imagesHolder: {
			minWidth: 'max-content',
			// no max width
			// no width
			minHeight: '100dvh',
			// no height
			alignItems: 'center', // add vertical alignment
		} as React.CSSProperties,

		image: {
			// no min width
			// no max width
			width: 'max-content',
			// no min height
			// no max height
			height: 'max-content',
		} as React.CSSProperties,
	},
}
