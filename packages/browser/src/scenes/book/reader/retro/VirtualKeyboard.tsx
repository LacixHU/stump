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

import {
	type Dispatchable,
	dispatchKey,
	type KeyModifiers,
	type KeySpec,
	type OverlayKeyId,
} from './keys'

/**
 * A sticky modifier cap.
 *
 * A single pointer cannot hold SHIFT and press a letter at the same time, so a modifier
 * latches on until the next keystroke consumes it. How it reaches the machine differs:
 * c64-ready presses matrix SHIFT itself for any event carrying `shiftKey` (and releases it
 * on the next unshifted one, so a flag can never leave it stuck), while C=, CTRL and both
 * of the Spectrum's shifts are genuinely held down across the keystroke.
 */
type Modifier = {
	/** Latch slot; unique within a layout. */
	name: string
	/** Held down for the length of the keystroke. Absent for a flag-only modifier. */
	key?: OverlayKeyId
	/** Stamped onto the keystroke as `shiftKey` instead of being held. */
	flag?: boolean
	/** Stays latched until pressed again, rather than being spent on one keystroke. */
	lock?: boolean
}

/** Cap, panel and legend colours: these are pictures of real machines, not app chrome. */
type Palette = {
	panel: string
	cap: string
	capActive: string
	text: string
	textActive: string
	/** The smaller legend printed above the main one. */
	legend: string
	/** Function keys are a different colour of plastic on the machines that have them. */
	fn?: string
	fnText?: string
	edge: string
}

type CapBase = {
	/** Legend on the front of the cap — what the key types on its own. */
	label: string
	/**
	 * Legend printed above it: what SHIFT produces on a C64, what SYMBOL SHIFT produces on
	 * a Spectrum — in both cases exactly what the real keycap shows.
	 */
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

type Layout = {
	rows: CapRow[]
	modifiers: Modifier[]
	palette: Palette
}

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

const C64_SHIFT: Modifier = { flag: true, name: 'shift' }
const C64_SHIFT_LOCK: Modifier = { flag: true, lock: true, name: 'shiftlock' }
const C64_COMMODORE: Modifier = { key: 'commodore', name: 'commodore' }
const C64_CTRL: Modifier = { key: 'ctrl', name: 'ctrl' }

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
		{ label: 'CTRL', modifier: C64_CTRL, width: 1.5 },
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
		{
			aria: 'Shift lock',
			label: 'LOCK',
			modifier: C64_SHIFT_LOCK,
			shiftLabel: 'SHIFT',
			width: 1.25,
		},
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
		{ aria: 'Commodore', label: 'C=', modifier: C64_COMMODORE, width: 1.25 },
		{ aria: 'Shift left', label: 'SHIFT', modifier: C64_SHIFT, width: 1.5 },
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
		{ aria: 'Shift right', label: 'SHIFT', modifier: C64_SHIFT, width: 1.25 },
		// The cursor cluster is two keys, not four: Shift turns down into up and right
		// into left, exactly as the emulator's own mapping already does.
		key('cursordown', 'CRSR', '↑↓', { aria: 'Cursor up and down' }),
		key('cursorright', 'CRSR', '←→', { aria: 'Cursor left and right' }),
		fn('f7', 'F7', 'F8'),
	],
	[{ filler: 4 }, key('space', 'SPACE', undefined, { width: 9, aria: 'Space' }), { filler: 4.5 }],
]

const SPECTRUM_CAPS_SHIFT: Modifier = { key: 'capsshift', name: 'capsshift' }
const SPECTRUM_SYMBOL_SHIFT: Modifier = { key: 'symbolshift', name: 'symbolshift' }

/**
 * The 48K rubber keyboard: four rows of ten, which is the whole machine — every other
 * legend is a shift away. `shiftLabel` is the red SYMBOL SHIFT character, so latching SYM
 * and tapping P really does type `"`.
 *
 * The BASIC keywords printed on the keys are left off: they belong to a keyboard mode the
 * machine chooses for itself, and there is no room for a third legend on a phone.
 */
