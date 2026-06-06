import { useSDK } from '@stump/client'
import { Button, Link, Text } from '@stump/components'
import { Dimension } from '@stump/graphql'
import { ImageReaderBookRef } from '../imageBased/context'
import { useReaderStore } from '@/stores'
import { ReadingImageScaleFit } from '@stump/graphql'
import { ArrowLeft, Minus, Plus, RotateCcw } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

type Props = {
	book?: ImageReaderBookRef
	/**
	 * The ID of the media
	 */
	id: string
	/**
	 * If true, fetches one-page PDFs from the paged endpoint.
	 */
	isPaged?: boolean
	/**
	 * Current page (1-based) for paged mode.
	 */
	page?: number
	/**
	 * Total pages in the media.
	 */
	totalPages?: number
	/**
	 * URL to return to when exiting the reader (book overview).
	 */
	exitUrl?: string
	/**
	 * Book title, shown in the header.
	 */
	title?: string
	/**
	 * Callback invoked when page changes via controls.
	 */
	onPageChange?: (page: number) => void
}

/** Detect mobile browsers that don't support <object type=application/pdf> inline */
function isMobileBrowser(): boolean {
	if (typeof navigator === 'undefined') return false
	return /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent)
}

/**
 * A PDF viewer that uses the native browser PDF viewer.
 * Provides a top toolbar with exit, title, direct page input, and prev/next navigation.
 * A thumbnail strip shows page previews when in paged mode.
 * On mobile, uses an <iframe> instead of <object> for better Android support.
 */
