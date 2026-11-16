//! In-process [Piper](https://github.com/rhasspy/piper) text-to-speech.
//!
//! A Rust port of Piper's C++ runtime (`piper.cpp`) and the parts of piper-phonemize
//! it uses (MIT, Copyright (c) 2022 Michael Hansen, see `LICENSE-piper.md`):
//!
//! - text → IPA phonemes with espeak-ng (GPL-3.0), compiled in from the `espeak-ng`
//!   submodule together with its data, which is unpacked to disk on first use
//! - phonemes → ids from the voice's `.onnx.json`
//! - ids → audio with the voice's VITS `.onnx` model on ONNX Runtime (linked in)
//!
//! Only the voice files (`.onnx` + `.onnx.json`) live outside the binary.

mod error;
mod espeak;
mod voice;

use std::{
	collections::HashMap,
	path::{Path, PathBuf},
	sync::{Arc, Mutex},
	time::{Instant, SystemTime},
};

pub use error::{PiperError, PiperResult};
pub use voice::voice_config_path;
use voice::Voice;

pub type Phoneme = char;
pub type PhonemeId = i64;

/// Loaded voice models are large (tens of MB each), so only a few stay resident.
const MAX_CACHED_VOICES: usize = 4;

/// Settings for the built-in espeak-ng.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EspeakConfig {
	/// Directory the bundled espeak-ng data (about 20 MB) is unpacked into, in a
	/// versioned subdirectory. Defaults to `piper_tts` in the system temp directory.
	/// Only the first value used in a process takes effect.
	pub data_dir: Option<PathBuf>,
}

#[derive(Debug, Clone, Default)]
pub struct SynthesisOptions {
	/// Phoneme length multiplier; lower is faster. Defaults to the voice config.
	pub length_scale: Option<f32>,
	/// Speaker for multi-speaker voices. Defaults to 0.
	pub speaker_id: Option<i64>,
	/// Silence after each sentence. Defaults to 0.2 seconds, as in Piper.
	pub sentence_silence_seconds: Option<f32>,
}

/// Unpacks the espeak-ng data and initializes espeak-ng, so problems surface before
/// the first request.
pub fn check_espeak(config: &EspeakConfig) -> PiperResult<()> {
	espeak::ensure_loaded(config)
}

/// Synthesizes `text` with the voice at `model_path` (`.onnx`, with its `.onnx.json`
/// beside it) and returns a 16-bit mono WAV file. Blocking and CPU-bound.
pub fn synthesize_wav(
	espeak_config: &EspeakConfig,
	model_path: &Path,
	text: &str,
	options: &SynthesisOptions,
) -> PiperResult<Vec<u8>> {
	let voice = cached_voice(model_path)?;
	let mut voice = voice
		.lock()
		.unwrap_or_else(|poisoned| poisoned.into_inner());
	let samples = voice.text_to_audio(espeak_config, text, options)?;
	Ok(tts_runtime::encode_wav(&samples, voice.config.sample_rate))
}

/// Phoneme ids per sentence for `text`, as fed to the model. Useful for comparing
/// against `piper --debug` output.
pub fn text_to_phoneme_ids(
	espeak_config: &EspeakConfig,
	model_path: &Path,
	text: &str,
) -> PiperResult<Vec<Vec<PhonemeId>>> {
	let voice = cached_voice(model_path)?;
	let voice = voice
		.lock()
		.unwrap_or_else(|poisoned| poisoned.into_inner());
	let mut missing = Default::default();
	Ok(voice
		.phonemize(espeak_config, text)?
		.iter()
		.filter(|sentence| !sentence.is_empty())
		.map(|sentence| voice.config.phonemes_to_ids(sentence, &mut missing))
		.collect())
}

struct CachedVoice {
	modified: Option<SystemTime>,
	last_used: Instant,
	voice: Arc<Mutex<Voice>>,
}

static VOICES: Mutex<Option<HashMap<PathBuf, CachedVoice>>> = Mutex::new(None);

fn modified_time(path: &Path) -> Option<SystemTime> {
	std::fs::metadata(path)
		.and_then(|meta| meta.modified())
		.ok()
}

/// Returns a loaded voice, reloading it if the model file changed on disk.
fn cached_voice(model_path: &Path) -> PiperResult<Arc<Mutex<Voice>>> {
	if !model_path.is_file() {
		return Err(PiperError::VoiceNotFound(model_path.to_path_buf()));
	}
	let modified = modified_time(model_path);

	{
		let mut cache = VOICES
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner());
		if let Some(entry) = cache.get_or_insert_with(HashMap::new).get_mut(model_path) {
			if entry.modified == modified {
				entry.last_used = Instant::now();
				return Ok(entry.voice.clone());
			}
		}
	}

	// Load outside the cache lock so other voices stay usable meanwhile.
	let voice = Arc::new(Mutex::new(Voice::load(model_path)?));

	let mut cache = VOICES
		.lock()
		.unwrap_or_else(|poisoned| poisoned.into_inner());
	let cache = cache.get_or_insert_with(HashMap::new);
	cache.remove(model_path);
	while cache.len() >= MAX_CACHED_VOICES {
		let Some(oldest) = cache
			.iter()
			.min_by_key(|(_, entry)| entry.last_used)
			.map(|(path, _)| path.clone())
		else {
			break;
		};
		cache.remove(&oldest);
	}
	cache.insert(
		model_path.to_path_buf(),
		CachedVoice {
			modified,
			last_used: Instant::now(),
			voice: voice.clone(),
		},
	);

	Ok(voice)
}
