import { useSDK, useSuspenseGraphQL } from '@stump/client'
import { Suspense, useCallback } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'

import NativePDFViewer from '@/components/readers/pdf/NativePDFViewer'
import { usePaths } from '@/paths'

import { BOOK_READER_SCENE_QUERY } from './BookReaderScene'

export default function PDFReaderScene() {
	const { id } = useParams()

	if (!id) {
		throw new Error('Media ID is required')
	}

	return (
		<Suspense>
			<PDFReaderSceneContent id={id} />
		</Suspense>
	)
}

type ContentProps = {
	id: string
}

function PDFReaderSceneContent({ id }: ContentProps) {
	const { sdk } = useSDK()
	const [search, setSearch] = useSearchParams()
	const navigate = useNavigate()
	const paths = usePaths()

	const {
		data: { mediaById: media },
	} = useSuspenseGraphQL(BOOK_READER_SCENE_QUERY, sdk.cacheKey('bookReader', [id]), { id })

	const isPaged = search.get('paged') === 'true'
	const page = parseInt(search.get('page') || '1', 10) || 1
	const totalPages = media?.pages || 1
	const exitUrl = paths.bookOverview(id)

	const handlePageChange = useCallback(
		(newPage: number) => {
			setSearch((prev) => {
				const next = new URLSearchParams(prev)
				next.set('page', String(newPage))
				return next
			})
		},
		[setSearch],
	)

	return (
		<NativePDFViewer
			id={id}
			isPaged={isPaged}
			page={page}
			totalPages={totalPages}
			title={media?.resolvedName}
			exitUrl={exitUrl}
			onPageChange={handlePageChange}
		/>
	)
}
