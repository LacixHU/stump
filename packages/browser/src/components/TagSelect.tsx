import { useSDK, useSuspenseGraphQL } from '@stump/client'
import { ComboBox } from '@stump/components'
import { graphql } from '@stump/graphql'
import { useCallback, useEffect, useMemo, useState } from 'react'

const query = graphql(`
	query TagSelectQuery {
		tags {
			id
			name
		}
	}
`)

export type TagOption = {
	label: string
	value: string
}

type Props = {
	label?: string
	description?: string
	selected?: TagOption[]
	onChange: (selected?: TagOption[]) => void
}

// Stable reference so an undefined `selected` prop doesn't produce a new array every render
const EMPTY_SELECTION: TagOption[] = []

const byLabel = (a: TagOption, b: TagOption) => a.label.localeCompare(b.label)

export default function TagSelect({
	label,
	description,
	selected = EMPTY_SELECTION,
	onChange,
}: Props) {
	const { sdk } = useSDK()
	const {
		data: { tags },
	} = useSuspenseGraphQL(query, sdk.cacheKey('tags'))

	/**
	 * Tags created locally in this session which do not (yet) exist on the server
	 */
	const [customOptions, setCustomOptions] = useState<TagOption[]>([])

	const options = useMemo(() => {
		const serverOptions = tags.map((tag) => ({ label: tag.name, value: tag.name.toLowerCase() }))
		const serverValues = new Set(serverOptions.map(({ value }) => value))
		return [
			...serverOptions,
			...customOptions.filter(({ value }) => !serverValues.has(value)),
		].sort(byLabel)
	}, [tags, customOptions])

	// Remove any selected tags that no longer exist (e.g. deleted on the server)
	useEffect(() => {
		const knownValues = new Set(options.map(({ value }) => value))
		const filtered = selected.filter((s) => knownValues.has(s.value))
		if (filtered.length !== selected.length) {
			onChange(filtered.length > 0 ? filtered : undefined)
		}
	}, [options, selected, onChange])

	const handleChange = useCallback(
		(newSelection?: string[]) => {
			onChange(
				newSelection?.map((value) => {
					const option = options.find((option) => option.value === value)
					if (!option) {
						return { label: value, value }
					}
					return option
				}),
			)
		},
		[onChange, options],
	)

	const handleAddOption = useCallback(
		(option: TagOption) =>
			setCustomOptions((curr) =>
				curr.some(({ value }) => value === option.value) ? curr : [...curr, option],
			),
		[],
	)

	const value = useMemo(() => [...selected].sort(byLabel).map(({ value }) => value), [selected])

	return (
		<ComboBox
			label={label ?? 'Tags'}
			description={description}
			options={options}
			value={value}
			onChange={handleChange}
			onAddOption={handleAddOption}
			isMultiSelect
			filterable
		/>
	)
}
