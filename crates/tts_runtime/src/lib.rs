//! Pieces shared by the server's text-to-speech engines (`piper_tts`, `supertonic_tts`).
//!
//! ONNX Runtime allows a single environment per process, so every engine creates its
//! sessions from [`environment`] instead of calling `ort::init()` itself.

use std::sync::{Mutex, OnceLock};

pub use ort;
use ort::environment::Environment;

/// The process-wide ONNX Runtime environment, created on first use.
pub fn environment() -> ort::Result<&'static Environment> {
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
		.with_name("stump-tts")
		.with_telemetry(false)
		.build()?;
	Ok(ENVIRONMENT.get_or_init(|| environment))
}

/// Encodes 16-bit mono PCM as a WAV file.
pub fn encode_wav(samples: &[i16], sample_rate: u32) -> Vec<u8> {
	const CHANNELS: u16 = 1;
	const BITS_PER_SAMPLE: u16 = 16;
	let block_align = CHANNELS * BITS_PER_SAMPLE / 8;
	let data_len = (samples.len() * 2) as u32;

	let mut wav = Vec::with_capacity(44 + data_len as usize);
	wav.extend_from_slice(b"RIFF");
	wav.extend_from_slice(&(36 + data_len).to_le_bytes());
	wav.extend_from_slice(b"WAVEfmt ");
	wav.extend_from_slice(&16_u32.to_le_bytes());
	wav.extend_from_slice(&1_u16.to_le_bytes()); // PCM
	wav.extend_from_slice(&CHANNELS.to_le_bytes());
	wav.extend_from_slice(&sample_rate.to_le_bytes());
	wav.extend_from_slice(&(sample_rate * u32::from(block_align)).to_le_bytes());
	wav.extend_from_slice(&block_align.to_le_bytes());
	wav.extend_from_slice(&BITS_PER_SAMPLE.to_le_bytes());
	wav.extend_from_slice(b"data");
	wav.extend_from_slice(&data_len.to_le_bytes());
	for sample in samples {
		wav.extend_from_slice(&sample.to_le_bytes());
	}
	wav
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn encodes_wav_header() {
		let wav = encode_wav(&[0, 1, -1], 22_050);
		assert_eq!(wav.len(), 44 + 6);
		assert_eq!(&wav[0..4], b"RIFF");
		assert_eq!(&wav[8..12], b"WAVE");
		assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 22_050);
		assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()), 6);
		assert_eq!(&wav[46..48], &1_i16.to_le_bytes());
		assert_eq!(&wav[48..50], &(-1_i16).to_le_bytes());
	}
}
