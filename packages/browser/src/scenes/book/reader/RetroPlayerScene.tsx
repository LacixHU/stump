import {
	isRetroExtension,
	resolveRetroPlatform,
	type RetroPlatform,
	useSDK,
	useSuspenseGraphQL,
} from '@stump/client'
import { Button, cn } from '@stump/components'
import { TypedDocumentString, UserPermission } from '@stump/graphql'
import { useLocaleContext } from '@stump/i18n'
import { Fullscreen, HardDrive, RotateCcw, Save } from 'lucide-react'
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useMediaMatch } from 'rooks'
import { toast } from 'sonner'

import { useAppContext } from '@/context'
import { usePaths } from '@/paths'

import {
	loadEmulator,
	type RetroDiskSpeed,
	type RetroEmulatorHandle,
	type RetroInputMode,
} from './retro/emulators'
import {
	DEFAULT_OVERLAY_KEYS,
	OnScreenControls,
	type OverlayKeyPlacement,
	resolveOverlayLayout,
} from './retro/OnScreenControls'
import { RetroPlayerSettings } from './retro/RetroPlayerSettings'

/** Inline document: not yet in gql codegen map (graphql() would return {}). */
type RetroPlayerSceneQuery = {
	mediaById: {
		id: string
		name: string
		resolvedName: string
		path: string
		extension: string
		pages: number
		series: {
			id: string
			name: string
			media: Array<{
				id: string
				name: string
				resolvedName: string
				extension: string
				path: string
			}>
		} | null
	} | null
}

type RetroPlayerSceneQueryVariables = { id: string }

/** Skip the emulated 1541 and inject the program straight into RAM. */
const DEFAULT_DISK_SPEED: RetroDiskSpeed = 'instant'

export const RETRO_PLAYER_SCENE_QUERY = new TypedDocumentString(`
	query RetroPlayerScene($id: ID!) {
		mediaById(id: $id) {
			id
			name
			resolvedName
			path
			extension
			pages
			series {
				id
				name
				media {
					id
					name
					resolvedName
					extension
					path
				}
			}
		}
	}
`) as unknown as TypedDocumentString<RetroPlayerSceneQuery, RetroPlayerSceneQueryVariables>

export default function RetroPlayerSceneContainer() {
	const { id } = useParams()
	if (!id) {
		throw new Error('Media ID is required')
	}

	return (
		<Suspense fallback={<div className="flex h-full items-center justify-center">Loading…</div>}>
			<RetroPlayerScene id={id} />
		</Suspense>
	)
}

