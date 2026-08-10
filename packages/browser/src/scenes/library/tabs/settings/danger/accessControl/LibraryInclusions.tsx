import { useGraphQLMutation, useSuspenseGraphQLQueries } from '@stump/client'
import {
	Alert,
	AlertDescription,
	AlertTitle,
	ComboBox,
	Heading,
	Text,
	usePrevious,
} from '@stump/components'
import { graphql } from '@stump/graphql'
import { useLocaleContext } from '@stump/i18n'
import { useQueryClient } from '@tanstack/react-query'
import { Info } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useDebouncedValue } from 'rooks'

import { useAppContext } from '@/context'

import { useLibraryContext } from '../../../../context'

const usersQuery = graphql(`
	query LibraryInclusionsUsersQuery {
		users(pagination: { none: { unpaginated: true } }) {
			nodes {
				id
				username
				isServerOwner
			}
		}
	}
`)

const includedUsersQuery = graphql(`
	query LibraryInclusionsQuery($id: ID!) {
		libraryById(id: $id) {
			includedUsers {
				id
				username
			}
		}
	}
`)

const mutation = graphql(`
	mutation UpdateLibraryInclusions($id: ID!, $userIds: [String!]!) {
		updateLibraryIncludedUsers(id: $id, userIds: $userIds) {
			id
			includedUsers {
				id
				username
			}
		}
	}
`)

export default function LibraryInclusions() {
	const { library } = useLibraryContext()
	const { user } = useAppContext()
	const { t } = useLocaleContext()

	const [
		{
			data: {
				users: { nodes: allUsers },
			},
		},
		{
			data: { libraryById },
		},
	] = useSuspenseGraphQLQueries([
		{
			document: usersQuery,
			queryKey: ['users'],
		},
		{
			document: includedUsersQuery,
			queryKey: ['libraryInclusions', library.id],
			// @ts-expect-error: Need to fix this type error with useSuspenseGraphQLQueries
			variables: { id: library.id },
		},
	])
	const includedUsers = useMemo(() => libraryById?.includedUsers || [], [libraryById])

	const client = useQueryClient()

	const { mutate } = useGraphQLMutation(mutation, {
		onSuccess: ({ updateLibraryIncludedUsers: { includedUsers } }) => {
			// Update without refetching to reduce network
			client.setQueryData(['libraryInclusions', library.id], {
				libraryById: {
					...libraryById,
					includedUsers,
				},
			})
		},
	})

	const updateInclusions = useCallback(
		(ids: string[]) => {
			mutate({ id: library.id, userIds: ids })
		},
		[mutate, library],
	)

	const [includedUserIds, setIncludedUserIds] = useState<string[] | undefined>(() =>
		includedUsers?.map((user) => user.id),
	)
	const [debouncedUserIds] = useDebouncedValue(includedUserIds, 500)

	useEffect(() => {
		setIncludedUserIds(includedUsers?.map((user) => user.id) || [])
	}, [includedUsers])

	const previousLibrary = usePrevious(library)
	const isSameLibrary = previousLibrary?.id === library.id
	const variablesLoaded = !!debouncedUserIds && !!includedUsers
	const shouldCall =
		variablesLoaded && debouncedUserIds.length !== includedUsers.length && isSameLibrary

	useEffect(() => {
		if (shouldCall) {
			updateInclusions(debouncedUserIds)
		}
	}, [debouncedUserIds, updateInclusions, shouldCall])

	const userOptions = useMemo(
		() =>
			(
				allUsers?.map((u) => ({
					label: u.username,
					value: u.id,
					isServerOwner: u.isServerOwner,
				})) || []
			)
				.filter((option) => option.value !== user.id && !option.isServerOwner)
				.map(({ label, value }) => ({ label, value })),
		[allUsers, user],
	)

	// TODO: disabled state if no options
	return (
		<div className="gap-4 flex flex-col">
			<div>
				<Heading size="sm">{t(getKey('heading'))}</Heading>
				<Text size="sm" variant="muted" className="mt-1">
					{t(getKey('description'))}
				</Text>
			</div>

			{userOptions.length === 0 && (
				<Alert variant="info">
					<Info />
					<AlertTitle>{t(getKey('noUsersTitle'))}</AlertTitle>
					<AlertDescription>{t(getKey('noUsers'))}</AlertDescription>
				</Alert>
			)}

			<ComboBox
				disabled={userOptions.length === 0}
				options={userOptions}
				value={includedUserIds}
				isMultiSelect
				onChange={(userIds) => {
					setIncludedUserIds(userIds || [])
				}}
			/>
		</div>
	)
}

const LOCALE_KEY = 'librarySettingsScene.danger-zone/access-control.sections.libraryInclusions'
const getKey = (key: string) => `${LOCALE_KEY}.${key}`
