import { useGraphQLMutation } from '@stump/client'
import { Button, DropdownMenu, Label, Text } from '@stump/components'
import { graphql } from '@stump/graphql'
import { useLocaleContext } from '@stump/i18n'
import { AlertTriangle, ChevronDown, ImagePlus } from 'lucide-react'
import { useCallback } from 'react'

import { useLibraryManagement } from '../../context'

const mutation = graphql(`
	mutation ProcessLibraryThumbnails($id: ID!, $forceRegenerate: Boolean!) {
		processLibraryThumbnails(id: $id, forceRegenerate: $forceRegenerate)
	}
`)

export default function ProcessLibraryThumbnails() {
	const { t } = useLocaleContext()
	const { library } = useLibraryManagement()

	const { mutate } = useGraphQLMutation(mutation)

	const process = useCallback(
		(force: boolean) => mutate({ id: library.id, forceRegenerate: force }),
		[mutate, library.id],
	)

	const iconStyle = 'mr-2 h-4 w-4'

	return (
		<div className="gap-4 flex flex-col">
			<div>
				<Label>{t('createLibraryScene.form.review.labels.processThumbnailColors')}</Label>
				<Text size="sm" variant="muted">
					{t('libraryThumbnails.processColors.description')}
				</Text>
			</div>

			<div>
				<DropdownMenu
					trigger={
						<Button variant="outline">
							{t('libraryThumbnails.processColors.extract')}
							<ChevronDown className="ml-2 h-4 w-4" />
						</Button>
					}
					groups={[
						{
							items: [
								{
									label: t('libraryThumbnails.processColors.missingOnly'),
									leftIcon: <ImagePlus className={iconStyle} />,
									onClick: () => process(false),
								},
								{
									label: t('libraryThumbnails.processColors.reprocessAll'),
									isDestructive: true,
									leftIcon: <AlertTriangle className={iconStyle} />,
									onClick: () => process(true),
								},
							],
						},
					]}
					align="start"
				/>
			</div>
		</div>
	)
}
