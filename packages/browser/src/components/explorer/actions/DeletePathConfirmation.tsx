import { UseDirectoryListingFile, useGraphQLMutation } from '@stump/client'
import { ConfirmationModal } from '@stump/components'
import { extractErrorMessage } from '@stump/graphql'
import { useLocaleContext } from '@stump/i18n'
import { toast } from 'sonner'

import { useFileExplorerContext } from '../context'
import { deletePathMutation } from './operations'

type Props = {
	file: UseDirectoryListingFile | null
	onClose: () => void
}

export default function DeletePathConfirmation({ file, onClose }: Props) {
	const { t } = useLocaleContext()
	const { libraryID, refetch } = useFileExplorerContext()

	const { mutateAsync: deletePath, isPending } = useGraphQLMutation(deletePathMutation)

	const handleConfirm = async () => {
		if (!file) return

		try {
			await deletePath({
				input: {
					libraryId: libraryID,
					path: file.path,
				},
			})
			await refetch()
			toast.success(t(getKey('toasts.deleted')))
			onClose()
		} catch (error) {
			toast.error(extractErrorMessage(error))
		}
	}

	const kind = file?.isDirectory ? 'directory' : 'file'

	return (
		<ConfirmationModal
			isOpen={!!file}
			title={t(getKey(`title.${kind}`), { name: file?.name })}
			description={t(getKey(`description.${kind}`), { name: file?.name })}
			confirmText={t('common.delete')}
			confirmVariant="destructive"
			confirmIsLoading={isPending}
			onClose={onClose}
			onConfirm={handleConfirm}
		/>
	)
}

const LOCALE_BASE = 'fileExplorer.delete'
const getKey = (key: string) => `${LOCALE_BASE}.${key}`
