import { BookReaderSceneQuery } from '@stump/graphql'
import { ComponentType, createContext, PropsWithChildren, ReactNode, useContext } from 'react'

import { Timer } from '@/stores/reader'

export type ImageReaderBookRef = NonNullable<BookReaderSceneQuery['mediaById']>

export type NextInSeriesBookRef = {
	id: string
	name: string
	thumbnailUrl: string
}

export type ImagePageDimensionRef = {
	height: number
	width: number
	ratio: number
}

// TODO: I think we can move this and useImageSizes to the client package so we can
// introduce better code sharing between platforms.

/**
 * Lets another reader reuse the image-based reader (its paging, touch and zoom
 * handling, toolbar and page strip) while adding its own features, like read aloud.
 */
export type ImageReaderExtension = {
	/**
	 * Rendered inside the reader context, around the whole reader, so the extension can
	 * use `useImageBaseReaderContext` and provide its own context to the parts below
	 */
	Provider?: ComponentType<PropsWithChildren>
	/**
	 * Drawn over a page in the paged readers, sized and positioned exactly like the
	 * page image, so it can be laid out in percentages of the page
	 */
	renderPageOverlay?: (page: number) => ReactNode
	/** Extra buttons in the reader header, next to the settings button */
	headerControls?: ReactNode
	/** An extra section at the end of the settings dialog */
	settings?: ReactNode
}

export type IImageBaseReaderContext = {
	/**
	 * The media entity associated with the reader
	 */
	book: ImageReaderBookRef
	/**
	 * The current page of the reader
	 */
	currentPage: number
	/**
	 * A function to set the current page
	 */
	setCurrentPage: (page: number) => void
	/**
	 * A function to get the URL of a specific page
	 */
	getPageUrl: (page: number) => string
	/**
	 * A function to get the URL of a small preview of a specific page
	 */
	getThumbnailUrl: (page: number) => string
	/**
	 * The sizes of the pages in the book, as they are loaded
	 */
	imageSizes: Record<number, ImagePageDimensionRef>
	/**
	 * A function to set the sizes of a page
	 */
	setPageSize: (page: number, dimensions: ImagePageDimensionRef) => void
	/**
	 * The page sets for the book
	 */
	pageSets: number[][]
	/**
	 * The active book's timer
	 */
	timer: Timer

	toggleToolbar: () => void

	extension?: ImageReaderExtension
}

export const ImageBaseReaderContext = createContext<IImageBaseReaderContext | null>(null)

export const useImageBaseReaderContext = () => {
	const context = useContext(ImageBaseReaderContext)
	if (!context) {
		throw new Error('useImageBaseReaderContext must be used within a ImageBaseReaderContext')
	}
	return context
}