export default function NativePDFViewer({
	id,
	isPaged = false,
	page = 1,
	totalPages = 1,
	exitUrl,
	title,
	onPageChange,
}: Props) {
	const { sdk } = useSDK()

	const bookPreferences = useReaderStore((state) => state.bookPreferences[id])
	const imageScaleFit = bookPreferences?.imageScaling?.scaleToFit || ReadingImageScaleFit.Height

	const [pdfObjectUrl, setPdfObjectUrl] = useState<string>()
	const [isLoading, setIsLoading] = useState(false)
	const [errorMessage, setErrorMessage] = useState<string>()
	// controlled value for the page jump input
	const [pageInputValue, setPageInputValue] = useState(String(page))
	const [showOverlay, setShowOverlay] = useState(true)
	const [zoom, setZoom] = useState(1)
	const [requestedZoom, setRequestedZoom] = useState(1)
	const [isPinching, setIsPinching] = useState(false)
	const [viewerSize, setViewerSize] = useState({ height: 0, width: 0 })
	const isMobile = isMobileBrowser()
	const viewerRef = useRef<HTMLDivElement>(null)
	const pinchStateRef = useRef<{ startDistance: number; startZoom: number } | null>(null)
	const zoomRef = useRef(1)
	const requestedZoomRef = useRef(1)

	useEffect(() => {
		zoomRef.current = zoom
	}, [zoom])

	useEffect(() => {
		requestedZoomRef.current = requestedZoom
	}, [requestedZoom])

	// keep page input in sync when page changes via prev/next
	useEffect(() => {
		setPageInputValue(String(page))
	}, [page])

	useEffect(() => {
		setZoom(1)
		setRequestedZoom(1)
		setIsPinching(false)
	}, [page])

	useEffect(() => {
		if (!isPaged || !isMobile || isPinching) return
		setRequestedZoom(zoom)
	}, [zoom, isPaged, isMobile, isPinching])

	useEffect(() => {
		if (!isPaged || !isMobile) return
		const viewerElement = viewerRef.current
		if (!viewerElement) return

		const resizeObserver = new ResizeObserver((entries) => {
			const entry = entries[0]
			if (!entry) return
			setViewerSize({
				height: Math.floor(entry.contentRect.height),
				width: Math.floor(entry.contentRect.width),
			})
		})

		resizeObserver.observe(viewerElement)
		return () => resizeObserver.disconnect()
	}, [isPaged, isMobile])

	useEffect(() => {
		if (!isPaged || !isMobile) return

		const viewportMeta = document.querySelector('meta[name="viewport"]')
		if (!viewportMeta) return

		const originalViewport = viewportMeta.getAttribute('content')
		const viewportParts = new Map<string, string>()

		for (const part of (originalViewport || '').split(',')) {
			const trimmed = part.trim()
			if (!trimmed) continue
			const [rawKey, rawValue] = trimmed.split('=')
			if (rawKey && rawValue) {
				viewportParts.set(rawKey.trim(), rawValue.trim())
			}
		}

		viewportParts.set('maximum-scale', '1')
		viewportParts.set('user-scalable', 'no')

		if (!viewportParts.has('width')) {
			viewportParts.set('width', 'device-width')
		}
		if (!viewportParts.has('initial-scale')) {
			viewportParts.set('initial-scale', '1')
		}

		viewportMeta.setAttribute(
			'content',
			Array.from(viewportParts.entries())
				.map(([key, value]) => `${key}=${value}`)
				.join(', '),
		)

		return () => {
			if (originalViewport === null) {
				viewportMeta.removeAttribute('content')
			} else {
				viewportMeta.setAttribute('content', originalViewport)
			}
		}
	}, [isPaged, isMobile])

	// Paged mode uses custom image rendering and does not need native PDF embedding.
	// Only non-paged desktop mode uses fetch + object URL.
	useEffect(() => {
		if (isMobile || isPaged) return

		let createdObjectUrl: string | undefined

		async function fetchPdf() {
			setIsLoading(true)
			setErrorMessage(undefined)
			setPdfObjectUrl(undefined)

			const url = isPaged ? sdk.media.bookPagePdfURL(id, page) : sdk.media.downloadURL(id)

			const response = await fetch(url, {
				credentials: 'include',
			})

			if (!response.ok) {
				throw new Error(`Failed to load PDF page (${response.status})`)
			}

			const contentType = response.headers.get('content-type')?.toLowerCase() || ''
			if (!contentType.includes('application/pdf')) {
				throw new Error(`Expected application/pdf but received ${contentType || 'unknown type'}`)
			}

			const blob = await response.blob()
			const arrayBuffer = await blob.arrayBuffer()
			createdObjectUrl = URL.createObjectURL(new Blob([arrayBuffer], { type: 'application/pdf' }))
			setPdfObjectUrl(createdObjectUrl)
		}

		fetchPdf()
			.catch((error) => {
				console.error(error)
				setErrorMessage(error instanceof Error ? error.message : 'Failed to load PDF')
			})
			.finally(() => {
				setIsLoading(false)
			})

		return () => {
			if (createdObjectUrl) {
				URL.revokeObjectURL(createdObjectUrl)
			}
		}
	}, [sdk, id, isPaged, page, isMobile])

	const canGoBack = page > 1
	const canGoForward = page < totalPages

	const mobileDisplayWidth = useMemo(() => {
		if (!isPaged || !isMobile) return 0
		// Use viewport width as base, accounting for safe area
		const viewportWidth = typeof window !== 'undefined' ? window.innerWidth * 0.95 : 375
		if (viewerSize.width > 0) {
			return Math.round(viewerSize.width * zoom)
		}
		return Math.round(viewportWidth * zoom)
	}, [isPaged, isMobile, zoom, viewerSize.width])

	const mobileRequestedImageWidth = useMemo(() => {
		if (!isPaged || !isMobile) return 0
		const baseWidth =
			viewerSize.width > 0
				? viewerSize.width
				: typeof window !== 'undefined'
					? window.innerWidth * 0.95
					: 375
		if (baseWidth <= 0) return 0
		const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
		return Math.max(900, Math.min(5000, Math.round(baseWidth * requestedZoom * dpr)))
	}, [isPaged, isMobile, viewerSize.width, requestedZoom])

	const mobilePagedImageUrl = useMemo(() => {
		if (!isPaged || !isMobile) return undefined
		if (!mobileRequestedImageWidth) return sdk.media.bookPageURL(id, page)
		return sdk.media.bookPageURL(id, page, {
			dimension: Dimension.Width,
			size: mobileRequestedImageWidth,
		})
	}, [sdk, id, page, isPaged, isMobile, mobileRequestedImageWidth])

	const desktopPagedPdfUrl = useMemo(() => {
		if (!isPaged || isMobile) return undefined
		const rawUrl = sdk.media.bookPagePdfURL(id, page)
		if (zoom !== 1) {
			const zoomPercent = Math.round(zoom * 100)
			return `${rawUrl}#toolbar=0&navpanes=0&zoom=${zoomPercent}`
		}
		const viewType =
			imageScaleFit === ReadingImageScaleFit.Width
				? 'FitH'
				: imageScaleFit === ReadingImageScaleFit.Height
					? 'FitV'
					: 'Fit'
		return `${rawUrl}#toolbar=0&navpanes=0&view=${viewType}`
	}, [sdk, id, page, zoom, isPaged, isMobile, imageScaleFit])

	const handlePageInputCommit = () => {
		const parsed = parseInt(pageInputValue, 10)
		if (!isNaN(parsed) && parsed >= 1 && parsed <= totalPages) {
			onPageChange?.(parsed)
		} else {
			// reset to current page if invalid
			setPageInputValue(String(page))
		}
	}

	const zoomIn = () => setZoom((prev) => Math.min(3, Number((prev + 0.2).toFixed(2))))
	const zoomOut = () => setZoom((prev) => Math.max(1, Number((prev - 0.2).toFixed(2))))
	const resetZoom = () => setZoom(1)

	const handleInteractiveClick = (event: React.MouseEvent) => {
		event.stopPropagation()
	}

	// Blur listener for PC native PDF clicks
	useEffect(() => {
		if (isMobile || !isPaged) return
		const handleBlur = () => {
			if (document.activeElement?.tagName === 'IFRAME') {
				setShowOverlay(false)
			}
		}
		window.addEventListener('blur', handleBlur)
		return () => window.removeEventListener('blur', handleBlur)
	}, [isMobile, isPaged])

	useEffect(() => {
		if (!isPaged || !isMobile) return
		const viewerElement = viewerRef.current
		if (!viewerElement) return

		const onTouchStart = (event: TouchEvent) => {
			if (event.touches.length !== 2) return

			event.preventDefault()
			setIsPinching(true)
			const first = event.touches[0]
			const second = event.touches[1]
			if (!first || !second) return
			const startDistance = Math.hypot(
				first.clientX - second.clientX,
				first.clientY - second.clientY,
			)
			pinchStateRef.current = {
				startDistance,
				startZoom: zoomRef.current,
			}
		}

		const onTouchMove = (event: TouchEvent) => {
			if (event.touches.length !== 2 || !pinchStateRef.current) return

			event.preventDefault()
			const first = event.touches[0]
			const second = event.touches[1]
			if (!first || !second) return
			const currentDistance = Math.hypot(
				first.clientX - second.clientX,
				first.clientY - second.clientY,
			)
			const ratio = currentDistance / pinchStateRef.current.startDistance
			const nextZoom = Math.min(
				4,
				Math.max(1, Number((pinchStateRef.current.startZoom * ratio).toFixed(2))),
			)
			if (nextZoom !== zoomRef.current) {
				setZoom(nextZoom)
			}
		}

		const onTouchEnd = () => {
			if (!pinchStateRef.current) return
			pinchStateRef.current = null
			setIsPinching(false)
			setRequestedZoom(zoomRef.current)
		}

		viewerElement.addEventListener('touchstart', onTouchStart, { passive: false })
		viewerElement.addEventListener('touchmove', onTouchMove, { passive: false })
		viewerElement.addEventListener('touchend', onTouchEnd, { passive: false })

		return () => {
			viewerElement.removeEventListener('touchstart', onTouchStart)
			viewerElement.removeEventListener('touchmove', onTouchMove)
			viewerElement.removeEventListener('touchmove', onTouchEnd)
		}
	}, [isPaged, isMobile])

	const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
		if (!isPaged) return
		if (!event.ctrlKey) return
		event.preventDefault()
		if (event.deltaY < 0) {
			zoomIn()
		} else {
			zoomOut()
		}
	}

	useEffect(() => {
		if (!isPaged || isMobile) return

		const handleGlobalCtrlWheel = (event: WheelEvent) => {
			if (!event.ctrlKey) return

			const viewerElement = viewerRef.current
			if (!viewerElement) return

			const bounds = viewerElement.getBoundingClientRect()
			const isInsideViewer =
				event.clientX >= bounds.left &&
				event.clientX <= bounds.right &&
				event.clientY >= bounds.top &&
				event.clientY <= bounds.bottom

			if (!isInsideViewer) return

			event.preventDefault()
			if (event.deltaY < 0) {
				zoomIn()
			} else {
				zoomOut()
			}
		}

		window.addEventListener('wheel', handleGlobalCtrlWheel, { passive: false })

		return () => {
			window.removeEventListener('wheel', handleGlobalCtrlWheel)
		}
	}, [isPaged, isMobile])

	return (
		<div className="inset-0 absolute flex flex-col overflow-hidden bg-background">
			{!showOverlay && !isMobile && isPaged && (
				<>
					<div
						className="inset-x-0 top-0 h-8 absolute z-40 bg-transparent"
						onMouseEnter={() => setShowOverlay(true)}
					/>
					<div className="right-3 top-3 absolute z-30">
						<Button size="xs" variant="ghost" onClick={() => setShowOverlay(true)}>
							Show controls
						</Button>
					</div>
				</>
			)}

			{showOverlay && (
				<div
					className="inset-x-0 top-0 border-white/20 bg-black/65 px-3 py-2 pointer-events-none absolute z-20 border-b"
					onClick={handleInteractiveClick}
				>
					<div className="gap-2 pointer-events-auto flex items-center">
						{exitUrl ? (
							<Link
								to={exitUrl}
								className="gap-1 text-sm text-white hover:text-white/90 flex shrink-0 items-center"
							>
								<ArrowLeft className="h-4 w-4" />
								<span className="sm:inline hidden">Exit</span>
							</Link>
						) : null}

						{title ? (
							<Text size="sm" className="min-w-0 text-white flex-1 truncate" variant="default">
								{title}
							</Text>
						) : (
							<span className="flex-1" />
						)}

						{isPaged && (
							<div className="gap-1 flex shrink-0 items-center">
								<div className="gap-1 flex items-center">
									<input
										type="number"
										min={1}
										max={totalPages}
										value={pageInputValue}
										className="w-14 rounded border-white/30 bg-black/40 px-1 py-0.5 text-sm text-white border text-center outline-none focus:ring-1 focus:ring-edge-brand"
										onChange={(e) => setPageInputValue(e.target.value)}
										onBlur={handlePageInputCommit}
										onKeyDown={(e) => {
											if (e.key === 'Enter') handlePageInputCommit()
										}}
									/>
									<Text size="sm" className="text-white/80" variant="default">
										/ {totalPages}
									</Text>
								</div>

								<Button size="xs" variant="ghost" onClick={zoomOut} disabled={zoom <= 1}>
									<Minus className="h-4 w-4" />
								</Button>
								<Button size="xs" variant="ghost" onClick={resetZoom}>
									<RotateCcw className="h-4 w-4" />
								</Button>
								<Button size="xs" variant="ghost" onClick={zoomIn} disabled={zoom >= 3}>
									<Plus className="h-4 w-4" />
								</Button>
							</div>
						)}
					</div>
				</div>
			)}

			<div
				ref={viewerRef}
				className="min-h-0 relative flex-1 overflow-hidden"
				onWheel={handleWheel}
				style={{
					touchAction: isPaged ? 'pan-x pan-y' : 'auto',
					overscrollBehavior: isPaged ? 'contain' : 'auto',
				}}
			>
				{isPaged && (
					<>
						{/* Left 20%: navigate to previous page */}
						<div
							className="left-0 top-0 absolute z-10 h-full w-[20%]"
							style={{ cursor: canGoBack ? 'pointer' : 'default' }}
							onClick={() => {
								if (canGoBack) onPageChange?.(Math.max(1, page - 1))
							}}
						/>
						{/* Center 60%: toggle overlay (thumbnail + controls) */}
						<div
							className="top-0 absolute left-[20%] z-10 h-full w-[60%] cursor-pointer"
							onClick={() => setShowOverlay((prev) => !prev)}
						/>
						{/* Right 20%: navigate to next page */}
						<div
							className="right-0 top-0 absolute z-10 h-full w-[20%]"
							style={{ cursor: canGoForward ? 'pointer' : 'default' }}
							onClick={() => {
								if (canGoForward) onPageChange?.(Math.min(totalPages, page + 1))
							}}
						/>
					</>
				)}
				{isPaged ? (
					<div className="bg-black/95 relative flex h-full w-full overflow-auto">
						{isMobile ? (
							<img
								key="mobile-paged-img"
								src={mobilePagedImageUrl}
								alt={`Page ${page}`}
								className="max-w-none shrink-0"
								style={{
									width: mobileDisplayWidth > 0 ? `${mobileDisplayWidth}px` : '100%',
									height: 'auto',
									display: 'block',
									margin: 'auto',
								}}
								draggable={false}
							/>
						) : (
							<iframe
								key="desktop-paged-iframe"
								src={desktopPagedPdfUrl}
								className="h-full w-full border-none"
								title={`PDF page ${page}`}
							/>
						)}
					</div>
				) : isMobile ? (
					<iframe
						key="mobile-iframe"
						src={sdk.media.downloadURL(id)}
						className="h-full w-full border-none"
						title={`PDF page ${page}`}
					/>
				) : (
					<>
						{isLoading && (
							<div className="inset-0 absolute flex items-center justify-center">
								<Text size="sm" variant="muted">
									Loading PDF page {page}…
								</Text>
							</div>
						)}

						{!!errorMessage && !isLoading && (
							<div className="gap-3 p-6 flex h-full flex-col items-center justify-center text-center">
								<Text className="max-w-xl" size="sm" variant="danger">
									{errorMessage}
								</Text>
								<Text size="sm" variant="muted">
									<Link href={sdk.media.downloadURL(id)}>Download the full PDF</Link> to read
									offline.
								</Text>
							</div>
						)}

						{pdfObjectUrl && !isLoading && !errorMessage && (
							<object data={pdfObjectUrl} type="application/pdf" className="h-full w-full">
								<Text>
									PDF failed to load. <Link href={sdk.media.downloadURL(id)}>Click here</Link> to
									download it directly.
								</Text>
							</object>
						)}
					</>
				)}
			</div>

			{isPaged && !errorMessage && showOverlay && (
				<div
					className="inset-x-0 bottom-3 px-3 pointer-events-none absolute z-20 flex justify-center"
					onClick={handleInteractiveClick}
				>
					<div className="max-w-5xl rounded-lg border-white/15 bg-black/60 shadow-2xl backdrop-blur-sm pointer-events-auto w-full border">
						<PageThumbnailStrip
							id={id}
							currentPage={page}
							totalPages={totalPages}
							onPageChange={onPageChange}
						/>
					</div>
				</div>
			)}
		</div>
	)
}

