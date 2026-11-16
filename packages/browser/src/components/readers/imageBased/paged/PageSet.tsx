import { BookImageScaling } from '@stump/client'
import { cn } from '@stump/components'
import { ReadingDirection, ReadingImageScaleFit } from '@stump/graphql'
import React, { forwardRef, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { EntityImage } from '@/components/entity'
import { useBookPreferences } from '@/scenes/book/reader/useBookPreferences'

import { ImagePageDimensionRef, useImageBaseReaderContext } from '../context'

const TRANSPARENT_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='

type Props = {
	currentPage: number
	getPageUrl: (page: number) => string
}

const PageSet = forwardRef<HTMLDivElement, Props>(({ currentPage, getPageUrl }, ref) => {
	const { setPageSize, book, pageSets, extension } = useImageBaseReaderContext()
	const renderOverlay = extension?.renderPageOverlay
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
						overlay={renderOverlay?.(idx + 1)}
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
	/** Drawn over the image, see `ImageReaderExtension.renderPageOverlay` */
	overlay?: React.ReactNode
}

// TODO(readers): consider exporting/relocating and sharing with the continuous reader(s)
const PageComponent = ({
	page,
	getPageUrl,
	upsertDimensions,
	imageScaling: { scaleToFit },
	style,
	overlay,
}: PageProps) => {
	const imageRef = useRef<HTMLImageElement>(null)
	return (
		<>
			<PageImage
				ref={imageRef}
				page={page}
				getPageUrl={getPageUrl}
				upsertDimensions={upsertDimensions}
				scaleToFit={scaleToFit}
				style={style}
			/>
			{overlay != null && <PageOverlay imageRef={imageRef}>{overlay}</PageOverlay>}
		</>
	)
}
const Page = React.memo(PageComponent)

type PageImageProps = Pick<PageProps, 'page' | 'getPageUrl' | 'upsertDimensions' | 'style'> & {
	scaleToFit: BookImageScaling['scaleToFit']
}

const PageImage = forwardRef<HTMLImageElement, PageImageProps>(
	({ page, getPageUrl, upsertDimensions, scaleToFit, style }, ref) => (
		<EntityImage
			ref={ref}
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
	),
)
PageImage.displayName = 'PageImage'

type PageOverlayProps = {
	imageRef: React.RefObject<HTMLImageElement | null>
	children: React.ReactNode
}

/**
 * Covers exactly the box of the page image (its sibling), following it through layout
 * changes, so the content can be positioned in percentages of the page. It moves with
 * the image when the reader is zoomed or panned, since both are transformed together.
 */
function PageOverlay({ imageRef, children }: PageOverlayProps) {
	const [box, setBox] = useState<{ left: number; top: number; width: number; height: number }>()

	useLayoutEffect(() => {
		const image = imageRef.current
		const container = image?.parentElement
		if (!image || !container) return

		const measure = () =>
			setBox((previous) => {
				const next = {
					left: image.offsetLeft,
					top: image.offsetTop,
					width: image.offsetWidth,
					height: image.offsetHeight,
				}
				const unchanged =
					previous &&
					previous.left === next.left &&
					previous.top === next.top &&
					previous.width === next.width &&
					previous.height === next.height
				return unchanged ? previous : next
			})

		measure()
		// the image moves when its neighbours in a double spread load or resize
		const observer = new ResizeObserver(measure)
		observer.observe(container)
		container.querySelectorAll('img').forEach((element) => observer.observe(element))
		image.addEventListener('load', measure)
		return () => {
			observer.disconnect()
			image.removeEventListener('load', measure)
		}
	}, [imageRef])

	if (!box || !box.width || !box.height) return null

	return (
		<div className="pointer-events-none absolute z-40 overflow-hidden" style={box}>
			{children}
		</div>
	)
}

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
