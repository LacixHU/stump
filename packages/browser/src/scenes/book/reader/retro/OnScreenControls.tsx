import { Button, cn } from '@stump/components'
import { useCallback, useRef, type PointerEvent, type RefObject } from 'react'

export const OVERLAY_KEY_IDS = [
	'up',
	'down',
	'left',
	'right',
	'fire',
	'runstop',
	'space',
	'return',
	'commodore',
	'ctrl',
	'shift',
	'shiftright',
	'restore',
	'instdel',
	'home',
	'f1',
	'f2',
	'f3',
	'f4',
	'f5',
	'f6',
	'f7',
	'f8',
	'pound',
	'at',
	'star',
	'plus',
	'minus',
	'equals',
	'colon',
	'semicolon',
	'comma',
	'period',
	'slash',
	'arrowleft',
	'arrowup',
	'cursorup',
	'cursordown',
	'cursorleft',
	'cursorright',
	'a',
	'b',
	'c',
	'd',
	'e',
	'f',
	'g',
	'h',
	'i',
	'j',
	'k',
	'l',
	'm',
	'n',
	'o',
	'p',
	'q',
	'r',
	's',
	't',
	'u',
	'v',
	'w',
	'x',
	'y',
	'z',
	'0',
	'1',
	'2',
	'3',
	'4',
	'5',
	'6',
	'7',
	'8',
	'9',
] as const

export type OverlayKeyId = (typeof OVERLAY_KEY_IDS)[number]

export type OverlayKeyPlacement = {
	id: OverlayKeyId
	x: number
	y: number
}

type KeySpec = { key: string; code: string }

function keySpec(id: OverlayKeyId): KeySpec {
	switch (id) {
		case 'up':
			return { key: 'ArrowUp', code: 'ArrowUp' }
		case 'down':
			return { key: 'ArrowDown', code: 'ArrowDown' }
		case 'left':
			return { key: 'ArrowLeft', code: 'ArrowLeft' }
		case 'right':
			return { key: 'ArrowRight', code: 'ArrowRight' }
		case 'fire':
			return { key: 'z', code: 'KeyZ' }
		case 'runstop':
			return { key: 'Escape', code: 'Escape' }
		case 'space':
			return { key: ' ', code: 'Space' }
		case 'return':
			return { key: 'Enter', code: 'Enter' }
		case 'commodore':
			return { key: 'Control', code: 'ControlRight' }
		case 'ctrl':
			return { key: 'Tab', code: 'Tab' }
		case 'shift':
		case 'shiftright':
			return { key: 'Shift', code: 'ShiftLeft' }
		case 'restore':
			return { key: 'PageUp', code: 'PageUp' }
		case 'instdel':
			return { key: 'Backspace', code: 'Backspace' }
		case 'home':
			return { key: 'Home', code: 'Home' }
		case 'f1':
			return { key: 'F1', code: 'C64_f1' }
		case 'f2':
			return { key: 'F2', code: 'C64_f2' }
		case 'f3':
			return { key: 'F3', code: 'C64_f3' }
		case 'f4':
			return { key: 'F4', code: 'C64_f4' }
		case 'f5':
			return { key: 'F5', code: 'C64_f5' }
		case 'f6':
			return { key: 'F6', code: 'C64_f6' }
		case 'f7':
			return { key: 'F7', code: 'C64_f7' }
		case 'f8':
			return { key: 'F8', code: 'C64_f8' }
		case 'pound':
			return { key: '\\', code: 'C64_pound' }
		case 'at':
			return { key: '@', code: 'C64_at' }
		case 'star':
			return { key: '*', code: 'C64_star' }
		case 'plus':
			return { key: '+', code: 'C64_plus' }
		case 'minus':
			return { key: '-', code: 'C64_minus' }
		case 'equals':
			return { key: '=', code: 'C64_equals' }
		case 'colon':
			return { key: ':', code: 'C64_colon' }
		case 'semicolon':
			return { key: ';', code: 'C64_semicolon' }
		case 'comma':
			return { key: ',', code: 'C64_comma' }
		case 'period':
			return { key: '.', code: 'C64_period' }
		case 'slash':
			return { key: '/', code: 'C64_slash' }
		case 'arrowleft':
			return { key: '`', code: 'C64_arrowleft' }
		case 'arrowup':
			return { key: '^', code: 'C64_arrowup' }
		case 'cursorup':
			return { key: 'ArrowUp', code: 'C64_cursorup' }
		case 'cursordown':
			return { key: 'ArrowDown', code: 'C64_cursordown' }
		case 'cursorleft':
			return { key: 'ArrowLeft', code: 'C64_cursorleft' }
		case 'cursorright':
			return { key: 'ArrowRight', code: 'C64_cursorright' }
		default:
			return { key: id, code: `C64_${id}` }
	}
}

