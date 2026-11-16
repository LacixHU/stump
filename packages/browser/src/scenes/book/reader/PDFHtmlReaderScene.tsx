import { useGraphQLMutation, useSDK, useSuspenseGraphQL } from '@stump/client'
import { ButtonOrLink, ProgressSpinner, Text } from '@stump/components'
import { BookReaderSceneQuery, ReadingMode } from '@stump/graphql'
import { useLocaleContext } from '@stump/i18n'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'

import { ImageBasedReader } from '@/components/readers/imageBased'
import { pdfReadAloudExtension } from '@/components/readers/pdf/PdfReadAloud'
import paths from '@/paths'

import { BOOK_READER_SCENE_QUERY, UPDATE_READ_PROGRESS_MUTATION } from './BookReaderScene'
import { useBookPreferences } from './useBookPreferences'

const THUMBNAIL_SIZE = 240
const READER_PARAMS = { isPdfHtml: true }

/**
 * Reads a PDF with the image-based (comic) reader, the pages being vector SVGs converted
 * by the server without PDFium, plus read aloud from the PDF's text layer.
 */
export default function PDFHtmlReaderScene() {
	const navigate = useNavigate()
	const { id } = useParams()
	const { sdk } = useSDK()

	const {
		data: { mediaById: book },
	} = useSuspenseGraphQL(BOOK_READER_SCENE_QUERY, sdk.cacheKey('bookReader', [id]), {
		id: id || '',
	})

	useEffect(() => {
		if (!book) {
			navigate(paths.notFound(), { replace: true })
		}
	}, [book, navigate])

	if (!book) {
		return null
	}

	return <PdfReader book={book} />
}

type Book = NonNullable<BookReaderSceneQuery['mediaById']>

function PdfReader({ book }: { book: Book }) {
	const { t } = useLocaleContext()
	const navigate = useNavigate()
	const [search] = useSearchParams()
	const { sdk } = useSDK()
	const client = useQueryClient()

	const isIncognito = search.get('incognito') === 'true'
	const pageParam = parseInt(search.get('page') || '', 10)
	const initialPage = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : undefined

	const { data: info, isError } = useQuery({
		queryKey: ['pdfHtmlInfo', book.id],
		queryFn: () => sdk.media.getPdfInfo(book.id),
		staleTime: Infinity,
	})

	const {
		bookPreferences: { readingMode, animatedReader },
	} = useBookPreferences({ book })

	// the paged reader takes its page from the URL
	useEffect(() => {
		if (!info) return
		const pageCount = Math.max(1, info.pageCount)
		const resumeAt = Math.min(Math.max(1, book.readProgress?.page || 1), pageCount)
		if (!initialPage && readingMode === ReadingMode.Paged && !animatedReader) {
			navigate(paths.bookReader(book.id, { ...READER_PARAMS, isIncognito, page: resumeAt }), {
				replace: true,
			})
		} else if (initialPage && initialPage > pageCount) {
			navigate(paths.bookReader(book.id, { ...READER_PARAMS, isIncognito, page: pageCount }), {
				replace: true,
			})
		}
	}, [info, initialPage, readingMode, animatedReader, book, isIncognito, navigate])

	const lastSyncedElapsedRef = useRef(book.readProgress?.elapsedSeconds ?? 0)
	const pendingSyncedElapsedRef = useRef(book.readProgress?.elapsedSeconds ?? 0)
	const lastSyncedPageRef = useRef(book.readProgress?.page)

	const { mutate } = useGraphQLMutation(UPDATE_READ_PROGRESS_MUTATION, {
		onError: (err) => console.error(err),
		onSuccess: () => {
			lastSyncedElapsedRef.current = pendingSyncedElapsedRef.current
		},
	})

	const updateProgress = useCallback(
		(page: number, elapsedSeconds: number) => {
			if (isIncognito || lastSyncedPageRef.current === page) return
			lastSyncedPageRef.current = page

			const delta = Math.max(0, elapsedSeconds - lastSyncedElapsedRef.current)
			pendingSyncedElapsedRef.current = elapsedSeconds
			mutate({
				id: book.id,
				input: {
					paged: {
						page,
						elapsedSecondsDelta: delta > 0 ? delta : undefined,
					},
				},
			})
		},
		[book.id, isIncognito, mutate],
	)

	// refresh "continue reading" lists when leaving the reader
	useEffect(() => {
		return () => {
			client.invalidateQueries({ exact: false, queryKey: [sdk.cacheKeys.inProgress] })
		}
	}, [sdk, client])

	// The page count and sizes from the PDF itself: the pages are laid out (and double
	// spreads paired) before any of them has loaded
	const media = useMemo(
		() =>
			info
				? {
						...book,
						pages: Math.max(1, info.pageCount),
						analysisData: {
							...book.analysisData,
							dimensions: info.pages.map(({ width, height }) => ({ width, height })),
						},
					}
				: null,
		[book, info],
	)

	const pageUrl = useCallback(
		(page: number) => sdk.media.pdfPageSvgURL(book.id, page),
		[sdk, book.id],
	)
	const thumbnailUrl = useCallback(
		(page: number) => sdk.media.pdfThumbnailURL(book.id, page, THUMBNAIL_SIZE),
		[sdk, book.id],
	)

	if (isError) {
		return (
			<div className="gap-4 p-4 flex h-[100dvh] w-full flex-col items-center justify-center text-center">
				<Text>{t('reader.pdfHtml.failedToOpen')}</Text>
				<ButtonOrLink variant="secondary" href={paths.bookOverview(book.id)}>
					{t('reader.goToMediaOverview')}
				</ButtonOrLink>
			</div>
		)
	}

	if (!media) {
		return (
			<div className="flex h-[100dvh] w-full items-center justify-center">
				<ProgressSpinner size="lg" />
			</div>
		)
	}

	return (
		<ImageBasedReader
			media={media}
			isIncognito={isIncognito}
			initialPage={initialPage}
			onProgress={updateProgress}
			pageUrl={pageUrl}
			thumbnailUrl={thumbnailUrl}
			readerParams={READER_PARAMS}
			extension={pdfReadAloudExtension}
		/>
	)
}
