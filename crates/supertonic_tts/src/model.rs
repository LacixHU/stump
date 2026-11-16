//! Model loading and inference, ported from Supertonic's reference `TextToSpeech`
//! (`rust/src/helper.rs`, MIT).
//!
//! Pipeline per chunk of text:
//! 1. `duration_predictor.onnx`: characters + voice style → speech length in seconds
//! 2. `text_encoder.onnx`: characters + voice style → text embedding
//! 3. `vector_estimator.onnx`: flow matching from Gaussian noise to a speech latent,
//!    run once per denoising step
//! 4. `vocoder.onnx`: latent → 44.1 kHz waveform

use std::{
	collections::HashMap,
	fs,
	path::{Path, PathBuf},
	sync::Arc,
	time::Instant,
};

use ort::{session::Session, value::Tensor};
use rand::Rng;
use serde::Deserialize;

use crate::{
	error::{SupertonicError, SupertonicResult},
	text,
};

pub(crate) const MODEL_FILES: [&str; 6] = [
	"tts.json",
	"unicode_indexer.json",
	"duration_predictor.onnx",
	"text_encoder.onnx",
	"vector_estimator.onnx",
	"vocoder.onnx",
];

#[derive(Debug, Deserialize)]
struct Config {
	ae: AeConfig,
	ttl: TtlConfig,
}

#[derive(Debug, Deserialize)]
struct AeConfig {
	sample_rate: u32,
	base_chunk_size: usize,
}

#[derive(Debug, Deserialize)]
struct TtlConfig {
	chunk_compress_factor: usize,
	latent_dim: usize,
}

#[derive(Debug, Deserialize)]
struct StyleFile {
	style_ttl: StyleComponent,
	style_dp: StyleComponent,
}

#[derive(Debug, Deserialize)]
struct StyleComponent {
	data: Vec<Vec<Vec<f32>>>,
	dims: Vec<usize>,
}

impl StyleComponent {
	fn into_tensor(self, path: &Path) -> SupertonicResult<Tensor<f32>> {
		let flat: Vec<f32> = self.data.into_iter().flatten().flatten().collect();
		if self.dims.len() != 3 || self.dims.iter().product::<usize>() != flat.len() {
			return Err(invalid(path, "style dims do not match its data"));
		}
		Ok(Tensor::from_array((self.dims, flat))?)
	}
}

/// A voice style: speaker embeddings for the text encoder and duration predictor.
pub(crate) struct Style {
	ttl: Tensor<f32>,
	dp: Tensor<f32>,
}

