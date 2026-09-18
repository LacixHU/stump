import { useGraphQLUploadMutation } from '@stump/client'
import { cn, ProgressBar } from '@stump/components'
import { extractErrorMessage } from '@stump/graphql'
import { useLocaleContext } from '@stump/i18n'
import { AxiosProgressEvent } from 'axios'
import { Upload } from 'lucide-react'
import { type ReactNode, useCallback, useMemo, useState } from 'react'
import { FileRejection, useDropzone } from 'react-dropzone'
import { toast } from 'sonner'

import { useFileExplorerContext } from '../context'
import { uploadFilesMutation } from './operations'

type Props = {
	children: ReactNode
}

export default function ExplorerDropzone({ children }: Props) {
	const { t } = useLocaleContext()
	const { currentPath, libraryID, refetch, uploadConfig, canManageFiles } = useFileExplorerContext()
	const [uploadProgress, setUploadProgress] = useState(0)

	const config = useMemo(
		() => ({
			onUploadProgress: ({ loaded, total }: AxiosProgressEvent) => {
				if (!total || total <= 0) {
					setUploadProgress(0)
					return
				}
				setUploadProgress(Math.round((loaded * 100) / total))
			},
		}),
		[],
	)

	const { mutateAsync: uploadFiles, isPending } = useGraphQLUploadMutation(uploadFilesMutation, {
		config,
		onSuccess: () => refetch(),
	})

	const handleDrop = useCallback(
		async (acceptedFiles: File[], rejections: FileRejection[]) => {
			if (rejections.length) {
				toast.error(t('fileExplorer.dropzone.rejected'))
			}

			if (!acceptedFiles.length || !currentPath) {
				return
			}

			setUploadProgress(0)

			try {
				await uploadFiles({
					input: {
						uploads: acceptedFiles,
						placeAt: currentPath,
						libraryId: libraryID,
					},
				})
				toast.success(t('fileExplorer.dropzone.success'))
			} catch (error) {
				toast.error(extractErrorMessage(error))
			} finally {
				setUploadProgress(0)
			}
		},
		[currentPath, libraryID, t, uploadFiles],
	)

	const enabled = canManageFiles && !!currentPath && !isPending
	const maxSize = uploadConfig?.maxFileUploadSize

	const { getRootProps, getInputProps, isDragActive } = useDropzone({
		disabled: !enabled,
		maxSize: maxSize && maxSize > 0 ? maxSize : undefined,
		multiple: true,
		noClick: true,
		noKeyboard: true,
		onDrop: handleDrop,
	})

	if (!canManageFiles) {
		return <>{children}</>
	}

	return (
		<div {...getRootProps()} className="min-h-0 relative flex h-full w-full flex-1 flex-col">
			<input {...getInputProps()} />
			{children}
			{(isDragActive || isPending) && (
				<div className="inset-0 pointer-events-none absolute z-20 flex items-center justify-center bg-background/80">
					<div
						className={cn(
							'gap-2 p-6 flex flex-col items-center rounded-lg border border-dashed border-border bg-muted/80',
						)}
					>
						<Upload className="h-8 w-8 text-muted-foreground" />
						<span className="text-sm font-medium">
							{isPending ? t('fileExplorer.dropzone.uploading') : t('fileExplorer.dropzone.active')}
						</span>
						{isPending && (
							<div className="h-4 w-64 flex items-center justify-center">
								<ProgressBar
									value={uploadProgress}
									isIndeterminate={uploadProgress === 0}
									className="h-1.5 rounded-lg"
									max={100}
								/>
							</div>
						)}
					</div>
				</div>
			)}
		</div>
	)
}
