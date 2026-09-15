import type { RetroPlatform } from '@stump/client'
import { Button, cn } from '@stump/components'
import { type PointerEvent, type RefObject, useCallback, useEffect, useRef, useState } from 'react'

import type { RetroEmulatorHandle } from './emulators'
import {
	dispatchKey,
	isJoystick,
	JOYSTICK_ID,
	type JoystickDirection,
	OVERLAY_CONTROL_IDS,
	type OverlayControlId,
	type OverlayKeyId,
	overlayLabel,
} from './keys'

/** How a control reaches the machine; see `RetroEmulatorHandle.sendKey`. */
type SendKey = NonNullable<RetroEmulatorHandle['sendKey']>

export type OverlayKeyPlacement = {
	id: OverlayControlId
	x: number
	y: number
}

const C64_EDITOR_ROWS: OverlayControlId[][] = [
	[
		'arrowleft',
		'1',
		'2',
		'3',
		'4',
		'5',
		'6',
		'7',
		'8',
		'9',
		'0',
		'plus',
		'minus',
		'pound',
		'home',
		'instdel',
	],
	['ctrl', 'q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p', 'at', 'star', 'arrowup', 'runstop'],
	[
		'commodore',
		'a',
		's',
		'd',
		'f',
		'g',
		'h',
		'j',
		'k',
		'l',
		'colon',
		'semicolon',
		'equals',
		'return',
	],
	['shift', 'z', 'x', 'c', 'v', 'b', 'n', 'm', 'comma', 'period', 'slash', 'shiftright'],
	['space'],
	['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'restore'],
	[
		JOYSTICK_ID,
		'fire',
		'up',
		'down',
		'left',
		'right',
		'cursorup',
		'cursordown',
		'cursorleft',
		'cursorright',
	],
]

/**
 * The Spectrum's 40 keys, in rubber-keyboard order, plus the stick. There are no function
 * keys, no C= and no RUN/STOP to offer: every other legend on the machine is CAPS SHIFT or
 * SYMBOL SHIFT plus one of these.
 */
const SPECTRUM_EDITOR_ROWS: OverlayControlId[][] = [
	['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
	['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
	['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'return'],
	['capsshift', 'z', 'x', 'c', 'v', 'b', 'n', 'm', 'symbolshift', 'space'],
	[JOYSTICK_ID, 'fire', 'up', 'down', 'left', 'right'],
]

const AMIGA_EDITOR_ROWS: OverlayControlId[][] = [
	['runstop', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'delete', 'help'],
	[
		'backquote',
		'1',
		'2',
		'3',
		'4',
		'5',
		'6',
		'7',
		'8',
		'9',
		'0',
		'minus',
		'equals',
		'backslash',
		'instdel',
	],
	[
		'tab',
		'q',
		'w',
		'e',
		'r',
		't',
		'y',
		'u',
		'i',
		'o',
		'p',
		'bracketleft',
		'bracketright',
		'return',
	],
	['ctrl', 'capslock', 'a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'semicolon', 'quote'],
	['shift', 'z', 'x', 'c', 'v', 'b', 'n', 'm', 'comma', 'period', 'slash', 'shiftright'],
	['alt', 'commodore', 'space'],
	[
		JOYSTICK_ID,
		'fire',
		'up',
		'down',
		'left',
		'right',
		'cursorup',
		'cursordown',
		'cursorleft',
		'cursorright',
	],
]

const EDITOR_ROWS: Partial<Record<RetroPlatform, OverlayControlId[][]>> = {
	c64: C64_EDITOR_ROWS,
	spectrum: SPECTRUM_EDITOR_ROWS,
	amiga: AMIGA_EDITOR_ROWS,
}

/** Whether this platform has a key vocabulary the overlay can be built from. */
export function hasOverlayControls(platform: RetroPlatform): boolean {
	return platform in EDITOR_ROWS
}

export const DEFAULT_OVERLAY_KEYS: OverlayKeyPlacement[] = [
	{ id: JOYSTICK_ID, x: 0.15, y: 0.74 },
	{ id: 'fire', x: 0.88, y: 0.78 },
	{ id: 'runstop', x: 0.42, y: 0.92 },
	{ id: 'space', x: 0.56, y: 0.92 },
	{ id: 'return', x: 0.7, y: 0.92 },
]

/**
 * A Spectrum stick presses whatever keys the joystick scheme names, so the overlay wants
 * the keys a game asks for around it -- `1` and `2` pick a control method in half the
 * catalogue -- rather than the C64's RUN/STOP.
 */
const SPECTRUM_OVERLAY_KEYS: OverlayKeyPlacement[] = [
	{ id: JOYSTICK_ID, x: 0.15, y: 0.74 },
	{ id: 'fire', x: 0.88, y: 0.78 },
	{ id: '1', x: 0.42, y: 0.92 },
	{ id: '2', x: 0.52, y: 0.92 },
	{ id: 'return', x: 0.68, y: 0.92 },
]

const AMIGA_OVERLAY_KEYS: OverlayKeyPlacement[] = [
	{ id: JOYSTICK_ID, x: 0.15, y: 0.74 },
	{ id: 'fire', x: 0.88, y: 0.78 },
	{ id: 'space', x: 0.42, y: 0.92 },
	{ id: 'return', x: 0.56, y: 0.92 },
	{ id: 'runstop', x: 0.7, y: 0.92 },
]

const PLATFORM_OVERLAY_KEYS: Partial<Record<RetroPlatform, OverlayKeyPlacement[]>> = {
	spectrum: SPECTRUM_OVERLAY_KEYS,
	amiga: AMIGA_OVERLAY_KEYS,
}

/** The layout a game starts with when it has no `controls.json` of its own. */
export function defaultOverlayKeys(platform: RetroPlatform): OverlayKeyPlacement[] {
	return PLATFORM_OVERLAY_KEYS[platform] ?? DEFAULT_OVERLAY_KEYS
}

const ALLOW = OVERLAY_CONTROL_IDS as readonly string[]

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

export function resolveOverlayLayout(
	data: unknown,
	platform: RetroPlatform = 'c64',
): OverlayKeyPlacement[] {
	const fallback = defaultOverlayKeys(platform)
	if (!data || typeof data !== 'object' || !('keys' in data)) {
		return fallback
	}
	const raw = (data as { keys: unknown }).keys
	if (!Array.isArray(raw) || raw.length === 0) {
		return fallback
	}
	const out: OverlayKeyPlacement[] = []
	for (const item of raw) {
		if (!item || typeof item !== 'object') continue
		const rec = item as { id?: unknown; x?: unknown; y?: unknown }
		if (typeof rec.id !== 'string') continue
		const id = rec.id.toLowerCase()
		if (!ALLOW.includes(id) || out.some((k) => k.id === id)) continue
		const x = typeof rec.x === 'number' ? rec.x : Number(rec.x)
		const y = typeof rec.y === 'number' ? rec.y : Number(rec.y)
		if (!Number.isFinite(x) || !Number.isFinite(y)) continue
		out.push({
			id: id as OverlayControlId,
			x: clamp01(x),
			y: clamp01(y),
		})
	}
	return out.length ? out : fallback
}

type PlacementProps = {
	placement: OverlayKeyPlacement
	editing: boolean
	onMove?: (id: OverlayControlId, x: number, y: number) => void
	onReleased?: () => void
	containerRef: RefObject<HTMLDivElement | null>
	platform: RetroPlatform
	sendKey: SendKey
}

/**
 * Edit mode turns every control into a drag handle: the pointer stream repositions it
 * within the playfield instead of reaching the emulator. Shared by the buttons and the
 * stick so both move -- and clamp -- identically.
 */
function usePlacementDrag(
	id: OverlayControlId,
	containerRef: RefObject<HTMLDivElement | null>,
	onMove?: (id: OverlayControlId, x: number, y: number) => void,
) {
	const dragging = useRef(false)

	const begin = useCallback(() => {
		dragging.current = true
	}, [])

	const end = useCallback(() => {
		dragging.current = false
	}, [])

	const drag = useCallback(
		(e: PointerEvent<HTMLElement>) => {
			if (!dragging.current) return
			const box = containerRef.current?.getBoundingClientRect()
			if (!box || box.width <= 0 || box.height <= 0) return
			onMove?.(
				id,
				clamp01((e.clientX - box.left) / box.width),
				clamp01((e.clientY - box.top) / box.height),
			)
		},
		[containerRef, id, onMove],
	)

	return { begin, drag, end }
}

/** Fraction of the base radius the finger must clear before any direction engages. */
const JOYSTICK_DEAD_ZONE = 0.24

/**
 * How far the knob rides from the centre at full deflection, as a fraction of the base
 * radius. Sized so the knob comes to rest flush with the inside of the ring.
 */
const JOYSTICK_TRAVEL = 0.55

/**
 * Cosine of the half-angle of a cardinal window. At 0.5 a pure direction spans 60 degrees
 * against a 30 degree diagonal: most C64 games are four-way, where a stray diagonal is a
 * missed jump, and the ones that do want eight-way still reach the corners easily.
 */
const JOYSTICK_DIAGONAL_THRESHOLD = 0.5

/**
 * Which directions a finger at (`dx`, `dy`) from the centre of a stick of `radius` holds.
 * A diagonal is two directions at once, exactly as a real stick closes two switches.
 */
export function joystickDirections(dx: number, dy: number, radius: number): JoystickDirection[] {
	const distance = Math.hypot(dx, dy)
	if (distance <= 0 || distance < radius * JOYSTICK_DEAD_ZONE) return []

	const nx = dx / distance
	const ny = dy / distance
	const out: JoystickDirection[] = []
	if (ny <= -JOYSTICK_DIAGONAL_THRESHOLD) out.push('up')
	if (ny >= JOYSTICK_DIAGONAL_THRESHOLD) out.push('down')
	if (nx <= -JOYSTICK_DIAGONAL_THRESHOLD) out.push('left')
	if (nx >= JOYSTICK_DIAGONAL_THRESHOLD) out.push('right')
	return out
}

const JOYSTICK_HINTS: Array<{ direction: JoystickDirection; glyph: string; className: string }> = [
	{ className: 'top-1 left-1/2 -translate-x-1/2', direction: 'up', glyph: '▲' },
	{ className: 'bottom-1 left-1/2 -translate-x-1/2', direction: 'down', glyph: '▼' },
	{ className: 'top-1/2 left-1.5 -translate-y-1/2', direction: 'left', glyph: '◀' },
	{ className: 'top-1/2 right-1.5 -translate-y-1/2', direction: 'right', glyph: '▶' },
]

/**
 * One stick standing in for the four direction keys: press anywhere on the base and
 * slide, and it keeps re-resolving which directions are held as the finger moves, without
 * ever asking for a lift. Pointer capture keeps the stream coming even once the finger
 * wanders off the base, which is what makes a fast turn feel continuous rather than like
 * four buttons being stabbed in sequence.
 */
function Thumbstick({
	placement,
	editing,
	onMove,
	onReleased,
	containerRef,
	platform,
	sendKey,
}: PlacementProps) {
	const baseRef = useRef<HTMLDivElement>(null)
	const held = useRef<JoystickDirection[]>([])
	const engaged = useRef(false)
	const { begin, drag, end } = usePlacementDrag(placement.id, containerRef, onMove)
	const [knob, setKnob] = useState({ x: 0, y: 0 })
	const [active, setActive] = useState<JoystickDirection[]>([])

	const hold = useCallback(
		(next: JoystickDirection[]) => {
			for (const direction of held.current) {
				if (!next.includes(direction)) sendKey(direction, false)
			}
			for (const direction of next) {
				if (!held.current.includes(direction)) sendKey(direction, true)
			}
			held.current = next
			setActive(next)
		},
		[sendKey],
	)

	// A stick torn down mid-throw -- overlay hidden, disk swapped -- would otherwise leave
	// its directions held down inside the emulator.
	useEffect(() => () => hold([]), [hold])

	const track = useCallback(
		(e: PointerEvent<HTMLDivElement>) => {
			const box = baseRef.current?.getBoundingClientRect()
			if (!box) return
			const radius = Math.min(box.width, box.height) / 2
			if (radius <= 0) return

			const dx = e.clientX - (box.left + box.width / 2)
			const dy = e.clientY - (box.top + box.height / 2)
			const distance = Math.hypot(dx, dy)
			const travel = radius * JOYSTICK_TRAVEL
			const scale = distance > travel ? travel / distance : 1

			setKnob({ x: dx * scale, y: dy * scale })
			hold(joystickDirections(dx, dy, radius))
		},
		[hold],
	)

	const press = useCallback(
		(e: PointerEvent<HTMLDivElement>) => {
			e.preventDefault()
			e.stopPropagation()
			e.currentTarget.setPointerCapture(e.pointerId)
			if (editing) {
				begin()
				return
			}
			engaged.current = true
			track(e)
		},
		[begin, editing, track],
	)

	const move = useCallback(
		(e: PointerEvent<HTMLDivElement>) => {
			if (editing) {
				drag(e)
				return
			}
			if (!engaged.current) return
			track(e)
		},
		[drag, editing, track],
	)

	const release = useCallback(
		(e: PointerEvent<HTMLDivElement>) => {
			e.preventDefault()
			e.stopPropagation()
			if (editing) {
				end()
				return
			}
			if (!engaged.current) return
			engaged.current = false
			setKnob({ x: 0, y: 0 })
			hold([])
			onReleased?.()
		},
		[editing, end, hold, onReleased],
	)

	return (
		<div
			ref={baseRef}
			role="group"
			aria-label={overlayLabel(placement.id, platform)}
			className={cn(
				'sm:h-32 sm:w-32 h-28 w-28 border-white/30 bg-white/10 backdrop-blur-sm pointer-events-auto absolute z-20 -translate-x-1/2 -translate-y-1/2 touch-none rounded-full border select-none',
				editing && 'ring-brand/80 ring-2',
			)}
			style={{ left: `${placement.x * 100}%`, top: `${placement.y * 100}%` }}
			onPointerDown={press}
			onPointerMove={move}
			onPointerUp={release}
			onPointerCancel={release}
			onContextMenu={(e) => e.preventDefault()}
		>
			{JOYSTICK_HINTS.map(({ className, direction, glyph }) => (
				<span
					key={direction}
					aria-hidden
					className={cn(
						'absolute text-[9px] leading-none',
						className,
						active.includes(direction) ? 'text-white' : 'text-white/35',
					)}
				>
					{glyph}
				</span>
			))}
			<span
				aria-hidden
				className="sm:h-14 sm:w-14 h-12 w-12 border-white/40 bg-white/35 shadow-lg absolute top-1/2 left-1/2 rounded-full border"
				style={{ transform: `translate(calc(-50% + ${knob.x}px), calc(-50% + ${knob.y}px))` }}
			/>
		</div>
	)
}

function PadButton({
	placement,
	editing,
	onMove,
	onReleased,
	containerRef,
	platform,
	sendKey,
}: PlacementProps) {
	const held = useRef(false)
	const { begin, drag, end } = usePlacementDrag(placement.id, containerRef, onMove)
	const keyId = placement.id as OverlayKeyId

	const lift = useCallback(() => {
		if (!held.current) return
		held.current = false
		sendKey(keyId, false)
	}, [keyId, sendKey])

	// Same reasoning as the stick: a button unmounted while down must not stay down.
	useEffect(() => lift, [lift])

	const press = useCallback(
		(e: PointerEvent<HTMLButtonElement>) => {
			e.preventDefault()
			e.stopPropagation()
			e.currentTarget.setPointerCapture(e.pointerId)
			if (editing) {
				begin()
				return
			}
			if (held.current) return
			held.current = true
			sendKey(keyId, true)
		},
		[begin, editing, keyId, sendKey],
	)

	const move = useCallback(
		(e: PointerEvent<HTMLButtonElement>) => {
			if (!editing) return
			drag(e)
		},
		[drag, editing],
	)

	const release = useCallback(
		(e: PointerEvent<HTMLButtonElement>) => {
			e.preventDefault()
			e.stopPropagation()
			if (editing) {
				end()
				return
			}
			if (!held.current) return
			lift()
			onReleased?.()
		},
		[editing, end, lift, onReleased],
	)

	const wide = [
		'runstop',
		'space',
		'return',
		'restore',
		'commodore',
		'shift',
		'shiftright',
		'capsshift',
		'symbolshift',
		'alt',
		'tab',
		'help',
		'capslock',
		'delete',
	].includes(placement.id)

	return (
		<button
			type="button"
			className={cn(
				'min-h-11 min-w-11 border-white/30 bg-white/20 text-xs font-medium text-white backdrop-blur-sm active:bg-white/40 pointer-events-auto absolute z-20 -translate-x-1/2 -translate-y-1/2 touch-none rounded-full border select-none',
				wide && 'min-w-16 px-2 rounded-md',
				placement.id === 'fire' && 'h-16 w-16 text-sm',
				editing && 'ring-brand/80 ring-2',
			)}
			style={{ left: `${placement.x * 100}%`, top: `${placement.y * 100}%` }}
			onPointerDown={press}
			onPointerMove={move}
			onPointerUp={release}
			onPointerCancel={release}
			onContextMenu={(e) => e.preventDefault()}
		>
			{overlayLabel(placement.id, platform)}
		</button>
	)
}

type OnScreenControlsProps = {
	keys: OverlayKeyPlacement[]
	editing?: boolean
	onChangeKeys?: (keys: OverlayKeyPlacement[]) => void
	onSave?: () => void
	onCancel?: () => void
	onReleased?: () => void
	/** Decides which keys the editor offers and what legend each control carries. */
	platform?: RetroPlatform
	/**
	 * How a control reaches the machine. Defaults to a synthetic `KeyboardEvent` on
	 * `window`, which is where c64-ready listens; emulators with an input API of their own
	 * pass `RetroEmulatorHandle.sendKey` instead.
	 */
	sendKey?: SendKey
}

export function OnScreenControls({
	keys,
	editing = false,
	onChangeKeys,
	onSave,
	onCancel,
	onReleased,
	platform = 'c64',
	sendKey = dispatchKey,
}: OnScreenControlsProps) {
	const containerRef = useRef<HTMLDivElement>(null)
	const editorRows = EDITOR_ROWS[platform] ?? C64_EDITOR_ROWS

	const onMove = useCallback(
		(id: OverlayControlId, x: number, y: number) => {
			onChangeKeys?.(keys.map((k) => (k.id === id ? { ...k, x, y } : k)))
		},
		[keys, onChangeKeys],
	)

	const toggle = (id: OverlayControlId) => {
		if (keys.some((k) => k.id === id)) {
			onChangeKeys?.(keys.filter((k) => k.id !== id))
			return
		}
		onChangeKeys?.([...keys, { id, x: 0.5, y: 0.5 }])
	}

	return (
		<div ref={containerRef} className="inset-0 pointer-events-none absolute z-20">
			{editing ? (
				<div className="top-2 right-2 left-2 p-2 gap-2 bg-black/80 pointer-events-auto absolute z-30 flex max-h-[45%] flex-col overflow-y-auto rounded-md">
					{editorRows.map((row, rowIndex) => (
						<div key={rowIndex} className="gap-1 flex flex-wrap">
							{row.map((id) => {
								const active = keys.some((k) => k.id === id)
								return (
									<button
										key={id}
										type="button"
										className={cn(
											'min-w-7 rounded px-1.5 py-1 border text-[11px]',
											active
												? 'border-brand bg-brand/30 text-white'
												: 'border-white/20 bg-white/10 text-white/60',
										)}
										onClick={() => toggle(id)}
									>
										{overlayLabel(id, platform)}
									</button>
								)
							})}
						</div>
					))}
					<div className="gap-2 flex justify-end">
						{/* The panel is a fixed dark surface in both themes, so these cannot rely on
						    the themed foreground color the way a ghost button normally would. */}
						<Button
							size="sm"
							variant="ghost"
							className="border-white/30 text-white hover:bg-white/15 hover:text-white border"
							onClick={onCancel}
						>
							Cancel
						</Button>
						<Button size="sm" onClick={onSave}>
							Save
						</Button>
					</div>
				</div>
			) : null}
			{keys.map((placement) =>
				isJoystick(placement.id) ? (
					<Thumbstick
						key={placement.id}
						placement={placement}
						editing={editing}
						onMove={onMove}
						onReleased={onReleased}
						containerRef={containerRef}
						platform={platform}
						sendKey={sendKey}
					/>
				) : (
					<PadButton
						key={placement.id}
						placement={placement}
						editing={editing}
						onMove={onMove}
						onReleased={onReleased}
						containerRef={containerRef}
						platform={platform}
						sendKey={sendKey}
					/>
				),
			)}
		</div>
	)
}