fn invalid(path: &Path, reason: impl ToString) -> SupertonicError {
	SupertonicError::InvalidModel {
		path: path.to_path_buf(),
		reason: reason.to_string(),
	}
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> SupertonicResult<T> {
	let text = fs::read_to_string(path).map_err(|error| invalid(path, error))?;
	serde_json::from_str(&text).map_err(|error| invalid(path, error))
}

pub(crate) fn load_style(path: &Path) -> SupertonicResult<Style> {
	let file: StyleFile = read_json(path)?;
	Ok(Style {
		ttl: file.style_ttl.into_tensor(path)?,
		dp: file.style_dp.into_tensor(path)?,
	})
}

pub(crate) struct Model {
	config: Config,
	/// Unicode code point → character id; negative for characters the model lacks.
	indexer: Vec<i64>,
	duration_predictor: Session,
	text_encoder: Session,
	vector_estimator: Session,
	vocoder: Session,
	styles: HashMap<PathBuf, Arc<Style>>,
}

pub(crate) struct Params {
	pub steps: usize,
	pub speed: f32,
	pub chunk_silence_seconds: f32,
}

impl Model {
	pub fn load(onnx_dir: &Path) -> SupertonicResult<Self> {
		let started = Instant::now();
		let config: Config = read_json(&onnx_dir.join("tts.json"))?;
		let indexer: Vec<i64> = read_json(&onnx_dir.join("unicode_indexer.json"))?;

		let session = |name: &str| -> SupertonicResult<Session> {
			let path = onnx_dir.join(name);
			if !path.is_file() {
				return Err(SupertonicError::ModelNotFound(path));
			}
			Ok(Session::builder(tts_runtime::environment()?)?.commit_from_file(&path)?)
		};

		let model = Self {
			duration_predictor: session("duration_predictor.onnx")?,
			text_encoder: session("text_encoder.onnx")?,
			vector_estimator: session("vector_estimator.onnx")?,
			vocoder: session("vocoder.onnx")?,
			config,
			indexer,
			styles: HashMap::new(),
		};
		tracing::debug!(
			model = %onnx_dir.display(),
			elapsed_ms = started.elapsed().as_millis() as u64,
			"Loaded Supertonic model"
		);
		Ok(model)
	}

	pub fn sample_rate(&self) -> u32 {
		self.config.ae.sample_rate
	}

	pub fn style(&mut self, path: &Path) -> SupertonicResult<Arc<Style>> {
		if let Some(style) = self.styles.get(path) {
			return Ok(style.clone());
		}
		let style = Arc::new(load_style(path)?);
		self.styles.insert(path.to_path_buf(), style.clone());
		Ok(style)
	}

	/// Maps preprocessed text to character ids, dropping characters the model lacks.
	fn text_ids(&self, text: &str) -> Vec<i64> {
		let mut unknown = Vec::new();
		let ids = text
			.chars()
			.filter_map(|c| {
				let id = self.indexer.get(c as usize).copied().unwrap_or(-1);
				if id < 0 {
					unknown.push(c);
					None
				} else {
					Some(id)
				}
			})
			.collect();
		if !unknown.is_empty() {
			tracing::debug!(?unknown, "Dropped characters Supertonic does not know");
		}
		ids
	}

	/// Synthesizes `text` and returns 16-bit mono PCM samples.
	pub fn synthesize(
		&mut self,
		style: &Style,
		lang: &str,
		text: &str,
		params: &Params,
	) -> SupertonicResult<Vec<i16>> {
		let silence =
			(params.chunk_silence_seconds.max(0.0) * self.sample_rate() as f32) as usize;
		let mut audio: Vec<f32> = Vec::new();
		for chunk in text::chunk(text, text::max_chunk_chars(lang)) {
			let ids = self.text_ids(&text::preprocess(&chunk, lang));
			if ids.is_empty() {
				continue;
			}
			let samples = self.infer(style, ids, params)?;
			if !audio.is_empty() {
				audio.resize(audio.len() + silence, 0.0);
			}
			audio.extend(samples);
		}
		Ok(to_pcm(&audio))
	}

	fn infer(
		&mut self,
		style: &Style,
		ids: Vec<i64>,
		params: &Params,
	) -> SupertonicResult<Vec<f32>> {
		let length = ids.len();
		let text_ids = Tensor::from_array(([1, length], ids))?;
		let text_mask = Tensor::from_array(([1, 1, length], vec![1.0_f32; length]))?;

		let duration = {
			let outputs = self.duration_predictor.run(ort::inputs![
				"text_ids" => &text_ids,
				"style_dp" => &style.dp,
				"text_mask" => &text_mask,
			])?;
			let (_, duration) = outputs["duration"].try_extract_tensor::<f32>()?;
			duration.first().copied().unwrap_or(0.0)
		};
		let seconds = (duration / params.speed.max(0.1)).max(0.0);

		let text_emb = {
			let outputs = self.text_encoder.run(ort::inputs![
				"text_ids" => &text_ids,
				"style_ttl" => &style.ttl,
				"text_mask" => &text_mask,
			])?;
			let (shape, data) = outputs["text_emb"].try_extract_tensor::<f32>()?;
			Tensor::from_array((shape.to_vec(), data.to_vec()))?
		};

		// Gaussian noise sized to the predicted duration, in latent frames.
		let sample_rate = self.sample_rate() as f32;
		let wav_len = (seconds * sample_rate) as usize;
		let chunk_size =
			self.config.ae.base_chunk_size * self.config.ttl.chunk_compress_factor;
		let latent_len = wav_len.div_ceil(chunk_size).max(1);
		let latent_dim =
			self.config.ttl.latent_dim * self.config.ttl.chunk_compress_factor;
		let mut latent_shape = vec![1_i64, latent_dim as i64, latent_len as i64];
		let mut latent = gaussian_noise(latent_dim * latent_len);
		let latent_mask =
			Tensor::from_array(([1, 1, latent_len], vec![1.0_f32; latent_len]))?;
		let total_step = Tensor::from_array(([1], vec![params.steps as f32]))?;

		for step in 0..params.steps {
			let current_step = Tensor::from_array(([1], vec![step as f32]))?;
			let noisy_latent = Tensor::from_array((latent_shape.clone(), latent))?;
			let outputs = self.vector_estimator.run(ort::inputs![
				"noisy_latent" => &noisy_latent,
				"text_emb" => &text_emb,
				"style_ttl" => &style.ttl,
				"latent_mask" => &latent_mask,
				"text_mask" => &text_mask,
				"current_step" => &current_step,
				"total_step" => &total_step,
			])?;
			let (shape, data) = outputs["denoised_latent"].try_extract_tensor::<f32>()?;
			latent_shape = shape.to_vec();
			latent = data.to_vec();
		}

		let latent = Tensor::from_array((latent_shape, latent))?;
		let outputs = self.vocoder.run(ort::inputs!["latent" => &latent])?;
		let (_, wav) = outputs["wav_tts"].try_extract_tensor::<f32>()?;
		// The vocoder renders whole latent frames; trim to the predicted duration.
		Ok(wav[..wav_len.min(wav.len())].to_vec())
	}
}

/// Peak level the output is normalized to. Supertonic speaks at about -9 dBFS while
/// Piper normalizes to full scale, so without this its voices sound much quieter.
const TARGET_PEAK: f32 = 0.9;
/// Keeps near-silent output from being amplified into noise.
const MAX_GAIN: f32 = 3.0;

/// Peak-normalizes `samples` and converts them to 16-bit PCM.
fn to_pcm(samples: &[f32]) -> Vec<i16> {
	let peak = samples.iter().fold(0.0_f32, |peak, s| peak.max(s.abs()));
	let gain = if peak > 0.0 {
		(TARGET_PEAK / peak).min(MAX_GAIN)
	} else {
		1.0
	};
	samples
		.iter()
		.map(|sample| ((sample * gain).clamp(-1.0, 1.0) * 32767.0) as i16)
		.collect()
}

/// Standard normal samples (Box-Muller).
fn gaussian_noise(len: usize) -> Vec<f32> {
	let mut rng = rand::rng();
	let mut noise = Vec::with_capacity(len + 1);
	while noise.len() < len {
		let u1: f32 = rng.random::<f32>().max(f32::MIN_POSITIVE);
		let u2: f32 = rng.random::<f32>();
		let radius = (-2.0 * u1.ln()).sqrt();
		let angle = std::f32::consts::TAU * u2;
		noise.push(radius * angle.cos());
		noise.push(radius * angle.sin());
	}
	noise.truncate(len);
	noise
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn normalizes_peak_with_capped_gain() {
		assert_eq!(to_pcm(&[0.3, -0.45]), vec![19660, -29490]);
		// Quiet input gains at most MAX_GAIN.
		assert_eq!(to_pcm(&[0.01]), vec![983]);
		// Overshoot is attenuated, not clipped.
		assert_eq!(to_pcm(&[2.0, -1.0]), vec![29490, -14745]);
		assert_eq!(to_pcm(&[0.0]), vec![0]);
	}

	#[test]
	fn noise_is_roughly_standard_normal() {
		let noise = gaussian_noise(100_001);
		assert_eq!(noise.len(), 100_001);
		let mean = noise.iter().sum::<f32>() / noise.len() as f32;
		let variance =
			noise.iter().map(|x| (x - mean).powi(2)).sum::<f32>() / noise.len() as f32;
		assert!(mean.abs() < 0.02, "mean {mean}");
		assert!((variance - 1.0).abs() < 0.03, "variance {variance}");
	}
}
