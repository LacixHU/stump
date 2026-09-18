import GenericEmptyState from '@/components/GenericEmptyState'

import { ExplorerDropzone } from './actions'
import { useFileExplorerContext } from './context'
import { FileGrid } from './grid'
import { FileTable } from './table'

export default function FileExplorer() {
	const { files, layout } = useFileExplorerContext()

	const content = !files.length ? (
		<div className="px-4 flex h-full w-full items-center justify-center">
			<GenericEmptyState title="No files" subtitle="This folder is empty" />
		</div>
	) : layout === 'grid' ? (
		<FileGrid />
	) : (
		<FileTable />
	)

	return <ExplorerDropzone>{content}</ExplorerDropzone>
}
