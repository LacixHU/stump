//! In-process [Supertonic 3](https://huggingface.co/supertone-oss-archive/supertonic-3)
//! text-to-speech: a 31-language flow-matching model that reads text directly, so it
//! needs no phonemizer (no espeak-ng).
//!
//! The inference code is a port of Supertone's MIT-licensed reference implementation.
//! The model weights are not bundled: they are licensed separately under OpenRAIL-M and
//! are downloaded into a model directory laid out like the Hugging Face repository:
//!
//! ```text
//! <model dir>/onnx/{tts.json, unicode_indexer.json, duration_predictor.onnx,
//!                   text_encoder.onnx, vector_estimator.onnx, vocoder.onnx}
//! <model dir>/voice_styles/{F1, …, M5}.json
//! ```

mod error;
mod model;
mod text;

use std::{
	path::{Path, PathBuf},
	sync::{Arc, Mutex},
	time::SystemTime,
};

pub use error::{SupertonicError, SupertonicResult};
use model::{Model, Params, MODEL_FILES};

/// Speed used by the reference implementation; slightly faster than the model's own
/// pacing.
pub const DEFAULT_SPEED: f32 = 1.05;
/// Flow-matching steps. More steps sound cleaner but cost time linearly.
pub const DEFAULT_STEPS: usize = 8;
const DEFAULT_CHUNK_SILENCE_SECONDS: f32 = 0.3;

/// Languages Supertonic 3 speaks: ISO 639-1 code and English name.
pub const LANGUAGES: &[(&str, &str)] = &[
	("ar", "Arabic"),
	("bg", "Bulgarian"),
	("cs", "Czech"),
	("da", "Danish"),
	("de", "German"),
	("el", "Greek"),
	("en", "English"),
	("es", "Spanish"),
	("et", "Estonian"),
	("fi", "Finnish"),
	("fr", "French"),
	("hi", "Hindi"),
	("hr", "Croatian"),
	("hu", "Hungarian"),
	("id", "Indonesian"),
	("it", "Italian"),
	("ja", "Japanese"),
	("ko", "Korean"),
	("lt", "Lithuanian"),
	("lv", "Latvian"),
	("nl", "Dutch"),
	("pl", "Polish"),
	("pt", "Portuguese"),
	("ro", "Romanian"),
	("ru", "Russian"),
	("sk", "Slovak"),
	("sl", "Slovenian"),
	("sv", "Swedish"),
	("tr", "Turkish"),
	("uk", "Ukrainian"),
	("vi", "Vietnamese"),
];

/// English name of a supported language code.
pub fn language_name(code: &str) -> Option<&'static str> {
	LANGUAGES
		.iter()
		.find(|(known, _)| *known == code)
		.map(|(_, name)| *name)
}

#[derive(Debug, Clone, Default)]
pub struct SynthesisOptions {
	/// Speech speed; higher is faster. Defaults to [`DEFAULT_SPEED`].
	pub speed: Option<f32>,
	/// Denoising steps. Defaults to [`DEFAULT_STEPS`].
	pub steps: Option<usize>,
	/// Pause between chunks when long text is split. Defaults to 0.3 seconds.
	pub chunk_silence_seconds: Option<f32>,
}

/// A Supertonic model directory and the voice styles it provides.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelInfo {
	pub dir: PathBuf,
	/// Voice style names (file stems in `voice_styles/`), sorted.
	pub voices: Vec<String>,
}

fn onnx_dir(model_dir: &Path) -> Option<PathBuf> {
	[model_dir.join("onnx"), model_dir.to_path_buf()]
		.into_iter()
		.find(|dir| MODEL_FILES.iter().all(|file| dir.join(file).is_file()))
}

