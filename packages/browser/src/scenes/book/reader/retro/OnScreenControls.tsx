import { Button, cn } from '@stump/components'
import { type PointerEvent, type RefObject, useCallback, useRef } from 'react'

import { dispatchKey, OVERLAY_KEY_IDS, OVERLAY_LABELS, type OverlayKeyId } from './keys'

export type OverlayKeyPlacement = {
	id: OverlayKeyId
	x: number
	y: number
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
			dispatchKey(placement.id, true)
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
			dispatchKey(placement.id, false)
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
