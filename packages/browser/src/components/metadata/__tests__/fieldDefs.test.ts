import { MetadataField } from '@stump/graphql'

import { getMediaFieldComparisons, isArrayField } from '../fieldDefs'

describe('getMediaFieldComparisons', () => {
	it('offers a game match its developers, platforms and publisher', () => {
		const comparisons = getMediaFieldComparisons(
			{ publisher: 'Edited by hand', developers: [] },
			{
				title: 'Uridium',
				publisher: 'Hewson Consultants',
				developers: ['Andrew Braybrook'],
				platforms: ['Commodore 64', 'ZX Spectrum'],
			},
		)
		const byField = Object.fromEntries(comparisons.map((c) => [c.field, c]))

		expect(byField[MetadataField.Developers]).toMatchObject({
			binding: 'developers',
			currentValue: [],
			candidateValue: ['Andrew Braybrook'],
		})
		expect(byField[MetadataField.Platforms]).toMatchObject({
			binding: 'platforms',
			currentValue: null,
			candidateValue: ['Commodore 64', 'ZX Spectrum'],
		})
		expect(byField[MetadataField.Publisher]).toMatchObject({
			currentValue: 'Edited by hand',
			candidateValue: 'Hewson Consultants',
		})
	})

	it('lists the publisher once', () => {
		const comparisons = getMediaFieldComparisons(null, {})
		expect(comparisons.filter((c) => c.field === MetadataField.Publisher)).toHaveLength(1)
	})

	it('edits developers and platforms as lists', () => {
		expect(isArrayField(MetadataField.Developers)).toBe(true)
		expect(isArrayField(MetadataField.Platforms)).toBe(true)
		expect(isArrayField(MetadataField.Publisher)).toBe(false)
	})
})
