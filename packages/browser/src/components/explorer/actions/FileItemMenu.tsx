import { UseDirectoryListingFile } from '@stump/client'
import { ContextMenu, type ContextMenuItemGroup } from '@stump/components'
import { useLocaleContext } from '@stump/i18n'
import { Pencil, Trash2 } from 'lucide-react'
import { type ReactElement, useMemo } from 'react'

import { useFileExplorerContext } from '../context'

type Props = {
	file: UseDirectoryListingFile
	children: ReactElement
}

export default function FileItemMenu({ file, children }: Props) {
	const { t } = useLocaleContext()
	const { canManageFiles, openRename, openDelete } = useFileExplorerContext()

	const groups = useMemo<ContextMenuItemGroup[]>(
		() => [
			{
				items: [
					{
						label: t('fileExplorer.actions.rename'),
						leftIcon: <Pencil className="mr-2 h-4 w-4" />,
						onClick: () => openRename(file),
					},
					{
						label: t('fileExplorer.actions.delete'),
						leftIcon: <Trash2 className="mr-2 h-4 w-4" />,
						isDestructive: true,
						onClick: () => openDelete(file),
					},
				],
			},
		],
		[file, openDelete, openRename, t],
	)

	if (!canManageFiles) {
		return children
	}

	return <ContextMenu groups={groups}>{children}</ContextMenu>
}
