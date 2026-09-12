import {
	isRetroExtension,
	resolveRetroPlatform,
	useSDK,
	useSuspenseGraphQL,
	type RetroPlatform,
} from '@stump/client'
import { Button, cn } from '@stump/components'
import { TypedDocumentString } from '@stump/graphql'
import { useLocaleContext } from '@stump/i18n'
import { Fullscreen, HardDrive, Save, Square } from 'lucide-react'
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'

import { useAppContext } from '@/context'
import { usePaths } from '@/paths'

import { loadEmulator, type RetroEmulatorHandle } from './retro/emulators'
import { loadRetroState, saveRetroState } from './retro/saves'

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
	const { user } = useAppContext()
	const canvasRef = useRef<HTMLCanvasElement>(null)
	const handleRef = useRef<RetroEmulatorHandle | null>(null)

	const {
		data: { mediaById: media },
	} = useSuspenseGraphQL(RETRO_PLAYER_SCENE_QUERY, sdk.cacheKey('retroPlayer', [id]), {
		id,
	})

	const [status, setStatus] = useState<'idle' | 'loading' | 'playing' | 'error'>('idle')
	const [errorMessage, setErrorMessage] = useState<string | null>(null)
	const [activeMediaId, setActiveMediaId] = useState(id)
	const [platform, setPlatform] = useState<RetroPlatform>('c64')

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
				const handle = await mod.create({ canvas, image, firmware, fileName })
				handleRef.current = handle
				setActiveMediaId(mediaId)
				setStatus('playing')
			} catch (e) {
				const message = e instanceof Error ? e.message : 'Failed to start emulator'
				setErrorMessage(message)
				setStatus('error')
				toast.error(message)
			}
		},
		[activeDisk, fetchFirmware, fetchImage, stopEmulator],
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
		if (!disk) return
		await startPlay(disk.id, disk.path || undefined, disk.extension || undefined)
	}

	const onSave = async () => {
		if (!user?.id || !handleRef.current?.saveState) {
			toast.message('Save states not available for this emulator yet')
			return
		}
		const data = await handleRef.current.saveState()
		if (!data) {
			toast.message('No save state produced')
			return
		}
		await saveRetroState(user.id, activeMediaId, 0, data)
		toast.success('Save state stored in this browser')
	}

	const onLoad = async () => {
		if (!user?.id || !handleRef.current?.loadState) {
			toast.message('Load state not available for this emulator yet')
			return
		}
		const data = await loadRetroState(user.id, activeMediaId, 0)
		if (!data) {
			toast.message('No save in slot 0')
			return
		}
		await handleRef.current.loadState(data)
		toast.success('Save state loaded')
	}

	const onFullscreen = () => {
		const el = canvasRef.current
		if (!el) return
		void el.requestFullscreen?.()
	}

	if (!media) {
		return null
	}

	return (
		<div className="min-h-0 flex h-full flex-col bg-background">
			<header className="border-edge gap-2 px-3 py-2 flex flex-wrap items-center border-b">
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
					<Button
						size="sm"
						variant="ghost"
						onClick={() => {
							stopEmulator()
							setStatus('idle')
						}}
						title="Stop"
					>
						<Square className="h-4 w-4" />
					</Button>
				</div>
			</header>

			<div className="min-h-0 md:flex-row flex flex-1 flex-col">
				<main className="p-4 flex flex-1 items-center justify-center">
					{status === 'error' && errorMessage ? (
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
					) : (
						<canvas
							ref={canvasRef}
							className={cn(
								'border-edge bg-black max-h-full max-w-full border',
								status === 'loading' && 'opacity-50',
							)}
						/>
					)}
				</main>

				{disks.length > 1 && (
					<aside className="border-edge p-3 md:w-56 md:border-l md:border-t-0 w-full border-t">
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
