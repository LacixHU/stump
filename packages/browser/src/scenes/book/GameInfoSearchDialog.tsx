import { useGraphQLMutation } from '@stump/client'
import { Button, Dialog, Input, Text } from '@stump/components'
import { extractErrorMessage, graphql, MergeStrategy, MetadataProvider } from '@stump/graphql'
import { useLocaleContext } from '@stump/i18n'
import { ExternalLink, Gamepad2 } from 'lucide-react'
import { FormEvent, useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'

import {
	ConfidenceBadge,
	MatchRecord,
	useMatchReviewStore,
} from '@/components/metadata/metadataMatching'

import { summarizePlatforms } from './gameInfo'

const searchMutation = graphql(`
	mutation GameInfoSearch($id: ID!, $search: MediaMetadataSearchInput) {
		fetchMediaMetadata(id: $id, search: $search) {
			...PendingMatchRecord
			matchCandidates {
				externalId
				metadata {
					... on ExternalMediaMetadata {
						coverUrl
						providerUrl
					}
				}
			}
		}
	}
`)

type Props = {
	mediaId: string
	/** The game's current name, offered as the starting search term */
	initialTerm: string
	isOpen: boolean
	onClose: () => void
}

/**
 * Search Wikipedia for a game and pick the right article from a list, then review its
 * details field by field. Opening it searches straight away by the game's file and folder
 * names; typing a term searches Wikipedia for exactly that.
 */
export default function GameInfoSearchDialog({ mediaId, initialTerm, isOpen, onClose }: Props) {
	const { t } = useLocaleContext()
	const openReview = useMatchReviewStore((s) => s.open)

	const [term, setTerm] = useState(initialTerm)
	const [record, setRecord] = useState<MatchRecord | null>(null)
	const [links, setLinks] = useState<CandidateLinks[]>([])

	const { mutate, isPending, reset } = useGraphQLMutation(searchMutation, {
		onSuccess: (data) => {
			// Fragment masking is type-level only; the response holds the whole fragment
			setRecord(data.fetchMediaMetadata as unknown as MatchRecord)
			setLinks(
				data.fetchMediaMetadata.matchCandidates.map(({ metadata }) =>
					metadata.__typename === 'ExternalMediaMetadata'
						? { coverUrl: metadata.coverUrl, providerUrl: metadata.providerUrl }
						: {},
				),
			)
		},
		onError: (error) => {
			setRecord(null)
			toast.error(t(getKey('failed')), { description: extractErrorMessage(error) })
		},
	})

	const search = useCallback(
		(title?: string) =>
			mutate({ id: mediaId, search: { title, provider: MetadataProvider.Wikipedia } }),
		[mediaId, mutate],
	)

	useEffect(() => {
		if (!isOpen) return
		setTerm(initialTerm)
		setRecord(null)
		setLinks([])
		reset()
		// No term: the server searches by the file's and the folder's names
		search()
	}, [isOpen, initialTerm, search, reset])

	const onSubmit = (e: FormEvent) => {
		e.preventDefault()
		const trimmed = term.trim()
		if (trimmed) search(trimmed)
	}

	const onPick = (index: number) => {
		if (!record) return
		// Chosen by hand, so the article may replace what is there (a title that is just
		// the file name, say); the review still lets each field be kept
		openReview([record], 0, MergeStrategy.PreferExternal, index)
		onClose()
	}

	const candidates = record?.matchCandidates ?? []

	return (
		<Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
			<Dialog.Content size="md">
				<Dialog.Header>
					<Dialog.Title>{t(getKey('heading'))}</Dialog.Title>
					<Dialog.Description>{t(getKey('description'))}</Dialog.Description>
					<Dialog.Close onClick={onClose} />
				</Dialog.Header>

				{/* min-w-0: the dialog body is a grid, whose items otherwise grow to fit their
				    longest line, and the rows' truncation never kicks in */}
				<form className="gap-2 min-w-0 flex items-end" onSubmit={onSubmit}>
					<Input
						label={t(getKey('term'))}
						value={term}
						onChange={(e) => setTerm(e.target.value)}
						fullWidth
						autoFocus
					/>
					<Button type="submit" isLoading={isPending} disabled={isPending || !term.trim()}>
						{t(getKey('search'))}
					</Button>
				</form>

				<div className="gap-2 min-h-24 min-w-0 flex flex-col" aria-live="polite">
					{isPending && (
						<Text size="sm" variant="muted">
							{t(getKey('searching'))}
						</Text>
					)}

					{!isPending && record && candidates.length === 0 && (
						<Text size="sm" variant="muted">
							{t(getKey('noResults'))}
						</Text>
					)}

					{!isPending &&
						candidates.map((candidate, index) => (
							<CandidateRow
								key={`${candidate.provider}:${candidate.externalId}`}
								candidate={candidate}
								links={links[index] ?? {}}
								onPick={() => onPick(index)}
							/>
						))}
				</div>

				<Dialog.Footer>
					<Button variant="outline" onClick={onClose}>
						{t('common.cancel')}
					</Button>
				</Dialog.Footer>
			</Dialog.Content>
		</Dialog>
	)
}

type CandidateLinks = {
	coverUrl?: string | null
	providerUrl?: string | null
}

type CandidateRowProps = {
	candidate: MatchRecord['matchCandidates'][number]
	links: CandidateLinks
	onPick: () => void
}

function CandidateRow({ candidate, links, onPick }: CandidateRowProps) {
	const { t } = useLocaleContext()
	const metadata = candidate.metadata as GameCandidateMetadata

	const facts = [metadata.year, metadata.developers?.join(', '), metadata.publisher]
		.filter(Boolean)
		.join(' · ')
	const platforms = summarizePlatforms(metadata.platforms ?? [])

	return (
		<div className="gap-3 p-2 flex items-center rounded-lg border border-border hover:bg-muted/50">
			<button
				type="button"
				onClick={onPick}
				className="gap-3 min-w-0 flex flex-1 items-center text-left"
				title={t(getKey('pick'))}
			>
				<div className="h-16 w-12 flex shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
					{links.coverUrl ? (
						<img src={links.coverUrl} alt="" className="h-full w-full object-cover" />
					) : (
						<Gamepad2 className="h-5 w-5 text-muted-foreground" />
					)}
				</div>
				<div className="min-w-0 gap-0.5 flex flex-col">
					<div className="gap-2 flex items-center">
						<Text className="font-medium truncate">{metadata.title ?? candidate.externalId}</Text>
						<ConfidenceBadge confidence={candidate.confidence} />
					</div>
					{/* The article name tells same-named games apart: "Barbarian (1987 video game)" */}
					{candidate.externalId !== metadata.title && (
						<Text size="xs" variant="muted" className="truncate">
							{candidate.externalId}
						</Text>
					)}
					{facts && (
						<Text size="xs" variant="muted" className="truncate">
							{facts}
						</Text>
					)}
					{platforms && (
						<Text size="xs" variant="muted" className="truncate">
							{platforms}
						</Text>
					)}
				</div>
			</button>
			{links.providerUrl && (
				<a
					href={links.providerUrl}
					target="_blank"
					rel="noreferrer"
					className="p-2 shrink-0 text-muted-foreground hover:text-foreground"
					title={t(getKey('openArticle'))}
					aria-label={t(getKey('openArticle'))}
				>
					<ExternalLink className="h-4 w-4" />
				</a>
			)}
		</div>
	)
}

type GameCandidateMetadata = {
	title?: string | null
	year?: number | null
	publisher?: string | null
	developers?: string[] | null
	platforms?: string[] | null
}

const LOCALE_KEY = 'gameInfoSearch'
const getKey = (key: string) => `${LOCALE_KEY}.${key}`
