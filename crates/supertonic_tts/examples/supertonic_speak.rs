//! Manual check of a Supertonic model.
//!
//! ```text
//! echo "Jó reggelt kívánok." | cargo run --release -p supertonic_tts --example supertonic_speak -- \
//!     voices/supertonic-3 F1 hu out.wav [steps]
//! ```

use std::{io::Read, path::PathBuf};

use supertonic_tts::SynthesisOptions;

const USAGE: &str =
	"usage: supertonic_speak <model dir> <voice> <lang> <out.wav> [steps]";

fn main() -> Result<(), Box<dyn std::error::Error>> {
	let mut args = std::env::args().skip(1);
	let model_dir = PathBuf::from(args.next().ok_or(USAGE)?);
	let voice = args.next().ok_or(USAGE)?;
	let lang = args.next().ok_or(USAGE)?;
	let output = PathBuf::from(args.next().ok_or(USAGE)?);
	let steps = args.next().map(|steps| steps.parse()).transpose()?;

	let mut text = String::new();
	std::io::stdin().read_to_string(&mut text)?;

	let info =
		supertonic_tts::find_model(&model_dir).ok_or("no Supertonic model there")?;
	println!("voices: {}", info.voices.join(", "));

	let options = SynthesisOptions {
		steps,
		..Default::default()
	};
	// The first call includes loading the model; the second shows steady-state speed.
	for run in ["cold", "warm"] {
		let started = std::time::Instant::now();
		let wav =
			supertonic_tts::synthesize_wav(&model_dir, &voice, &lang, &text, &options)?;
		let seconds = (wav.len() - 44) as f64 / 2.0 / 44_100.0;
		std::fs::write(&output, &wav)?;
		println!(
			"{run}: wrote {} ({seconds:.1}s of audio) in {:?}",
			output.display(),
			started.elapsed()
		);
	}

	Ok(())
}
