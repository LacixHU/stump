import {
	invalidateQueries,
	queryClient,
	useGraphQLMutation,
	useGraphQLUploadMutation,
} from '@stump/client'
import { Button, Dialog, Label, PickSelect, Text } from '@stump/components'
import {
	extractErrorMessage,
	graphql,
	LibraryThumbnailSelectorUpdateMutation,
} from '@stump/graphql'
import { useLocaleContext } from '@stump/i18n'
import { Suspense, useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'

import EditThumbnailDropdown from '@/components/thumbnail/EditThumbnailDropdown'
import BookPageGrid from '@/scenes/book/settings/BookPageGrid'
import SeriesBookGrid, { SelectedBook } from '@/scenes/series/tabs/settings/SeriesBookGrid'

import { useLibraryManagement } from '../../context'
import LibrarySeriesGrid, { SelectedSeries } from '../../LibrarySeriesGrid'

// TODO: Redesign this ugly shit

const updateMutation = graphql(`
	mutation LibraryThumbnailSelectorUpdate($id: ID!, $input: UpdateThumbnailInput!) {
		updateLibraryThumbnail(id: $id, input: $input) {
			id
			thumbnail {
				url
			}
		}
	}
`)

const uploadMutation = graphql(`
	mutation LibraryThumbnailSelectorUpload($id: ID!, $file: Upload!) {
		uploadLibraryThumbnail(id: $id, file: $file) {
			id
			thumbnail {
				url
			}
		}
	}
`)

const regenerateMutation = graphql(`
	mutation LibraryThumbnailSelectorRegenerate($id: ID!) {
		regenerateLibraryThumbnail(id: $id) {
			id
			thumbnail {
				url
			}
		}
	}
`)

type OnSuccessData = PickSelect<LibraryThumbnailSelectorUpdateMutation, 'updateLibraryThumbnail'>

export default function LibraryThumbnailSelector() {
	const { t } = useLocaleContext()

	const [selectedSeries, setSelectedSeries] = useState<SelectedSeries>()
	const [selectedBook, setSelectedBook] = useState<SelectedBook>()
	const [page, setPage] = useState<number>()

	const [isOpen, setIsOpen] = useState(false)

	const { library } = useLibraryManagement()

	const onSuccess = useCallback(async ({ thumbnail }: OnSuccessData) => {
		const baseUrl = thumbnail.url.split('?')[0] ?? thumbnail.url
		await queryClient.removeQueries({
			predicate: ({ queryKey }) =>
				queryKey[0] === 'AuthImage.fetchImage' &&
				typeof queryKey[1] === 'string' &&
				queryKey[1].startsWith(baseUrl),
		})
		await invalidateQueries({
			keys: ['libraryById', 'libraryOverview', 'libraries', 'lastVisitedLibrary', 'sidebar'],
		})
	}, [])

	const { mutateAsync: patchThumbnail, isPending: isPatchingThumbnail } = useGraphQLMutation(
		updateMutation,
		{
			onSuccess: (data) => onSuccess(data.updateLibraryThumbnail),
		},
	)

	const { mutateAsync: uploadThumbnail, isPending: isUploadingThumbnail } =
		useGraphQLUploadMutation(uploadMutation, {
			onSuccess: (data) => onSuccess(data.uploadLibraryThumbnail),
		})

	const { mutateAsync: regenerateThumbnail, isPending: isRegenerating } = useGraphQLMutation(
		regenerateMutation,
		{
			onSuccess: (data) => onSuccess(data.regenerateLibraryThumbnail),
		},
	)

	const handleOpenChange = (nowOpen: boolean) => {
		if (!nowOpen) {
			setIsOpen(false)
		}
	}

	const handleCancel = () => {
		if (page) {
			setPage(undefined)
		}
		setIsOpen(false)
	}

	const handleUploadImage = useCallback(
		async (file: File) => {
			try {
				await uploadThumbnail({ id: library.id, file })
				setIsOpen(false)
			} catch (error) {
				console.error(error)
				const message = error instanceof Error ? error.message : 'Failed to upload image'
				toast.error(message)
			}
		},
		[library.id, uploadThumbnail],
	)

	const handleRegenerate = useCallback(async () => {
		try {
			await regenerateThumbnail({ id: library.id })
			toast.success(t('thumbnailDropdown.regenerated'))
		} catch (error) {
			console.error(error)
			// The server says *why* -- most often that the game has no sidecar cover and no
			// Wikipedia match for its system -- and that is the only actionable part.
			toast.error(t('thumbnailDropdown.regenerateFailed'), {
				description: extractErrorMessage(error),
			})
		}
	}, [library.id, regenerateThumbnail, t])

	const handleConfirm = useCallback(async () => {
		if (!selectedBook || !page) return

		try {
			await patchThumbnail({ id: library.id, input: { mediaId: selectedBook.id, page } })
			setIsOpen(false)
		} catch (error) {
			console.error(error)
			toast.error('Failed to update thumbnail')
		}
	}, [patchThumbnail, selectedBook, page, library.id])

	useEffect(() => {
		return () => {
			setSelectedSeries(undefined)
			setSelectedBook(undefined)
			setPage(undefined)
		}
	}, [isOpen])

	const renderContent = () => {
		if (selectedBook) {
			return (
				<BookPageGrid
					bookId={selectedBook.id}
					pages={selectedBook.pages}
					selectedPage={page}
					onSelectPage={setPage}
				/>
			)
		} else if (selectedSeries) {
			return <SeriesBookGrid seriesId={selectedSeries.id} onSelectBook={setSelectedBook} />
		} else {
			return <LibrarySeriesGrid libraryId={library.id} onSelectSeries={setSelectedSeries} />
		}
	}

	const renderDescription = () => {
		if (selectedBook) {
			return 'Choose a page from this book to use as the new thumbnail'
		} else if (selectedSeries) {
			return 'Select a book from the series'
		} else {
			return 'Select a series from the library'
		}
	}

	const renderGoBack = () => {
		if (!selectedBook && !selectedSeries) return null

		return (
			<span
				className="ml-2 cursor-pointer underline"
				onClick={() => {
					setPage(undefined)
					if (selectedBook) {
						setSelectedBook(undefined)
					} else if (selectedSeries) {
						setSelectedSeries(undefined)
					}
				}}
			>
				Go back
			</span>
		)
	}

	return (
		<div className="gap-4 flex flex-col">
			<div>
				<Label>Select thumbnail</Label>
				<Text size="sm" variant="muted">
					Choose a different thumbnail for this library, either from a book or upload a custom one
				</Text>
			</div>

			<div>
				<EditThumbnailDropdown
					onChooseSelector={() => setIsOpen(true)}
					onUploadImage={handleUploadImage}
					onRegenerate={handleRegenerate}
					isRegenerating={isRegenerating}
				/>
			</div>

			<Dialog open={isOpen} onOpenChange={handleOpenChange}>
				<Dialog.Content size="xl">
					<Dialog.Header>
						<Dialog.Title>Select a thumbnail</Dialog.Title>
						<Dialog.Description>
							{renderDescription()}
							{renderGoBack()}
						</Dialog.Description>
						<Dialog.Close onClick={() => setIsOpen(false)} />
					</Dialog.Header>

					<Suspense>{renderContent()}</Suspense>
					<Dialog.Footer>
						<Button variant="outline" onClick={handleCancel}>
							Cancel
						</Button>
						<Button
							onClick={handleConfirm}
							disabled={!selectedSeries || !selectedBook || !page}
							isLoading={isPatchingThumbnail || isUploadingThumbnail}
						>
							Confirm selection
						</Button>
					</Dialog.Footer>
				</Dialog.Content>
			</Dialog>
		</div>
	)
}