const SPECTRUM_ROWS: CapRow[] = [
	[
		key('1', '1', '!'),
		key('2', '2', '@'),
		key('3', '3', '#'),
		key('4', '4', '$'),
		key('5', '5', '%'),
		key('6', '6', '&'),
		key('7', '7', "'"),
		key('8', '8', '('),
		key('9', '9', ')'),
		key('0', '0', '_'),
	],
	[
		key('q', 'Q', '≤'),
		key('w', 'W', '≠'),
		key('e', 'E', '≥'),
		key('r', 'R', '<'),
		key('t', 'T', '>'),
		key('y', 'Y', 'AND'),
		key('u', 'U', 'OR'),
		key('i', 'I', 'AT'),
		key('o', 'O', ';'),
		key('p', 'P', '"'),
	],
	[
		key('a', 'A', 'STOP'),
		key('s', 'S', 'NOT'),
		key('d', 'D', 'STEP'),
		key('f', 'F', 'TO'),
		key('g', 'G', 'THEN'),
		key('h', 'H', '↑'),
		key('j', 'J', '-'),
		key('k', 'K', '+'),
		key('l', 'L', '='),
		key('return', 'ENTER', undefined, { aria: 'Enter' }),
	],
	[
		{ aria: 'Caps shift', label: 'CAPS', modifier: SPECTRUM_CAPS_SHIFT, shiftLabel: 'SHIFT' },
		key('z', 'Z', ':'),
		key('x', 'X', '£'),
		key('c', 'C', '?'),
		key('v', 'V', '/'),
		key('b', 'B', '*'),
		key('n', 'N', ','),
		key('m', 'M', '.'),
		{ aria: 'Symbol shift', label: 'SYM', modifier: SPECTRUM_SYMBOL_SHIFT, shiftLabel: 'SHIFT' },
		key('space', 'SPACE', 'BREAK', { aria: 'Space' }),
	],
]

const LAYOUTS: Partial<Record<RetroPlatform, Layout>> = {
	c64: {
		modifiers: [C64_SHIFT, C64_SHIFT_LOCK, C64_COMMODORE, C64_CTRL],
		palette: {
			cap: '#d9d3c5',
			capActive: '#6f8f5a',
			edge: 'rgba(0, 0, 0, 0.25)',
			fn: '#9a7d5d',
			fnText: '#f6efe2',
			legend: 'rgba(46, 42, 36, 0.7)',
			panel: '#a9a091',
			text: '#2e2a24',
			textActive: '#ffffff',
		},
		rows: C64_ROWS,
	},
	spectrum: {
		modifiers: [SPECTRUM_CAPS_SHIFT, SPECTRUM_SYMBOL_SHIFT],
		palette: {
			cap: '#3f3f42',
			capActive: '#c8102e',
			edge: 'rgba(0, 0, 0, 0.6)',
			legend: '#ff5a4d',
			panel: '#121212',
			text: '#f2f2f2',
			textActive: '#ffffff',
		},
		rows: SPECTRUM_ROWS,
	},
}

/** Whether this platform has an authentic layout to show. */
export function hasVirtualKeyboard(platform: RetroPlatform): boolean {
	return platform in LAYOUTS
}

type SendKey = (target: Dispatchable, down: boolean, modifiers?: KeyModifiers) => void

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
				'min-w-0 px-0.5 flex touch-none flex-col items-center justify-center overflow-hidden rounded-[3px] border-b-2 leading-none select-none',
				'shadow-sm border-[color:var(--cap-edge)] bg-[var(--cap-bg)] text-[color:var(--cap-fg)]',
				'active:translate-y-px active:border-b active:brightness-90',
				cap.tone === 'fn' && 'bg-[var(--cap-fn-bg)] text-[color:var(--cap-fn-fg)]',
				active && 'bg-[var(--cap-active-bg)] text-[color:var(--cap-active-fg)]',
			)}
			style={{ flexBasis: 0, flexGrow: cap.width ?? 1 }}
			onPointerDown={press}
			onPointerUp={release}
			onPointerCancel={release}
			onContextMenu={(e) => e.preventDefault()}
		>
			{cap.shiftLabel ? (
				<span className="max-w-full truncate text-[0.75em] text-[color:var(--cap-legend)]">
					{cap.shiftLabel}
				</span>
			) : null}
			<span className="max-w-full truncate">{cap.label}</span>
		</button>
	)
}

