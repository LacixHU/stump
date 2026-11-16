use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum SupertonicError {
	#[error("No Supertonic model found in {}", .0.display())]
	ModelNotFound(PathBuf),
	#[error("Invalid Supertonic model file {}: {reason}", .path.display())]
	InvalidModel { path: PathBuf, reason: String },
	#[error("Voice style '{0}' was not found")]
	VoiceNotFound(String),
	#[error("Language '{0}' is not supported by Supertonic")]
	UnsupportedLanguage(String),
	#[error("ONNX Runtime error: {0}")]
	Onnx(String),
	#[error("I/O error: {0}")]
	Io(#[from] std::io::Error),
}

impl<T> From<ort::Error<T>> for SupertonicError {
	fn from(error: ort::Error<T>) -> Self {
		SupertonicError::Onnx(error.to_string())
	}
}

pub type SupertonicResult<T> = Result<T, SupertonicError>;
