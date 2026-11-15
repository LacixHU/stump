//! Voice loading and synthesis, ported from Piper's `piper.cpp`.

use std::{
	collections::{BTreeMap, HashMap},
	path::{Path, PathBuf},
	sync::{Mutex, OnceLock},
	time::Instant,
};

use ort::{
	environment::Environment,
	session::{builder::GraphOptimizationLevel, Session},
	value::Tensor,
};
use serde_json::Value;
use unicode_normalization::UnicodeNormalization;

use crate::{
	error::{PiperError, PiperResult},
	espeak, EspeakConfig, Phoneme, PhonemeId, SynthesisOptions,
};

/// Padding symbol, optionally interspersed between phonemes.
const PAD: Phoneme = '_';
/// Beginning of sentence.
const BOS: Phoneme = '^';
/// End of sentence.
const EOS: Phoneme = '$';

const DEFAULT_SENTENCE_SILENCE_SECONDS: f32 = 0.2;
const MAX_WAV_VALUE: f32 = 32767.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PhonemeType {
	ESpeak,
	/// Text codepoints are used directly as phonemes.
	Text,
}

#[derive(Debug, Clone)]
pub(crate) struct VoiceConfig {
	pub espeak_voice: String,
	pub phoneme_type: PhonemeType,
	pub phoneme_id_map: HashMap<Phoneme, Vec<PhonemeId>>,
	pub sample_rate: u32,
	pub noise_scale: f32,
	pub length_scale: f32,
	pub noise_w: f32,
	/// Extra silence (seconds) inserted after specific phonemes.
	pub phoneme_silence: Option<HashMap<Phoneme, f32>>,
	pub num_speakers: i64,
}

pub(crate) struct Voice {
	pub config: VoiceConfig,
	session: Session,
}

fn single_codepoint(value: &str) -> Option<Phoneme> {
	let mut chars = value.chars();
	match (chars.next(), chars.next()) {
		(Some(c), None) => Some(c),
		_ => None,
	}
}

impl VoiceConfig {
	pub fn from_json(path: &Path, root: &Value) -> PiperResult<Self> {
		let invalid = |reason: String| PiperError::InvalidVoiceConfig {
			path: path.to_path_buf(),
			reason,
		};

		let espeak_voice = root
			.pointer("/espeak/voice")
			.and_then(Value::as_str)
			.unwrap_or("en-us")
			.to_string();

		let phoneme_type = match root.get("phoneme_type").and_then(Value::as_str) {
			Some("text") => PhonemeType::Text,
			_ => PhonemeType::ESpeak,
		};

		let mut phoneme_id_map = HashMap::new();
		if let Some(map) = root.get("phoneme_id_map").and_then(Value::as_object) {
			for (phoneme, ids) in map {
				let phoneme = single_codepoint(phoneme).ok_or_else(|| {
					invalid(format!(
						"\"{phoneme}\" is not a single codepoint (phoneme_id_map)"
					))
				})?;
				let ids = ids
					.as_array()
					.map(|ids| ids.iter().filter_map(Value::as_i64).collect::<Vec<_>>())
					.unwrap_or_default();
				phoneme_id_map.insert(phoneme, ids);
			}
		}
		for required in [PAD, BOS, EOS] {
			if !phoneme_id_map.contains_key(&required) {
				return Err(invalid(format!(
					"phoneme_id_map is missing the '{required}' symbol"
				)));
			}
		}

		let sample_rate = root
			.pointer("/audio/sample_rate")
			.and_then(Value::as_u64)
			.and_then(|rate| u32::try_from(rate).ok())
			.filter(|rate| *rate > 0)
			.unwrap_or(22_050);

		let inference = root.get("inference");
		let inference_f32 = |key: &str, default: f32| {
			inference
				.and_then(|value| value.get(key))
				.and_then(Value::as_f64)
				.map_or(default, |value| value as f32)
		};

		let phoneme_silence = match inference
			.and_then(|value| value.get("phoneme_silence"))
			.and_then(Value::as_object)
		{
			Some(map) => {
				let mut silence = HashMap::new();
				for (phoneme, seconds) in map {
					let phoneme = single_codepoint(phoneme).ok_or_else(|| {
						invalid(format!(
							"\"{phoneme}\" is not a single codepoint (phoneme_silence)"
						))
					})?;
					silence.insert(phoneme, seconds.as_f64().unwrap_or_default() as f32);
				}
				Some(silence)
			},
			None => None,
		};

		Ok(Self {
			espeak_voice,
			phoneme_type,
			phoneme_id_map,
			sample_rate,
			noise_scale: inference_f32("noise_scale", 0.667),
			length_scale: inference_f32("length_scale", 1.0),
			noise_w: inference_f32("noise_w", 0.8),
			phoneme_silence,
			num_speakers: root
				.get("num_speakers")
				.and_then(Value::as_i64)
				.unwrap_or(1),
		})
	}