type VirtualKeyboardProps = {
	platform: RetroPlatform
	/** Hand focus back to the canvas once a keystroke completes. */
	onReleased?: () => void
	/**
	 * How a keystroke reaches the machine. Defaults to a synthetic `KeyboardEvent` on
	 * `window`, which is where c64-ready listens; emulators with an input API of their own
	 * pass `RetroEmulatorHandle.sendKey` instead.
	 */
	sendKey?: SendKey
}

/**
 * The machine's own keyboard, docked under the playfield.
 *
 * Modifiers are sticky one-shots rather than held buttons — a single pointer cannot hold
 * SHIFT and press a letter at the same time — with the C64's SHIFT LOCK covering the case
 * where a user wants shift to stay down, which is what the cap is for on the real machine
 * too.
 */
export function VirtualKeyboard({
	platform,
	onReleased,
	sendKey = dispatchKey,
}: VirtualKeyboardProps) {
	const layout = LAYOUTS[platform]
	const modifiers = layout?.modifiers
	const [latched, setLatched] = useState<Record<string, boolean>>({})

	const flagActive = !!modifiers?.some((modifier) => modifier.flag && latched[modifier.name])

	// Unmounting mid-chord (toggling the panel off, closing the book) must not leave a
	// matrix key held down for the rest of the session.
	const releaseHeldRef = useRef<() => void>(() => undefined)
	useEffect(() => {
		releaseHeldRef.current = () => {
			for (const modifier of modifiers ?? []) {
				if (modifier.key && latched[modifier.name]) sendKey(modifier.key, false)
			}
		}
	}, [latched, modifiers, sendKey])
	useEffect(() => () => releaseHeldRef.current(), [])

	const onPress = useCallback(
		(cap: KeyCap): Dispatchable | null => {
			if (!cap.modifier) {
				// A `shiftSpec` already encodes the shift press, so the flag would only
				// duplicate it.
				const target = flagActive && cap.shiftSpec ? cap.shiftSpec : cap.id
				sendKey(target, true, { shiftKey: flagActive && !cap.shiftSpec })
				return target
			}

			const { name, key: heldKey, lock } = cap.modifier
			const next = !latched[name]
			if (heldKey) sendKey(heldKey, next)
			setLatched((current) => {
				// Latching SHIFT LOCK takes over from a one-shot SHIFT rather than stacking
				// with it.
				const cleared = lock
					? Object.fromEntries(
							Object.entries(current).map(([slot, on]) => [
								slot,
								modifiers?.some((modifier) => modifier.name === slot && modifier.flag) ? false : on,
							]),
						)
					: current
				return { ...cleared, [name]: next }
			})
			return null
		},
		[flagActive, latched, modifiers, sendKey],
	)

	const onRelease = useCallback(
		(cap: KeyCap, target: Dispatchable | null) => {
			if (cap.modifier || !target) return
			sendKey(target, false, { shiftKey: flagActive && typeof target === 'string' })
			// The keystroke is what consumes a one-shot modifier. A lock is the exception,
			// which is the whole point of it having its own cap.
			for (const modifier of modifiers ?? []) {
				if (modifier.lock || !latched[modifier.name]) continue
				if (modifier.key) sendKey(modifier.key, false)
			}
			setLatched((current) => {
				const next = { ...current }
				for (const modifier of modifiers ?? []) {
					if (!modifier.lock) next[modifier.name] = false
				}
				return next
			})
			onReleased?.()
		},
		[flagActive, latched, modifiers, onReleased, sendKey],
	)

	if (!layout) return null

	const { palette, rows } = layout

	return (
		<div
			// A picture of a physical machine rather than app chrome, so the palette is the
			// machine's own in both themes -- the same call the overlay editor panel makes.
			className="p-1 flex shrink-0 touch-none flex-col gap-[2px] border-t border-[color:var(--cap-edge)] bg-[var(--panel-bg)] select-none"
			style={
				{
					'--cap-active-bg': palette.capActive,
					'--cap-active-fg': palette.textActive,
					'--cap-bg': palette.cap,
					'--cap-edge': palette.edge,
					'--cap-fg': palette.text,
					'--cap-fn-bg': palette.fn ?? palette.cap,
					'--cap-fn-fg': palette.fnText ?? palette.text,
					'--cap-h': 'clamp(20px, min(4.4vw, 6.2vh), 40px)',
					'--cap-legend': palette.legend,
					'--panel-bg': palette.panel,
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
								active={!!cap.modifier && !!latched[cap.modifier.name]}
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
