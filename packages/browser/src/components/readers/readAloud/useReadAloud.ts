import { useSDK } from '@stump/client'
import { UserPermission } from '@stump/graphql'
import { useLocaleContext } from '@stump/i18n'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { useAppContext } from '@/context'

export type ReadAloudEngine = 'browser' | 'server'

export type ReadAloudVoiceOption = { label: string; value: string }

export type ReadAloudPreferences = {
	engine: ReadAloudEngine
	rate: number
	pitch: number
	voiceUri: string | null
}

/** Shared with the EPUB reader, so both readers speak with the same voice and speed */
const READ_ALOUD_PREFS_KEY = 'stump:epubjs-read-aloud-preferences'
const SENTENCE_GAP_MS = 400

const DEFAULT_PREFERENCES: ReadAloudPreferences = {
	engine: 'browser',
	rate: 1,
	pitch: 1,
	voiceUri: null,
}

function loadPreferences(): ReadAloudPreferences {
	try {
		const raw = window.localStorage.getItem(READ_ALOUD_PREFS_KEY)
		if (!raw) return DEFAULT_PREFERENCES
		const parsed = JSON.parse(raw) as Partial<ReadAloudPreferences>
		return {
			engine: parsed.engine === 'server' ? 'server' : 'browser',
			rate: typeof parsed.rate === 'number' ? parsed.rate : DEFAULT_PREFERENCES.rate,
			pitch: typeof parsed.pitch === 'number' ? parsed.pitch : DEFAULT_PREFERENCES.pitch,
			voiceUri: typeof parsed.voiceUri === 'string' ? parsed.voiceUri : null,
		}
	} catch {
		return DEFAULT_PREFERENCES
	}
}

type Options = {
	/**
	 * Called when the last sentence of the queue has been spoken. Read aloud stays active,
	 * so the caller can `play` the next part (e.g. the next page) or `stop`.
	 */
	onQueueEnd?: () => void
}

/**
 * Speaks a queue of sentences one after the other, with the browser's speech synthesis
 * or the server's voices (Piper, Supertonic), and the same preferences as the EPUB reader.
 */