function RetroPlayerScene({ id }: { id: string }) {
	const navigate = useNavigate()
	const paths = usePaths()
	const { t } = useLocaleContext()
	const { sdk } = useSDK()
	const { checkPermission } = useAppContext()
	const canvasRef = useRef<HTMLCanvasElement>(null)
	const playfieldRef = useRef<HTMLDivElement>(null)
	const handleRef = useRef<RetroEmulatorHandle | null>(null)
	const canEditOverlay = checkPermission(UserPermission.ManageLibrary)

	const {
		data: { mediaById: media },
	} = useSuspenseGraphQL(RETRO_PLAYER_SCENE_QUERY, sdk.cacheKey('retroPlayer', [id]), {
		id,
	})

	const [status, setStatus] = useState<'idle' | 'loading' | 'playing' | 'error'>('idle')
	const [errorMessage, setErrorMessage] = useState<string | null>(null)
	const [activeMediaId, setActiveMediaId] = useState(id)
	const [platform, setPlatform] = useState<RetroPlatform>('c64')
	const [inputMode, setInputMode] = useState<RetroInputMode>('mixed')
	const [joystickPort, setJoystickPort] = useState<1 | 2>(2)
	const [diskSpeed, setDiskSpeed] = useState<RetroDiskSpeed>(DEFAULT_DISK_SPEED)
	const [overlayKeys, setOverlayKeys] = useState<OverlayKeyPlacement[]>(DEFAULT_OVERLAY_KEYS)
	const [draftOverlayKeys, setDraftOverlayKeys] =
		useState<OverlayKeyPlacement[]>(DEFAULT_OVERLAY_KEYS)
	const [editingOverlay, setEditingOverlay] = useState(false)
	const [isFullscreen, setIsFullscreen] = useState(false)
	const isMobile = useMediaMatch('(max-width: 768px)')

	const disks = useMemo(() => {
		const list = media?.series?.media ?? []
		return [...list]
			.filter((m) => isRetroExtension(m.extension || ''))
			.sort((a, b) => (a.name || '').localeCompare(b.name || ''))
	}, [media])

	const activeDisk = useMemo(
		() => disks.find((d) => d.id === activeMediaId) ?? media,
		[disks, activeMediaId, media],
	)

	useEffect(() => {
		if (!media) {
			navigate(paths.notFound(), { replace: true })
			return
		}
		if (!isRetroExtension(media.extension || '')) {
			navigate(paths.bookOverview(id), { replace: true })
		}
	}, [media, navigate, paths, id])

	const stopEmulator = useCallback(() => {
		handleRef.current?.destroy()
		handleRef.current = null
	}, [])

	const fetchImage = useCallback(
		async (mediaId: string) => {
			const url = sdk.media.playFileURL(mediaId)
			const res = await fetch(url, { credentials: 'include' })
			if (!res.ok) {
				throw new Error(
					res.status === 400
						? 'This file cannot be played (not a retro image)'
						: `Failed to load play file (${res.status})`,
				)
			}
			return res.arrayBuffer()
		},
		[sdk],
	)

	const fetchControls = useCallback(
		async (mediaId: string) => {
			try {
				const res = await fetch(sdk.media.retroControlsURL(mediaId), { credentials: 'include' })
				if (!res.ok) {
					setOverlayKeys(DEFAULT_OVERLAY_KEYS)
					return
				}
				const data: unknown = await res.json()
				setOverlayKeys(resolveOverlayLayout(data))
			} catch {
				setOverlayKeys(DEFAULT_OVERLAY_KEYS)
			}
		},
		[sdk],
	)

	const fetchFirmware = useCallback(
		async (names: string[]) => {
			const out: Record<string, ArrayBuffer> = {}
			for (const name of names) {
				const url = sdk.firmware.fileURL(name)
				const res = await fetch(url, { credentials: 'include' })
				if (!res.ok) {
					throw new Error(
						`Missing firmware "${name}". Place Kickstart ROMs in STUMP_FIRMWARE_DIR (user-supplied only).`,
					)
				}
				out[name] = await res.arrayBuffer()
			}
			return out
		},
		[sdk],
	)

	const startPlay = useCallback(
		async (mediaId: string, pathHint?: string, extension?: string) => {
			stopEmulator()
			setStatus('loading')
			setErrorMessage(null)

			try {
				const ext = extension || activeDisk?.extension || 'd64'
				const path = pathHint || activeDisk?.path || ''
				const resolved = resolveRetroPlatform(ext, path)
				setPlatform(resolved)

				const image = await fetchImage(mediaId)
				const mod = await loadEmulator(resolved)

				let firmware: Record<string, ArrayBuffer> | undefined
				if (mod.requiredFirmware?.length) {
					firmware = await fetchFirmware(mod.requiredFirmware)
				}

				const canvas = canvasRef.current
				if (!canvas) {
					throw new Error('Canvas not ready')
				}

				const fileName =
					path.split(/[/\\]/).pop() ||
					(extension ? `game.${extension.replace(/^\./, '')}` : undefined)
				const handle = await mod.create({
					canvas,
					image,
					firmware,
					fileName,
					diskSpeed: DEFAULT_DISK_SPEED,
				})
				handleRef.current = handle
				setActiveMediaId(mediaId)
				setInputMode('mixed')
				setJoystickPort(2)
				setDiskSpeed(DEFAULT_DISK_SPEED)
				setStatus('playing')
				if (resolved === 'c64') {
					void fetchControls(mediaId)
				} else {
					setOverlayKeys(DEFAULT_OVERLAY_KEYS)
				}
			} catch (e) {
				const message = e instanceof Error ? e.message : 'Failed to start emulator'
				setErrorMessage(message)
				setStatus('error')
				toast.error(message)
			}
		},
		[activeDisk, fetchControls, fetchFirmware, fetchImage, stopEmulator],
	)

	useEffect(() => {
		if (media && isRetroExtension(media.extension || '')) {
			void startPlay(media.id, media.path || undefined, media.extension || undefined)
		}
		return () => stopEmulator()
		// eslint-disable-next-line react-hooks/exhaustive-deps -- mount once for initial media
	}, [media?.id])

	const onSwapDisk = async (diskId: string) => {
		const disk = disks.find((d) => d.id === diskId)
		if (!disk || diskId === activeMediaId) return
		const handle = handleRef.current
		if (status === 'playing' && handle?.mountImage) {
			try {
				const image = await fetchImage(diskId)
				const fileName = (disk.path || disk.name || '').split(/[/\\]/).pop()
				await handle.mountImage(image, fileName)
				setActiveMediaId(diskId)
			} catch (e) {
				const message = e instanceof Error ? e.message : 'Could not insert disk'
				toast.error(message)
			}
			return
		}
		await startPlay(disk.id, disk.path || undefined, disk.extension || undefined)
	}

	// A snapshot round-trip is now a network call, so the buttons have to be re-entrancy
	// safe -- two overlapping saves would race each other onto the same server slot.
	const saveStateBusyRef = useRef(false)

	const onSave = async () => {
		if (!handleRef.current?.saveState) {
			toast.message('Save states not available for this emulator yet')
			return
		}
		if (saveStateBusyRef.current) return
		saveStateBusyRef.current = true

		try {
			const data = await handleRef.current.saveState()
			if (!data) {
				toast.message('No save state produced')
				return
			}
			// Note: keyed to the book that was opened, not `activeMediaId`. A multi-disk
			// game is one game, so swapping to disk 2 must not hide the save behind a
			// different media id.
			await sdk.media.putSaveState(id, data)
			toast.success('Save state saved to the server')
		} catch (e) {
			toast.error(saveStateErrorMessage(e, 'Failed to save state'))
		} finally {
			saveStateBusyRef.current = false
		}
	}

	const onLoad = async () => {
		if (!handleRef.current?.loadState) {
			toast.message('Load state not available for this emulator yet')
			return
		}
		if (saveStateBusyRef.current) return
		saveStateBusyRef.current = true

		try {
			const data = await sdk.media.getSaveState(id)
			if (!data) {
				toast.message('No save state stored for this game')
				return
			}
			await handleRef.current.loadState(data)
			toast.success('Save state loaded')
		} catch (e) {
			toast.error(saveStateErrorMessage(e, 'Failed to load state'))
		} finally {
			saveStateBusyRef.current = false
		}
	}

	useEffect(() => {
		const sync = () => {
			setIsFullscreen(document.fullscreenElement === playfieldRef.current)
		}
		document.addEventListener('fullscreenchange', sync)
		return () => document.removeEventListener('fullscreenchange', sync)
	}, [])

	const onFullscreen = () => {
		const el = playfieldRef.current
		if (!el) return
		if (document.fullscreenElement === el) {
			void document.exitFullscreen?.()
			return
		}
		void el.requestFullscreen?.()
	}

	const onReset = () => {
		if (!handleRef.current?.reset) {
			toast.message('Reset is not available for this emulator')
			return
		}
		handleRef.current.reset()
	}

	const onChangeInputMode = (mode: RetroInputMode) => {
		setInputMode(mode)
		handleRef.current?.setInputMode?.(mode)
	}

	const onChangeJoystickPort = (port: 1 | 2) => {
		setJoystickPort(port)
		handleRef.current?.setJoystickPort?.(port)
	}

	const onChangeDiskSpeed = (speed: RetroDiskSpeed) => {
		setDiskSpeed(speed)
		handleRef.current?.setDiskSpeed?.(speed)
	}

	const focusCanvas = () => {
		canvasRef.current?.focus()
	}

	const isTouch = useMediaMatch('(pointer: coarse)')
	const showC64Chrome = platform === 'c64' && status === 'playing'
	const showOverlay = showC64Chrome && (isMobile || isTouch || editingOverlay)

	const onEditOverlay = () => {
		setDraftOverlayKeys(overlayKeys)
		setEditingOverlay(true)
	}

	const onCancelOverlay = () => {
		setEditingOverlay(false)
		setDraftOverlayKeys(overlayKeys)
	}

	const onSaveOverlay = async () => {
		try {
			const data = await sdk.media.saveRetroControls(activeMediaId, draftOverlayKeys)
			const next = resolveOverlayLayout(data)
			setOverlayKeys(next)
			setDraftOverlayKeys(next)
			setEditingOverlay(false)
			toast.success('Overlay saved for this game')
		} catch (e) {
			const axiosData =
				e && typeof e === 'object' && 'response' in e
					? (e as { response?: { data?: { message?: string }; status?: number } }).response
					: undefined
			const message =
				axiosData?.data?.message ||
				(e instanceof Error
					? e.message
					: `Failed to save overlay (${axiosData?.status ?? 'error'})`)
			toast.error(message)
		}
	}

	if (!media) {
		return null
	}

	return (
		<div className="min-h-0 bg-black flex h-[100dvh] flex-col">
			<header className="border-edge gap-2 px-3 py-2 flex shrink-0 flex-wrap items-center border-b bg-background">
				<Button size="sm" variant="ghost" onClick={() => navigate(paths.bookOverview(id))}>
					{t('common.back', { defaultValue: 'Back' })}
				</Button>
				<span className="text-sm font-medium">{media.resolvedName || media.name}</span>
				<span className="rounded px-1.5 py-0.5 text-xs bg-muted text-muted-foreground uppercase">
					{platform}
				</span>
				<div className="gap-1 ml-auto flex items-center">
					<Button size="sm" variant="ghost" onClick={onSave} title="Save state">
						<Save className="h-4 w-4" />
					</Button>
					<Button size="sm" variant="ghost" onClick={onLoad} title="Load state">
						<HardDrive className="h-4 w-4" />
					</Button>
					<Button size="sm" variant="ghost" onClick={onFullscreen} title="Fullscreen">
						<Fullscreen className="h-4 w-4" />
					</Button>
					{showC64Chrome ? (
						<>
							<RetroPlayerSettings
								inputMode={inputMode}
								joystickPort={joystickPort}
								onInputMode={onChangeInputMode}
								onJoystickPort={onChangeJoystickPort}
								diskSpeed={diskSpeed}
								onDiskSpeed={onChangeDiskSpeed}
								canEditOverlay={canEditOverlay}
								onEditOverlay={onEditOverlay}
								t={t}
							/>
							<Button
								size="sm"
								variant="ghost"
								onClick={onReset}
								title={t('reader.retro.reset', { defaultValue: 'Reset' })}
							>
								<RotateCcw className="h-4 w-4" />
							</Button>
						</>
					) : null}
				</div>
			</header>

			<div className="min-h-0 md:flex-row flex flex-1 flex-col">
				<main className="min-h-0 bg-black relative flex-1">
					<div ref={playfieldRef} className="inset-0 bg-black absolute">
						<canvas
							ref={canvasRef}
							className={cn(
								'inset-0 bg-black absolute h-full w-full object-contain [image-rendering:pixelated]',
								(status === 'loading' || status === 'error') && 'opacity-50',
							)}
						/>
						{showOverlay ? (
							<OnScreenControls
								keys={editingOverlay ? draftOverlayKeys : overlayKeys}
								editing={editingOverlay}
								onChangeKeys={setDraftOverlayKeys}
								onSave={() => void onSaveOverlay()}
								onCancel={onCancelOverlay}
								onReleased={focusCanvas}
							/>
						) : null}
					</div>
					{status === 'error' && errorMessage ? (
						<div className="inset-0 p-4 absolute z-10 flex items-center justify-center">
							<div className="max-w-md text-sm text-center text-destructive">
								<p>{errorMessage}</p>
								{errorMessage.includes('Kickstart') && (
									<p className="mt-2 text-muted-foreground">
										Set STUMP_FIRMWARE_DIR and place required Kickstart files there. ROMs are never
										bundled.
									</p>
								)}
								<Button
									className="mt-4"
									size="sm"
									onClick={() =>
										void startPlay(
											activeMediaId,
											activeDisk?.path || undefined,
											activeDisk?.extension || undefined,
										)
									}
								>
									Retry
								</Button>
							</div>
						</div>
					) : null}
				</main>

				{disks.length > 1 && (
					<aside className="border-edge p-3 md:w-56 md:border-l md:border-t-0 md:max-h-none max-h-40 w-full shrink-0 overflow-y-auto border-t bg-background">
						<p className="mb-2 text-xs font-medium text-muted-foreground uppercase">Disks</p>
						<ul className="space-y-1">
							{disks.map((disk) => (
								<li key={disk.id}>
									<button
										type="button"
										className={cn(
											'rounded px-2 py-1.5 text-sm w-full text-left hover:bg-muted',
											disk.id === activeMediaId && 'font-medium bg-muted',
										)}
										onClick={() => void onSwapDisk(disk.id)}
									>
										{disk.resolvedName || disk.name}
									</button>
								</li>
							))}
						</ul>
					</aside>
				)}
			</div>
		</div>
	)
}

/**
 * Pull a human message out of a failed save-state call.
 *
 * The GET is issued with `responseType: 'arraybuffer'`, so an error body arrives as
 * bytes rather than parsed JSON and `response.data.message` is not available -- fall back
 * to the status code in that case.
 */
function saveStateErrorMessage(error: unknown, fallback: string): string {
	const response =
		error && typeof error === 'object' && 'response' in error
			? (error as { response?: { data?: { message?: string }; status?: number } }).response
			: undefined

	if (response?.status === 413) {
		return 'Save state is too large for this server'
	}

	if (typeof response?.data?.message === 'string') {
		return response.data.message
	}

	if (response?.status) {
		return `${fallback} (${response.status})`
	}

	return error instanceof Error ? error.message : fallback
}
