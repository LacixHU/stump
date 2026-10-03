import { MediaMetadataEditorFragment, SeriesMetadataEditorFragment } from '@stump/graphql'

export type MetadataEditorRow<Field extends string> = {
	label: string
	field: Field
}

export type MediaMetadataField = keyof Omit<
	MediaMetadataEditorFragment,
	'__typename' | ' $fragmentName' | 'mediaId'
>

export type MediaMetadataArrayField = Extract<
	MediaMetadataField,
	| 'characters'
	| 'colorists'
	| 'composers'
	| 'coverArtists'
	| 'developers'
	| 'editors'
	| 'genres'
	| 'inkers'
	| 'letterers'
	| 'links'
	| 'pencillers'
	| 'platforms'
	| 'teams'
	| 'writers'
>

export type MediaMetadataEditorRow = MetadataEditorRow<MediaMetadataField>

export const MediaMetadataKeys: MediaMetadataField[] = [
	'format',
	'title',
	'titleSort',
	'summary',
	'day',
	'month',
	'year',
	'number',
	'volume',
	'series',
	'seriesGroup',
	'storyArc',
	'storyArcNumber',
	'publisher',
	'developers',
	'platforms',
	'composers',
	'ageRating',
	'editors',
	'writers',
	'coverArtists',
	'pencillers',
	'inkers',
	'colorists',
	'letterers',
	'characters',
	'genres',
	'language',
	'links',
	'notes',
	'pageCount',
	'teams',
	'identifierAmazon',
	'identifierCalibre',
	'identifierGoogle',
	'identifierIsbn',
	'identifierMobiAsin',
	'identifierUuid',
]

export type SeriesMetadataField = keyof Omit<
	SeriesMetadataEditorFragment,
	'__typename' | ' $fragmentName' | 'seriesId'
>

export type SeriesMetadataEditorRow = MetadataEditorRow<SeriesMetadataField>

export const SeriesMetadataKeys: SeriesMetadataField[] = [
	'title',
	'summary',
	'comicid',
	'volume',
	'year',
	'totalIssues',
	'publisher',
	'booktype',
	'ageRating',
	'writers',
	'characters',
	'genres',
	'imprint',
	'links',
	'metaType',
	'status',
	'publicationRun',
	'comicImage',
	'descriptionFormatted',
]
