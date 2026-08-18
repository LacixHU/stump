import { EBOOK_EXTENSION } from '@stump/client'
import { ButtonOrLink } from '@stump/components'
import { BookCardFragment } from '@stump/graphql'
import { useLocaleContext } from '@stump/i18n'
import { useMemo } from 'react'

import { usePaths } from '@/paths'

type Props = {
	book: BookCardFragment
}

export default function BookReaderLink({ book }: Props) {
	const paths = usePaths()
	const { t } = useLocaleContext()

	const isReadAgain = useMemo(() => isReadAgainPrompt(book), [book])

	const epubcfi = book?.readProgress?.epubcfi
	const currentPage = book.readProgress?.page ?? -1
	const title = useMemo(() => {
		if (isReadAgain) {
			return t('bookActions.readAgain')
		} else if (currentPage > 0 || !!epubcfi) {
			return t('bookActions.continueReading')
		} else {
			return t('bookActions.read')
		}
	}, [isReadAgain, currentPage, epubcfi, t])

	const readUrl = useMemo(() => {
		const { id, readProgress, extension } = book
		const { epubcfi, page } = readProgress || {}

		if (epubcfi || extension.match(EBOOK_EXTENSION)) {
			return paths.bookReader(id, {
				epubcfi: isReadAgain ? undefined : epubcfi,
				isEpub: true,
			})
		} else {
			return paths.bookReader(id, { page: isReadAgain ? 1 : page || 1 })
		}
	}, [book, isReadAgain, paths])

	return (
		<ButtonOrLink className="w-full" href={readUrl} title={title}>
			{title}
		</ButtonOrLink>
	)
}

export const isReadAgainPrompt = (
	book: Pick<BookCardFragment, 'pages' | 'readProgress' | 'readHistory' | 'extension'>,
) => {
	const { readProgress, readHistory } = book

	const isHistoricallyCompleted = readHistory?.some((h) => h.completedAt) ?? false

	return isHistoricallyCompleted && !readProgress
}
