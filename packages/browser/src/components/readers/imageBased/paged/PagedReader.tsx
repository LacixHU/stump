import Panzoom from '@panzoom/panzoom'
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
		bookPreferences: {
			tapSidesToNavigate,
			imageScaling,
			secondPageSeparate,
			doublePageBehavior,
			panzoomWithoutCtrl,
		},
		settings: { showToolBar },
		setSettings,
	} = useBookPreferences({ book })

	const { innerWidth } = useWindowSize()

	const isMobile = useMediaMatch('(max-width: 768px)')

	const pageSetRef = useRef<HTMLDivElement | null>(null)
	const panzoomRef = useRef<ReturnType<typeof Panzoom> | null>(null)

	const panningDetected = useRef(false)
	const panGestureActive = useRef(false)
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
		const pageSetElement = pageSetRef.current
		if (!pageSetElement) return
		const previousTouchAction = pageSetElement.style.touchAction
		pageSetElement.style.touchAction = 'none'

		const parentElement = pageSetElement.parentElement
		if (!parentElement) return

		const handleWheel = (event: WheelEvent) => {
			if (event.ctrlKey || panzoomWithoutCtrl) {
				panzoomRef.current?.zoomWithWheel(event)
			}
		}

		// Check panning vs clicking
		let startX = 0
		let startY = 0
		const activePanPointerIds = new Set<number>()
		const pointerDownCache = new Map<number, PointerEvent>()
		let panInitialized = false

		const handlePointerDown = (event: PointerEvent) => {
			if (event.button === 2) return

			startX = event.clientX
			startY = event.clientY

			const isSidebarClicked = !!(event.target as HTMLElement).closest('.z-50')

			// Cache down event for later initialization
			pointerDownCache.set(event.pointerId, event)
			activePanPointerIds.add(event.pointerId)

			if (event.pointerType === 'touch') {
				// For touch, defer initialization until movement
				return
			}

			// Non-touch: initialize immediately if not on sidebar
			if (!isSidebarClicked && !panInitialized) {
				panGestureActive.current = true
				panzoomRef.current?.handleDown(event)
				panInitialized = true
				parentElement.style.cursor = 'move'
				pageSetElement.style.cursor = 'move'
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
			panzoomRef.current?.handleUp(event)
			activePanPointerIds.delete(event.pointerId)
			pointerDownCache.delete(event.pointerId)

			// Always reset pan state when no more pointers are active
			if (activePanPointerIds.size === 0) {
				panGestureActive.current = false
				panInitialized = false
				parentElement.style.cursor = 'default'
				pageSetElement.style.cursor = 'default'
			}

			panningDetected.current =
				Math.abs(deltaX) > PAN_GESTURE_THRESHOLD_PX || Math.abs(deltaY) > PAN_GESTURE_THRESHOLD_PX
			setTimeout(() => {
				panningDetected.current = false
			}, 100)
		}
		const handlePointerCancel = (event: PointerEvent) => {
			if (!activePanPointerIds.has(event.pointerId)) return

			panzoomRef.current?.handleUp(event)
			activePanPointerIds.delete(event.pointerId)
			pointerDownCache.delete(event.pointerId)

			// Always reset pan state when no more pointers are active
			if (activePanPointerIds.size === 0) {
				panGestureActive.current = false
				panInitialized = false
				parentElement.style.cursor = 'default'
				pageSetElement.style.cursor = 'default'
			}
		}
		const handleMove = (event: PointerEvent) => {
			if (!activePanPointerIds.has(event.pointerId)) return

			// For touch input, only initialize pan when movement threshold exceeded
			// Only check this once per gesture (panInitialized gates it)
			if (event.pointerType === 'touch' && !panInitialized && activePanPointerIds.size > 0) {
				// Compute max movement across all active pointers comparing latest -> down
				let moved = false
				for (const id of activePanPointerIds) {
					const down = pointerDownCache.get(id)
					if (!down) continue
					const dx = event.clientX - down.clientX
					const dy = event.clientY - down.clientY
					if (Math.hypot(dx, dy) >= PAN_GESTURE_THRESHOLD_PX) {
						moved = true
						break
					}
				}

				// Require a meaningful movement before initializing pan/zoom
				if (!moved) return

				// If single-touch started in page-change side area (10% both sides),
				// only initialize pan if the image is zoomed (scale > 1).
				if (activePanPointerIds.size === 1) {
					const onlyId = Array.from(activePanPointerIds)[0]
					if (onlyId == null) return
					const down = pointerDownCache.get(onlyId)
					if (!down) return
					// Use the actual element width, not window width, so it adapts to rotation
					const elementRect = pageSetElement.getBoundingClientRect()
					const elementLeft = elementRect.left
					const elementWidth = elementRect.width
					const startedOnSideArea =
						down &&
						(down.clientX <= elementLeft + elementWidth * 0.1 ||
							down.clientX >= elementLeft + elementWidth * 0.9)
					if (startedOnSideArea) {
						// For side-area taps, only allow pan if image is zoomed
						const scale = pageSetElement.style.transform
							? parseFloat(pageSetElement.style.transform.match(/scale\(([^)]+)\)/)?.[1] || '1')
							: 1
						if (scale <= 1) return
					}
				}

				// Initialize Panzoom with all cached down events
				for (const id of activePanPointerIds) {
					const down = pointerDownCache.get(id)
					if (down) panzoomRef.current?.handleDown(down)
				}
				panInitialized = true
				panGestureActive.current = true
				parentElement.style.cursor = 'move'
				pageSetElement.style.cursor = 'move'
			}

			panzoomRef.current?.handleMove(event)
		}

		/**
		 * A function that manually calculates the correct panzoom origin due to the default origin X value being wrong
		 *
		 * Because we do not set pageSet imagesHolder to use w-full (for SideBarControl to expand up to the pageSet), then
		 * for some reason '50%' from the left is marked as where this is: pageSetWidth / 2 to the left of the right side of the viewport.
		 *
		 * But the real center is at the center of the viewport so we must do the origin calculation with respect to this weird coordinate system.
		 *
		 * Hence we:
		 * 1. Calculate the stretch factor required -> viewportWidth / pageSetWidth
		 * 2. Calculate the fraction it is from the right side of the viewport -> 50% * viewportWidth / pageSetWidth
		 * 3. Calculate the fraction it is from the left side of the viewport -> 1 - 50% * viewportWidth / pageSetWidth
		 * 4. Convert to a percentage
		 */
		const panzoomOriginCalculation = () => {
			const viewportWidth = window.innerWidth
			const xOrigin = (1 - viewportWidth / (2 * pageSetWidth)) * 100
			const origin = `${xOrigin}% 50%`
			return origin
		}

		const createPanzoom = () => {
			if (panzoomRef.current) {
				panzoomRef.current.destroy()
			}

			const pz = Panzoom(pageSetElement, {
				noBind: true,
				cursor: 'default',
				minScale: 0.8,
				maxScale: 2.5,
				origin: panzoomOriginCalculation(),
				pinchAndPan: true,
			})

			panzoomRef.current = pz
		}

		createPanzoom()

		parentElement.addEventListener('wheel', handleWheel)
		parentElement.addEventListener('pointerdown', handlePointerDown)
		document.addEventListener('pointermove', handleMove)
		document.addEventListener('pointerup', handlePointerUp)
		document.addEventListener('pointercancel', handlePointerCancel)
		window.addEventListener('resize', createPanzoom)

		return () => {
			pageSetElement.style.touchAction = previousTouchAction
			parentElement.removeEventListener('wheel', handleWheel)
			parentElement.removeEventListener('pointerdown', handlePointerDown)
			document.removeEventListener('pointermove', handleMove)
			document.removeEventListener('pointerup', handlePointerUp)
			document.removeEventListener('pointercancel', handlePointerCancel)
			window.removeEventListener('resize', createPanzoom)
			panzoomRef.current?.destroy()
		}
	}, [
		currentPage,
		imageScaling,
		secondPageSeparate,
		doublePageBehavior,
		pageSetWidth,
		panzoomWithoutCtrl,
	])

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
		const scrollElement = pageSetRef.current?.parentElement?.parentElement?.parentElement
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
			const scrollElement = pageSetRef.current?.parentElement?.parentElement?.parentElement
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

	return (
		<div className="relative flex h-screen w-full justify-center overflow-hidden">
			{!showToolBar && tapSidesToNavigate && (
				<SideBarControl
					fixed={fixSideNavigation}
					position="left"
					onClick={() => handleLeftwardPageChange()}
				/>
			)}

			<PageSet
				ref={pageSetRef}
				currentPage={currentPage}
				getPageUrl={getPageUrl}
				onPageClick={() => {
					if (!panningDetected.current) {
						setSettings({ showToolBar: !showToolBar })
					}
				}}
			/>

			{!showToolBar && tapSidesToNavigate && (
				<SideBarControl
					fixed={fixSideNavigation}
					position="right"
					onClick={() => handleRightwardPageChange()}
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
}

/**
 * A component that renders an invisible div on either the left or right side of the screen that, when
 * clicked, will call the onClick callback. This is used in the `PagedReader` component for
 * navigating to the next/previous page.
 */
function SideBarControl({ onClick, position, fixed }: SideBarControlProps) {
	const pointerDownPosition = useRef<{ x: number; y: number } | null>(null)
	const TAP_MOVE_TOLERANCE_PX = 10

	const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
		pointerDownPosition.current = { x: event.clientX, y: event.clientY }
	}, [])

	const handlePointerUp = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			const start = pointerDownPosition.current
			pointerDownPosition.current = null
			if (!start) return

			const deltaX = Math.abs(event.clientX - start.x)
			const deltaY = Math.abs(event.clientY - start.y)
			if (deltaX <= TAP_MOVE_TOLERANCE_PX && deltaY <= TAP_MOVE_TOLERANCE_PX) {
				onClick()
			}
		},
		[onClick],
	)

	const clearPointerTracking = useCallback(() => {
		pointerDownPosition.current = null
	}, [])

	return (
		<div
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
