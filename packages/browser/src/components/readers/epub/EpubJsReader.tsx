import { queryClient, useGraphQLMutation, useSDK, useSuspenseGraphQL } from '@stump/client'
import { ProgressSpinner } from '@stump/components'
import {
	Bookmark,
	EpubJsReaderQuery,
	EpubProgressInput,
	graphql,
	ReadingDirection,
	ReadingMode,
	SupportedFont,
	UserPermission,
} from '@stump/graphql'
import { useLocaleContext } from '@stump/i18n'
import { useQueryClient } from '@tanstack/react-query'
import { Book, Contents, Rendition } from 'epubjs'
import uniqby from 'lodash/uniqBy'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import AutoSizer from 'react-virtualized-auto-sizer'
import { toast } from 'sonner'

import { useAppContext } from '@/context'
import { useTheme } from '@/hooks'
import { useBookPreferences } from '@/scenes/book/reader/useBookPreferences'
import { useBookTimer } from '@/stores/reader'

import { EpubContent, ReadAloudEngine } from './context'
import EpubReaderContainer from './EpubReaderContainer'
import { elementReadableText, normalizeReaderWhitespace, splitIntoSentences } from './readAloudText'
import { darkVariantText, toFamilyName } from './themes'

// TODO: Fix all lifecycle lints
// TODO: Consider a total re-write or at least thorough review of this component, it was written a while
// ago and I feel like it could be improved
// TODO: Support elapsed time tracking!!!!

// NOTE: http://epubjs.org/documentation/0.3/ for epubjs documentation overview

const LOCATIONS_CACHE_KEY = 'stump:epubjs-locations-cache'
const READ_ALOUD_PREFS_KEY = 'stump:epubjs-read-aloud-preferences'
const READ_ALOUD_RESUME_KEY = 'stump:epubjs-read-aloud-resume'
const READ_ALOUD_SENTENCE_GAP_MS = 400

type ReadAloudPreferences = {
	engine: ReadAloudEngine
	rate: number
	pitch: number
	voiceUri: string | null
}

type ReadAloudResume = {
	cfi: string | null
	sentenceIndex: number
}

const defaultReadAloudPreferences: ReadAloudPreferences = {
	engine: 'browser',
	rate: 1,
	pitch: 1,
	voiceUri: null,
}

const loadReadAloudPreferences = (): ReadAloudPreferences => {
	if (typeof window === 'undefined') {
		return defaultReadAloudPreferences
	}

	const raw = window.localStorage.getItem(READ_ALOUD_PREFS_KEY)
	if (!raw) {
		return defaultReadAloudPreferences
	}

	try {
		const parsed = JSON.parse(raw) as Partial<ReadAloudPreferences>
		return {
			engine: parsed.engine === 'server' ? 'server' : defaultReadAloudPreferences.engine,
			rate: typeof parsed.rate === 'number' ? parsed.rate : defaultReadAloudPreferences.rate,
			pitch: typeof parsed.pitch === 'number' ? parsed.pitch : defaultReadAloudPreferences.pitch,
			voiceUri:
				typeof parsed.voiceUri === 'string'
					? parsed.voiceUri
					: defaultReadAloudPreferences.voiceUri,
		}
	} catch {
		return defaultReadAloudPreferences
	}
}

const formatResumeKey = (id: string) => `${READ_ALOUD_RESUME_KEY}:book-${id}`

const loadReadAloudResume = (id: string): ReadAloudResume => {
	if (typeof window === 'undefined') {
		return { cfi: null, sentenceIndex: 0 }
	}

	const raw = window.localStorage.getItem(formatResumeKey(id))
	if (!raw) {
		return { cfi: null, sentenceIndex: 0 }
	}

	try {
		const parsed = JSON.parse(raw) as Partial<ReadAloudResume>
		return {
			cfi: typeof parsed.cfi === 'string' ? parsed.cfi : null,
			sentenceIndex:
				typeof parsed.sentenceIndex === 'number' && parsed.sentenceIndex >= 0
					? Math.floor(parsed.sentenceIndex)
					: 0,
		}
	} catch {
		return { cfi: null, sentenceIndex: 0 }
	}
}

const formatCacheKey = (id: string) => `${LOCATIONS_CACHE_KEY}:book-${id}`

const loadCachedLocations = (id: string): string[] | null => {
	const cached = localStorage.getItem(formatCacheKey(id))
	if (!cached) {
		return null
	}

	try {
		const parsed = JSON.parse(cached)
		if (Array.isArray(parsed) && typeof parsed.at(0) === 'string') {
			return parsed
		}
	} catch (error) {
		console.error('Failed to parse cached locations:', error)
	}

	return null
}

const saveCachedLocations = (id: string, locations: string[]) => {
	localStorage.setItem(formatCacheKey(id), JSON.stringify(locations))
}

/** EPUB paths must use `/`; server PathBuf can emit `\` on Windows. */
const normalizeEpubPath = (value: string) => value.replace(/\\/g, '/')

const splitHrefFragment = (href: string) => {
	const normalized = normalizeEpubPath(href)
	const hashIndex = normalized.indexOf('#')
	if (hashIndex === -1) {
		return { path: normalized, fragment: '' }
	}

	return {
		path: normalized.slice(0, hashIndex),
		fragment: normalized.slice(hashIndex),
	}
}

const formatHrefTarget = (path: string, fragment: string) => `${path}${fragment}`

const getHrefDisplayTargets = (href: string, rootBase?: string) => {
	const trimmedHref = normalizeEpubPath(href.trim())
	if (!trimmedHref) {
		return []
	}

	const { path, fragment } = splitHrefFragment(trimmedHref)
	const trimmedRoot = rootBase ? normalizeEpubPath(rootBase).replace(/^\/+|\/+$/g, '') : undefined
	const pathWithoutLeadingSlash = path.replace(/^\/+/, '')
	const basename = pathWithoutLeadingSlash.includes('/')
		? pathWithoutLeadingSlash.slice(pathWithoutLeadingSlash.lastIndexOf('/') + 1)
		: pathWithoutLeadingSlash

	const candidates = [
		trimmedHref,
		formatHrefTarget(pathWithoutLeadingSlash, fragment),
		formatHrefTarget(basename, fragment),
	]

	if (trimmedRoot) {
		if (pathWithoutLeadingSlash.startsWith(`${trimmedRoot}/`)) {
			candidates.push(
				formatHrefTarget(pathWithoutLeadingSlash.slice(trimmedRoot.length + 1), fragment),
			)
		} else {
			candidates.push(formatHrefTarget(`${trimmedRoot}/${pathWithoutLeadingSlash}`, fragment))
		}
	}

	// Path-only fallbacks (epubjs often fails on missing/odd fragment ids)
	for (const withFragment of [...candidates]) {
		const pathOnly = splitHrefFragment(withFragment).path
		if (pathOnly) {
			candidates.push(pathOnly)
		}
	}

	return Array.from(new Set(candidates.filter(Boolean)))
}

/** The props for the EpubJsReader component */
type EpubJsReaderProps = {
	/** The ID of the associated media entity for this epub */
	id: string
	/** If true, starts progress at the start of the book, or the default location if set */
	isIncognito: boolean
}

/** Location information as it is structured internally in epubjs */
type EpubLocation = {
	/** The epubcfi for the location */
	cfi: string
	/** The chapter display information */
	displayed: {
		/** The current page within the chapter */
		page: number
		/** The total pages in the chapter */
		total: number
	}
	/** The href as it is represented in the epub */
	href: string
	/** The index of this location, relative to the spine */
	index: number
	// TODO: i don't remember lol
	location: number
	// TODO: i don't remember lol
	percentage: number
}

/** The epubjs location state */
type EpubLocationState = {
	atStart?: boolean
	atEnd?: boolean
	start: EpubLocation
	end: EpubLocation
}

class SectionLengths {
	public lengths: { [key: number]: number } = {}
}

const query = graphql(`
	query EpubJsReader($id: ID!) {
		epubById(id: $id) {
			mediaId
			rootBase
			rootFile
			extraCss
			toc
			resources
			metadata
			spine {
				id
				idref
				properties
				linear
			}
			bookmarks {
				id
				userId
				epubcfi
				mediaId
				createdAt
			}
			media {
				id
				resolvedName
				pages
				extension
				readProgress {
					percentageCompleted
					epubcfi
					page
					elapsedSeconds
				}
				libraryConfig {
					defaultReadingImageScaleFit
					defaultReadingMode
					defaultReadingDir
				}
				nextInSeries(pagination: { cursor: { limit: 1 } }) {
					nodes {
						id
						name: resolvedName
						thumbnail {
							url
						}
					}
				}
			}
		}
	}
`)

