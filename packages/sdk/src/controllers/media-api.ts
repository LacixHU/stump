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
	 * Whether the current user already has a save state for this book.
	 *
	 * Uses HEAD so the player can ask before overwriting without downloading the snapshot.
	 */
	async hasSaveState(id: string): Promise<boolean> {
		try {
			await this.axios.head(mediaURL(`/${id}/save-state`))
			return true
		} catch (error) {
			if (isAxiosError(error) && error.response?.status === 404) {
				return false
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

	/**
	 * Page count and page sizes (in PDF points) of a PDF, for the HTML PDF reader
	 */
	async getPdfInfo(id: string): Promise<PdfInfo> {
		const { data } = await this.axios.get<PdfInfo>(mediaURL(`/${id}/pdf/info`))
		return data
	}

	/**
	 * The URL of one PDF page converted to a standalone HTML document, meant to be shown
	 * in a sandboxed iframe. `fit` and `zoom` set its initial view.
	 */
	pdfPageURL(id: string, page: number, view?: { fit?: PdfPageFit; zoom?: number }): string {
		return this.withServiceURL(mediaURL(`/${id}/pdf/page/${page}`, view))
	}

	/**
	 * The URL of one PDF page as a vector SVG image (white background, sized in PDF
	 * points). Safe to show with a plain `<img>`.
	 */
	pdfPageSvgURL(id: string, page: number): string {
		// `v` changes when the server output does, so browsers do not keep stale pages
		return this.withServiceURL(mediaURL(`/${id}/pdf/svg/${page}`, { v: PDF_SVG_VERSION }))
	}

	/**
	 * The text of one PDF page, as runs with their position on the page
	 */
	async getPdfPageText(id: string, page: number): Promise<PdfPageText> {
		const { data } = await this.axios.get<PdfPageText>(mediaURL(`/${id}/pdf/text/${page}`))
		return data
	}

	/**
	 * The URL of a WebP preview of one PDF page, `size` being its longer edge in pixels
	 */
	pdfThumbnailURL(id: string, page: number, size?: number): string {
		return this.withServiceURL(
			mediaURL(`/${id}/pdf/thumbnail/${page}`, size ? { size } : undefined),
		)
	}
}

/** Bump together with the page SVGs the server makes (`OUTPUT_VERSION` in `pdf_viewer.rs`) */
const PDF_SVG_VERSION = 3

export type PdfPageFit = 'page' | 'width' | 'none'

export type PdfInfo = {
	pageCount: number
	title?: string | null
	pages: Array<{ width: number; height: number }>
}

/**
 * A run of text on one baseline. Positions are in PDF points from the top-left corner of
 * the page, `x`/`y` being the baseline origin and `angle` the clockwise rotation in radians.
 */
export type PdfTextSpan = {
	text: string
	x: number
	y: number
	size: number
	angle: number
	width: number
	/** Where each UTF-16 code unit of `text` starts, along the baseline from `x`/`y` */
	offsets?: number[]
}

export type PdfPageText = {
	width: number
	height: number
	spans: PdfTextSpan[]
}
