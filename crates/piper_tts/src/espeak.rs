//! Text → IPA phonemes via espeak-ng, ported from piper-phonemize's `phonemize_eSpeak`.
//!
//! espeak-ng (GPL-3.0) is compiled into this crate by `build.rs`. Its compiled
//! phoneme and dictionary data is embedded too, and unpacked to disk on first use
//! because espeak-ng only reads data from files. espeak-ng keeps process-global
//! state, so every call is serialized through [`ESPEAK`].

use std::{
	ffi::{c_char, c_int, c_void, CStr, CString},
	fs,
	path::{Component, Path, PathBuf},
	sync::Mutex,
};

use unicode_normalization::UnicodeNormalization;

use crate::{
	error::{PiperError, PiperResult},
	EspeakConfig, Phoneme,
};

const AUDIO_OUTPUT_SYNCHRONOUS: c_int = 2;
/// Return an error instead of calling `exit()` when initialization fails.
const ESPEAK_INITIALIZE_DONT_EXIT: c_int = 0x8000;
const ESPEAK_CHARS_AUTO: c_int = 0;
const ESPEAK_PHONEMES_IPA: c_int = 0x02;

// Clause terminator flags from espeak-ng's speak_lib.h.
const CLAUSE_INTONATION_FULL_STOP: c_int = 0x0000_0000;
const CLAUSE_INTONATION_COMMA: c_int = 0x0000_1000;
const CLAUSE_INTONATION_QUESTION: c_int = 0x0000_2000;
const CLAUSE_INTONATION_EXCLAMATION: c_int = 0x0000_3000;
const CLAUSE_TYPE_CLAUSE: c_int = 0x0004_0000;
const CLAUSE_TYPE_SENTENCE: c_int = 0x0008_0000;

const CLAUSE_PERIOD: c_int = 40 | CLAUSE_INTONATION_FULL_STOP | CLAUSE_TYPE_SENTENCE;
const CLAUSE_COMMA: c_int = 20 | CLAUSE_INTONATION_COMMA | CLAUSE_TYPE_CLAUSE;
const CLAUSE_QUESTION: c_int = 40 | CLAUSE_INTONATION_QUESTION | CLAUSE_TYPE_SENTENCE;
const CLAUSE_EXCLAMATION: c_int =
	45 | CLAUSE_INTONATION_EXCLAMATION | CLAUSE_TYPE_SENTENCE;
const CLAUSE_COLON: c_int = 30 | CLAUSE_INTONATION_FULL_STOP | CLAUSE_TYPE_CLAUSE;
const CLAUSE_SEMICOLON: c_int = 30 | CLAUSE_INTONATION_COMMA | CLAUSE_TYPE_CLAUSE;

// Linked statically by build.rs.
extern "C" {
	fn espeak_Initialize(
		output: c_int,
		buflength: c_int,
		path: *const c_char,
		options: c_int,
	) -> c_int;
	fn espeak_SetVoiceByName(name: *const c_char) -> c_int;
	fn espeak_TextToPhonemesWithTerminator(
		textptr: *mut *const c_void,
		textmode: c_int,
		phonememode: c_int,
		terminator: *mut c_int,
	) -> *const c_char;
}

/// espeak-ng's compiled data (see `pack_data` in build.rs for the format).
static DATA_ARCHIVE: &[u8] =
	include_bytes!(concat!(env!("OUT_DIR"), "/espeak-ng-data.zst"));
/// espeak-ng version plus a hash of [`DATA_ARCHIVE`], so new data never mixes with old.
const DATA_ID: &str = env!("PIPER_ESPEAK_DATA_ID");
const DATA_DIR_PREFIX: &str = "espeak-ng-";
const COMPLETE_MARKER: &str = ".complete";

static ESPEAK: Mutex<Option<Espeak>> = Mutex::new(None);

struct Espeak {
	/// Holds `espeak-ng-data`; dictionaries are read from it whenever the voice
	/// language changes, so it has to stay on disk.
	root: PathBuf,
}

/// Unpacks the data and initializes espeak-ng if that has not happened yet.
pub(crate) fn ensure_loaded(config: &EspeakConfig) -> PiperResult<()> {
	with_espeak(config, |_| Ok(()))
}

/// Phonemizes `text` with the given espeak-ng voice (e.g. `en-us`), returning one
/// phoneme list per sentence. Punctuation is kept as phonemes, as Piper models expect.
pub(crate) fn phonemize(
	config: &EspeakConfig,
	voice: &str,
	text: &str,
) -> PiperResult<Vec<Vec<Phoneme>>> {
	with_espeak(config, |espeak| espeak.phonemize(voice, text))
}

