import Panzoom from '@panzoom/panzoom'
import { IMAGE_BASED_READER_WEB_MAX_ZOOM } from '@stump/sdk'
import clsx from 'clsx'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import { Hotkey } from 'react-hotkeys-hook/dist/types'
import { useMediaMatch, useWindowSize } from 'rooks'

import { useBookPreferences } from '@/scenes/book/reader/useBookPreferences'

import { useImageBaseReaderContext } from '../context'
import PageSet from './PageSet'

export type PagedReaderProps = {
	/** The current page which the reader should render */
	currentPage: number
	/** A callback that is called in order to change the page */
	onPageChange: (page: number) => void
}

/**
 * A reader component for image-based media. Images are displayed one at a time,
 * however preloading is done to reduce wait times for consecutive pages.
 *
 * Note: This component lacks animations between pages. The `AnimatedPagedReader` component
 * will have animations between pages, but is currently a WIP
 */
function PagedReader({ currentPage, onPageChange }: PagedReaderProps) {
	const { pageSets, book, getPageUrl } = useImageBaseReaderContext()
	const {
		bookPreferences: { tapSidesToNavigate, panzoomWithoutCtrl },
		settings: { showToolBar },
		setSettings,
	} = useBookPreferences({ book })

	const { innerWidth } = useWindowSize()

	const isMobile = useMediaMatch('(max-width: 768px)')

	// Content width (for side-nav sizing). Separate from the full-bleed panzoom surface.
	const pageSetRef = useRef<HTMLDivElement | null>(null)
	// Full-viewport element that panzoom transforms. Must fill its parent so default
	// origin 50% 50% keeps pinch/wheel focal points under the fingers/cursor.
	const panzoomSurfaceRef = useRef<HTMLDivElement | null>(null)
	const panzoomRef = useRef<ReturnType<typeof Panzoom> | null>(null)
	const panzoomWithoutCtrlRef = useRef(panzoomWithoutCtrl)
	useEffect(() => {
		panzoomWithoutCtrlRef.current = panzoomWithoutCtrl
	}, [panzoomWithoutCtrl])

	const panningDetected = useRef(false)
	const panGestureActive = useRef(false)
	// Blocks side-tap page turns while pinching/panning (including when one finger is on a side bar)
	const suppressSideNavigationRef = useRef(false)
	const PAN_GESTURE_THRESHOLD_PX = 2

	const [pageSetWidth, setPageSetWidth] = useState(0)
	useEffect(() => {
		const pageSetElement = pageSetRef.current
		if (!pageSetElement) return

		const resizeObserver = new ResizeObserver((entries) => {
			if (!entries[0]) return
			const newWidth = entries[0].contentRect.width
			setPageSetWidth(newWidth)
		})
		resizeObserver.observe(pageSetElement)
		return () => {
			resizeObserver.disconnect()
		}
	}, [])

	useEffect(() => {
		const surfaceElement = panzoomSurfaceRef.current
		if (!surfaceElement) return
		const previousTouchAction = surfaceElement.style.touchAction
		surfaceElement.style.touchAction = 'none'

		const parentElement = surfaceElement.parentElement
		if (!parentElement) return

		const createPanzoom = () => {
			if (panzoomRef.current) {
				panzoomRef.current.destroy()
			}

			// Keep default origin ('50% 50%'). Custom origins break panzoom focal-point
			// math used by pinch and wheel zoom (fingers/cursor drift off content).
			// Pinch focal/pan behavior is corrected in patches/@panzoom+panzoom+4.6.1.patch
			const pz = Panzoom(surfaceElement, {
				noBind: true,
				cursor: 'default',
				minScale: 0.8,
				maxScale: IMAGE_BASED_READER_WEB_MAX_ZOOM,
			})

			panzoomRef.current = pz
		}

		createPanzoom()

		const handleWheel = (event: WheelEvent) => {
			if (event.ctrlKey || panzoomWithoutCtrlRef.current) {
				panzoomRef.current?.zoomWithWheel(event)
			}
		}

		// Check panning vs clicking
		let startX = 0
		let startY = 0
		const activePanPointerIds = new Set<number>()
		// Latest event per pointer (down or move) so pinch starts at current finger positions
		const latestPointerEvents = new Map<number, PointerEvent>()
		const pointerDownPositions = new Map<number, { x: number; y: number }>()
		// True when that pointer's down target was a page-change side bar
		const pointerStartedOnSideNav = new Map<number, boolean>()
		let panInitialized = false

		const setCursor = (cursor: string) => {
			parentElement.style.cursor = cursor
			surfaceElement.style.cursor = cursor
		}

		const markSideNavSuppressed = () => {
			suppressSideNavigationRef.current = true
			panningDetected.current = true
		}

		const resetPointerTracking = () => {
			activePanPointerIds.clear()
			latestPointerEvents.clear()
			pointerDownPositions.clear()
			pointerStartedOnSideNav.clear()
			panInitialized = false
			panGestureActive.current = false
			setCursor('default')
		}

		const beginPanzoomWithActivePointers = () => {
			for (const id of activePanPointerIds) {
				const pointerEvent = latestPointerEvents.get(id)
				if (pointerEvent) panzoomRef.current?.handleDown(pointerEvent)
			}
			panInitialized = true
			panGestureActive.current = true
			markSideNavSuppressed()
			setCursor('move')
		}

		const isSideAreaSingleTouchBlocked = () => {
			if (activePanPointerIds.size !== 1) return false
			const onlyId = Array.from(activePanPointerIds)[0]
			if (onlyId == null) return false

			const scale = panzoomRef.current?.getScale() ?? 1
			if (scale > 1) return false

			// Prefer hit-target: side bars are 20% when fixed; geometric 10% is only a fallback
			if (pointerStartedOnSideNav.get(onlyId)) return true

			const down = pointerDownPositions.get(onlyId)
			if (!down) return false
			const elementRect = surfaceElement.getBoundingClientRect()
			return (
				down.x <= elementRect.left + elementRect.width * 0.1 ||
				down.x >= elementRect.left + elementRect.width * 0.9
			)
		}

		const releasePointer = (event: PointerEvent) => {
			if (!activePanPointerIds.has(event.pointerId)) return

			if (panGestureActive.current) {
				panzoomRef.current?.handleUp(event)
			}

			activePanPointerIds.delete(event.pointerId)
			latestPointerEvents.delete(event.pointerId)
			pointerDownPositions.delete(event.pointerId)
			pointerStartedOnSideNav.delete(event.pointerId)

			if (activePanPointerIds.size === 0) {
				panInitialized = false
				panGestureActive.current = false
				setCursor('default')
				// Keep suppress briefly so side-bar pointerup does not change page after a pinch
				setTimeout(() => {
					if (activePanPointerIds.size === 0) {
						suppressSideNavigationRef.current = false
					}
				}, 100)
			} else if (panInitialized && panGestureActive.current) {
				// Remaining finger(s): re-baseline panzoom after handleUp clears isPanning
				for (const id of activePanPointerIds) {
					const pointerEvent = latestPointerEvents.get(id)
					if (pointerEvent) panzoomRef.current?.handleDown(pointerEvent)
				}
			}
		}

		const handlePointerDown = (event: PointerEvent) => {
			if (event.button === 2) return
			// Only track pointers that land inside the reader viewport
			if (!parentElement.contains(event.target as Node)) return

			startX = event.clientX
			startY = event.clientY

			const startedOnSideNav = !!(event.target as HTMLElement).closest('[data-reader-side-nav]')

			// Mouse on side nav: leave to SideBarControl (page turn), do not pan
			if (event.pointerType !== 'touch' && startedOnSideNav) return

			latestPointerEvents.set(event.pointerId, event)
			pointerDownPositions.set(event.pointerId, { x: event.clientX, y: event.clientY })
			pointerStartedOnSideNav.set(event.pointerId, startedOnSideNav)
			activePanPointerIds.add(event.pointerId)

			if (event.pointerType === 'touch') {
				// Two or more fingers: always allow pinch, even if one is on a side bar
				if (activePanPointerIds.size >= 2) {
					markSideNavSuppressed()
					if (panInitialized && panGestureActive.current) {
						panzoomRef.current?.handleDown(event)
					} else {
						beginPanzoomWithActivePointers()
					}
					event.preventDefault()
					return
				}

				// Single touch on side nav at 1x: defer; page turn handled by SideBarControl
				if (startedOnSideNav && (panzoomRef.current?.getScale() ?? 1) <= 1) {
					return
				}

				// Single touch: defer until movement so taps still work
				return
			}

			// Non-touch: initialize immediately
			if (!panInitialized) {
				beginPanzoomWithActivePointers()
				event.preventDefault()
			}
		}
		const handlePointerUp = (event: PointerEvent) => {
			if (!activePanPointerIds.has(event.pointerId)) {
				panningDetected.current = false
				return
			}

			const deltaX = event.clientX - startX
			const deltaY = event.clientY - startY
			releasePointer(event)

			panningDetected.current =
				Math.abs(deltaX) > PAN_GESTURE_THRESHOLD_PX || Math.abs(deltaY) > PAN_GESTURE_THRESHOLD_PX
			setTimeout(() => {
				panningDetected.current = false
			}, 100)
		}
		const handlePointerCancel = (event: PointerEvent) => {
			releasePointer(event)
		}
		const handleLostPointerCapture = (event: PointerEvent) => {
			releasePointer(event)
		}
		const handleVisibilityChange = () => {
			if (document.visibilityState === 'visible') return
			resetPointerTracking()
		}
		const handleMove = (event: PointerEvent) => {
			if (!activePanPointerIds.has(event.pointerId)) return

			latestPointerEvents.set(event.pointerId, event)

			// For touch input, only initialize single-finger pan when movement exceeds threshold
			if (event.pointerType === 'touch' && !panInitialized) {
				let moved = false
				for (const id of activePanPointerIds) {
					const down = pointerDownPositions.get(id)
					const latest = latestPointerEvents.get(id)
					if (!down || !latest) continue
					if (
						Math.hypot(latest.clientX - down.x, latest.clientY - down.y) >= PAN_GESTURE_THRESHOLD_PX
					) {
						moved = true
						break
					}
				}

				if (!moved && activePanPointerIds.size < 2) return
				if (isSideAreaSingleTouchBlocked()) return

				beginPanzoomWithActivePointers()
			}

			if (panGestureActive.current) {
				panzoomRef.current?.handleMove(event)
			}
		}

		parentElement.addEventListener('wheel', handleWheel)
		// Capture phase so side-nav stopPropagation cannot hide a finger from pinch tracking
		parentElement.addEventListener('pointerdown', handlePointerDown, true)
		document.addEventListener('pointermove', handleMove)
		document.addEventListener('pointerup', handlePointerUp)
		document.addEventListener('pointercancel', handlePointerCancel)
		document.addEventListener('lostpointercapture', handleLostPointerCapture)
		document.addEventListener('visibilitychange', handleVisibilityChange)

		return () => {
			surfaceElement.style.touchAction = previousTouchAction
			parentElement.removeEventListener('wheel', handleWheel)
			parentElement.removeEventListener('pointerdown', handlePointerDown, true)
			document.removeEventListener('pointermove', handleMove)
			document.removeEventListener('pointerup', handlePointerUp)
			document.removeEventListener('pointercancel', handlePointerCancel)
			document.removeEventListener('lostpointercapture', handleLostPointerCapture)
			document.removeEventListener('visibilitychange', handleVisibilityChange)
			resetPointerTracking()
			suppressSideNavigationRef.current = false
			panzoomRef.current?.reset({ animate: false })
			panzoomRef.current?.destroy()
			panzoomRef.current = null
		}
	}, [])

	useEffect(() => {
		panzoomRef.current?.reset({ animate: false })
	}, [currentPage])

	const currentSetIdx = useMemo(
		() => pageSets.findIndex((set) => set.includes(currentPage - 1)),
		[currentPage, pageSets],
	)

	/**
	 * If the image parts are collective >= 86% of the screen width, we want to fix the side navigation
	 */
	const fixSideNavigation = useMemo(() => {
		return (!!innerWidth && pageSetWidth >= innerWidth * 0.86) || isMobile
	}, [pageSetWidth, innerWidth, isMobile])

	/**
	 * Record previous scroll position to restore if backtracked within 3 seconds
	 */
	const scrollPositionMap = useRef(new Map<number, { scrollTop: number; timestamp: number }>())

	useEffect(() => {
		const scrollElement = panzoomSurfaceRef.current?.parentElement?.parentElement?.parentElement
		const storedScrollState = scrollPositionMap.current.get(currentSetIdx)
		let scrollTop = 0
		if (storedScrollState && Date.now() - storedScrollState.timestamp < 3000) {
			scrollTop = storedScrollState.scrollTop
		}
		scrollElement?.scrollTo({ top: scrollTop, behavior: 'smooth' })
	}, [currentSetIdx])

	/**
	 * A callback to actually change the page. This should not be called directly, but rather
	 * through the `handleLeftwardPageChange` and `handleRightwardPageChange` callbacks to
	 * ensure that the reading direction is respected.
	 *
	 * @param newPage The new page to navigate to (1-indexed)
	 */
	const doChangePage = useCallback(
		(newPage: number) => {
			const scrollElement = panzoomSurfaceRef.current?.parentElement?.parentElement?.parentElement
			const scrollTop = scrollElement?.scrollTop ?? 0
			scrollPositionMap.current.set(currentSetIdx, { scrollTop: scrollTop, timestamp: Date.now() })

			if (newPage <= book.pages && newPage > 0) {
				onPageChange(newPage)
			}
		},
		[book.pages, onPageChange, currentSetIdx],
	)

	/**
	 * A callback to change the page to the left. This will respect the reading direction
	 * and the double spread setting.
	 */
	const handleLeftwardPageChange = useCallback(() => {
		const nextSetIdx = currentSetIdx - 1
		const nextSet = pageSets[nextSetIdx]
		const endOfNextSet = nextSet?.at(-1)

		if (!nextSet || endOfNextSet == null || panningDetected.current) {
			return
		}

		if (nextSetIdx >= 0 && nextSetIdx < pageSets.length) {
			doChangePage(endOfNextSet + 1)
		}
	}, [doChangePage, currentSetIdx, pageSets])
	/**
	 * A callback to change the page to the right. This will respect the reading direction
	 * and the double spread setting.
	 */
	const handleRightwardPageChange = useCallback(() => {
		const nextSetIdx = currentSetIdx + 1
		const nextSet = pageSets[nextSetIdx]
		const startOfNextSet = nextSet?.at(0)

		if (!nextSet || startOfNextSet == null || panningDetected.current) {
			return
		}

		if (nextSetIdx >= 0 && nextSetIdx < pageSets.length) {
			doChangePage(startOfNextSet + 1)
		}
	}, [doChangePage, currentSetIdx, pageSets])

	/**
	 * A callback handler for changing the page or toggling the toolbar visibility via
	 * keyboard shortcuts.
	 */
	const hotKeyHandler = useCallback(
		(hotkey: Hotkey) => {
			const targetKey = hotkey.keys?.at(0)
			switch (targetKey) {
				case 'right':
					handleRightwardPageChange()
					break
				case 'left':
					handleLeftwardPageChange()
					break
				case 'space':
					setSettings({
						showToolBar: !showToolBar,
					})
					break
				case 'escape':
					setSettings({
						showToolBar: false,
					})
					break
				default:
					break
			}
		},
		[setSettings, showToolBar, handleRightwardPageChange, handleLeftwardPageChange],
	)
	/**
	 * Register the hotkeys for the reader component
	 */
	useHotkeys('right, left, space, escape', (_, handler) => hotKeyHandler(handler))

	const handleViewportClick = useCallback(
		(event: React.MouseEvent<HTMLDivElement>) => {
			if ((event.target as HTMLElement).closest('.z-50')) return
			if (!panningDetected.current) {
				setSettings({ showToolBar: !showToolBar })
			}
		},
		[setSettings, showToolBar],
	)

	return (
		<div
			className="min-h-0 relative flex h-[100dvh] w-full justify-center overflow-hidden"
			onClick={handleViewportClick}
		>
			{!showToolBar && tapSidesToNavigate && (
				<SideBarControl
					fixed={fixSideNavigation}
					position="left"
					onClick={() => handleLeftwardPageChange()}
					shouldSuppressNavigation={() => suppressSideNavigationRef.current}
				/>
			)}

			{/* Full-bleed surface so panzoom focal math matches viewport (pinch stays under fingers) */}
			<div
				ref={panzoomSurfaceRef}
				className="inset-0 absolute z-0 flex items-center justify-center"
			>
				<PageSet ref={pageSetRef} currentPage={currentPage} getPageUrl={getPageUrl} />
			</div>

			{!showToolBar && tapSidesToNavigate && (
				<SideBarControl
					fixed={fixSideNavigation}
					position="right"
					onClick={() => handleRightwardPageChange()}
					shouldSuppressNavigation={() => suppressSideNavigationRef.current}
				/>
			)}
		</div>
	)
}

