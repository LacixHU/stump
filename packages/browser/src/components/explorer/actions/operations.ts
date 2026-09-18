import { graphql } from '@stump/graphql'

export const createDirectoryMutation = graphql(`
	mutation CreateExplorerDirectory($input: CreateDirectoryInput!) {
		createDirectory(input: $input)
	}
`)

export const renamePathMutation = graphql(`
	mutation RenameExplorerPath($input: RenamePathInput!) {
		renamePath(input: $input)
	}
`)

export const deletePathMutation = graphql(`
	mutation DeleteExplorerPath($input: DeletePathInput!) {
		deletePath(input: $input)
	}
`)

export const uploadFilesMutation = graphql(`
	mutation UploadExplorerFiles($input: UploadFilesInput!) {
		uploadFiles(input: $input)
	}
`)