	/// Maps phonemes to model ids: `^ _ p1 _ p2 _ ... $` (piper-phonemize defaults).
	pub fn phonemes_to_ids(
		&self,
		phonemes: &[Phoneme],
		missing: &mut BTreeMap<Phoneme, usize>,
	) -> Vec<PhonemeId> {
		let map = &self.phoneme_id_map;
		let pad = &map[&PAD];
		let mut ids = Vec::with_capacity(phonemes.len() * 2 + 3);

		ids.extend_from_slice(&map[&BOS]);
		ids.extend_from_slice(pad);
		for phoneme in phonemes {
			match map.get(phoneme) {
				Some(mapped) => {
					ids.extend_from_slice(mapped);
					ids.extend_from_slice(pad);
				},
				None => *missing.entry(*phoneme).or_default() += 1,
			}
		}
		ids.extend_from_slice(&map[&EOS]);

		ids
	}
}

/// Model config lives next to the model: `voice.onnx` → `voice.onnx.json`.
pub fn voice_config_path(model_path: &Path) -> PathBuf {
	let mut path = model_path.as_os_str().to_owned();
	path.push(".json");
	PathBuf::from(path)
}

fn environment() -> PiperResult<&'static Environment> {
	static ENVIRONMENT: OnceLock<Environment> = OnceLock::new();
	static INIT_LOCK: Mutex<()> = Mutex::new(());

	if let Some(environment) = ENVIRONMENT.get() {
		return Ok(environment);
	}
	let _guard = INIT_LOCK
		.lock()
		.unwrap_or_else(|poisoned| poisoned.into_inner());
	if let Some(environment) = ENVIRONMENT.get() {
		return Ok(environment);
	}
	let environment = ort::init()
		.with_name("piper")
		.with_telemetry(false)
		.build()?;
	Ok(ENVIRONMENT.get_or_init(|| environment))
}

impl Voice {
	pub fn load(model_path: &Path) -> PiperResult<Self> {
		if !model_path.is_file() {
			return Err(PiperError::VoiceNotFound(model_path.to_path_buf()));
		}

		let config_path = voice_config_path(model_path);
		let config_text = std::fs::read_to_string(&config_path).map_err(|error| {
			PiperError::InvalidVoiceConfig {
				path: config_path.clone(),
				reason: error.to_string(),
			}
		})?;
		let root: Value = serde_json::from_str(&config_text).map_err(|error| {
			PiperError::InvalidVoiceConfig {
				path: config_path.clone(),
				reason: error.to_string(),
			}
		})?;
		let config = VoiceConfig::from_json(&config_path, &root)?;

		let started = Instant::now();
		// Same session options as Piper: graph optimization roughly doubles load
		// time without a measurable inference gain for these models.
		let session = Session::builder(environment()?)?
			.with_optimization_level(GraphOptimizationLevel::Disable)?
			.with_memory_pattern(false)?
			.commit_from_file(model_path)?;
		tracing::debug!(
			model = %model_path.display(),
			elapsed_ms = started.elapsed().as_millis() as u64,
			speakers = config.num_speakers,
			"Loaded Piper voice"
		);

		Ok(Self { config, session })
	}

	/// Phonemizes `text` into per-sentence phoneme lists.
	pub fn phonemize(
		&self,
		espeak_config: &EspeakConfig,
		text: &str,
	) -> PiperResult<Vec<Vec<Phoneme>>> {
		match self.config.phoneme_type {
			PhonemeType::ESpeak => {
				espeak::phonemize(espeak_config, &self.config.espeak_voice, text)
			},
			// Lowercased, decomposed codepoints with no sentence splitting.
			PhonemeType::Text => Ok(vec![text.to_lowercase().nfd().collect()]),
		}
	}

