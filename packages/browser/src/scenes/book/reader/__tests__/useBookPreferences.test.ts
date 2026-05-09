import { DEFAULT_BOOK_PREFERENCES, ReaderSettings } from '@stump/client'
import { ReadingDirection, ReadingImageScaleFit, ReadingMode } from '@stump/graphql'

import { buildPreferences } from '../useBookPreferences'

const createReaderSettings = (overrides: Partial<ReaderSettings> = {}): ReaderSettings => ({
	preload: {
		ahead: 5,
		behind: 3,
	},
	showToolBar: false,
	...DEFAULT_BOOK_PREFERENCES,
	...overrides,
})

describe('buildPreferences', () => {
	it('prefers global reader image scaling over library defaults for new books', () => {
		const preferences = buildPreferences(
			{},
			createReaderSettings({
				imageScaling: {
					scaleToFit: ReadingImageScaleFit.Auto,
				},
			}),
			{
				imageScaling: {
					scaleToFit: ReadingImageScaleFit.Height,
				},
				readingDirection: ReadingDirection.Rtl,
				readingMode: ReadingMode.ContinuousVertical,
			},
		)

		expect(preferences.imageScaling.scaleToFit).toBe(ReadingImageScaleFit.Auto)
	})

	it('prefers book-specific image scaling over global reader settings', () => {
		const preferences = buildPreferences(
			{
				imageScaling: {
					scaleToFit: ReadingImageScaleFit.Width,
				},
			},
			createReaderSettings({
				imageScaling: {
					scaleToFit: ReadingImageScaleFit.Auto,
				},
			}),
			{
				imageScaling: {
					scaleToFit: ReadingImageScaleFit.Height,
				},
			},
		)

		expect(preferences.imageScaling.scaleToFit).toBe(ReadingImageScaleFit.Width)
	})
})