export const OVERLAY_LABELS: Record<OverlayKeyId, string> = {
	up: 'Joy ↑',
	down: 'Joy ↓',
	left: 'Joy ←',
	right: 'Joy →',
	fire: 'Fire',
	runstop: 'R/S',
	space: 'Space',
	return: 'Return',
	commodore: 'C=',
	ctrl: 'Ctrl',
	shift: 'Shift',
	shiftright: 'Shift',
	restore: 'Rest',
	instdel: 'Del',
	home: 'Clr',
	f1: 'F1',
	f2: 'F2',
	f3: 'F3',
	f4: 'F4',
	f5: 'F5',
	f6: 'F6',
	f7: 'F7',
	f8: 'F8',
	pound: '£',
	at: '@',
	star: '*',
	plus: '+',
	minus: '-',
	equals: '=',
	colon: ':',
	semicolon: ';',
	comma: ',',
	period: '.',
	slash: '/',
	arrowleft: '←',
	arrowup: '↑',
	cursorup: 'Cr ↑',
	cursordown: 'Cr ↓',
	cursorleft: 'Cr ←',
	cursorright: 'Cr →',
	a: 'A',
	b: 'B',
	c: 'C',
	d: 'D',
	e: 'E',
	f: 'F',
	g: 'G',
	h: 'H',
	i: 'I',
	j: 'J',
	k: 'K',
	l: 'L',
	m: 'M',
	n: 'N',
	o: 'O',
	p: 'P',
	q: 'Q',
	r: 'R',
	s: 'S',
	t: 'T',
	u: 'U',
	v: 'V',
	w: 'W',
	x: 'X',
	y: 'Y',
	z: 'Z',
	'0': '0',
	'1': '1',
	'2': '2',
	'3': '3',
	'4': '4',
	'5': '5',
	'6': '6',
	'7': '7',
	'8': '8',
	'9': '9',
}

const EDITOR_ROWS: OverlayKeyId[][] = [
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
	['up', 'down', 'left', 'right', 'fire', 'cursorup', 'cursordown', 'cursorleft', 'cursorright'],
]

export const DEFAULT_OVERLAY_KEYS: OverlayKeyPlacement[] = [
	{ id: 'up', x: 0.16, y: 0.7 },
	{ id: 'left', x: 0.06, y: 0.82 },
	{ id: 'right', x: 0.26, y: 0.82 },
	{ id: 'down', x: 0.16, y: 0.94 },
	{ id: 'fire', x: 0.88, y: 0.82 },
	{ id: 'runstop', x: 0.42, y: 0.92 },
	{ id: 'space', x: 0.56, y: 0.92 },
	{ id: 'return', x: 0.7, y: 0.92 },
]

const ALLOW = OVERLAY_KEY_IDS as readonly string[]

export function resolveOverlayLayout(data: unknown): OverlayKeyPlacement[] {
	if (!data || typeof data !== 'object' || !('keys' in data)) {
		return DEFAULT_OVERLAY_KEYS
	}
	const raw = (data as { keys: unknown }).keys
	if (!Array.isArray(raw) || raw.length === 0) {
		return DEFAULT_OVERLAY_KEYS
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
			id: id as OverlayKeyId,
			x: Math.min(1, Math.max(0, x)),
			y: Math.min(1, Math.max(0, y)),
		})
	}
	return out.length ? out : DEFAULT_OVERLAY_KEYS
}

function dispatchKey(spec: KeySpec, down: boolean) {
	window.dispatchEvent(
		new KeyboardEvent(down ? 'keydown' : 'keyup', {
			bubbles: true,
			cancelable: true,
			code: spec.code,
			key: spec.key,
		}),
	)
}

type PadButtonProps = {
	placement: OverlayKeyPlacement
	editing: boolean
	onMove?: (id: OverlayKeyId, x: number, y: number) => void
	onReleased?: () => void
	containerRef: RefObject<HTMLDivElement | null>
}

function PadButton({ placement, editing, onMove, onReleased, containerRef }: PadButtonProps) {
	const held = useRef(false)
	const dragging = useRef(false)

	const press = useCallback(
		(e: PointerEvent<HTMLButtonElement>) => {
			e.preventDefault()
			e.stopPropagation()
			e.currentTarget.setPointerCapture(e.pointerId)
			if (editing) {
				dragging.current = true
				return
			}
			if (held.current) return
			held.current = true
			dispatchKey(keySpec(placement.id), true)
		},
		[editing, placement.id],
	)

	const move = useCallback(
		(e: PointerEvent<HTMLButtonElement>) => {
			if (!editing || !dragging.current) return
			const box = containerRef.current?.getBoundingClientRect()
			if (!box || box.width <= 0 || box.height <= 0) return
			onMove?.(
				placement.id,
				Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)),
				Math.min(1, Math.max(0, (e.clientY - box.top) / box.height)),
			)
		},
		[containerRef, editing, onMove, placement.id],
	)

	const release = useCallback(
		(e: PointerEvent<HTMLButtonElement>) => {
			e.preventDefault()
			e.stopPropagation()
			if (editing) {
				dragging.current = false
				return
			}
			if (!held.current) return
			held.current = false
			dispatchKey(keySpec(placement.id), false)
			onReleased?.()
		},
		[editing, onReleased, placement.id],
	)

	const wide = [
		'runstop',
		'space',
		'return',
		'restore',
		'commodore',
		'shift',
		'shiftright',
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
			{OVERLAY_LABELS[placement.id]}
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
}

export function OnScreenControls({
	keys,
	editing = false,
	onChangeKeys,
	onSave,
	onCancel,
	onReleased,
}: OnScreenControlsProps) {
	const containerRef = useRef<HTMLDivElement>(null)

	const onMove = useCallback(
		(id: OverlayKeyId, x: number, y: number) => {
			onChangeKeys?.(keys.map((k) => (k.id === id ? { ...k, x, y } : k)))
		},
		[keys, onChangeKeys],
	)

	const toggle = (id: OverlayKeyId) => {
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
					{EDITOR_ROWS.map((row, rowIndex) => (
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
										{OVERLAY_LABELS[id]}
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
			{keys.map((placement) => (
				<PadButton
					key={placement.id}
					placement={placement}
					editing={editing}
					onMove={onMove}
					onReleased={onReleased}
					containerRef={containerRef}
				/>
			))}
		</div>
	)
}
