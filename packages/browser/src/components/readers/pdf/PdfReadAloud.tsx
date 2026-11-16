import { useSDK } from '@stump/client'
import { useLocaleContext } from '@stump/i18n'
import { PdfPageText } from '@stump/sdk'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Pause, Volume2, VolumeX } from 'lucide-react'
import {
	createContext,
	PropsWithChildren,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react'
import { toast } from 'sonner'

import ControlButton from '../imageBased/container/ControlButton'
import { ImageReaderExtension, useImageBaseReaderContext } from '../imageBased/context'
import ReadAloudSettingsPanel from '../readAloud/ReadAloudSettingsPanel'
import { ReadAloudController, useReadAloud } from '../readAloud/useReadAloud'
import { buildPdfSentences, PdfSentence, sentenceRects } from './pdfReadAloudText'

/** Pages without text (e.g. scans without OCR) skipped in a row before giving up */
const MAX_EMPTY_PAGES = 5

type PdfReadAloudContextValue = {
	tts: ReadAloudController
	/** Read aloud is on (it may be waiting for the text of the page) */
	isEnabled: boolean
	toggle: () => void
	/** The page being read and the sentence being spoken on it */
	page: number
	currentSentence: PdfSentence | null
	pageText?: PdfPageText
}

const PdfReadAloudContext = createContext<PdfReadAloudContextValue | null>(null)

const usePdfReadAloud = () => useContext(PdfReadAloudContext)

/**
 * Reads the current page aloud, sentence by sentence, then turns to the next page and
 * goes on. Uses the text layer the server extracts from the PDF.
 */
function PdfReadAloudProvider({ children }: PropsWithChildren) {
	const { t } = useLocaleContext()
	const { sdk } = useSDK()
	const client = useQueryClient()
	const { book, currentPage, setCurrentPage } = useImageBaseReaderContext()

	const [isEnabled, setIsEnabled] = useState(false)
	// bumped to (re)start reading the current page
	const [startToken, setStartToken] = useState(0)
	const emptyPagesRef = useRef(0)

	const { data: pageText } = useQuery({
		queryKey: ['pdfPageText', book.id, currentPage],
		queryFn: () => sdk.media.getPdfPageText(book.id, currentPage),
		enabled: isEnabled,
		staleTime: Infinity,
	})
	const sentences = useMemo(() => (pageText ? buildPdfSentences(pageText.spans) : null), [pageText])

	const advanceRef = useRef<() => void>(() => {})
	const tts = useReadAloud({ onQueueEnd: () => advanceRef.current() })
	const ttsRef = useRef(tts)

	const finish = useCallback(() => {
		ttsRef.current.stop()
		setIsEnabled(false)
	}, [])

	const advance = useCallback(() => {
		if (currentPage < book.pages) {
			setCurrentPage(currentPage + 1)
		} else {
			finish()
		}
	}, [book.pages, currentPage, finish, setCurrentPage])

	useEffect(() => {
		ttsRef.current = tts
		advanceRef.current = advance
	}, [tts, advance])

	// warm up the text of the next page while this one is read
	useEffect(() => {
		if (!isEnabled || currentPage >= book.pages) return
		const next = currentPage + 1
		void client.prefetchQuery({
			queryKey: ['pdfPageText', book.id, next],
			queryFn: () => sdk.media.getPdfPageText(book.id, next),
			staleTime: Infinity,
		})
	}, [book.id, book.pages, client, currentPage, isEnabled, sdk])

	useEffect(() => {
		if (!isEnabled) return
		if (!sentences) {
			// the page changed: stop until its text is here
			ttsRef.current.stop()
			return
		}
		if (!sentences.length) {
			emptyPagesRef.current += 1
			if (emptyPagesRef.current > MAX_EMPTY_PAGES || currentPage >= book.pages) {
				emptyPagesRef.current = 0
				toast.error(t('reader.toasts.noReadableText'))
				finish()
			} else {
				advanceRef.current()
			}
			return
		}
		emptyPagesRef.current = 0
		ttsRef.current.play(sentences.map((sentence) => sentence.text))
	}, [isEnabled, sentences, startToken]) // eslint-disable-line react-hooks/exhaustive-deps

	const isReading = isEnabled && tts.isActive
	const toggle = useCallback(() => {
		if (isReading) {
			finish()
		} else {
			emptyPagesRef.current = 0
			setIsEnabled(true)
			setStartToken((token) => token + 1)
		}
	}, [finish, isReading])

	const currentSentence =
		isReading && tts.currentIndex != null ? (sentences?.[tts.currentIndex] ?? null) : null

	return (
		<PdfReadAloudContext.Provider
			value={{
				tts,
				isEnabled,
				toggle,
				page: currentPage,
				currentSentence,
				pageText,
			}}
		>
			{children}
		</PdfReadAloudContext.Provider>
	)
}

function PdfReadAloudToggle() {
	const { t } = useLocaleContext()
	const context = usePdfReadAloud()
	if (!context?.tts.supported) return null

	const { tts, isEnabled, toggle } = context
	const isReading = isEnabled && tts.isActive
	return (
		<ControlButton
			title={isReading ? t('reader.stopReadAloud') : t('reader.readAloud')}
			onClick={toggle}
		>
			{!isReading && <Volume2 className="h-4 w-4" />}
			{isReading && tts.isPaused && <Pause className="h-4 w-4" />}
			{isReading && !tts.isPaused && <VolumeX className="h-4 w-4" />}
		</ControlButton>
	)
}

function PdfReadAloudSettings() {
	const context = usePdfReadAloud()
	if (!context) return null

	const { tts, currentSentence } = context
	return (
		<ReadAloudSettingsPanel
			supported={tts.supported}
			serverAvailable={tts.serverAvailable}
			engine={tts.engine}
			voices={tts.voices}
			voiceUri={tts.voiceUri}
			rate={tts.rate}
			pitch={tts.pitch}
			isActive={tts.isActive}
			isPaused={tts.isPaused}
			currentSentence={currentSentence?.text}
			onSetEngine={tts.setEngine}
			onSetVoiceUri={tts.setVoiceUri}
			onSetRate={tts.setRate}
			onSetPitch={tts.setPitch}
			onPause={tts.pause}
			onResume={tts.resume}
		/>
	)
}

/** Marks the sentence being spoken on `page` */
function PdfReadAloudHighlight({ page }: { page: number }) {
	const context = usePdfReadAloud()
	const sentence = context?.page === page ? context.currentSentence : null
	const pageText = context?.pageText

	const rects = useMemo(
		() =>
			sentence && pageText
				? sentenceRects(sentence, pageText.spans, pageText.width, pageText.height)
				: [],
		[sentence, pageText],
	)

	return (
		<>
			{rects.map((rect, index) => (
				<div
					key={index}
					className="bg-yellow-300/45 absolute rounded-[2px] mix-blend-multiply transition-all duration-150"
					style={{
						left: `${rect.left}%`,
						top: `${rect.top}%`,
						width: `${rect.width}%`,
						height: `${rect.height}%`,
						transform: rect.angle ? `rotate(${rect.angle}rad)` : undefined,
						transformOrigin: '0 0',
					}}
				/>
			))}
		</>
	)
}

/** Read aloud for the image-based reader, when it shows the pages of a PDF */
export const pdfReadAloudExtension: ImageReaderExtension = {
	Provider: PdfReadAloudProvider,
	renderPageOverlay: (page) => <PdfReadAloudHighlight page={page} />,
	headerControls: <PdfReadAloudToggle />,
	settings: <PdfReadAloudSettings />,
}
