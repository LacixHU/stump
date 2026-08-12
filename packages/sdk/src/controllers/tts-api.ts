import { APIBase } from '../base'
import { ClassQueryKeys } from './types'
import { createRouteURLHandler } from './utils'

const TTS_ROUTE = '/tts'
const ttsURL = createRouteURLHandler(TTS_ROUTE)

export type TtsVoice = {
	id: string
	label: string
}

export type TtsStatus = {
	enabled: boolean
	defaultVoice: string | null
	voices: TtsVoice[]
	maxChars: number
}

export type SpeakTtsInput = {
	text: string
	voice?: string | null
	rate?: number
}

/**
 * Server-side text-to-speech (Piper) API controller.
 */
export class TtsAPI extends APIBase {
	async status(): Promise<TtsStatus> {
		const { data } = await this.axios.get<TtsStatus>(ttsURL(''))
		return data
	}

	async speak(input: SpeakTtsInput): Promise<Blob> {
		const { data } = await this.axios.post<Blob>(ttsURL('/speak'), input, {
			responseType: 'blob',
		})
		return data
	}

	get keys(): ClassQueryKeys<InstanceType<typeof TtsAPI>> {
		return {
			speak: 'tts.speak',
			status: 'tts.status',
		}
	}
}
