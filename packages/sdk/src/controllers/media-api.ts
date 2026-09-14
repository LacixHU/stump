import { ScaledDimensionResizeInput } from '@stump/graphql'

import { APIBase } from '../base'
import { createRouteURLHandler, isAxiosError } from './utils'

/**
 * The root route for the media API
 */
const MEDIA_ROUTE = '/media'
/**
 * A helper function to format the URL for media API routes with optional query parameters
 */
const mediaURL = createRouteURLHandler(MEDIA_ROUTE)

/**
 * The media API controller, used for interacting with the media endpoints of the Stump API
 */
export class MediaAPI extends APIBase {
	/**
	 * The URL for fetching the thumbnail of a media entity
	 */
	thumbnailURL(id: string): string {
		return this.withServiceURL(mediaURL(`/${id}/thumbnail`))
	}

	/**
	 * The URL for fetching the file of a media entity
	 */
	downloadURL(id: string): string {
		return this.withServiceURL(mediaURL(`/${id}/file`))
	}

	/**
	 * The URL for fetching a retro disk/tape image for in-browser play
	 * (library access only; does not require DownloadFile)
	 */
	playFileURL(id: string): string {
		return this.withServiceURL(mediaURL(`/${id}/play-file`))
	}

	/**
	 * URL for optional series-folder overlay keys (`controls.json`) for the retro player
	 */
	retroControlsURL(id: string): string {
		return this.withServiceURL(mediaURL(`/${id}/retro-controls`))
	}

	async saveRetroControls(
		id: string,
		keys: Array<{ id: string; x: number; y: number }>,
	): Promise<{ keys: Array<{ id: string; x: number; y: number }> }> {
		const { data } = await this.axios.post<{
			keys: Array<{ id: string; x: number; y: number }>
		}>(mediaURL(`/${id}/retro-controls`), { keys })
		return data
	}

	/**
	 * Fetch the current user's emulator save state for a book.
	 *
	 * Resolves to `null` when the server has no save state for this user and book, which
	 * is the normal case for a game that has never been saved. Anything else -- an
	 * offline server, an expired session -- still rejects, so callers can tell "nothing
	 * saved yet" apart from "something went wrong".
	 */
	async getSaveState(id: string): Promise<ArrayBuffer | null> {
		try {
			const { data } = await this.axios.get<ArrayBuffer>(mediaURL(`/${id}/save-state`), {
				responseType: 'arraybuffer',
			})
			return data
		} catch (error) {
			if (isAxiosError(error) && error.response?.status === 404) {
				return null
			}
			throw error
		}
	}

	/**
	 * Store the current user's emulator save state for a book, replacing any previous one
	 */
	async putSaveState(id: string, data: ArrayBuffer): Promise<void> {
		await this.axios.put(mediaURL(`/${id}/save-state`), data, {
			headers: { 'Content-Type': 'application/octet-stream' },
		})
	}

	/**
	 * Delete the current user's emulator save state for a book
	 */
	async deleteSaveState(id: string): Promise<void> {
		await this.axios.delete(mediaURL(`/${id}/save-state`))
	}

	/**
	 * The URL for fetching a page of a media entity
	 */
	bookPageURL(mediaID: string, page: number, params?: ScaledDimensionResizeInput): string {
		return this.withServiceURL(mediaURL(`${mediaID}/page/${page}`, params))
	}
}
