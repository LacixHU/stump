/** Below this the download is over before a progress bar would be worth showing. */
const DOWNLOAD_PROGRESS_MIN_BYTES = 5 * 1024 * 1024

/**
 * Read a response body, reporting whole-percent progress when its length is known.
 *
 * With a `Content-Encoding` the `Content-Length` counts encoded bytes while the reader yields
 * decoded ones, so the percentage would overshoot; that case reports an indeterminate bar.
 */
export async function readWithProgress(
	res: Response,
	onProgress: (percent: number | null) => void,
): Promise<ArrayBuffer> {
	const length = Number(res.headers.get('content-length'))
	const measurable = !res.headers.has('content-encoding') && length > 0
	if (measurable && length < DOWNLOAD_PROGRESS_MIN_BYTES) return res.arrayBuffer()
	if (!measurable || !res.body) {
		onProgress(null)
		return res.arrayBuffer()
	}

	const reader = res.body.getReader()
	const chunks: Uint8Array<ArrayBuffer>[] = []
	let received = 0
	let reported = -1
	for (;;) {
		const { done, value } = await reader.read()
		if (done) break
		chunks.push(value as Uint8Array<ArrayBuffer>)
		received += value.byteLength
		const percent = Math.min(100, Math.floor((received / length) * 100))
		if (percent !== reported) {
			reported = percent
			onProgress(percent)
		}
	}
	// A Blob lets the browser hold the chunks off the JS heap while it assembles the buffer
	return new Blob(chunks).arrayBuffer()
}