fn with_espeak<T>(
	config: &EspeakConfig,
	f: impl FnOnce(&Espeak) -> PiperResult<T>,
) -> PiperResult<T> {
	let mut guard = ESPEAK
		.lock()
		.unwrap_or_else(|poisoned| poisoned.into_inner());
	match guard.as_ref() {
		// Put the files back if something (e.g. a cache cleanup) removed them; espeak-ng
		// keeps using the same path.
		Some(espeak) if !espeak.root.join(COMPLETE_MARKER).is_file() => {
			unpack_data(&espeak.root)?;
		},
		Some(_) => {},
		None => *guard = Some(Espeak::init(config)?),
	}
	f(guard.as_ref().expect("espeak-ng is initialized"))
}

fn data_parent(config: &EspeakConfig) -> PathBuf {
	config
		.data_dir
		.clone()
		.unwrap_or_else(|| std::env::temp_dir().join("piper_tts"))
}

/// Writes the embedded data to `root/espeak-ng-data` unless it is already there.
fn unpack_data(root: &Path) -> PiperResult<()> {
	let marker = root.join(COMPLETE_MARKER);
	if marker.is_file() {
		return Ok(());
	}
	let fail = |what: &str, path: &Path, error: std::io::Error| {
		PiperError::EspeakUnavailable(format!(
			"failed to {what} {}: {error}",
			path.display()
		))
	};

	let raw = zstd::decode_all(DATA_ARCHIVE).map_err(|error| {
		PiperError::EspeakUnavailable(format!(
			"embedded espeak-ng data is corrupt: {error}"
		))
	})?;
	let corrupt =
		|| PiperError::EspeakUnavailable("embedded espeak-ng data is corrupt".into());

	let data_dir = root.join("espeak-ng-data");
	let mut rest = raw.as_slice();
	while !rest.is_empty() {
		let (name_len, tail) = split_le::<4>(rest).ok_or_else(corrupt)?;
		let name_len = u32::from_le_bytes(name_len) as usize;
		let (name, tail) = (tail.get(..name_len), tail.get(name_len..));
		let name = name
			.and_then(|name| std::str::from_utf8(name).ok())
			.ok_or_else(corrupt)?;
		let (size, tail) =
			split_le::<8>(tail.ok_or_else(corrupt)?).ok_or_else(corrupt)?;
		let size = usize::try_from(u64::from_le_bytes(size)).map_err(|_| corrupt())?;
		let bytes = tail.get(..size).ok_or_else(corrupt)?;
		rest = &tail[size..];

		let relative = Path::new(name);
		if !relative
			.components()
			.all(|part| matches!(part, Component::Normal(_)))
		{
			return Err(corrupt());
		}
		let path = data_dir.join(relative);
		if let Some(parent) = path.parent() {
			fs::create_dir_all(parent).map_err(|error| fail("create", parent, error))?;
		}
		fs::write(&path, bytes).map_err(|error| fail("write", &path, error))?;
	}

	fs::write(&marker, DATA_ID).map_err(|error| fail("write", &marker, error))?;
	tracing::info!(path = %data_dir.display(), "Unpacked espeak-ng data for Piper TTS");
	Ok(())
}

fn split_le<const N: usize>(bytes: &[u8]) -> Option<([u8; N], &[u8])> {
	let head = bytes.get(..N)?.try_into().ok()?;
	Some((head, &bytes[N..]))
}

/// Removes data unpacked by other versions of this crate.
fn remove_stale_data(parent: &Path, current: &Path) {
	let Ok(entries) = fs::read_dir(parent) else {
		return;
	};
	for entry in entries.flatten() {
		let path = entry.path();
		let is_ours = entry
			.file_name()
			.to_str()
			.is_some_and(|name| name.starts_with(DATA_DIR_PREFIX));
		if is_ours && path != current && path.is_dir() {
			// Best effort: another server version may still be running from it.
			let _ = fs::remove_dir_all(&path);
		}
	}
}

