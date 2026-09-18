import { IconButton, ToolTip } from '@stump/components'
import { useLocaleContext } from '@stump/i18n'
import { FolderPlus } from 'lucide-react'

import { useFileExplorerContext } from './context'
import FileExplorerNavigation from './FileExplorerNavigation'
import LayoutButtons from './LayoutButtons'
import { UploadModal } from './upload'

export const HEADER_HEIGHT = 40

export default function FileExplorerHeader() {
	const { t } = useLocaleContext()
	const { uploadConfig, canManageFiles, openCreateFolder } = useFileExplorerContext()

	return (
		<header className="top-0 h-10 px-4 md:border-y-0 md:border-b sticky z-10 flex w-full justify-between border-y border-border bg-background">
			<nav className="h-10 gap-2 flex items-center">
				<FileExplorerNavigation />
			</nav>

			<div className="gap-3 flex shrink-0 items-center">
				<LayoutButtons />
				{canManageFiles && (
					<ToolTip content={t('fileExplorer.actions.createFolder')} side="left" size="sm">
						<IconButton
							variant="ghost"
							size="xs"
							className="hover:bg-accent"
							onClick={openCreateFolder}
						>
							<FolderPlus className="h-4 w-4" />
						</IconButton>
					</ToolTip>
				)}
				{uploadConfig?.enabled && <UploadModal />}
			</div>
		</header>
	)
}
