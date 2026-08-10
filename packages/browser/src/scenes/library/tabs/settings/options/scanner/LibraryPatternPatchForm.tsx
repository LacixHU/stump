import { zodResolver } from '@hookform/resolvers/zod'
import { Form } from '@stump/components'
import { LibraryPattern } from '@stump/graphql'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useForm, useWatch } from 'react-hook-form'

import {
	buildSchema,
	CreateOrUpdateLibrarySchema,
	formDefaults,
	LibraryPattern as LibraryPatternSection,
} from '@/components/library/createOrUpdate'

import { useLibraryManagement } from '../../context'

export default function LibraryPatternPatchForm() {
	const { library, patch } = useLibraryManagement()
	const applyingRef = useRef(false)

	const schema = useMemo(() => buildSchema([], library), [library])
	const form = useForm<CreateOrUpdateLibrarySchema>({
		defaultValues: formDefaults(library),
		reValidateMode: 'onChange',
		resolver: zodResolver(schema),
	})

	const libraryPattern = useWatch({ control: form.control, name: 'libraryPattern' })
	const currentPattern = library.config.libraryPattern

	useEffect(() => {
		form.reset(formDefaults(library))
		applyingRef.current = false
	}, [library, form])

	const applyPattern = useCallback(
		(pattern: LibraryPattern) => {
			if (applyingRef.current || pattern === currentPattern) return
			applyingRef.current = true
			// Persist Nested/Series/Collection and rescan so parent links are rebuilt
			patch({
				config: { libraryPattern: pattern },
				scanAfterPersist: true,
			})
		},
		[currentPattern, patch],
	)

	useEffect(() => {
		if (libraryPattern && libraryPattern !== currentPattern) {
			applyPattern(libraryPattern as LibraryPattern)
		}
	}, [libraryPattern, currentPattern, applyPattern])

	return (
		<Form form={form} onSubmit={() => undefined} fieldsetClassName="space-y-4">
			<LibraryPatternSection />
		</Form>
	)
}