type SideBarControlProps = {
	/** A callback that is called when the sidebar is clicked */
	onClick: () => void
	/** The position of the sidebar control */
	position: 'left' | 'right'
	/** Whether the sidebar should be fixed to the screen */
	fixed: boolean
	/** When true, ignore the tap (e.g. pinch/pan used a finger on this bar) */
	shouldSuppressNavigation?: () => boolean
}

/**
 * A component that renders an invisible div on either the left or right side of the screen that, when
 * clicked, will call the onClick callback. This is used in the `PagedReader` component for
 * navigating to the next/previous page.
 */
function SideBarControl({
	onClick,
	position,
	fixed,
	shouldSuppressNavigation,
}: SideBarControlProps) {
	const pointerDownPosition = useRef<{ x: number; y: number } | null>(null)
	const TAP_MOVE_TOLERANCE_PX = 10

	const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
		// Do not stopPropagation: pinch needs this finger if the other is on the page.
		// Capture-phase panzoom tracking also observes this event.
		pointerDownPosition.current = { x: event.clientX, y: event.clientY }
	}, [])

	const handlePointerUp = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			const start = pointerDownPosition.current
			pointerDownPosition.current = null
			if (!start) return
			if (shouldSuppressNavigation?.()) return

			const deltaX = Math.abs(event.clientX - start.x)
			const deltaY = Math.abs(event.clientY - start.y)
			if (deltaX <= TAP_MOVE_TOLERANCE_PX && deltaY <= TAP_MOVE_TOLERANCE_PX) {
				onClick()
			}
		},
		[onClick, shouldSuppressNavigation],
	)

	const clearPointerTracking = useCallback(() => {
		pointerDownPosition.current = null
	}, [])

	return (
		<div
			data-reader-side-nav
			className={clsx(
				'z-50 h-full shrink-0 border border-transparent transition-all duration-300',
				'active:border-edge-subtle active:bg-background-surface/50',
				fixed ? 'absolute w-[20%]' : 'relative mx-[-3%] flex flex-1 grow',
				{ 'right-0': position === 'right' },
				{ 'left-0': position === 'left' },
			)}
			onPointerDown={handlePointerDown}
			onPointerUp={handlePointerUp}
			onPointerCancel={clearPointerTracking}
		/>
	)
}

export default memo(PagedReader)
