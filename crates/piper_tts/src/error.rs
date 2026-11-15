use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum PiperError {
	/// The espeak-ng shared library or its data directory could not be loaded.
	#[error("espeak-ng is unavailable: {0}")]
	EspeakUnavailable(String),
	#[error("espeak-ng failed: {0}")]
	Espeak(String),
	#[error("Voice model not found: {}", .0.display())]
	VoiceNotFound(PathBuf),
	#[error("Invalid voice config {}: {reason}", .path.display())]
	InvalidVoiceConfig { path: PathBuf, reason: String },
	#[error("ONNX Runtime error: {0}")]
	Onnx(String),
	#[error("I/O error: {0}")]
	Io(#[from] std::io::Error),
}

impl<T> From<ort::Error<T>> for PiperError {
	fn from(error: ort::Error<T>) -> Self {
		PiperError::Onnx(error.to_string())
	}
}

pub type PiperResult<T> = Result<T, PiperError>;
