import { Heading, Link, RadioGroup, Text } from '@stump/components'
import { LibraryPattern } from '@stump/graphql'
import { useLocaleContext } from '@stump/i18n'
import { useCallback } from 'react'
import { useFormContext, useWatch } from 'react-hook-form'

export default function LibraryPatternRadioGroup() {
	const form = useFormContext()

	const { t } = useLocaleContext()

	const libraryPattern = useWatch({ control: form.control, name: 'libraryPattern' })

	const handleChange = useCallback(
		(pattern: LibraryPattern) => {
			form.setValue('libraryPattern', pattern, { shouldDirty: true })
		},
		[form],
	)

	// Note: if this section ever becomes more than library pattern, restore the section locale keys
	return (
		<div className="gap-6 flex flex-col">
			<div>
				<Heading size="sm">{t(getOptionKey('label'))}</Heading>
				<Text size="sm" variant="muted">
					{t(getOptionKey('description'))}
				</Text>
			</div>

			<div className="gap-y-4 flex flex-col">
				<input type="hidden" {...form.register('libraryPattern')} />

				<RadioGroup
					value={libraryPattern}
					onValueChange={handleChange}
					className="mt-1 sm:flex-row flex flex-col flex-wrap"
					defaultValue="SERIES_BASED"
				>
					<RadioGroup.CardItem
						label={t(getOptionKey('collectionPriority.label'))}
						description={t(getOptionKey('collectionPriority.description'))}
						innerContainerClassName="block sm:flex-col sm:items-start sm:gap-2"
						isActive={libraryPattern === LibraryPattern.CollectionBased}
						value={LibraryPattern.CollectionBased}
						className="md:w-[calc(50%-0.5rem)]"
					/>

					<RadioGroup.CardItem
						label={t(getOptionKey('seriesPriority.label'))}
						description={t(getOptionKey('seriesPriority.description'))}
						innerContainerClassName="block sm:flex-col sm:items-start sm:gap-2"
						isActive={libraryPattern === LibraryPattern.SeriesBased}
						value={LibraryPattern.SeriesBased}
						className="md:w-[calc(50%-0.5rem)]"
					/>

					<RadioGroup.CardItem
						label={t(getOptionKey('nested.label'))}
						description={t(getOptionKey('nested.description'))}
						innerContainerClassName="block sm:flex-col sm:items-start sm:gap-2"
						isActive={libraryPattern === LibraryPattern.Nested}
						value={LibraryPattern.Nested}
						className="md:w-[calc(50%-0.5rem)]"
					/>
				</RadioGroup>

				<Text size="xs" variant="muted">
					{t(getKey('section.docs.0'))}{' '}
					<Link
						target="_blank"
						href="https://stumpapp.dev/docs/guides/fundamentals/libraries#supported-patterns"
					>
						{t(getKey('section.docs.1'))}
					</Link>{' '}
					{t(getKey('section.docs.2'))} {t(getKey('section.rescanHint'))}
				</Text>
			</div>
		</div>
	)
}

const LOCALE_KEY = 'createOrUpdateLibraryForm.fields.libraryPattern'
const getKey = (key: string) => `${LOCALE_KEY}.${key}`
const getOptionKey = (key: string) => getKey(`options.${key}`)
