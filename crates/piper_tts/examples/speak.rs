//! Manual check against the Piper executable.
//!
//! ```text
//! echo "Hello there." | cargo run -p piper_tts --example speak -- voice.onnx out.wav
//! ```
//!
//! Prints the phoneme ids per sentence (compare with `piper --debug`) and writes the
//! WAV. espeak-ng is built in; its data unpacks to the system temp directory.

use std::{io::Read, path::PathBuf};

use piper_tts::{EspeakConfig, SynthesisOptions};

fn main() -> Result<(), Box<dyn std::error::Error>> {
	let mut args = std::env::args().skip(1);
	let model = PathBuf::from(args.next().ok_or("usage: speak <model.onnx> <out.wav>")?);
	let output = PathBuf::from(args.next().ok_or("usage: speak <model.onnx> <out.wav>")?);

	let mut text = String::new();
	std::io::stdin().read_to_string(&mut text)?;

	let espeak = EspeakConfig::default();

	for ids in piper_tts::text_to_phoneme_ids(&espeak, &model, &text)? {
		let ids = ids.iter().map(i64::to_string).collect::<Vec<_>>();
		println!("{}", ids.join(", "));
	}

	let started = std::time::Instant::now();
	let wav =
		piper_tts::synthesize_wav(&espeak, &model, &text, &SynthesisOptions::default())?;
	std::fs::write(&output, &wav)?;
	println!(
		"wrote {} ({} bytes) in {:?}",
		output.display(),
		wav.len(),
		started.elapsed()
	);

	Ok(())
}
