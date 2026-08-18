import { useGraphQLMutation } from '@stump/client'
import {
	Alert,
	AlertDescription,
	AlertTitle,
	Button,
	ConfirmationModal,
	Heading,
	Text,
} from '@stump/components'
import { graphql } from '@stump/graphql'
import { useLocaleContext } from '@stump/i18n'
import { AlertTriangle } from 'lucide-react'
import { useCallback, useState } from 'react'
import { toast } from 'sonner'

import { useLibraryManagement } from '../../context'

const mutation = graphql(`
	mutation DeleteLibraryThumbnails($id: ID!) {
		deleteLibraryThumbnails(id: $id)
	}
`)

export default function DeleteLibraryThumbnails() {
	const { t } = useLocaleContext()
	const {
		library: { id },
	} = useLibraryManagement()

	// This is a naive way to prevent the user from deleting the thumbnails multiple times
	// in a row. I don't feel it would be worth it to implement a more robust solution.
	const [showConfirmation, setShowConfirmation] = useState(false)

	const { mutateAsync: deleteThumbnails, isPending, data } = useGraphQLMutation(mutation)

	const handleDeleteThumbnails = useCallback(async () => {
		try {
			await deleteThumbnails({ id })
			toast.success(t('libraryThumbnails.delete.success'))
		} catch (error) {
			console.error(error)
			const fallbackMessage = t('libraryThumbnails.delete.error')
			if (error instanceof Error) {
				toast.error(error.message || fallbackMessage)
			} else {
				toast.error(fallbackMessage)
			}
		}
	}, [id, deleteThumbnails, t])

	return (
		<>
			<div>
				<Heading size="sm">{t('libraryThumbnails.delete.heading')}</Heading>
				<Text size="sm" variant="muted">
					{t('libraryThumbnails.delete.description')}
				</Text>
			</div>

			<div className="flex">
				<Button
					variant="destructive"
					onClick={() => setShowConfirmation(true)}
					className="shrink-0"
					disabled={isPending || !!data}
				>
					{t('libraryThumbnails.delete.heading')}
				</Button>
			</div>

			<ConfirmationModal
				title={t('libraryThumbnails.delete.confirmTitle')}
				description={t('libraryThumbnails.delete.confirmDescription')}
				confirmText={t('libraryThumbnails.delete.heading')}
				cancelText={t('common.cancel')}
				confirmVariant="destructive"
				isOpen={showConfirmation && !data}
				onClose={() => setShowConfirmation(false)}
				onConfirm={handleDeleteThumbnails}
				confirmIsLoading={isPending}
				size="md"
			>
				<Alert variant="warning">
					<AlertTriangle />
					<AlertTitle>{t('common.thisCannotBeUndone')}</AlertTitle>
					<AlertDescription>{t('libraryThumbnails.delete.warning')}</AlertDescription>
				</Alert>
			</ConfirmationModal>
		</>
	)
}
