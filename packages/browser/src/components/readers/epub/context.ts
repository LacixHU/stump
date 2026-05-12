import { Bookmark } from '@stump/graphql'
import { createContext, useContext } from 'react'

import { ImageReaderBookRef } from '@/components/readers/imageBased/context'

import { noop } from '../../../utils/misc'

export type EpubReaderChapterMeta = {
	/** The chapter's title. */
	name?: string
	/** The chapter's position in the book. */
	position?: number
	/** The chapter's index in the spine */
	sectionSpineIndex?: number
	/** The chapter's total number of pages. */
	totalPages?: number
	/**
	 * The chapter's current page. If the viewport is large enough, two pages will
	 * be displayed, so this will be an array of two numbers.
	 */
	currentPage?: [number | undefined, number | undefined]
	/**
	 * The visible cfi strings for the first and last visible pages.
	 */
	cfiRange: [string | undefined, string | undefined]
}

export interface EpubContent {
	label: string
	content: string
	children: EpubContent[]
	play_order: number
}

export type EpubReaderBookMeta = {
	chapter: EpubReaderChapterMeta
	toc: EpubContent[]
	sectionLengths: { [key: number]: number }
	bookmarks: Record<string, Bookmark>
}

export type EpubReaderMeta = {
	bookEntity: ImageReaderBookRef
	bookMeta: EpubReaderBookMeta | null
	progress: number | null
}

export type EpubReaderControls = {
	visible: boolean
	fullscreen: boolean
	readAloudSupported: boolean
	isReadAloudActive: boolean
	isReadAloudPaused: boolean
	readAloudRate: number
	readAloudPitch: number
	readAloudVoiceUri: string | null
	readAloudVoices: Array<{ label: string; value: string }>
	readAloudCurrentSentence: string | null
	setFullscreen: (fullscreen: boolean) => void
	setVisible: (visible: boolean) => void
	onMouseEnterControls: () => void
	onMouseLeaveControls: () => void
	onToggleReadAloud: () => void
	onPauseReadAloud: () => void
	onResumeReadAloud: () => void
	onSetReadAloudRate: (rate: number) => void
	onSetReadAloudPitch: (pitch: number) => void
	onSetReadAloudVoiceUri: (voiceUri: string | null) => void
	onLinkClick: (href: string) => void
	onPaginateForward: () => void
	onPaginateBackward: () => void
	jumpToSection: (section: number) => void
	getCfiPreviewText: (cfi: string) => Promise<string | null>
	searchEntireBook: (query: string) => Promise<SpineSearchResult[]>
	onGoToCfi: (cfi: string) => void
}

export type SpineSearchResult = {
	results: SearchResult[]
	spineIndex: number
}

export type SearchResult = {
	cfi: string
	excerpt: string
}

export type EpubReaderContextProps = {
	readerMeta: EpubReaderMeta
	controls: EpubReaderControls
}

export const EpubReaderContext = createContext<EpubReaderContextProps>({
	controls: {
		fullscreen: false,
		getCfiPreviewText: async () => null,
		isReadAloudActive: false,
		isReadAloudPaused: false,
		onGoToCfi: noop,
		onLinkClick: noop,
		onMouseEnterControls: noop,
		onMouseLeaveControls: noop,
		onPaginateBackward: noop,
		onPaginateForward: noop,
		onPauseReadAloud: noop,
		onResumeReadAloud: noop,
		onSetReadAloudPitch: noop,
		onSetReadAloudRate: noop,
		onSetReadAloudVoiceUri: noop,
		onToggleReadAloud: noop,
		jumpToSection: noop,
		readAloudCurrentSentence: null,
		readAloudPitch: 1,
		readAloudSupported: false,
		readAloudRate: 1,
		readAloudVoiceUri: null,
		readAloudVoices: [],
		searchEntireBook: async () => [],
		setFullscreen: noop,
		setVisible: noop,
		visible: false,
	},
	readerMeta: {
		bookEntity: {} as ImageReaderBookRef,
		bookMeta: null,
		progress: null,
	},
})
export const useEpubReaderContext = () => useContext<EpubReaderContextProps>(EpubReaderContext)
export const useEpubReaderControls = () => useEpubReaderContext().controls