type StripProps = {
	id: string
	currentPage: number
	totalPages: number
	onPageChange?: (page: number) => void
}

function PageThumbnailStrip({ id, currentPage, totalPages, onPageChange }: StripProps) {
	const { sdk } = useSDK()
	const pages = Array.from({ length: totalPages }, (_, i) => i + 1)

	return (
		<div className="gap-1 p-2 scrollbar-thin flex overflow-x-auto">
			{pages.map((p) => {
				const isNear = Math.abs(p - currentPage) <= 5
				return (
					<button
						key={p}
						data-active={p === currentPage}
						className={[
							'gap-0.5 rounded p-0.5 flex shrink-0 flex-col items-center transition',
							p === currentPage ? 'ring-brand ring-2' : 'opacity-70 hover:opacity-100',
						].join(' ')}
						onClick={() => onPageChange?.(p)}
					>
						{isNear ? (
							<img
								src={sdk.media.bookPageURL(id, p)}
								alt={`Page ${p}`}
								className="h-16 rounded-sm w-auto object-contain"
								loading="lazy"
							/>
						) : (
							<div className="h-16 w-12 rounded-sm bg-black/20 dark:bg-white/10 shrink-0" />
						)}
						<Text size="xs" className="text-white/70" variant="default">
							{p}
						</Text>
					</button>
				)
			})}
		</div>
	)
}
