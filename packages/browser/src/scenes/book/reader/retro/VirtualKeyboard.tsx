import type { RetroPlatform } from '@stump/client'
import { cn } from '@stump/components'
import {
	type CSSProperties,
	type PointerEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from 'react'

import { type Dispatchable, dispatchKey, type KeySpec, type OverlayKeyId } from './keys'

/**
 * Sticky modifiers.
 *
 * `shift` is not a keystroke of its own: c64-ready presses matrix SHIFT itself when an
 * event carries `shiftKey`, and releases it on the next unshifted one, so a flag can
 * never leave SHIFT stuck the way a held keydown could. `commodore` and `ctrl` have no
 * such flag and are genuinely held down between their keydown and keyup.
 */
type Modifier = 'shift' | 'shiftlock' | 'commodore' | 'ctrl'

type CapBase = {
	/** Legend on the front of the cap — what the key types unshifted. */
	label: string
	/** Legend printed above it — what Shift produces, as on the real keycap. */
	shiftLabel?: string
	/** Width in cap units, where a letter key is 1. */
	width?: number
	/** Screen-reader name, for caps whose legend is a symbol rather than a word. */
	aria?: string
	/**
	 * What to send while Shift is down, for the one cap whose shifted legend the emulator
	 * will not produce on its own: c64-ready clears shift inside its `:` case, so `[` has
	 * to arrive as `[`.
	 */
	shiftSpec?: KeySpec
	/** Function keys are a different colour of plastic on every one of these machines. */
	tone?: 'fn'
}

type KeyCap =
	| (CapBase & { id: OverlayKeyId; modifier?: never })
	| (CapBase & { modifier: Modifier; id?: never })

/** Dead space, so the space bar sits where it does on the real machine. */
type Filler = { filler: number }

type CapRow = Array<KeyCap | Filler>

const isFiller = (cap: KeyCap | Filler): cap is Filler => 'filler' in cap

function key(
	id: OverlayKeyId,
	label: string,
	shiftLabel?: string,
	extra?: Partial<CapBase>,
): KeyCap {
	return { id, label, shiftLabel, ...extra }
}

function fn(id: OverlayKeyId, label: string, shiftLabel: string): KeyCap {
	return { id, label, shiftLabel, tone: 'fn', width: 1.5 }
}

/**
 * The breadbin layout, row by row. Every row totals 17.5 cap units (a 16-unit main block
 * plus the 1.5-unit function column), which is what keeps the caps aligned into columns
 * once the rows are stretched to the panel width.
 *
 * The shifted legend is the top one on a C64 keycap, which is why `shiftLabel` renders
 * above `label` — `CLR` over `HOME`, `RUN` over `STOP`, `!` over `1`.
 */
const C64_ROWS: CapRow[] = [
	[
		key('arrowleft', '←', undefined, { aria: 'Left arrow' }),
		key('1', '1', '!'),
		key('2', '2', '"'),
		key('3', '3', '#'),
		key('4', '4', '$'),
		key('5', '5', '%'),
		key('6', '6', '&'),
		key('7', '7', "'"),
		key('8', '8', '('),
		key('9', '9', ')'),
		key('0', '0'),
		key('plus', '+'),
		key('minus', '-'),
		key('pound', '£'),
		key('home', 'HOME', 'CLR'),
		key('instdel', 'DEL', 'INST'),
		fn('f1', 'F1', 'F2'),
	],
	[
		{ modifier: 'ctrl', label: 'CTRL', width: 1.5 },
		key('q', 'Q'),
		key('w', 'W'),
		key('e', 'E'),
		key('r', 'R'),
		key('t', 'T'),
		key('y', 'Y'),
		key('u', 'U'),
		key('i', 'I'),
		key('o', 'O'),
		key('p', 'P'),
		key('at', '@'),
		key('star', '*'),
		key('arrowup', '↑', undefined, { aria: 'Up arrow' }),
		key('restore', 'RESTORE', undefined, { width: 1.5 }),
		fn('f3', 'F3', 'F4'),
	],
	[
		key('runstop', 'STOP', 'RUN', { width: 1.25 }),
		{ modifier: 'shiftlock', label: 'LOCK', shiftLabel: 'SHIFT', width: 1.25, aria: 'Shift lock' },
		key('a', 'A'),
		key('s', 'S'),
		key('d', 'D'),
		key('f', 'F'),
		key('g', 'G'),
		key('h', 'H'),
		key('j', 'J'),
		key('k', 'K'),
		key('l', 'L'),
		key('colon', ':', '[', { shiftSpec: { code: 'C64_bracketleft', key: '[' } }),
		key('semicolon', ';', ']'),
		key('equals', '='),
		key('return', 'RETURN', undefined, { width: 1.5 }),
		fn('f5', 'F5', 'F6'),
	],
	[
		{ modifier: 'commodore', label: 'C=', width: 1.25, aria: 'Commodore' },
		{ modifier: 'shift', label: 'SHIFT', width: 1.5, aria: 'Shift left' },
		key('z', 'Z'),
		key('x', 'X'),
		key('c', 'C'),
		key('v', 'V'),
		key('b', 'B'),
		key('n', 'N'),
		key('m', 'M'),
		key('comma', ',', '<'),
		key('period', '.', '>'),
		key('slash', '/', '?'),
		{ modifier: 'shift', label: 'SHIFT', width: 1.25, aria: 'Shift right' },
		// The cursor cluster is two keys, not four: Shift turns down into up and right
		// into left, exactly as the emulator's own mapping already does.
		key('cursordown', 'CRSR', '↑↓', { aria: 'Cursor up and down' }),
		key('cursorright', 'CRSR', '←→', { aria: 'Cursor left and right' }),
		fn('f7', 'F7', 'F8'),
	],
	[{ filler: 4 }, key('space', 'SPACE', undefined, { width: 9, aria: 'Space' }), { filler: 4.5 }],
]

const LAYOUTS: Partial<Record<RetroPlatform, CapRow[]>> = {
	c64: C64_ROWS,
}

/** Whether this platform has an authentic layout to show. */
export function hasVirtualKeyboard(platform: RetroPlatform): boolean {
	return platform in LAYOUTS
}

type CapButtonProps = {
	cap: KeyCap
	active: boolean
	/** Returns what it dispatched, so the release can undo exactly that. */
	onPress: (cap: KeyCap) => Dispatchable | null
	onRelease: (cap: KeyCap, pressed: Dispatchable | null) => void
}

function CapButton({ cap, active, onPress, onRelease }: CapButtonProps) {
	// A second finger can flip the shift latch between this cap's press and its release.
	// Releasing whatever was actually pressed is what stops that from stranding a key in
	// the matrix.
	const pressed = useRef<Dispatchable | null>(null)
	const held = useRef(false)

	const press = useCallback(
		(e: PointerEvent<HTMLButtonElement>) => {
			e.preventDefault()
			e.stopPropagation()
			e.currentTarget.setPointerCapture(e.pointerId)
			if (held.current) return
			held.current = true
			pressed.current = onPress(cap)
		},
		[cap, onPress],
	)

	const release = useCallback(
		(e: PointerEvent<HTMLButtonElement>) => {
			e.preventDefault()
			e.stopPropagation()
			if (!held.current) return
			held.current = false
			onRelease(cap, pressed.current)
			pressed.current = null
		},
		[cap, onRelease],
	)

	return (
		<button
			type="button"
			aria-label={cap.aria ?? cap.label}
			aria-pressed={cap.modifier ? active : undefined}
			className={cn(
				'min-w-0 px-0.5 border-black/25 shadow-sm flex touch-none flex-col items-center justify-center overflow-hidden rounded-[3px] border-b-2 bg-[#d9d3c5] leading-none text-[#2e2a24] select-none',
				'active:translate-y-px active:border-b active:bg-[#bdb5a3]',
				cap.tone === 'fn' && 'border-black/35 bg-[#9a7d5d] text-[#f6efe2]',
				active && 'border-black/40 text-white bg-[#6f8f5a]',
			)}
			style={{ flexBasis: 0, flexGrow: cap.width ?? 1 }}
			onPointerDown={press}
			onPointerUp={release}
			onPointerCancel={release}
			onContextMenu={(e) => e.preventDefault()}
		>
			{cap.shiftLabel ? (
				<span className="max-w-full truncate text-[0.75em] opacity-70">{cap.shiftLabel}</span>
			) : null}
			<span className="max-w-full truncate">{cap.label}</span>
		</button>
	)
}

type VirtualKeyboardProps = {
	platform: RetroPlatform
	/** Hand focus back to the canvas once a keystroke completes. */
	onReleased?: () => void
}

/**
 * The machine's own keyboard, docked under the playfield.
 *
 * Modifiers are sticky one-shots rather than held buttons — a single pointer cannot hold
 * SHIFT and press a letter at the same time — with SHIFT LOCK covering the case where a
 * user wants shift to stay down, which is what the cap is for on the real machine too.
 */
export function VirtualKeyboard({ platform, onReleased }: VirtualKeyboardProps) {
	const rows = LAYOUTS[platform]

	const [shift, setShift] = useState(false)
	const [shiftLock, setShiftLock] = useState(false)
	const [commodore, setCommodore] = useState(false)
	const [ctrl, setCtrl] = useState(false)

	// Unmounting mid-chord (toggling the panel off, closing the book) must not leave a
	// matrix key held down for the rest of the session.
	const heldRef = useRef({ commodore: false, ctrl: false })
	useEffect(() => {
		heldRef.current = { commodore, ctrl }
	}, [commodore, ctrl])
	useEffect(
		() => () => {
			if (heldRef.current.commodore) dispatchKey('commodore', false)
			if (heldRef.current.ctrl) dispatchKey('ctrl', false)
		},
		[],
	)

	const shiftActive = shift || shiftLock

	const onPress = useCallback(
		(cap: KeyCap): Dispatchable | null => {
			if (!cap.modifier) {
				// A `shiftSpec` already encodes the shift press, so the flag would only
				// duplicate it.
				const target = shiftActive && cap.shiftSpec ? cap.shiftSpec : cap.id
				dispatchKey(target, true, { shiftKey: shiftActive && !cap.shiftSpec })
				return target
			}
			switch (cap.modifier) {
				case 'shift':
					setShift((held) => !held)
					break
				case 'shiftlock':
					setShiftLock((locked) => !locked)
					setShift(false)
					break
				case 'commodore':
					dispatchKey('commodore', !commodore)
					setCommodore(!commodore)
					break
				case 'ctrl':
					dispatchKey('ctrl', !ctrl)
					setCtrl(!ctrl)
					break
			}
			return null
		},
		[commodore, ctrl, shiftActive],
	)

	const onRelease = useCallback(
		(cap: KeyCap, target: Dispatchable | null) => {
			if (cap.modifier || !target) return
			dispatchKey(target, false, { shiftKey: shiftActive && typeof target === 'string' })
			// The keystroke is what consumes a one-shot modifier. SHIFT LOCK is the
			// exception, which is the whole point of it having its own cap.
			if (shift) setShift(false)
			if (commodore) {
				dispatchKey('commodore', false)
				setCommodore(false)
			}
			if (ctrl) {
				dispatchKey('ctrl', false)
				setCtrl(false)
			}
			onReleased?.()
		},
		[commodore, ctrl, onReleased, shift, shiftActive],
	)

	if (!rows) return null

	const isActive = (cap: KeyCap) => {
		switch (cap.modifier) {
			case 'shift':
				return shift
			case 'shiftlock':
				return shiftLock
			case 'commodore':
				return commodore
			case 'ctrl':
				return ctrl
			default:
				return false
		}
	}

	return (
		<div
			// A picture of a physical machine rather than app chrome, so the palette is the
			// C64's in both themes -- the same call the overlay editor panel makes.
			className="border-black/50 p-1 flex shrink-0 touch-none flex-col gap-[2px] border-t bg-[#a9a091] select-none"
			style={
				{
					'--cap-h': 'clamp(20px, min(4.4vw, 6.2vh), 40px)',
					fontSize: 'clamp(7px, min(1vw, 1.5vh), 11px)',
				} as CSSProperties
			}
		>
			{rows.map((row, rowIndex) => (
				<div key={rowIndex} className="flex gap-[2px]" style={{ height: 'var(--cap-h)' }}>
					{row.map((cap, capIndex) =>
						isFiller(cap) ? (
							<div key={capIndex} style={{ flexBasis: 0, flexGrow: cap.filler }} />
						) : (
							<CapButton
								key={capIndex}
								cap={cap}
								active={isActive(cap)}
								onPress={onPress}
								onRelease={onRelease}
							/>
						),
					)}
				</div>
			))}
		</div>
	)
}