export function useReadAloud({ onQueueEnd }: Options = {}) {
	const { t } = useLocaleContext()
	const { sdk } = useSDK()
	const { checkPermission } = useAppContext()
	const canUseServerTts = checkPermission(UserPermission.AccessServerTts)

	const [preferences, setPreferences] = useState<ReadAloudPreferences>(loadPreferences)
	const [browserVoices, setBrowserVoices] = useState<ReadAloudVoiceOption[]>([])
	const [serverVoices, setServerVoices] = useState<ReadAloudVoiceOption[]>([])
	const [serverAvailable, setServerAvailable] = useState(false)

	const [isActive, setIsActive] = useState(false)
	const [isPaused, setIsPaused] = useState(false)
	/** Index of the sentence being spoken in the current queue */
	const [currentIndex, setCurrentIndex] = useState<number | null>(null)

	const browserSupported = typeof window !== 'undefined' && 'speechSynthesis' in window
	const engine: ReadAloudEngine =
		preferences.engine === 'server' && serverAvailable ? 'server' : 'browser'
	const supported = browserSupported || (serverAvailable && typeof Audio !== 'undefined')

	const requestRef = useRef(0)
	const queueRef = useRef<string[]>([])
	const audioRef = useRef<HTMLAudioElement | null>(null)
	const audioUrlRef = useRef<string | null>(null)
	const prefetchRef = useRef<{
		requestId: number
		index: number
		promise: Promise<string | null>
	} | null>(null)
	const gapTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	const pendingIndexRef = useRef<number | null>(null)
	// the latest values, for callbacks that outlive a render (speech and audio events)
	const preferencesRef = useRef(preferences)
	const engineRef = useRef(engine)
	const onQueueEndRef = useRef(onQueueEnd)
	const playIndexRef = useRef<(requestId: number, index: number) => void>(() => {})

	useEffect(() => {
		preferencesRef.current = preferences
		engineRef.current = engine
		onQueueEndRef.current = onQueueEnd
	}, [preferences, engine, onQueueEnd])

	useEffect(() => {
		try {
			window.localStorage.setItem(READ_ALOUD_PREFS_KEY, JSON.stringify(preferences))
		} catch {
			// preferences are a convenience
		}
	}, [preferences])

	useEffect(() => {
		if (!browserSupported) return
		const updateVoices = () =>
			setBrowserVoices(
				window.speechSynthesis
					.getVoices()
					.map((voice) => ({ label: `${voice.name} (${voice.lang})`, value: voice.voiceURI }))
					.sort((a, b) => a.label.localeCompare(b.label)),
			)
		updateVoices()
		window.speechSynthesis.addEventListener('voiceschanged', updateVoices)
		return () => window.speechSynthesis.removeEventListener('voiceschanged', updateVoices)
	}, [browserSupported])

	useEffect(() => {
		const fallBackToBrowser = () => {
			setServerAvailable(false)
			setServerVoices([])
			setPreferences((prev) => (prev.engine === 'server' ? { ...prev, engine: 'browser' } : prev))
		}
		if (!canUseServerTts) {
			fallBackToBrowser()
			return
		}

		let cancelled = false
		sdk.tts
			.status()
			.then((status) => {
				if (cancelled) return
				const available = status.enabled && status.voices.length > 0
				if (!available) {
					fallBackToBrowser()
					return
				}
				setServerAvailable(true)
				setServerVoices(status.voices.map((voice) => ({ label: voice.label, value: voice.id })))
				setPreferences((prev) =>
					prev.engine === 'server' && !prev.voiceUri && status.defaultVoice
						? { ...prev, voiceUri: status.defaultVoice }
						: prev,
				)
			})
			.catch(() => {
				if (!cancelled) fallBackToBrowser()
			})
		return () => {
			cancelled = true
		}
	}, [canUseServerTts, sdk])

	const clearPlayingAudio = useCallback(() => {
		if (audioRef.current) {
			audioRef.current.onended = null
			audioRef.current.onerror = null
			audioRef.current.pause()
			audioRef.current.src = ''
			audioRef.current = null
		}
		if (audioUrlRef.current) {
			URL.revokeObjectURL(audioUrlRef.current)
			audioUrlRef.current = null
		}
	}, [])

	const clearPrefetchedAudio = useCallback(() => {
		const entry = prefetchRef.current
		prefetchRef.current = null
		void entry?.promise.then((url) => url && URL.revokeObjectURL(url))
	}, [])

	const clearGap = useCallback(() => {
		if (gapTimeoutRef.current !== null) {
			clearTimeout(gapTimeoutRef.current)
			gapTimeoutRef.current = null
		}
		pendingIndexRef.current = null
	}, [])

	/** Silences everything and invalidates the callbacks of what was playing */
	const halt = useCallback(() => {
		requestRef.current += 1
		if (browserSupported) window.speechSynthesis.cancel()
		clearPlayingAudio()
		clearPrefetchedAudio()
		clearGap()
	}, [browserSupported, clearGap, clearPlayingAudio, clearPrefetchedAudio])

	const fail = useCallback(
		(requestId: number, message = t('reader.toasts.failedReadAloud')) => {
			if (requestRef.current !== requestId) return
			halt()
			setIsActive(false)
			setIsPaused(false)
			setCurrentIndex(null)
			toast.error(message)
		},
		[halt, t],
	)

	const scheduleNext = useCallback((requestId: number, nextIndex: number) => {
		if (requestRef.current !== requestId) return
		pendingIndexRef.current = nextIndex
		gapTimeoutRef.current = setTimeout(() => {
			gapTimeoutRef.current = null
			pendingIndexRef.current = null
			playIndexRef.current(requestId, nextIndex)
		}, SENTENCE_GAP_MS)
	}, [])

	const speakWithBrowser = useCallback(
		(requestId: number, index: number, sentence: string) => {
			const { rate, pitch, voiceUri } = preferencesRef.current
			const utterance = new SpeechSynthesisUtterance(sentence)
			utterance.rate = Math.max(0.1, Math.min(10, rate))
			utterance.pitch = Math.max(0, Math.min(2, pitch))
			const voices = window.speechSynthesis.getVoices()
			const voice = voices.find((candidate) => candidate.voiceURI === voiceUri)
			if (voice) utterance.voice = voice

			utterance.onend = () => scheduleNext(requestId, index + 1)
			utterance.onerror = (event) => {
				// cancelling (stop, page change) reports an error on the cancelled utterance
				if (event.error === 'interrupted' || event.error === 'canceled') return
				console.error('Speech synthesis error', event.error)
				fail(requestId)
			}
			try {
				window.speechSynthesis.speak(utterance)
			} catch (error) {
				console.error('Speech synthesis failed', error)
				fail(requestId)
			}
		},
		[fail, scheduleNext],
	)

	const requestServerAudio = useCallback(
		(requestId: number, index: number, sentence: string) => {
			const existing = prefetchRef.current
			if (existing?.requestId === requestId && existing.index === index) {
				return existing.promise
			}
			clearPrefetchedAudio()

			const { rate, voiceUri } = preferencesRef.current
			const promise = sdk.tts
				.speak({ rate, text: sentence, voice: voiceUri })
				.then((blob) =>
					requestRef.current === requestId
						? URL.createObjectURL(new Blob([blob], { type: 'audio/wav' }))
						: null,
				)
				.catch((error) => {
					console.error('Server TTS failed', error)
					return null
				})
			prefetchRef.current = { requestId, index, promise }
			return promise
		},
		[clearPrefetchedAudio, sdk],
	)

	const speakWithServer = useCallback(
		async (requestId: number, index: number, sentence: string) => {
			clearPlayingAudio()
			const url = await requestServerAudio(requestId, index, sentence)
			if (prefetchRef.current?.requestId === requestId && prefetchRef.current.index === index) {
				prefetchRef.current = null
			}
			if (requestRef.current !== requestId) {
				if (url) URL.revokeObjectURL(url)
				return
			}
			if (!url) {
				fail(requestId)
				return
			}

			const next = queueRef.current[index + 1]
			if (next) void requestServerAudio(requestId, index + 1, next)

			audioUrlRef.current = url
			const audio = new Audio(url)
			audioRef.current = audio
			// the speed is applied by the server, stacking playbackRate would distort it
			audio.playbackRate = 1
			audio.onended = () => {
				clearPlayingAudio()
				scheduleNext(requestId, index + 1)
			}
			audio.onerror = () => fail(requestId)
			try {
				await audio.play()
			} catch (error) {
				console.error('Server TTS playback failed', error)
				fail(requestId)
			}
		},
		[clearPlayingAudio, fail, requestServerAudio, scheduleNext],
	)

	const playIndex = useCallback(
		(requestId: number, index: number) => {
			if (requestRef.current !== requestId) return
			const sentence = queueRef.current[index]
			if (sentence == null) {
				setCurrentIndex(null)
				onQueueEndRef.current?.()
				return
			}

			setCurrentIndex(index)
			if (engineRef.current === 'server') {
				void speakWithServer(requestId, index, sentence)
			} else if (browserSupported) {
				speakWithBrowser(requestId, index, sentence)
			} else {
				fail(requestId, t('reader.toasts.readAloudUnsupported'))
			}
		},
		[browserSupported, fail, speakWithBrowser, speakWithServer, t],
	)

	useEffect(() => {
		playIndexRef.current = playIndex
	}, [playIndex])

	/** Starts speaking `sentences` from `startIndex`, replacing whatever was playing */
	const play = useCallback(
		(sentences: string[], startIndex = 0) => {
			if (!supported) {
				toast.error(t('reader.toasts.readAloudUnsupported'))
				return
			}
			halt()
			queueRef.current = sentences
			setIsActive(true)
			setIsPaused(false)
			playIndex(requestRef.current, Math.max(0, startIndex))
		},
		[halt, playIndex, supported, t],
	)

	const stop = useCallback(() => {
		halt()
		queueRef.current = []
		setIsActive(false)
		setIsPaused(false)
		setCurrentIndex(null)
	}, [halt])

	const pause = useCallback(() => {
		if (!isActive || isPaused) return
		if (gapTimeoutRef.current !== null) {
			clearTimeout(gapTimeoutRef.current)
			gapTimeoutRef.current = null
		}
		if (engine === 'server') {
			audioRef.current?.pause()
		} else if (browserSupported) {
			window.speechSynthesis.pause()
		}
		setIsPaused(true)
	}, [browserSupported, engine, isActive, isPaused])

	const resume = useCallback(() => {
		if (!isActive || !isPaused) return
		setIsPaused(false)

		const pendingIndex = pendingIndexRef.current
		if (pendingIndex !== null) {
			pendingIndexRef.current = null
			playIndex(requestRef.current, pendingIndex)
			return
		}
		if (engine === 'server') {
			void audioRef.current
				?.play()
				.catch(() => toast.error(t('reader.toasts.failedResumeReadAloud')))
		} else if (browserSupported) {
			window.speechSynthesis.resume()
		}
	}, [browserSupported, engine, isActive, isPaused, playIndex, t])

	const setEngine = useCallback(
		(next: ReadAloudEngine) => {
			if (next === 'server' && !serverAvailable) return
			stop()
			// voices are not shared between engines
			setPreferences((prev) => ({ ...prev, engine: next, voiceUri: null }))
		},
		[serverAvailable, stop],
	)

	const setRate = useCallback(
		(rate: number) => {
			clearPrefetchedAudio()
			setPreferences((prev) => ({
				...prev,
				rate: Math.min(10, Math.max(0.1, Math.round(rate * 10) / 10)),
			}))
		},
		[clearPrefetchedAudio],
	)

	const setPitch = useCallback((pitch: number) => {
		setPreferences((prev) => ({
			...prev,
			pitch: Math.min(2, Math.max(0, Math.round(pitch * 10) / 10)),
		}))
	}, [])

	const setVoiceUri = useCallback(
		(voiceUri: string | null) => {
			clearPrefetchedAudio()
			setPreferences((prev) => ({ ...prev, voiceUri }))
		},
		[clearPrefetchedAudio],
	)

	useEffect(() => halt, [halt])

	return {
		supported,
		serverAvailable,
		engine,
		voices: engine === 'server' ? serverVoices : browserVoices,
		rate: preferences.rate,
		pitch: preferences.pitch,
		voiceUri: preferences.voiceUri,
		isActive,
		isPaused,
		currentIndex,
		play,
		stop,
		pause,
		resume,
		setEngine,
		setRate,
		setPitch,
		setVoiceUri,
	}
}

export type ReadAloudController = ReturnType<typeof useReadAloud>