impl Espeak {
	fn init(config: &EspeakConfig) -> PiperResult<Self> {
		let parent = data_parent(config);
		let root = parent.join(format!("{DATA_DIR_PREFIX}{DATA_ID}"));
		unpack_data(&root)?;
		remove_stale_data(&parent, &root);

		// espeak-ng opens its files with narrow-character C APIs, which only handle
		// non-ASCII paths in the system code page on Windows.
		let root_c = root
			.to_str()
			.filter(|path| !cfg!(windows) || path.is_ascii())
			.and_then(|path| CString::new(path).ok())
			.ok_or_else(|| {
				PiperError::EspeakUnavailable(format!(
					"espeak-ng cannot read data from {}; choose a directory whose path \
					 has only ASCII characters",
					root.display()
				))
			})?;

		// SAFETY: root_c outlives the call; espeak-ng copies the path.
		let result = unsafe {
			espeak_Initialize(
				AUDIO_OUTPUT_SYNCHRONOUS,
				0,
				root_c.as_ptr(),
				ESPEAK_INITIALIZE_DONT_EXIT,
			)
		};
		if result < 0 {
			return Err(PiperError::EspeakUnavailable(format!(
				"espeak_Initialize failed (code {result}) with data in {}",
				root.display()
			)));
		}

		tracing::info!(data = %root.display(), "Initialized espeak-ng for Piper TTS");
		Ok(Self { root })
	}

	fn phonemize(&self, voice: &str, text: &str) -> PiperResult<Vec<Vec<Phoneme>>> {
		let voice_c = CString::new(voice)
			.map_err(|_| PiperError::Espeak(format!("invalid voice name '{voice}'")))?;
		// SAFETY: voice_c is a valid NUL-terminated string for the duration of the call.
		let result = unsafe { espeak_SetVoiceByName(voice_c.as_ptr()) };
		if result != 0 {
			return Err(PiperError::Espeak(format!(
				"failed to set voice '{voice}' (code {result})"
			)));
		}

		let text_c = CString::new(text.replace('\0', ""))
			.expect("interior NUL bytes were removed");
		let mut text_ptr = text_c.as_ptr() as *const c_void;

		let mut sentences: Vec<Vec<Phoneme>> = Vec::new();
		let mut sentence_open = false;

		while !text_ptr.is_null() {
			let mut terminator: c_int = 0;

			// SAFETY: text_ptr points into text_c, which espeak-ng advances clause by
			// clause and sets to NULL at the end. The returned buffer is owned by
			// espeak-ng and only valid until the next call, so it is copied at once.
			let clause = unsafe {
				let phonemes = espeak_TextToPhonemesWithTerminator(
					&mut text_ptr,
					ESPEAK_CHARS_AUTO,
					ESPEAK_PHONEMES_IPA,
					&mut terminator,
				);
				if phonemes.is_null() {
					String::new()
				} else {
					CStr::from_ptr(phonemes).to_string_lossy().into_owned()
				}
			};

			if !sentence_open {
				sentences.push(Vec::new());
				sentence_open = true;
			}
			let sentence = sentences.last_mut().expect("a sentence was just opened");

			// Decompose (e.g. "ç" -> "c" + "̧") and drop "(lang)" switch flags that
			// surround words espeak-ng reads with another language.
			let mut in_language_flag = false;
			for phoneme in clause.nfd() {
				if in_language_flag {
					if phoneme == ')' {
						in_language_flag = false;
					}
				} else if phoneme == '(' {
					in_language_flag = true;
				} else {
					sentence.push(phoneme);
				}
			}

			match terminator & 0x000F_FFFF {
				CLAUSE_PERIOD => sentence.push('.'),
				CLAUSE_QUESTION => sentence.push('?'),
				CLAUSE_EXCLAMATION => sentence.push('!'),
				CLAUSE_COMMA => sentence.extend([',', ' ']),
				CLAUSE_COLON => sentence.extend([':', ' ']),
				CLAUSE_SEMICOLON => sentence.extend([';', ' ']),
				_ => {},
			}

			if terminator & CLAUSE_TYPE_SENTENCE == CLAUSE_TYPE_SENTENCE {
				sentence_open = false;
			}
		}

		Ok(sentences)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn phonemizes_with_bundled_espeak() {
		let dir =
			std::env::temp_dir().join(format!("piper_tts-test-{}", std::process::id()));
		let config = EspeakConfig {
			data_dir: Some(dir.clone()),
		};

		let sentences = phonemize(&config, "en-us", "Hello there. How are you?").unwrap();
		assert_eq!(sentences.len(), 2);
		assert_eq!(sentences[0].last(), Some(&'.'));
		assert_eq!(sentences[1].last(), Some(&'?'));
		assert!(sentences[0].contains(&'h'));

		// Hungarian uses its own dictionary, loaded from the unpacked data.
		let hungarian = phonemize(&config, "hu", "Jó napot kívánok!").unwrap();
		assert_eq!(hungarian.len(), 1);
		assert_eq!(hungarian[0].last(), Some(&'!'));

		let _ = fs::remove_dir_all(dir);
	}
}
