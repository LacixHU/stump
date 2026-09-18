import { useGraphQLMutation } from '@stump/client'
import { Button, Dialog, Input } from '@stump/components'
import { extractErrorMessage } from '@stump/graphql'
import { useLocaleContext } from '@stump/i18n'
import { FormEvent, useEffect, useState } from 'react'
import { toast } from 'sonner'

import { useFileExplorerContext } from '../context'
import { createDirectoryMutation } from './operations'

type Props = {
	isOpen: boolean
	onClose: () => void
}

export default function CreateFolderDialog({ isOpen, onClose }: Props) {
	const { t } = useLocaleContext()
	const { currentPath, libraryID, refetch } = useFileExplorerContext()
	const [name, setName] = useState('')

	const { mutateAsync: createDirectory, isPending } = useGraphQLMutation(createDirectoryMutation)

	useEffect(() => {
		if (!isOpen) {
			setName('')
		}
	}, [isOpen])

	const handleSubmit = async (event: FormEvent) => {
		event.preventDefault()
		if (!currentPath || !name.trim()) return

		try {
			await createDirectory({
				input: {
					libraryId: libraryID,
					placeAt: currentPath,
					name: name.trim(),
				},
			})
			await refetch()
			toast.success(t(getKey('toasts.created')))
			onClose()
		} catch (error) {
			toast.error(extractErrorMessage(error))
		}
	}

	return (
		<Dialog open={isOpen} onOpenChange={(open) => !open && !isPending && onClose()}>
			<Dialog.Content size="sm">
				<form onSubmit={handleSubmit}>
					<Dialog.Header>
						<Dialog.Title>{t(getKey('title'))}</Dialog.Title>
						<Dialog.Description>{t(getKey('description'))}</Dialog.Description>
					</Dialog.Header>

					<div className="py-2">
						<Input
							autoFocus
							placeholder={t(getKey('placeholder'))}
							value={name}
							onChange={(event) => setName(event.target.value)}
						/>
					</div>

					<Dialog.Footer>
						<Button type="button" variant="outline" onClick={onClose} disabled={isPending}>
							{t('common.cancel')}
						</Button>
						<Button type="submit" disabled={!name.trim() || !currentPath} isLoading={isPending}>
							{t('common.create')}
						</Button>
					</Dialog.Footer>
				</form>
			</Dialog.Content>
		</Dialog>
	)
}

const LOCALE_BASE = 'fileExplorer.createFolder'
const getKey = (key: string) => `${LOCALE_BASE}.${key}`