fn is_valid_voice_name(name: &str) -> bool {
	!name.is_empty()
		&& name
			.chars()
			.all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Returns the model in `dir` if it holds every model file and at least one voice
/// style. Cheap: only checks which files exist.
pub fn find_model(dir: &Path) -> Option<ModelInfo> {
	onnx_dir(dir)?;
	let mut voices = std::fs::read_dir(dir.join("voice_styles"))
		.ok()?
		.filter_map(|entry| entry.ok())
		.filter_map(|entry| {
			let path = entry.path();
			if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
				return None;
			}
			let name = path.file_stem()?.to_str()?;
			is_valid_voice_name(name).then(|| name.to_string())
		})
		.collect::<Vec<_>>();
	if voices.is_empty() {
		return None;
	}
	voices.sort();
	Some(ModelInfo {
		dir: dir.to_path_buf(),
		voices,
	})
}

struct CachedModel {
	dir: PathBuf,
	modified: Option<SystemTime>,
	model: Arc<Mutex<Model>>,
}

/// The model is about 400 MB in memory, so only the most recently used one stays loaded.
static MODEL: Mutex<Option<CachedModel>> = Mutex::new(None);

fn cached_model(model_dir: &Path) -> SupertonicResult<Arc<Mutex<Model>>> {
	let onnx_dir = onnx_dir(model_dir)
		.ok_or_else(|| SupertonicError::ModelNotFound(model_dir.to_path_buf()))?;
	let modified = std::fs::metadata(onnx_dir.join("vector_estimator.onnx"))
		.and_then(|meta| meta.modified())
		.ok();

	let mut cache = MODEL
		.lock()
		.unwrap_or_else(|poisoned| poisoned.into_inner());
	if let Some(cached) = cache.as_ref() {
		if cached.dir == model_dir && cached.modified == modified {
			return Ok(cached.model.clone());
		}
	}
	// Free the previous model before loading another one.
	*cache = None;
	let model = Arc::new(Mutex::new(Model::load(&onnx_dir)?));
	*cache = Some(CachedModel {
		dir: model_dir.to_path_buf(),
		modified,
		model: model.clone(),
	});
	Ok(model)
}

/// Synthesizes `text` in language `lang` with voice style `voice` of the model in
/// `model_dir`, and returns a 16-bit mono WAV file. Blocking and CPU-bound; the first
/// call loads the model, which takes a few seconds.
pub fn synthesize_wav(
	model_dir: &Path,
	voice: &str,
	lang: &str,
	text: &str,
	options: &SynthesisOptions,
) -> SupertonicResult<Vec<u8>> {
	if language_name(lang).is_none() {
		return Err(SupertonicError::UnsupportedLanguage(lang.to_string()));
	}
	if !is_valid_voice_name(voice) {
		return Err(SupertonicError::VoiceNotFound(voice.to_string()));
	}
	let style_path = model_dir.join("voice_styles").join(format!("{voice}.json"));
	if !style_path.is_file() {
		return Err(SupertonicError::VoiceNotFound(voice.to_string()));
	}

	let model = cached_model(model_dir)?;
	let mut model = model
		.lock()
		.unwrap_or_else(|poisoned| poisoned.into_inner());
	let style = model.style(&style_path)?;
	let params = Params {
		steps: options.steps.unwrap_or(DEFAULT_STEPS).clamp(1, 64),
		speed: options.speed.unwrap_or(DEFAULT_SPEED),
		chunk_silence_seconds: options
			.chunk_silence_seconds
			.unwrap_or(DEFAULT_CHUNK_SILENCE_SECONDS),
	};
	let samples = model.synthesize(&style, lang, text, &params)?;
	Ok(tts_runtime::encode_wav(&samples, model.sample_rate()))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn knows_31_languages() {
		assert_eq!(LANGUAGES.len(), 31);
		assert_eq!(language_name("hu"), Some("Hungarian"));
		assert_eq!(language_name("na"), None);
	}

	#[test]
	fn rejects_path_like_voice_names() {
		assert!(is_valid_voice_name("F1"));
		assert!(!is_valid_voice_name("../F1"));
		assert!(!is_valid_voice_name(""));
	}
}
