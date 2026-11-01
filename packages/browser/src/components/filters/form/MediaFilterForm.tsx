import { zodResolver } from '@hookform/resolvers/zod'
import { useGraphQL } from '@stump/client'
import { CheckBox, Form } from '@stump/components'
import {
	graphql,
	MediaFilterFormQuery,
	MediaFilterInput,
	MediaMetadataFilterInput,
	ReadingStatus,
} from '@stump/graphql'
import { useLocaleContext } from '@stump/i18n'
import { useEffect, useMemo, useState } from 'react'
import { FieldValues, useForm } from 'react-hook-form'
import z from 'zod'

import { useSeriesContextSafe } from '@/scenes/series'

import { useFilterContext } from '..'
import AgeRatingFilter from './AgeRatingFilter'
import ExtensionSelect from './ExtensionSelect'
import GenericFilterMultiselect from './GenericFilterMultiselect'
import ReadStatusSelect from './ReadStatusSelect'

const query = graphql(`
	query MediaFilterForm($seriesId: ID) {
		mediaMetadataOverview(seriesId: $seriesId) {
			genres
			writers
			pencillers
			colorists
			letterers
			inkers
			publishers
			composers
			developers
			platforms
			editors
			characters
		}
	}
`)

const schema = z.object({
	extension: z.string().optional(),
	metadata: z
		.object({
			age_rating: z
				.number()
				.optional()
				.nullable()
				.refine((val) => val == null || (val >= 0 && val <= 18)),
			character: z.array(z.string()).optional(),
			colorist: z.array(z.string()).optional(),
			composer: z.array(z.string()).optional(),
			developer: z.array(z.string()).optional(),
			editor: z.array(z.string()).optional(),
			genre: z.array(z.string()).optional(),
			inker: z.array(z.string()).optional(),
			letterer: z.array(z.string()).optional(),
			penciller: z.array(z.string()).optional(),
			platform: z.array(z.string()).optional(),
			publisher: z.array(z.string()).optional(),
			writer: z.array(z.string()).optional(),
		})
		.optional(),
	read_status: z.array(z.enum(['finished', 'reading', 'not_started'])).optional(),
})
export type MediaFilterFormSchema = z.infer<typeof schema>

