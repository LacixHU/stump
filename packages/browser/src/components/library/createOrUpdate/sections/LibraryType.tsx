import { Label, NativeSelect, Text } from '@stump/components'
import { LibraryPattern, LibraryType } from '@stump/graphql'
import { useLocaleContext } from '@stump/i18n'
import { useFormContext } from 'react-hook-form'

import { CreateOrUpdateLibrarySchema } from '../schema'

export default function LibraryTypeSelect() {
	const form = useFormContext<CreateOrUpdateLibrarySchema>()

	const { t } = useLocaleContext()

	return (
		<div className="gap-2 flex flex-col">
			<Label>{t(getKey('label'))}</Label>
			<NativeSelect
				options={OPTIONS.map((option) => ({
					value: option,
					label: t(getKey(`options.${option}`)),
				}))}
				{...form.register('libraryType', {
					onChange: (e) => {
						if (e.target.value === LibraryType.Retro) {
							form.setValue('libraryPattern', LibraryPattern.Nested)
						}
					},
				})}
			/>
			<Text size="xs" variant="muted">
				{t(getKey('description'))}
			</Text>
		</div>
	)
}

const OPTIONS = [
	LibraryType.Book,
	LibraryType.Comic,
	LibraryType.LightNovel,
	LibraryType.Manga,
	LibraryType.Manhwa,
	LibraryType.Mixed,
	LibraryType.Retro,
	LibraryType.WebNovel,
	LibraryType.Webtoon,
]

const LOCALE_KEY = 'createOrUpdateLibraryForm.fields.libraryType'
const getKey = (key: string) => `${LOCALE_KEY}.${key}`