	/// Phonemizes and synthesizes `text`, returning 16-bit mono PCM samples.
	pub fn text_to_audio(
		&mut self,
		espeak_config: &EspeakConfig,
		text: &str,
		options: &SynthesisOptions,
	) -> PiperResult<Vec<i16>> {
		let sentences = self.phonemize(espeak_config, text)?;
		let sample_rate = self.config.sample_rate as f32;
		let sentence_silence = (options
			.sentence_silence_seconds
			.unwrap_or(DEFAULT_SENTENCE_SILENCE_SECONDS)
			.max(0.0) * sample_rate) as usize;
		let scales = [
			self.config.noise_scale,
			options.length_scale.unwrap_or(self.config.length_scale),
			self.config.noise_w,
		];
		let speaker_id =
			(self.config.num_speakers > 1).then(|| options.speaker_id.unwrap_or(0));

		let mut audio = Vec::new();
		let mut missing = BTreeMap::new();

		for sentence in &sentences {
			// Split into phrases after phonemes that carry extra silence.
			let mut phrases: Vec<(&[Phoneme], usize)> = Vec::new();
			match &self.config.phoneme_silence {
				Some(silence) => {
					let mut start = 0;
					for (index, phoneme) in sentence.iter().enumerate() {
						if let Some(seconds) = silence.get(phoneme) {
							phrases.push((
								&sentence[start..=index],
								(seconds * sample_rate) as usize,
							));
							start = index + 1;
						}
					}
					phrases.push((&sentence[start..], 0));
				},
				None => phrases.push((sentence, 0)),
			}

			for (phonemes, silence_samples) in phrases {
				if phonemes.is_empty() {
					continue;
				}
				let ids = self.config.phonemes_to_ids(phonemes, &mut missing);
				self.infer(&ids, scales, speaker_id, &mut audio)?;
				audio.resize(audio.len() + silence_samples, 0);
			}

			audio.resize(audio.len() + sentence_silence, 0);
		}

		if !missing.is_empty() {
			let missing = missing
				.iter()
				.map(|(phoneme, count)| {
					format!("\"{phoneme}\" (\\u{:04X}) x{count}", *phoneme as u32)
				})
				.collect::<Vec<_>>()
				.join(", ");
			tracing::warn!(%missing, "Phonemes missing from the voice's phoneme_id_map");
		}

		Ok(audio)
	}

	/// Runs the VITS model for one phrase and appends normalized int16 samples.
	fn infer(
		&mut self,
		ids: &[PhonemeId],
		scales: [f32; 3],
		speaker_id: Option<i64>,
		audio: &mut Vec<i16>,
	) -> PiperResult<()> {
		let length = ids.len() as i64;
		let mut inputs = ort::inputs![
			"input" => Tensor::from_array(([1_i64, length], ids.to_vec()))?,
			"input_lengths" => Tensor::from_array(([1_i64], vec![length]))?,
			"scales" => Tensor::from_array(([3_i64], scales.to_vec()))?,
		];
		if let Some(speaker_id) = speaker_id {
			inputs.push((
				"sid".into(),
				Tensor::from_array(([1_i64], vec![speaker_id]))?.into(),
			));
		}

		let outputs = self.session.run(inputs)?;
		let (_, samples) = outputs
			.get("output")
			.ok_or_else(|| PiperError::Onnx("model has no 'output' tensor".to_string()))?
			.try_extract_tensor::<f32>()?;

		// Scale to fill the int16 range, as Piper does.
		let peak = samples
			.iter()
			.fold(0.01_f32, |peak, sample| peak.max(sample.abs()));
		let scale = MAX_WAV_VALUE / peak;
		audio.reserve(samples.len());
		audio.extend(samples.iter().map(|sample| {
			(sample * scale).clamp(i16::MIN as f32, i16::MAX as f32) as i16
		}));

		Ok(())
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn config() -> VoiceConfig {
		let root = serde_json::json!({
			"audio": { "sample_rate": 16000 },
			"espeak": { "voice": "hu" },
			"inference": { "noise_scale": 0.5, "length_scale": 1.1, "noise_w": 0.7 },
			"num_speakers": 1,
			"phoneme_id_map": {
				"_": [0], "^": [1], "$": [2], "a": [14], "b": [15], " ": [3]
			}
		});
		VoiceConfig::from_json(Path::new("test.onnx.json"), &root).unwrap()
	}

	#[test]
	fn parses_config() {
		let config = config();
		assert_eq!(config.espeak_voice, "hu");
		assert_eq!(config.sample_rate, 16000);
		assert_eq!(config.phoneme_type, PhonemeType::ESpeak);
		assert!((config.length_scale - 1.1).abs() < 1e-6);
		assert!(config.phoneme_silence.is_none());
	}

	#[test]
	fn maps_phonemes_with_padding() {
		let mut missing = BTreeMap::new();
		let ids = config().phonemes_to_ids(&['a', ' ', 'b', 'x'], &mut missing);
		assert_eq!(ids, vec![1, 0, 14, 0, 3, 0, 15, 0, 2]);
		assert_eq!(missing.get(&'x'), Some(&1));
	}

	#[test]
	fn rejects_missing_special_symbols() {
		let root = serde_json::json!({ "phoneme_id_map": { "a": [1] } });
		assert!(VoiceConfig::from_json(Path::new("x.json"), &root).is_err());
	}

	#[test]
	fn config_path_appends_json() {
		assert_eq!(
			voice_config_path(Path::new("voices/en_US-lessac-medium.onnx")),
			PathBuf::from("voices/en_US-lessac-medium.onnx.json")
		);
	}
}
