import { HomeSectionKind, TypedDocumentString } from '@stump/graphql'

type HomeArrangementSupport = {
	__type: { name: string } | null
}

export const homeArrangementSupportQuery = new TypedDocumentString<
	HomeArrangementSupport,
	Record<string, never>
>(`query HomeArrangementSupport {
	__type(name: "HomeSection") {
		name
	}
}`)

export function supportsHomeArrangement(data: HomeArrangementSupport | undefined) {
	return Boolean(data?.__type?.name)
}

export const LEGACY_HOME_SECTIONS = [
	HomeSectionKind.InProgressBooks,
	HomeSectionKind.OnDeck,
	HomeSectionKind.RecentlyAddedBooks,
	HomeSectionKind.RecentlyAddedSeries,
]
