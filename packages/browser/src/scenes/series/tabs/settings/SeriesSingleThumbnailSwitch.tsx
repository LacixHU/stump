import { invalidateQueries, useGraphQLMutation, useSDK, useSuspenseGraphQL } from '@stump/client'
import { WideSwitch } from '@stump/components'
import { TypedDocumentString } from '@stump/graphql'
import { Suspense, useState } from 'react'
import { toast } from 'sonner'

type UpdateSeriesUseSingleThumbnailMutation = {
	updateSeriesUseSingleThumbnail: {
		id: string
		useSingleThumbnail: boolean
	}
}

type UpdateSeriesUseSingleThumbnailMutationVariables = {
	id: string
	enabled: boolean
}

const UPDATE_MUTATION = new TypedDocumentString(`
	mutation UpdateSeriesUseSingleThumbnail($id: ID!, $enabled: Boolean!) {
		updateSeriesUseSingleThumbnail(id: $id, enabled: $enabled) {
			id
			useSingleThumbnail
		}
	}
`) as unknown as TypedDocumentString<
	UpdateSeriesUseSingleThumbnailMutation,
	UpdateSeriesUseSingleThumbnailMutationVariables
>

type SeriesSingleThumbnailQuery = {
	seriesById: { id: string; useSingleThumbnail: boolean } | null
}

type SeriesSingleThumbnailQueryVariables = { id: string }

const QUERY = new TypedDocumentString(`
	query SeriesSingleThumbnail($id: ID!) {
		seriesById(id: $id) {
			id
			useSingleThumbnail
		}
	}
`) as unknown as TypedDocumentString<
	SeriesSingleThumbnailQuery,
	SeriesSingleThumbnailQueryVariables
>

type Props = {
	seriesId: string
}

export default function SeriesSingleThumbnailSwitch({ seriesId }: Props) {
	return (
		<Suspense fallback={null}>
			<SeriesSingleThumbnailSwitchInner seriesId={seriesId} />
		</Suspense>
	)
}

function SeriesSingleThumbnailSwitchInner({ seriesId }: Props) {
	const { sdk } = useSDK()
	const {
		data: { seriesById },
	} = useSuspenseGraphQL(QUERY, sdk.cacheKey('seriesSingleThumbnail', [seriesId]), {
		id: seriesId,
	})
	const enabled = seriesById?.useSingleThumbnail ?? false
	const [checked, setChecked] = useState(enabled)

	const { mutate, isPending } = useGraphQLMutation(UPDATE_MUTATION, {
		onError: (error) => {
			setChecked(enabled)
			toast.error(error instanceof Error ? error.message : 'Failed to update series cover display')
		},
		onSuccess: (data) => {
			setChecked(data.updateSeriesUseSingleThumbnail.useSingleThumbnail)
			void invalidateQueries({ keys: ['seriesById', 'series', 'LibrarySeries'] })
		},
	})

	return (
		<WideSwitch
			label="Single cover only"
			description="Show only this series thumbnail in library grids, without stacked book covers behind it"
			checked={checked}
			disabled={isPending}
			onCheckedChange={(next) => {
				setChecked(next)
				mutate({ enabled: next, id: seriesId })
			}}
		/>
	)
}