const mutation = graphql(`
	mutation UpdateEpubProgress($id: ID!, $input: MediaProgressInput!) {
		updateMediaProgress(id: $id, input: $input) {
			__typename
		}
	}
`)

const injectFontStylesheet = (rendition: Rendition) => {
	const doc = Object.values(rendition.getContents())[0]?.document
	if (!doc) return

	const head = doc.head
	if (!head) return

	const link = doc.createElement('link')
	link.rel = 'stylesheet'
	link.id = 'stump-fonts-stylesheet'
	link.href = '/assets/fonts/fonts.css'
	head.appendChild(link)
}

/**
 * A component for rendering a reader capable of reading epub files. This component uses
 * epubjs internally for the main rendering logic.
 *
 * Note: At some point in the future, I will be prioritizing some sort of streamable
 * epub reader as an additional option.
 */
export default function EpubJsReader({ id, isIncognito }: EpubJsReaderProps) {
	const { sdk } = useSDK()
	const { t } = useLocaleContext()
	const { checkPermission } = useAppContext()
	const { isDarkVariant } = useTheme()
	const canUseServerTts = checkPermission(UserPermission.AccessServerTts)

	const {
		data: { epubById: ebook },
	} = useSuspenseGraphQL(query, ['epubJsReader', id], {
		id: id || '',
	})

	const ref = useRef<HTMLDivElement>(null)

	const [book, setBook] = useState<Book | null>(null)
	const [rendition, setRendition] = useState<Rendition | null>(null)
	const [sectionsLengths, setSectionLengths] = useState<SectionLengths | null>(null)
	const [isReadAloudActive, setIsReadAloudActive] = useState(false)
	const [isReadAloudPaused, setIsReadAloudPaused] = useState(false)
	const [readAloudCurrentSentence, setReadAloudCurrentSentence] = useState<string | null>(null)
	const [readAloudServerAvailable, setReadAloudServerAvailable] = useState(false)
	const [browserReadAloudVoices, setBrowserReadAloudVoices] = useState<
		Array<{ label: string; value: string }>
	>([])
	const [serverReadAloudVoices, setServerReadAloudVoices] = useState<
		Array<{ label: string; value: string }>
	>([])
	const [
		{
			engine: readAloudEngine,
			pitch: readAloudPitch,
			rate: readAloudRate,
			voiceUri: readAloudVoiceUri,
		},
		setReadAloudPreferences,
	] = useState<ReadAloudPreferences>(() => loadReadAloudPreferences())

	const [currentLocation, setCurrentLocation] = useState<EpubLocationState>()
	const [isInitialLoading, setIsInitialLoading] = useState(true)
	const readAloudRequestRef = useRef(0)
	const readAloudSentenceQueueRef = useRef<string[]>([])
	const readAloudSentenceIndexRef = useRef(0)
	const readAloudAutoTurnInProgressRef = useRef(false)
	const currentLocationRef = useRef<EpubLocationState>()
	const readAloudCurrentCfiRef = useRef<string | null>(null)
	const readAloudResumeRef = useRef<ReadAloudResume>(loadReadAloudResume(id))
	const readAloudAudioRef = useRef<HTMLAudioElement | null>(null)
	const readAloudObjectUrlRef = useRef<string | null>(null)
	const readAloudPrefetchRef = useRef<{
		requestId: number
		sentenceIndex: number
		promise: Promise<string | null>
	} | null>(null)
	const readAloudSentenceGapTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	const readAloudSentenceGapPendingRef = useRef<{
		requestId: number
		nextIndex: number
	} | null>(null)
	const playSentenceQueueRef = useRef<((requestId: number, sentenceIndex: number) => void) | null>(
		null,
	)
	const speakCurrentLocationRef = useRef<
		| ((opts?: {
				suppressToast?: boolean
				preferSelection?: boolean
				preferVisibleText?: boolean
		  }) => Promise<boolean>)
		| null
	>(null)

	const {
		bookPreferences: {
			fontSize,
			lineHeight,
			fontFamily,
			readingMode,
			readingDirection,
			trackElapsedTime,
		},
	} = useBookPreferences({ book: ebook.media })

	const timer = useBookTimer(ebook.media?.id || '', {
		initial: ebook.media?.readProgress?.elapsedSeconds,
		enabled: trackElapsedTime,
	})

	const lastSyncedElapsedRef = useRef(ebook.media?.readProgress?.elapsedSeconds ?? 0)

	const client = useQueryClient()
	const browserSpeechSupported = typeof window !== 'undefined' && 'speechSynthesis' in window
	const effectiveReadAloudEngine: ReadAloudEngine =
		readAloudEngine === 'server' && readAloudServerAvailable ? 'server' : 'browser'
	const readAloudSupported =
		browserSpeechSupported || (readAloudServerAvailable && typeof Audio !== 'undefined')
	const readAloudVoices =
		effectiveReadAloudEngine === 'server' ? serverReadAloudVoices : browserReadAloudVoices

	const clearPlayingServerAudio = useCallback(() => {
		if (readAloudAudioRef.current) {
			readAloudAudioRef.current.pause()
			readAloudAudioRef.current.src = ''
			readAloudAudioRef.current = null
		}
		if (readAloudObjectUrlRef.current) {
			URL.revokeObjectURL(readAloudObjectUrlRef.current)
			readAloudObjectUrlRef.current = null
		}
	}, [])

	const clearPrefetchedServerAudio = useCallback(() => {
		const entry = readAloudPrefetchRef.current
		readAloudPrefetchRef.current = null
		if (!entry) {
			return
		}
		void entry.promise.then((url) => {
			if (url) {
				URL.revokeObjectURL(url)
			}
		})
	}, [])

	const clearServerAudio = useCallback(() => {
		clearPlayingServerAudio()
		clearPrefetchedServerAudio()
	}, [clearPlayingServerAudio, clearPrefetchedServerAudio])

	const clearSentenceGapTimer = useCallback(() => {
		if (readAloudSentenceGapTimeoutRef.current !== null) {
			clearTimeout(readAloudSentenceGapTimeoutRef.current)
			readAloudSentenceGapTimeoutRef.current = null
		}
	}, [])

	const clearSentenceGap = useCallback(() => {
		clearSentenceGapTimer()
		readAloudSentenceGapPendingRef.current = null
	}, [clearSentenceGapTimer])

	const scheduleNextReadAloudSentence = useCallback(
		(requestId: number, nextIndex: number) => {
			clearSentenceGapTimer()
			readAloudSentenceGapPendingRef.current = { nextIndex, requestId }
			readAloudSentenceGapTimeoutRef.current = setTimeout(() => {
				readAloudSentenceGapTimeoutRef.current = null
				if (readAloudRequestRef.current !== requestId) {
					readAloudSentenceGapPendingRef.current = null
					return
				}
				readAloudSentenceGapPendingRef.current = null
				playSentenceQueueRef.current?.(requestId, nextIndex)
			}, READ_ALOUD_SENTENCE_GAP_MS)
		},
		[clearSentenceGapTimer],
	)

	const persistReadAloudResume = useCallback(
		(resume: ReadAloudResume) => {
			readAloudResumeRef.current = resume

			if (typeof window === 'undefined') {
				return
			}

			window.localStorage.setItem(formatResumeKey(id), JSON.stringify(resume))
		},
		[id],
	)

	useEffect(() => {
		if (typeof window === 'undefined') {
			return
		}

		window.localStorage.setItem(
			READ_ALOUD_PREFS_KEY,
			JSON.stringify({
				engine: readAloudEngine,
				rate: readAloudRate,
				pitch: readAloudPitch,
				voiceUri: readAloudVoiceUri,
			}),
		)
	}, [readAloudEngine, readAloudPitch, readAloudRate, readAloudVoiceUri])

	useEffect(() => {
		clearPrefetchedServerAudio()
	}, [clearPrefetchedServerAudio, readAloudRate, readAloudVoiceUri])

	useEffect(() => {
		if (!browserSpeechSupported) {
			return
		}

		const updateVoices = () => {
			const voices = window.speechSynthesis
				.getVoices()
				.map((voice) => ({
					label: `${voice.name} (${voice.lang})`,
					value: voice.voiceURI,
				}))
				.sort((a, b) => a.label.localeCompare(b.label))

			setBrowserReadAloudVoices(voices)

			// Log voice availability for debugging, especially on Android
			if (voices.length === 0) {
				console.warn(
					'No TTS voices available on this device. TTS may not work. Try reloading the page or check device TTS settings.',
				)
			}
		}

		updateVoices()

		// Some browsers don't fire voiceschanged, so retry a few times
		const timeout = setTimeout(() => {
			const voices = window.speechSynthesis.getVoices()
			if (voices.length === 0) {
				console.warn('Still no TTS voices after initial load. This may cause read-aloud to fail.')
			}
		}, 1000)

		window.speechSynthesis.addEventListener('voiceschanged', updateVoices)

		return () => {
			clearTimeout(timeout)
			window.speechSynthesis.removeEventListener('voiceschanged', updateVoices)
		}
	}, [browserSpeechSupported])

	useEffect(() => {
		if (!canUseServerTts) {
			setReadAloudServerAvailable(false)
			setServerReadAloudVoices([])
			setReadAloudPreferences((prev) =>
				prev.engine === 'server' ? { ...prev, engine: 'browser' } : prev,
			)
			return
		}

		let cancelled = false

		sdk.tts
			.status()
			.then((status) => {
				if (cancelled) {
					return
				}

				const available = status.enabled && status.voices.length > 0
				setReadAloudServerAvailable(available)
				setServerReadAloudVoices(
					status.voices.map((voice) => ({
						label: voice.label,
						value: voice.id,
					})),
				)

				if (!available) {
					setReadAloudPreferences((prev) =>
						prev.engine === 'server' ? { ...prev, engine: 'browser' } : prev,
					)
					return
				}

				setReadAloudPreferences((prev) => {
					if (prev.engine !== 'server' || prev.voiceUri || !status.defaultVoice) {
						return prev
					}
					return { ...prev, voiceUri: status.defaultVoice }
				})
			})
			.catch(() => {
				if (cancelled) {
					return
				}
				setReadAloudServerAvailable(false)
				setServerReadAloudVoices([])
				setReadAloudPreferences((prev) =>
					prev.engine === 'server' ? { ...prev, engine: 'browser' } : prev,
				)
			})

		return () => {
			cancelled = true
		}
	}, [canUseServerTts, sdk])

	const extractVisibleText = useCallback(() => {
		if (!rendition) {
			return ''
		}

		return normalizeReaderWhitespace(
			rendition
				.getContents()
				.map(
					(content) =>
						content.document?.body?.innerText || content.document?.body?.textContent || '',
				)
				.join('\n'),
		)
	}, [rendition])

	const getSelectedVisibleText = useCallback(() => {
		if (!rendition) {
			return ''
		}

		return normalizeReaderWhitespace(
			rendition
				.getContents()
				.map((content) => content.window?.getSelection?.()?.toString() || '')
				.join('\n'),
		)
	}, [rendition])

	const extractTextFromCurrentLocation = useCallback(async () => {
		const location = currentLocationRef.current

		if (!book || !location?.start.cfi) {
			return ''
		}

		try {
			const range = await book.getRange(location.start.cfi)
			if (!range) {
				return ''
			}

			const startContainer = range.startContainer
			const doc = startContainer?.ownerDocument
			if (!doc || !startContainer) {
				return normalizeReaderWhitespace(range.toString() || '')
			}

			const fragments: string[] = []
			const body = doc.body
			const pushNodeText = (node: Node) => {
				if (node.nodeType === Node.TEXT_NODE) {
					fragments.push(node.textContent ?? '')
					return
				}
				if (node.nodeType === Node.ELEMENT_NODE) {
					fragments.push(elementReadableText(node as Element))
				}
			}

			if (startContainer.nodeType === Node.TEXT_NODE) {
				fragments.push(startContainer.textContent?.slice(range.startOffset) ?? '')

				let nextNode: Node | null = startContainer.nextSibling
				while (nextNode && body?.contains(nextNode)) {
					pushNodeText(nextNode)
					nextNode = nextNode.nextSibling
				}

				let ancestor: Node | null = startContainer.parentNode
				while (ancestor && ancestor !== body) {
					let uncle = ancestor.nextSibling
					while (uncle && body.contains(uncle)) {
						pushNodeText(uncle)
						uncle = uncle.nextSibling
					}
					ancestor = ancestor.parentNode
				}
			} else if (startContainer.nodeType === Node.ELEMENT_NODE) {
				fragments.push(elementReadableText(startContainer as Element))
			}

			const text = normalizeReaderWhitespace(fragments.join('\n'))
			return text || normalizeReaderWhitespace(range.toString() || '')
		} catch (error) {
			console.error('Error extracting text from current location:', error)
			return ''
		}
	}, [book])

	const stopReadAloud = useCallback(() => {
		if (!readAloudSupported) {
			return
		}

		if (browserSpeechSupported) {
			window.speechSynthesis.cancel()
		}
		clearServerAudio()
		readAloudRequestRef.current += 1
		readAloudSentenceQueueRef.current = []
		clearSentenceGap()
		persistReadAloudResume({
			cfi: readAloudCurrentCfiRef.current,
			sentenceIndex: readAloudSentenceIndexRef.current,
		})
		setIsReadAloudActive(false)
		setIsReadAloudPaused(false)
		setReadAloudCurrentSentence(null)
		readAloudAutoTurnInProgressRef.current = false
	}, [
		browserSpeechSupported,
		clearSentenceGap,
		clearServerAudio,
		persistReadAloudResume,
		readAloudSupported,
	])

	const playBrowserSentence = useCallback(
		(requestId: number, sentenceIndex: number, sentence: string) => {
			const utterance = new SpeechSynthesisUtterance(sentence)

			// Set rate and pitch with bounds for Android compatibility
			// Android's Web Speech API can be finicky with certain values
			try {
				utterance.rate = Math.max(0.1, Math.min(10, readAloudRate))
				utterance.pitch = Math.max(0, Math.min(2, readAloudPitch))
			} catch (e) {
				// Fallback to defaults if setting fails
				utterance.rate = 1
				utterance.pitch = 1
				console.warn('Failed to set utterance rate/pitch, using defaults', e)
			}

			// Try to find the selected voice, fallback to first available voice
			let voiceWasSet = false
			if (readAloudVoiceUri) {
				const voice = window.speechSynthesis
					.getVoices()
					.find((candidate) => candidate.voiceURI === readAloudVoiceUri)
				if (voice) {
					try {
						utterance.voice = voice
						voiceWasSet = true
					} catch (e) {
						console.warn(
							`Failed to set selected voice "${readAloudVoiceUri}": ${e instanceof Error ? e.message : String(e)}`,
						)
					}
				} else {
					console.warn(
						`Selected voice URI "${readAloudVoiceUri}" not found. Available voices: ${window.speechSynthesis
							.getVoices()
							.map((v) => v.voiceURI)
							.join(', ')}`,
					)
				}
			}

			// If no voice was explicitly set, try to use the first available voice
			if (!voiceWasSet) {
				const fallbackVoice = window.speechSynthesis.getVoices()[0]
				if (fallbackVoice) {
					try {
						utterance.voice = fallbackVoice
						voiceWasSet = true
						if (readAloudVoiceUri) {
							console.warn(
								`Using fallback voice "${fallbackVoice.name}" (${fallbackVoice.lang}) because selected voice is unavailable`,
							)
						}
					} catch (e) {
						console.warn(
							`Failed to set fallback voice "${fallbackVoice.name}": ${e instanceof Error ? e.message : String(e)}`,
						)
					}
				}
			}

			utterance.onend = () => {
				if (readAloudRequestRef.current === requestId) {
					scheduleNextReadAloudSentence(requestId, sentenceIndex + 1)
				}
			}
			utterance.onerror = (event: SpeechSynthesisErrorEvent) => {
				if (readAloudRequestRef.current === requestId) {
					const errorDetails = event.error || 'unknown error'
					const voiceInfo = utterance.voice
						? `(voice: ${utterance.voice.name}, lang: ${utterance.voice.lang})`
						: '(no voice set)'
					console.error(
						`Speech synthesis error: ${errorDetails} ${voiceInfo}. Available voices: ${window.speechSynthesis.getVoices().length}. Text length: ${sentence.length}`,
					)

					// Try recovery: create a new utterance without voice selection
					if (voiceWasSet && window.speechSynthesis.getVoices().length > 0) {
						console.warn('Attempting recovery: retrying without explicitly set voice...')
						try {
							const recoveryUtterance = new SpeechSynthesisUtterance(sentence)
							recoveryUtterance.rate = utterance.rate
							recoveryUtterance.pitch = utterance.pitch
							recoveryUtterance.onend = utterance.onend
							recoveryUtterance.onerror = () => {
								// Second failure: give up
								if (readAloudRequestRef.current === requestId) {
									setIsReadAloudActive(false)
									setIsReadAloudPaused(false)
									setReadAloudCurrentSentence(null)
									toast.error(t('reader.toasts.failedReadAloud'))
								}
							}
							window.speechSynthesis.speak(recoveryUtterance)
						} catch (recoveryError) {
							console.error(
								`Recovery attempt failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
							)
							setIsReadAloudActive(false)
							setIsReadAloudPaused(false)
							setReadAloudCurrentSentence(null)
							toast.error(t('reader.toasts.failedReadAloud'))
						}
					} else {
						setIsReadAloudActive(false)
						setIsReadAloudPaused(false)
						setReadAloudCurrentSentence(null)
						toast.error(t('reader.toasts.failedReadAloud'))
					}
				}
			}

			// Attempt to speak with error handling
			try {
				window.speechSynthesis.speak(utterance)
			} catch (e) {
				if (readAloudRequestRef.current === requestId) {
					setIsReadAloudActive(false)
					setIsReadAloudPaused(false)
					setReadAloudCurrentSentence(null)
					console.error(`Failed to call speak(): ${e instanceof Error ? e.message : String(e)}`)
					toast.error(t('reader.toasts.failedReadAloud'))
				}
			}
		},
		[readAloudPitch, readAloudRate, readAloudVoiceUri, scheduleNextReadAloudSentence, t],
	)

	const requestServerSentenceAudio = useCallback(
		(requestId: number, sentenceIndex: number, sentence: string) => {
			const existing = readAloudPrefetchRef.current
			if (
				existing &&
				existing.requestId === requestId &&
				existing.sentenceIndex === sentenceIndex
			) {
				return existing.promise
			}

			if (existing) {
				readAloudPrefetchRef.current = null
				void existing.promise.then((url) => {
					if (url) {
						URL.revokeObjectURL(url)
					}
				})
			}

			const promise = sdk.tts
				.speak({
					rate: readAloudRate,
					text: sentence,
					voice: readAloudVoiceUri,
				})
				.then((blob) => {
					if (readAloudRequestRef.current !== requestId) {
						return null
					}
					return URL.createObjectURL(new Blob([blob], { type: 'audio/wav' }))
				})
				.catch((error) => {
					console.error('Server TTS failed', error)
					return null
				})

			readAloudPrefetchRef.current = { promise, requestId, sentenceIndex }
			return promise
		},
		[readAloudRate, readAloudVoiceUri, sdk],
	)

	const playServerSentence = useCallback(
		async (requestId: number, sentenceIndex: number, sentence: string) => {
			clearPlayingServerAudio()

			try {
				const objectUrl = await requestServerSentenceAudio(requestId, sentenceIndex, sentence)
				if (
					readAloudPrefetchRef.current?.requestId === requestId &&
					readAloudPrefetchRef.current.sentenceIndex === sentenceIndex
				) {
					readAloudPrefetchRef.current = null
				}

				if (readAloudRequestRef.current !== requestId) {
					if (objectUrl) {
						URL.revokeObjectURL(objectUrl)
					}
					return
				}

				if (!objectUrl) {
					setIsReadAloudActive(false)
					setIsReadAloudPaused(false)
					setReadAloudCurrentSentence(null)
					toast.error(t('reader.toasts.failedReadAloud'))
					return
				}

				const nextSentence = readAloudSentenceQueueRef.current[sentenceIndex + 1]
				if (nextSentence) {
					void requestServerSentenceAudio(requestId, sentenceIndex + 1, nextSentence)
				}

				// Keep playbackRate at 1 — speed is already applied server-side via Piper length_scale.
				// Stacking both causes chipmunk/distorted audio.
				readAloudObjectUrlRef.current = objectUrl
				const audio = new Audio(objectUrl)
				readAloudAudioRef.current = audio
				audio.playbackRate = 1

				audio.onended = () => {
					if (readAloudObjectUrlRef.current === objectUrl) {
						URL.revokeObjectURL(objectUrl)
						readAloudObjectUrlRef.current = null
					}
					if (readAloudAudioRef.current === audio) {
						readAloudAudioRef.current = null
					}
					if (readAloudRequestRef.current === requestId) {
						scheduleNextReadAloudSentence(requestId, sentenceIndex + 1)
					}
				}

				audio.onerror = () => {
					if (readAloudObjectUrlRef.current === objectUrl) {
						URL.revokeObjectURL(objectUrl)
						readAloudObjectUrlRef.current = null
					}
					if (readAloudAudioRef.current === audio) {
						readAloudAudioRef.current = null
					}
					if (readAloudRequestRef.current === requestId) {
						setIsReadAloudActive(false)
						setIsReadAloudPaused(false)
						setReadAloudCurrentSentence(null)
						toast.error(t('reader.toasts.failedReadAloud'))
					}
				}

				await audio.play()
			} catch (error) {
				if (readAloudRequestRef.current === requestId) {
					console.error('Server TTS failed', error)
					setIsReadAloudActive(false)
					setIsReadAloudPaused(false)
					setReadAloudCurrentSentence(null)
					toast.error(t('reader.toasts.failedReadAloud'))
				}
			}
		},
		[clearPlayingServerAudio, requestServerSentenceAudio, scheduleNextReadAloudSentence, t],
	)

	const playSentenceQueue = useCallback(
		(requestId: number, sentenceIndex: number) => {
			if (!readAloudSupported || readAloudRequestRef.current !== requestId) {
				return
			}

			const location = currentLocationRef.current

			const sentence = readAloudSentenceQueueRef.current[sentenceIndex]
			if (!sentence) {
				if (rendition && !location?.atEnd) {
					const priorCfi = location?.start.cfi ?? null
					readAloudAutoTurnInProgressRef.current = true
					setIsReadAloudPaused(false)
					setReadAloudCurrentSentence(null)
					readAloudSentenceQueueRef.current = []
					readAloudSentenceIndexRef.current = 0
					persistReadAloudResume({ cfi: null, sentenceIndex: 0 })
					rendition
						.next()
						.then(async () => {
							readAloudAutoTurnInProgressRef.current = false
							if (readAloudRequestRef.current !== requestId) {
								return
							}

							if (readAloudSentenceQueueRef.current.length > 0) {
								return
							}

							const didRelocate =
								(priorCfi && currentLocationRef.current?.start.cfi !== priorCfi) ||
								(!priorCfi && !!currentLocationRef.current?.start.cfi)

							const continued = await speakCurrentLocationRef.current?.({
								suppressToast: true,
								preferSelection: false,
								preferVisibleText: !didRelocate,
							})
							if (!continued && readAloudRequestRef.current === requestId) {
								setIsReadAloudActive(false)
								setIsReadAloudPaused(false)
								setReadAloudCurrentSentence(null)
								persistReadAloudResume({ cfi: null, sentenceIndex: 0 })
							}
						})
						.catch(() => {
							readAloudAutoTurnInProgressRef.current = false
							if (readAloudRequestRef.current === requestId) {
								setIsReadAloudActive(false)
								setIsReadAloudPaused(false)
								setReadAloudCurrentSentence(null)
								toast.error(t('reader.toasts.failedContinueReadAloud'))
							}
						})
					return
				}

				setIsReadAloudActive(false)
				setIsReadAloudPaused(false)
				setReadAloudCurrentSentence(null)
				readAloudSentenceIndexRef.current = 0
				readAloudAutoTurnInProgressRef.current = false
				persistReadAloudResume({ cfi: null, sentenceIndex: 0 })
				return
			}

			readAloudSentenceIndexRef.current = sentenceIndex
			persistReadAloudResume({
				cfi: location?.start.cfi ?? null,
				sentenceIndex,
			})
			setReadAloudCurrentSentence(sentence)

			if (effectiveReadAloudEngine === 'server') {
				void playServerSentence(requestId, sentenceIndex, sentence)
				return
			}

			if (!browserSpeechSupported) {
				setIsReadAloudActive(false)
				setIsReadAloudPaused(false)
				setReadAloudCurrentSentence(null)
				toast.error(t('reader.toasts.readAloudUnsupported'))
				return
			}

			playBrowserSentence(requestId, sentenceIndex, sentence)
		},
		[
			browserSpeechSupported,
			effectiveReadAloudEngine,
			persistReadAloudResume,
			playBrowserSentence,
			playServerSentence,
			readAloudSupported,
			rendition,
			t,
		],
	)

	useEffect(() => {
		playSentenceQueueRef.current = playSentenceQueue
	}, [playSentenceQueue])

	useEffect(() => {
		return () => {
			if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
				window.speechSynthesis.cancel()
			}
			clearSentenceGap()
			clearServerAudio()
		}
	}, [clearSentenceGap, clearServerAudio])

	const speakCurrentLocation = useCallback(
		async (
			opts: {
				suppressToast?: boolean
				preferSelection?: boolean
				preferVisibleText?: boolean
			} = {},
		) => {
			if (!readAloudSupported) {
				if (!opts.suppressToast) {
					toast.error(t('reader.toasts.readAloudUnsupported'))
				}
				return false
			}

			if (effectiveReadAloudEngine === 'browser' && browserSpeechSupported) {
				// Check if TTS voices are available
				const availableVoices = window.speechSynthesis.getVoices()
				if (availableVoices.length === 0) {
					// On Android, getVoices() can be empty even when default TTS still works.
					console.warn(
						'No TTS voices returned by getVoices(); continuing with system default voice fallback.',
					)
				}

				// Log diagnostic info if trying to use a saved voice that's no longer available
				if (readAloudVoiceUri) {
					const savedVoiceExists = availableVoices.some((v) => v.voiceURI === readAloudVoiceUri)
					if (!savedVoiceExists) {
						console.warn(
							`Saved voice URI "${readAloudVoiceUri}" is no longer available. Will use fallback voice. Available: ${availableVoices.map((v) => v.voiceURI).join(', ')}`,
						)
					}
				}
			}

			const preferSelection = opts.preferSelection ?? true
			const preferVisibleText = opts.preferVisibleText ?? false
			const selectedText = preferSelection ? getSelectedVisibleText() : ''

			let sentences: string[] = []
			let startAtSentence = 0

			if (selectedText) {
				// If there's selected text, use that and find it in the full page
				const pageText = extractVisibleText()
				const pageSentences = splitIntoSentences(pageText)
				const selectedSentences = splitIntoSentences(selectedText)
				const normalize = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase()
				const normalizedPageSentences = pageSentences.map(normalize)
				const normalizedSelectedSentences = selectedSentences.map(normalize)

				let matchIdx = -1

				// Prefer matching the full selected sentence sequence against page sentences.
				if (normalizedSelectedSentences.length > 0) {
					matchIdx = normalizedPageSentences.findIndex((candidate, index) => {
						if (!candidate.includes(normalizedSelectedSentences[0])) {
							return false
						}

						for (let offset = 1; offset < normalizedSelectedSentences.length; offset += 1) {
							const pageSentence = normalizedPageSentences[index + offset]
							if (!pageSentence || !pageSentence.includes(normalizedSelectedSentences[offset])) {
								return false
							}
						}

						return true
					})
				}

				// Fallback: map selection text offset to sentence index in normalized page text.
				if (matchIdx < 0 && normalizedPageSentences.length > 0) {
					const normalizedPageText = normalize(pageText)
					const normalizedSelectedText = normalize(selectedText)
					const selectionStart = normalizedPageText.indexOf(normalizedSelectedText)

					if (selectionStart >= 0) {
						let cursor = 0
						for (let index = 0; index < normalizedPageSentences.length; index += 1) {
							const sentenceLength = normalizedPageSentences[index].length
							if (selectionStart >= cursor && selectionStart <= cursor + sentenceLength) {
								matchIdx = index
								break
							}
							cursor += sentenceLength + 1
						}
					}
				}

				if (matchIdx >= 0) {
					sentences = pageSentences
					startAtSentence = matchIdx
				} else if (selectedSentences.length > 0) {
					// Last-resort fallback when selected text cannot be mapped to visible page sentences.
					// Keep reading the visible page so continuation does not jump backwards.
					sentences = pageSentences.length > 0 ? pageSentences : selectedSentences
					startAtSentence = 0
				}
			} else if (preferVisibleText) {
				const visibleText = extractVisibleText()
				sentences = splitIntoSentences(visibleText)
				startAtSentence = 0
			} else {
				// No selection: extract text starting from current visible location (CFI)
				// This naturally begins at the first character on screen, not the page beginning
				const locationText = await extractTextFromCurrentLocation()
				sentences = splitIntoSentences(locationText)

				// Some engines return a very short CFI range (often a single sentence).
				// Fallback to visible-page text to avoid page-hopping after one sentence.
				if (sentences.length <= 1) {
					const visibleSentences = splitIntoSentences(extractVisibleText())
					if (visibleSentences.length > sentences.length) {
						sentences = visibleSentences
					}
				}
				startAtSentence = 0
			}

			if (sentences.length === 0) {
				setIsReadAloudActive(false)
				setIsReadAloudPaused(false)
				setReadAloudCurrentSentence(null)
				if (!opts.suppressToast) {
					toast.error(t('reader.toasts.noReadableText'))
				}
				return false
			}

			if (browserSpeechSupported) {
				window.speechSynthesis.cancel()
			}
			clearSentenceGap()
			clearServerAudio()
			setIsReadAloudActive(true)
			setIsReadAloudPaused(false)

			const requestId = readAloudRequestRef.current + 1
			readAloudRequestRef.current = requestId
			readAloudSentenceQueueRef.current = sentences
			readAloudSentenceIndexRef.current = startAtSentence

			playSentenceQueue(requestId, startAtSentence)
			return true
		},
		[
			browserSpeechSupported,
			clearSentenceGap,
			clearServerAudio,
			effectiveReadAloudEngine,
			extractTextFromCurrentLocation,
			extractVisibleText,
			getSelectedVisibleText,
			playSentenceQueue,
			readAloudSupported,
			readAloudVoiceUri,
			t,
		],
	)

	useEffect(() => {
		speakCurrentLocationRef.current = speakCurrentLocation
	}, [speakCurrentLocation])

	const onToggleReadAloud = useCallback(() => {
		if (isReadAloudActive) {
			stopReadAloud()
			return
		}

		speakCurrentLocation({ preferSelection: true })
	}, [isReadAloudActive, speakCurrentLocation, stopReadAloud])

	const onPauseReadAloud = useCallback(() => {
		if (!readAloudSupported || !isReadAloudActive || isReadAloudPaused) {
			return
		}

		clearSentenceGapTimer()
		if (effectiveReadAloudEngine === 'server') {
			readAloudAudioRef.current?.pause()
		} else if (browserSpeechSupported) {
			window.speechSynthesis.pause()
		}
		setIsReadAloudPaused(true)
	}, [
		browserSpeechSupported,
		clearSentenceGapTimer,
		effectiveReadAloudEngine,
		isReadAloudActive,
		isReadAloudPaused,
		readAloudSupported,
	])

	const onResumeReadAloud = useCallback(() => {
		if (!readAloudSupported || !isReadAloudActive || !isReadAloudPaused) {
			return
		}

		const pendingGap = readAloudSentenceGapPendingRef.current
		if (pendingGap && pendingGap.requestId === readAloudRequestRef.current) {
			readAloudSentenceGapPendingRef.current = null
			setIsReadAloudPaused(false)
			playSentenceQueueRef.current?.(pendingGap.requestId, pendingGap.nextIndex)
			return
		}

		if (effectiveReadAloudEngine === 'server') {
			void readAloudAudioRef.current?.play().catch(() => {
				toast.error(t('reader.toasts.failedResumeReadAloud'))
			})
		} else if (browserSpeechSupported) {
			window.speechSynthesis.resume()
		}
		setIsReadAloudPaused(false)
	}, [
		browserSpeechSupported,
		effectiveReadAloudEngine,
		isReadAloudActive,
		isReadAloudPaused,
		readAloudSupported,
		t,
	])

	const onSetReadAloudEngine = useCallback(
		(engine: ReadAloudEngine) => {
			if (engine === 'server' && !readAloudServerAvailable) {
				return
			}

			stopReadAloud()
			setReadAloudPreferences((prev) => ({
				...prev,
				engine,
				// Voices are not shared between engines.
				voiceUri: null,
			}))
		},
		[readAloudServerAvailable, stopReadAloud],
	)

	const onSetReadAloudRate = useCallback((rate: number) => {
		const clamped = Math.min(10, Math.max(0.1, Math.round(rate * 10) / 10))
		setReadAloudPreferences((prev) => ({
			...prev,
			rate: clamped,
		}))
	}, [])

	const onSetReadAloudPitch = useCallback((pitch: number) => {
		const clamped = Math.min(2, Math.max(0, Math.round(pitch * 10) / 10))
		setReadAloudPreferences((prev) => ({
			...prev,
			pitch: clamped,
		}))
	}, [])

	const onSetReadAloudVoiceUri = useCallback((voiceUri: string | null) => {
		setReadAloudPreferences((prev) => ({
			...prev,
			voiceUri,
		}))
	}, [])

	useEffect(() => {
		if (!isReadAloudActive) {
			return
		}

		readAloudSentenceIndexRef.current = 0
		persistReadAloudResume({ cfi: currentLocation?.start.cfi ?? null, sentenceIndex: 0 })
	}, [currentLocation?.start.cfi, isReadAloudActive, persistReadAloudResume])

	const { mutate } = useGraphQLMutation(mutation, {
		onSuccess: () => {
			lastSyncedElapsedRef.current = timer.getCurrentTime()
			client.invalidateQueries({
				queryKey: ['epubJsReader', id],
			})
		},
	})

	const updateProgress = useCallback(
		(input: EpubProgressInput) => {
			if (isIncognito) return

			const totalSeconds = timer.getCurrentTime()
			const delta = Math.max(0, totalSeconds - lastSyncedElapsedRef.current)

			mutate({
				id: ebook.media?.id || '',
				input: {
					epub: {
						...input,
						elapsedSecondsDelta: delta > 0 ? delta : undefined,
					},
				},
			})
		},
		[mutate, ebook, isIncognito, timer],
	)

	const existingBookmarks = useMemo(
		() =>
			(ebook?.bookmarks ?? []).reduce(
				(acc: Record<string, Bookmark>, bookmark: Bookmark) => {
					if (!bookmark.epubcfi) {
						return acc
					} else {
						acc[bookmark.epubcfi] = bookmark
						return acc
					}
				},
				{} as Record<string, Bookmark>,
			),

		[ebook],
	)

	//* Note: some books have entries in the spine for each href, some don't. It seems
	//* mostly just a matter of if the epub is good.
	const { chapter, chapterName, sectionIndex } = useMemo(() => {
		let name: string | undefined
		const currentHref = currentLocation?.start.href

		const spineItem = book?.spine.get(currentHref)
		const sectionIndex = spineItem?.index

		const position = book?.navigation?.toc?.findIndex(
			(toc) => toc.href === currentHref || (!!currentHref && toc.href.startsWith(currentHref)),
		)

		if (position !== undefined && position !== -1) {
			name = book?.navigation.toc[position]?.label.trim()
		}

		return { chapter: position, chapterName: name, sectionIndex: sectionIndex }
	}, [book, currentLocation])

	const computeNaiveProgress = useCallback(
		({ start }: EpubLocationState) => {
			let percentage: number | null = null

			const spineSize = ebook.spine.length
			if (spineSize) {
				const currentChapterPage = start.displayed.page
				const pagesInChapter = start.displayed.total

				const chapterCount = spineSize //* not a great assumption
				//* The percentage of the book that has been read based on spine position.
				//* We treat this as: (current_spine_index + page_progress_in_spine) / total_spine_items
				const spineProgress = start.index / chapterCount
				const totalChapterPercentage = spineProgress
				//* The percentage of the current chapter that has been read based on the page number.
				//* E.g. if you are on page 2 of 20 in the current chapter, this will be 0.1.
				const chapterPercentage = currentChapterPage / pagesInChapter
				//* The percentage of the book that has been read based on the current page, assuming
				//* that each chapter is the same length. This is obviously not ideal, but epubjs is
				//* terrible and doesn't provide a better way to do this.
				const naiveAdjustment = chapterPercentage * (1 / chapterCount)

				const naiveTotal = totalChapterPercentage + naiveAdjustment
				percentage = naiveTotal
			}

			return percentage
		},
		[ebook.spine],
	)

	const computeProgress = useCallback(
		async (location: EpubLocationState) => {
			let percentageCompleted = book?.locations?.percentageFromCfi(location.start.cfi) ?? null
			if (percentageCompleted == null) {
				// Attempt to reload the locations
				await book?.locations?.generate(1000)
				percentageCompleted = book?.locations?.percentageFromCfi(location.start.cfi) ?? null
			}

			if (percentageCompleted == null) {
				console.warn('No CFI percentage available, falling back to spine-based calculation')
				percentageCompleted = computeNaiveProgress(location)
			}

			if (percentageCompleted == null) {
				percentageCompleted = computeNaiveProgress(location)
			}

			// epubjs's percentageFromCfi uses start.cfi; on the final page this still
			// returns <1.0 (e.g. ~0.98) even when the reader has seen everything. Clamp
			// to 1.0 when epubjs signals atEnd so completion is persisted correctly.
			if (location.atEnd) {
				percentageCompleted = 1.0
			}

			if (percentageCompleted == null) {
				console.warn('Failed to compute any percentage-based progress')
				return
			}

			updateProgress({
				locator: {
					epubcfi: location.start.cfi,
				},
				percentage: percentageCompleted,
				isComplete: percentageCompleted >= 1.0,
			})
		},
		[book, computeNaiveProgress, updateProgress],
	)

	/**
	 * Syncs the current location with local state whenever epubjs internal location
	 * changes. It will also try and determine the current chapter information.
	 *
	 * @param changeState The new location state of the epub
	 */
	const handleLocationChange = useCallback(
		(changeState: EpubLocationState) => {
			const start = changeState.start
			//* NOTE: this shouldn't happen, but the types are so unreliable that I am
			//* adding this extra check as a precaution.
			if (!start) {
				return
			}
			currentLocationRef.current = changeState
			readAloudCurrentCfiRef.current = start.cfi
			setCurrentLocation(changeState)
			computeProgress(changeState)

			if (isReadAloudActive && !readAloudAutoTurnInProgressRef.current) {
				speakCurrentLocation({
					suppressToast: true,
					preferSelection: false,
				})
			}
		},
		[computeProgress, isReadAloudActive, speakCurrentLocation],
	)

	/**
	 * This effect is responsible for initializing the epubjs book, which gets stored in
	 * this component's state. It will only run once when media entity is fetched from the
	 * Stump server.
	 *
	 * Note: epubjs uses the download endpoint from the Stump server to locally load the
	 * epub file. This is why the requestCredentials option is set to true, as it would
	 * otherwise not be able to authenticate with the server.
	 */
	useEffect(() => {
		if (!book && ebook && ebook.media) {
			setBook(
				new Book(sdk.media.downloadURL(id), {
					openAs: 'epub',
					// @ts-expect-error: epubjs has incorrect types
					requestCredentials: true,
				}),
			)
		}
	}, [book, ebook, id, sdk])

	/**
	 *	A function for applying the initial epub reader preferences to the epubjs rendition instance
	 *
	 * @param rendition: The epubjs rendition instance
	 * @param preferences The epub reader preferences
	 */
	const applyEpubPreferences = useCallback(
		(rendition: Rendition, lang: string, pageFlipDirection: string) => {
			// ja should be ltr no matter what because text is always written "forwards"
			const isJaWithPageFlipRtl =
				(lang === 'ja' || lang === 'zh-TW' || lang === 'zh-HK') && pageFlipDirection === 'rtl'
			if (isJaWithPageFlipRtl) {
				rendition.hooks.content.register(function (contents: Contents) {
					const textDirection = contents.window.getComputedStyle(contents.documentElement).direction
					if (textDirection === 'rtl') {
						contents.addStylesheetRules(
							{
								'p, div, span, h1, h2, h3, h4, h5, h6, blockquote': {
									direction: 'ltr !important',
								},
							},
							'ja-ltr',
						)
					}
				})
			}

			if (isDarkVariant) {
				rendition.themes.register('dark-variant', darkVariantText)
				rendition.themes.select('dark-variant')
			} else {
				rendition.themes.register('light-variant', {})
				rendition.themes.select('light-variant')
			}
		},
		[isDarkVariant],
	)

	/**	A function for applying updates to the the epub reader preferences to the epubjs rendition instance */
	const updateEpubPreferences = useCallback(
		(rendition: Rendition, fontSize?: number, lineHeight?: number, fontFamily?: string) => {
			const newStylesheetRules = {
				'a, blockquote, body, h1, h2, h3, h4, h5, p, span, ul': {
					'font-size': `${fontSize}px !important`,
					'line-height': `${lineHeight} !important`,
					'font-family': `${toFamilyName(fontFamily as SupportedFont)} !important`,
				},
				img: { 'max-width': '100% !important', height: 'auto !important' },
				'p[align="center"], div[align="center"]': {
					'text-align': 'center !important',
				},
				'p[align="center"] > img, div[align="center"] > img': {
					display: 'block',
					'margin-left': 'auto !important',
					'margin-right': 'auto !important',
				},
			}

			const contents = rendition.getContents()
			// Only applies temporarily for the current section
			// @ts-expect-error: epubjs is a silly bean
			contents.forEach((content: Contents) => {
				content.addStylesheetRules(newStylesheetRules, 'font-stylesheet-rules')
			})
			// Only applies once section changes
			rendition.hooks.content.register(function (contents: Contents) {
				contents.addStylesheetRules(newStylesheetRules, 'font-stylesheet-rules')
			})
		},
		[],
	)

	const generateLocations = useCallback(
		async (book: Book) => {
			try {
				const locations = await book.locations.generate(1000)
				saveCachedLocations(ebook.mediaId, locations)
			} catch (error) {
				console.error('Failed to generate locations for epub', { error })
			} finally {
				setIsInitialLoading(false)
			}
		},
		[ebook.mediaId],
	)

	const didRenderToScreen = useRef(false)
	/**
	 * This effect is responsible for rendering the epub to the screen. It will only run once
	 * when the book is has been loaded. It will also set the initial location and theme
	 * for the rendition.
	 */
	useEffect(() => {
		if (!book || !ref.current) return

		book.ready.then(async () => {
			if (book.spine && !didRenderToScreen.current) {
				didRenderToScreen.current = true
				const defaultLoc = book.rendition?.location?.start?.cfi

				const boundingClient = ref.current?.getBoundingClientRect()
				const height = boundingClient?.height ? boundingClient.height - 2 : '100%'
				const width = boundingClient?.width ?? '100%'

				const cachedLocations = loadCachedLocations(ebook.mediaId)
				if (cachedLocations) {
					book.locations.load(JSON.stringify(cachedLocations))
					setIsInitialLoading(false)
					// We still want to re-generate in-case the cache is bad, but we don't
					// need to block the UI
					generateLocations(book)
				} else {
					await generateLocations(book)
				}

				const rendition_ = book.renderTo(ref.current!, {
					width: width,
					height: height,
					// enable the following line to allow rendition?.on('keydown', handleKeyDown) to work for Safari
					// allowScriptedContent: true,
				})

				rendition_.hooks.content.register(() => {
					injectFontStylesheet(rendition_)
				})

				//? TODO: I guess here I would need to wait for and load in custom theme blobs...
				//* Color manipulation reference: https://github.com/futurepress/epub.js/issues/1019
				rendition_.themes.register('dark-variant', darkVariantText)
				rendition_.themes.register('light-variant', {})

				rendition_.on('relocated', handleLocationChange)

				const lang = book?.packaging?.metadata?.language
				// @ts-expect-error: PackagingMetadataObject does have property 'direction'
				const pageFlipDirection = book?.packaging?.metadata?.direction
				applyEpubPreferences(rendition_, lang, pageFlipDirection)

				setRendition(rendition_)

				const targetCfi = ebook.media?.readProgress?.epubcfi
				if (targetCfi && !isIncognito) {
					rendition_.display(targetCfi)
				} else if (defaultLoc) {
					rendition_.display(defaultLoc)
				} else {
					rendition_.display()
				}

				createSectionLengths(book, setSectionLengths)
			}
		})
	}, [
		book,
		applyEpubPreferences,
		readingMode,
		handleLocationChange,
		isIncognito,
		ebook,
		generateLocations,
	])

	/** This effect handles page turning via keyboard keys */
	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			const isLtr = readingDirection === ReadingDirection.Ltr

			const nextKey = isLtr ? 'ArrowRight' : 'ArrowLeft'
			const prevKey = isLtr ? 'ArrowLeft' : 'ArrowRight'

			if (event.key === nextKey) {
				rendition?.next()
			} else if (event.key === prevKey) {
				rendition?.prev()
			}
		}
		window.addEventListener('keydown', handleKeyDown, { capture: true })
		rendition?.on('keydown', handleKeyDown)
		return () => {
			window.removeEventListener('keydown', handleKeyDown, { capture: true })
			rendition?.off('keydown', handleKeyDown)
		}
	}, [rendition, readingDirection])

	// I'm hopeful this solves: https://github.com/stumpapp/stump/issues/726
	// Honestly though epub.js is such a migraine that I'm OK just waiting until
	// I have the time to migrate off of it
	useEffect(() => {
		return () => {
			stopReadAloud()
			rendition?.destroy()
		}
	}, [rendition, stopReadAloud])

	// TODO: this needs to have fullscreen as an effect dependency
	/**
	 * This effect is responsible for resizing the epubjs rendition instance whenever the
	 * div it attaches to is resized.
	 *
	 * Resizing here typically happens, outside user-initiated
	 * events like window resizing, when the fullscreen state changes.
	 */
	useEffect(() => {
		const resizeObserver = new ResizeObserver((entries) => {
			for (const entry of entries) {
				const { width, height } = entry.contentRect
				rendition?.resize(width, height)
			}
		})

		if (ref.current) {
			resizeObserver.observe(ref.current)
		}

		return () => {
			resizeObserver.disconnect()
		}
	}, [rendition])

	/**
	 * This effect is responsible for updating the epub theme options whenever the epub
	 * preferences change. It will only run when the epub preferences change and the
	 * rendition instance is set.
	 */
	useEffect(() => {
		if (!rendition) return
		updateEpubPreferences(rendition, fontSize, lineHeight, fontFamily)
	}, [rendition, fontSize, fontFamily, lineHeight, updateEpubPreferences])

	/* This effect updates the reading mode. This is separated because it causes flashing */
	useEffect(() => {
		if (!rendition) return
		const flowStyle = readingMode === ReadingMode.ContinuousVertical ? 'scrolled' : 'paginated'
		rendition.flow(flowStyle)
	}, [rendition, readingMode])

	/**
	 * Invalidate the book query when a reader is unmounted so that the book overview
	 * is updated with the latest read progress
	 */
	useEffect(() => {
		return () => {
			Promise.all([
				queryClient.invalidateQueries({ queryKey: ['bookOverview', id], exact: false }),
				queryClient.invalidateQueries({ queryKey: ['keepReading'], exact: false }),
			])
		}
	}, [id])

	/**
	 * A callback for when the reader should paginate forward. This will only run if the
	 * rendition instance is set.
	 */
	const onPaginateForward = useCallback(async () => {
		if (rendition) {
			try {
				await rendition.next()
			} catch (err) {
				console.error(err)
				toast.error(t('common.unknownError'))
			}
		}
	}, [rendition, t])

	/**
	 * A callback for when the reader should paginate backward. This will only run if the
	 * rendition instance is set.
	 */
	const onPaginateBackward = useCallback(async () => {
		if (rendition) {
			try {
				await rendition.prev()
			} catch (err) {
				console.error(err)
				toast.error(t('reader.toasts.somethingWentWrong'))
			}
		}
	}, [rendition, t])

	/**
	 * A callback for when the user wants to navigate to a specific cfi. This will only run
	 * if the rendition instance is set.
	 *
	 * @param cfi The cfi to navigate to
	 */
	const onGoToCfi = useCallback(
		async (cfi: string) => {
			if (!rendition) {
				return
			}

			try {
				await rendition.display(cfi)
			} catch (err) {
				console.error(err)
				toast.error(t('reader.toasts.failedNavigateEpub'))
			}
		},
		[rendition, t],
	)

	// jump to a specific section
	const jumpToSection = useCallback(
		async (section: number) => {
			onJumpToSection(section, book, rendition, ref, onGoToCfi)
		},
		[book, rendition, onGoToCfi],
	)

	/**
	 * A callback for when the user clicks on a link embedded in the epub. This will only run
	 * if the rendition instance is set.
	 */
	const onLinkClick = useCallback(
		async (href: string) => {
			if (!book || !rendition) {
				return
			}

			const failureMessage = t('reader.toasts.failedNavigateEpub')
			const targets = getHrefDisplayTargets(href, ebook.rootBase)
			let displayError: unknown

			for (const target of targets) {
				try {
					await rendition.display(target)
					return
				} catch (err) {
					displayError = err
				}
			}

			const adjustedTargets = targets.map((target) => splitHrefFragment(target).path)
			const adjustedTargetSet = new Set(adjustedTargets)

			let spineItem = adjustedTargets.map((target) => book.spine.get(target)).find(Boolean)
			if (!spineItem) {
				// @ts-expect-error: epubjs has incorrect types
				const matches = book.spine.items
					.filter((item: Record<string, unknown>) => {
						const itemTargets = [item.href, item.url, item.canonical]
							.filter((value): value is string => typeof value === 'string')
							.flatMap((value) => {
								const normalized = normalizeEpubPath(value).replace(/^\/+/, '')
								const base = normalized.includes('/')
									? normalized.slice(normalized.lastIndexOf('/') + 1)
									: normalized
								return [normalized, `/${normalized}`, base]
							})

						return itemTargets.some((target) => adjustedTargetSet.has(target))
					})
					.map((item: Record<string, unknown>) => book.spine.get(item.index as number))
					.filter(Boolean)

				if (matches.length > 0) {
					spineItem = matches[0]
				} else {
					console.error('Could not find spine item for href', href, { targets })
					toast.error(failureMessage)
					return
				}
			}

			if (!spineItem) {
				console.error('Could not find spine item for href', href)
				toast.error(failureMessage)
				return
			}

			try {
				await rendition.display(spineItem.href)
			} catch (err) {
				console.error('Could not display href', href, { err, displayError })
				toast.error(failureMessage)
			}
		},
		[book, rendition, ebook.rootBase, t],
	)

	/**
	 * A callback for attempting to extract preview text from a given cfi. This is used for bookmarks,
	 * to provide a preview of the bookmarked start location
	 */
	const getCfiPreviewText = useCallback(
		async (cfi: string) => {
			if (!book) return null

			const range = await book.getRange(cfi)
			if (!range) return null

			return range.commonAncestorContainer?.textContent ?? null
		},
		[book],
	)

	/**
	 * A callback for searching the entire book for a given query. This will only run if the book
	 * and spine are available.
	 *
	 * Note: This is a relatively expensive operation, since it requires loading each spine item
	 * and then unloading it after the search is complete. This makes sense, since this reader is
	 * completely client-side, but should be noted
	 */
	const searchEntireBook = useCallback(
		async (query: string) => {
			if (!book || !book.spine || !book.spine.each) return []

			const promises: Array<Promise<SpineItemFindResult[]>> = []

			book.spine.each((item?: SpineItem) => {
				if (!item) return []

				promises.push(
					item
						// @ts-expect-error: I literally can't stand epubjs lol
						.load(book.load.bind(book))
						.then(() => item.find(query))
						.then((res) => uniqby(res, 'excerpt'))
						.finally(() => item.unload.bind(item)),
				)
			})

			return await Promise.all(promises).then((results) =>
				results
					.map((res, idx) => ({
						results: res,
						spineIndex: idx,
					}))
					.filter(({ results }) => results.length > 0),
			)
		},
		[book],
	)

	// TODO: figure this out! Basically, I would (ideally) like to be able to determine if a bookmark
	// 'exists' within another. This can happen when you move between viewport sizes..
	// const cfiWithinAnother = useCallback(
	// 	async (cfi: string, otherCfi: string) => {
	// 		if (!book) return false

	// 		const range = await book.getRange(cfi)
	// 		const otherRange = await book.getRange(otherCfi)

	// 		if (!range || !otherRange) return false

	// 		console.log({ otherRange, range })

	// 		const firstStartNode = range.startContainer
	// 		const firstEndNode = range.endContainer

	// 		range.commonAncestorContainer

	// 		// const firstIsInOther = range.isPointInRange(otherRange.startContainer, otherRange.startOffset)
	// 		// const otherIsInFirst = otherRange.isPointInRange(range.startContainer, range.startOffset)

	// 		// return firstIsInOther || otherIsInFirst

	// 		book.locations.generate(10000)

	// 		const first = new EpubCFI(cfi)
	// 		const second = new EpubCFI(otherCfi)

	// 		console.log({ compare: first.compare(cfi, otherCfi) })
	// 		console.log({ first, second })

	// 		const location1 = book.locations.locationFromCfi(cfi)
	// 		const location2 = book.locations.locationFromCfi(otherCfi)

	// 		console.log({ location1, location2 })
	// 	},
	// 	[book, rendition],
	// )

	// cfiWithinAnother(
	// 	'epubcfi(/6/12!/4[3Q280-a9efbf2f573d4345819e3829f80e5dbc]/2[prologue]/2/2/2/4/2[calibre_pb_0]/1:0)',
	// 	'epubcfi(/6/12!/4[3Q280-a9efbf2f573d4345819e3829f80e5dbc]/2[prologue]/4[prologue-text]/8/1:56)',
	// ).then((res) => console.log('cfiWithinAnother', res))

	if (!ebook || !ebook.media) {
		return null
	}

	const toc = parseToc(ebook.toc)

	return (
		<EpubReaderContainer
			readerMeta={{
				bookEntity: ebook.media,
				bookMeta: {
					bookmarks: existingBookmarks,
					chapter: {
						cfiRange: [currentLocation?.start.cfi, currentLocation?.end.cfi],
						currentPage: [
							currentLocation?.start.displayed.page,
							currentLocation?.end.displayed.page,
						],
						name: chapterName,
						sectionSpineIndex: sectionIndex,
						position: chapter,
						totalPages: currentLocation?.start.displayed.total,
					},
					toc: toc,
					sectionLengths: sectionsLengths?.lengths ?? {},
				},
				progress: ebook.media.readProgress?.percentageCompleted || null,
			}}
			controls={{
				getCfiPreviewText,
				isReadAloudActive,
				isReadAloudPaused,
				onGoToCfi,
				onLinkClick,
				onPauseReadAloud,
				onResumeReadAloud,
				onSetReadAloudEngine,
				onSetReadAloudPitch,
				onSetReadAloudRate,
				onSetReadAloudVoiceUri,
				onToggleReadAloud,
				onPaginateBackward,
				onPaginateForward,
				jumpToSection,
				readAloudCurrentSentence,
				readAloudEngine: effectiveReadAloudEngine,
				readAloudPitch,
				readAloudServerAvailable,
				readAloudSupported,
				readAloudRate,
				readAloudVoiceUri,
				readAloudVoices,
				searchEntireBook,
			}}
		>
			<div className="relative h-full w-full">
				{isReadAloudActive && readAloudCurrentSentence && (
					<div className="top-4 px-4 py-2 shadow-lg backdrop-blur-md border-edge-subtle/80 pointer-events-none absolute left-1/2 z-50 w-[min(48rem,calc(100%-2rem))] -translate-x-1/2 rounded-2xl border bg-background/95">
						<div className="text-sm leading-relaxed font-medium text-center text-foreground">
							{isReadAloudPaused ? 'Paused: ' : ''}
							{readAloudCurrentSentence}
						</div>
					</div>
				)}

				<AutoSizer>
					{({ height, width }) => {
						return <div ref={ref} key={ebook.media.id} style={{ height, width }} />
					}}
				</AutoSizer>

				{(isInitialLoading || !rendition) && (
					<div className="inset-0 absolute z-50 flex items-center justify-center bg-background">
						<ProgressSpinner size="lg" />
					</div>
				)}
			</div>
		</EpubReaderContainer>
	)
}

function parseToc(toc: EpubJsReaderQuery['epubById']['toc']): EpubContent[] {
	if (!toc) return []

	// epub toc is an array of json strings of EpubContent, so we need to parse them
	const parsedToc = toc
		.map((item) => {
			try {
				return JSON.parse(item) as EpubContent
			} catch (e) {
				console.error('Failed to parse toc item', item, e)
				return null
			}
		})
		.filter((item) => item !== null) as EpubContent[]

	return parsedToc
}

async function createSectionLengths(
	book: Book,
	setSectionLengths: (sections: SectionLengths) => void,
) {
	const sections = new SectionLengths()

	function getTextLength(node: Node): number {
		if (!node) return 0

		let length = 0

		if (node.nodeType === Node.TEXT_NODE) {
			// If it's a text node, add its length to the total.
			length += (node as Text).length
		} else if (node.hasChildNodes()) {
			// Otherwise, recursively sum up the lengths of all child nodes.
			for (const childNode of node.childNodes.values()) {
				length += getTextLength(childNode)
			}
		}

		return length
	}

	if (!book || !book.spine || !book.spine.each) return sections

	// TODO: remove this in favor of a more efficient method where we don't have to load the entire book
	const promises: Promise<number[] | void>[] = []
	book.spine.each((item?: SpineItem) => {
		if (!item) return []

		promises.push(
			item
				// @ts-expect-error: I literally can't stand epubjs lol
				.load(book.load.bind(book))
				.then(() => [item.index, getTextLength(item.document?.body)])
				.catch(() => console.error('could not load section'))
				.finally(() => item.unload.bind(item)),
		)
	})

	const results = await Promise.all(promises)
	results.forEach((res) => {
		if (!res || res.length < 2) return
		const sectionIndex = res[0] ?? 0
		const length = res[1] ?? 0
		sections.lengths[sectionIndex] = length
	})

	setSectionLengths(sections)
}

async function onJumpToSection(
	section: number,
	book: Book | null,
	rendition: Rendition | null,
	ref: React.RefObject<HTMLDivElement | null> | undefined,
	onGoToCfi: (cfi: string) => void,
) {
	if (!book || !rendition || !ref || !ref.current || section < 0) return

	let maxIndex = -1
	book?.spine.each((item?: SpineItem) => {
		if (!item) return []
		maxIndex = Math.max(maxIndex, item.index)
	})

	if (section > maxIndex) {
		return
	}

	const spineItem = book?.spine.get(section)
	const sectionHref = spineItem?.href

	if (!sectionHref) {
		return
	}

	// Load the section
	onGoToCfi(spineItem.href)
}

interface SpineItem {
	load: (book: Book) => Promise<object>
	unload: (item: SpineItem) => void
	find: (query: string) => Promise<SpineItemFindResult[]>
	index: number
	document: Document
}

interface SpineItemFindResult {
	cfi: string
	excerpt: string
}