export default function MediaFilterForm() {
	const { t } = useLocaleContext()
	const { filters: filtersInput, setFilters } = useFilterContext()
	const filters = useMemo(() => (filtersInput || {}) as MediaFilterInput, [filtersInput])

	const seriesContext = useSeriesContextSafe()
	const [onlyFromSeries, setOnlyFromSeries] = useState(false)

	const params = useMemo(() => {
		if (onlyFromSeries && !!seriesContext?.series.id) {
			return {
				seriesId: seriesContext.series.id,
			}
		}
		return {}
	}, [onlyFromSeries, seriesContext])

	const { data: _data, isPending } = useGraphQL(query, ['mediaFilterForm', params], params, {
		placeholderData: (prev) => prev,
	})
	const data = _data?.mediaMetadataOverview

	const defaultValue = useMemo(() => {
		const flattenMetadata = {
			age_rating: (filters?.metadata as MediaMetadataFilterInput)?.ageRating?.eq ?? null,
			character: (filters?.metadata as MediaMetadataFilterInput)?.characters?.hasAnyOf ?? [],
			colorist: (filters?.metadata as MediaMetadataFilterInput)?.colorists?.hasAnyOf ?? [],
			composer: (filters?.metadata as MediaMetadataFilterInput)?.composers?.hasAnyOf ?? [],
			developer: (filters?.metadata as MediaMetadataFilterInput)?.developers?.hasAnyOf ?? [],
			editor: (filters?.metadata as MediaMetadataFilterInput)?.editors?.hasAnyOf ?? [],
			genre: (filters?.metadata as MediaMetadataFilterInput)?.genres?.hasAnyOf ?? [],
			inker: (filters?.metadata as MediaMetadataFilterInput)?.inkers?.hasAnyOf ?? [],
			letterer: (filters?.metadata as MediaMetadataFilterInput)?.letterers?.hasAnyOf ?? [],
			penciller: (filters?.metadata as MediaMetadataFilterInput)?.pencillers?.hasAnyOf ?? [],
			platform: (filters?.metadata as MediaMetadataFilterInput)?.platforms?.hasAnyOf ?? [],
			publisher: (filters?.metadata as MediaMetadataFilterInput)?.publisher?.hasAnyOf ?? [],
			writer: (filters?.metadata as MediaMetadataFilterInput)?.writers?.hasAnyOf ?? [],
		}
		return {
			extension: filters?.extension?.eq as string,
			metadata: flattenMetadata,
			read_status: filters?.readingStatus?.isAnyOf?.map((elem) => (elem as string).toLowerCase()),
		}
	}, [filters])

	const form = useForm({
		defaultValues: defaultValue,
		resolver: zodResolver(schema),
	})
	const { reset } = form

	useEffect(() => {
		reset(defaultValue)
	}, [defaultValue, reset])

	/**
	 * A function that handles the form submission. This function merges the form
	 * values with the existing filters and sets the new filters.
	 * @param values The values from the form.
	 */
	const handleSubmit = (values: FieldValues) => {
		const newFilters: MediaFilterInput = {}
		if (values.extension) {
			newFilters.extension = { eq: values.extension }
		}

		if (values.read_status) {
			newFilters.readingStatus = {
				isAnyOf: values.read_status.map(
					(elem: string) => (elem as string).toUpperCase() as ReadingStatus,
				),
			}
		}

		if (values.metadata) {
			if (values.metadata.age_rating !== null) {
				newFilters.metadata = {
					ageRating: values.metadata.age_rating ? { lte: values.metadata.age_rating } : null,
				}
			}

			if (values.metadata.character?.length) {
				newFilters.metadata = {
					...newFilters.metadata,
					characters: { hasAnyOf: values.metadata.character },
				}
			}

			if (values.metadata.colorist?.length) {
				newFilters.metadata = {
					...newFilters.metadata,
					colorists: { hasAnyOf: values.metadata.colorist },
				}
			}

			if (values.metadata.editor?.length) {
				newFilters.metadata = {
					...newFilters.metadata,
					editors: { hasAnyOf: values.metadata.editor },
				}
			}

			if (values.metadata.genre?.length) {
				newFilters.metadata = {
					...newFilters.metadata,
					genres: { hasAnyOf: values.metadata.genre },
				}
			}

			if (values.metadata.inker?.length) {
				newFilters.metadata = {
					...newFilters.metadata,
					inkers: { hasAnyOf: values.metadata.inker },
				}
			}

			if (values.metadata.letterer?.length) {
				newFilters.metadata = {
					...newFilters.metadata,
					letterers: { hasAnyOf: values.metadata.letterer },
				}
			}

			if (values.metadata.penciller?.length) {
				newFilters.metadata = {
					...newFilters.metadata,
					pencillers: { hasAnyOf: values.metadata.penciller },
				}
			}

			if (values.metadata.publisher?.length) {
				newFilters.metadata = {
					...newFilters.metadata,
					publisher: { hasAnyOf: values.metadata.publisher },
				}
			}

			if (values.metadata.composer?.length) {
				newFilters.metadata = {
					...newFilters.metadata,
					composers: { hasAnyOf: values.metadata.composer },
				}
			}

			if (values.metadata.developer?.length) {
				newFilters.metadata = {
					...newFilters.metadata,
					developers: { hasAnyOf: values.metadata.developer },
				}
			}

			if (values.metadata.platform?.length) {
				newFilters.metadata = {
					...newFilters.metadata,
					platforms: { hasAnyOf: values.metadata.platform },
				}
			}

			if (values.metadata.writer?.length) {
				newFilters.metadata = {
					...newFilters.metadata,
					writers: { hasAnyOf: values.metadata.writer },
				}
			}
		}

		setFilters(newFilters)
	}

	const isEmptyState = useMemo(() => !isPending && isEmptyResult(data), [isPending, data])

	return (
		<Form
			className="px-6 py-2 scrollbar-hide flex max-h-full grow flex-col overflow-x-visible overflow-y-auto"
			id="filter-form"
			form={form}
			onSubmit={handleSubmit}
		>
			{!!seriesContext && (
				<CheckBox
					label={t('filters.onlyFromSeries')}
					checked={onlyFromSeries}
					onClick={() => setOnlyFromSeries((prev) => !prev)}
				/>
			)}

			<ExtensionSelect />
			<ReadStatusSelect />
			<AgeRatingFilter />

			{!isEmptyState && (
				<>
					<GenericFilterMultiselect
						name="metadata.genre"
						label={t('metadataEditor.labels.genres')}
						options={data?.genres.map((genre) => ({ label: genre, value: genre })) || []}
					/>

					<GenericFilterMultiselect
						name="metadata.writer"
						label={t('metadataEditor.labels.writers')}
						options={data?.writers.map((writer) => ({ label: writer, value: writer })) || []}
					/>

					<GenericFilterMultiselect
						name="metadata.penciller"
						label={t('metadataEditor.labels.pencillers')}
						options={
							data?.pencillers.map((penciller) => ({
								label: penciller,
								value: penciller,
							})) || []
						}
					/>

					<GenericFilterMultiselect
						name="metadata.colorist"
						label={t('metadataEditor.labels.colorists')}
						options={
							data?.colorists.map((colorist) => ({
								label: colorist,
								value: colorist,
							})) || []
						}
					/>

					<GenericFilterMultiselect
						name="metadata.letterer"
						label={t('metadataEditor.labels.letterers')}
						options={
							data?.letterers.map((letterer) => ({
								label: letterer,
								value: letterer,
							})) || []
						}
					/>

					<GenericFilterMultiselect
						name="metadata.inker"
						label={t('metadataEditor.labels.inkers')}
						options={data?.inkers.map((inker) => ({ label: inker, value: inker })) || []}
					/>

					<GenericFilterMultiselect
						name="metadata.publisher"
						label={t('metadataEditor.labels.publisher')}
						options={
							data?.publishers.map((publisher) => ({
								label: publisher,
								value: publisher,
							})) || []
						}
					/>

					<GenericFilterMultiselect
						name="metadata.composer"
						label={t('metadataEditor.labels.composers')}
						options={
							data?.composers.map((composer) => ({
								label: composer,
								value: composer,
							})) || []
						}
					/>

					<GenericFilterMultiselect
						name="metadata.developer"
						label={t('metadataEditor.labels.developers')}
						options={
							data?.developers.map((developer) => ({
								label: developer,
								value: developer,
							})) || []
						}
					/>

					<GenericFilterMultiselect
						name="metadata.platform"
						label={t('metadataEditor.labels.platforms')}
						options={
							data?.platforms.map((platform) => ({
								label: platform,
								value: platform,
							})) || []
						}
					/>

					<GenericFilterMultiselect
						name="metadata.editor"
						label={t('metadataEditor.labels.editors')}
						options={data?.editors.map((editor) => ({ label: editor, value: editor })) || []}
					/>

					<GenericFilterMultiselect
						name="metadata.character"
						label={t('metadataEditor.labels.characters')}
						options={
							data?.characters.map((character) => ({
								label: character,
								value: character,
							})) || []
						}
					/>
				</>
			)}
		</Form>
	)
}

const isEmptyResult = (result?: MediaFilterFormQuery['mediaMetadataOverview']) =>
	!(
		result?.genres?.length ||
		result?.writers?.length ||
		result?.pencillers?.length ||
		result?.colorists?.length ||
		result?.letterers?.length ||
		result?.inkers?.length ||
		result?.publishers?.length ||
		result?.composers?.length ||
		result?.developers?.length ||
		result?.platforms?.length ||
		result?.editors?.length ||
		result?.characters?.length
	) || result == null
