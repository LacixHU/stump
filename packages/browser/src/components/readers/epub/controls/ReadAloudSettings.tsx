import ReadAloudSettingsPanel from '../../readAloud/ReadAloudSettingsPanel'
import { useEpubReaderControls } from '../context'

export default function ReadAloudSettings() {
	const {
		isReadAloudActive,
		isReadAloudPaused,
		onPauseReadAloud,
		onResumeReadAloud,
		onSetReadAloudEngine,
		onSetReadAloudPitch,
		onSetReadAloudRate,
		onSetReadAloudVoiceUri,
		readAloudCurrentSentence,
		readAloudEngine,
		readAloudPitch,
		readAloudRate,
		readAloudServerAvailable,
		readAloudSupported,
		readAloudVoiceUri,
		readAloudVoices,
	} = useEpubReaderControls()

	return (
		<ReadAloudSettingsPanel
			supported={readAloudSupported}
			serverAvailable={readAloudServerAvailable}
			engine={readAloudEngine}
			voices={readAloudVoices}
			voiceUri={readAloudVoiceUri}
			rate={readAloudRate}
			pitch={readAloudPitch}
			isActive={isReadAloudActive}
			isPaused={isReadAloudPaused}
			currentSentence={readAloudCurrentSentence}
			onSetEngine={onSetReadAloudEngine}
			onSetVoiceUri={onSetReadAloudVoiceUri}
			onSetRate={onSetReadAloudRate}
			onSetPitch={onSetReadAloudPitch}
			onPause={onPauseReadAloud}
			onResume={onResumeReadAloud}
		/>
	)
}
