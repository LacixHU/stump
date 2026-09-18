import { UseDirectoryListingFile, useGraphQLMutation } from '@stump/client'
import { Button, Dialog, Input } from '@stump/components'
import { extractErrorMessage } from '@stump/graphql'
import { useLocaleContext } from '@stump/i18n'
import { FormEvent, useEffect, useState } from 'react'
import { toast } from 'sonner'

import { useFileExplorerContext } from '../context'
import { renamePathMutation } from './operations'

type Props = {
	file: UseDirectoryListingFile | null
	onClose: () => void
}

export default function RenameDialog({ file, onClose }: Props) {
	const { t } = useLocaleContext()
	const { libraryID, refetch } = useFileExplorerContext()
	const [name, setName] = useState('')

	const { mutateAsync: renamePath, isPending } = useGraphQLMutation(renamePathMutation)

	useEffect(() => {
		setName(file?.name ?? '')
	}, [file])

	const handleSubmit = async (event: FormEvent) => {
		event.preventDefault()
		if (!file || !name.trim() || name.trim() === file.name) return

		try {
			await renamePath({
				input: {
					libraryId: libraryID,
					path: file.path,
					newName: name.trim(),
				},
			})
			await refetch()
			toast.success(t(getKey('toasts.renamed')))
			onClose()
		} catch (error) {
			toast.error(extractErrorMessage(error))
		}
	}

	return (
		<Dialog open={!!file} onOpenChange={(open) => !open && !isPending && onClose()}>
			<Dialog.Content size="sm">
				<form onSubmit={handleSubmit}>
					<Dialog.Header>
						<Dialog.Title>{t(getKey('title'))}</Dialog.Title>
						<Dialog.Description>{t(getKey('description'))}</Dialog.Description>
					</Dialog.Header>

					<div className="py-2">
						<Input autoFocus value={name} onChange={(event) => setName(event.target.value)} />
					</div>

					<Dialog.Footer>
						<Button type="button" variant="outline" onClick={onClose} disabled={isPending}>
							{t('common.cancel')}
						</Button>
						<Button
							type="submit"
							disabled={!file || !name.trim() || name.trim() === file.name}
							isLoading={isPending}
						>
							{t(getKey('confirm'))}
						</Button>
					</Dialog.Footer>
				</form>
			</Dialog.Content>
		</Dialog>
	)
}

const LOCALE_BASE = 'fileExplorer.rename'
const getKey = (key: string) => `${LOCALE_BASE}.${key}`
