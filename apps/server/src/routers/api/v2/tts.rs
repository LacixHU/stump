use std::{
	path::{Path, PathBuf},
	sync::{
		atomic::{AtomicBool, Ordering},
		Arc,
	},
};

use axum::{
	extract::State,
	http::{header, HeaderValue, StatusCode},
	middleware,
	response::{IntoResponse, Response},
	routing::{get, post},
	Extension, Json, Router,
};
use graphql::data::AuthContext;
use models::shared::enums::UserPermission;
use piper_tts::{EspeakConfig, PiperError};
use serde::{Deserialize, Serialize};
use stump_core::config::StumpConfig;
use supertonic_tts::SupertonicError;
use tokio::sync::Semaphore;
use tracing::{error, warn};

use crate::{
	config::state::AppState,
	errors::{APIError, APIResult},
	middleware::auth::auth_middleware,
};

#[path = "tts_hu.rs"]
mod tts_hu;

const MAX_CONCURRENT_TTS: usize = 2;

/// Shared limit so a few readers cannot saturate the host with TTS jobs.
static TTS_SEMAPHORE: std::sync::OnceLock<Arc<Semaphore>> = std::sync::OnceLock::new();

fn tts_semaphore() -> Arc<Semaphore> {
	TTS_SEMAPHORE
		.get_or_init(|| Arc::new(Semaphore::new(MAX_CONCURRENT_TTS)))
		.clone()
}

pub(crate) fn mount(app_state: AppState) -> Router<AppState> {
	Router::new()
		.route("/tts", get(get_tts_status))
		.route("/tts/speak", post(speak_tts))
		.layer(middleware::from_fn_with_state(app_state, auth_middleware))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TtsVoice {
	id: String,
	label: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TtsStatusResponse {
	enabled: bool,
	default_voice: Option<String>,
	voices: Vec<TtsVoice>,
	max_chars: usize,
}

fn enforce_tts_access(req: &AuthContext) -> APIResult<()> {
	req.user_and_enforce_permissions(&[UserPermission::AccessServerTts])
		.map(|_| ())
		.map_err(|_| {
			APIError::Forbidden(
				"You do not have permission to use server text-to-speech".to_string(),
			)
		})
}

fn list_piper_voices(voices_dir: &Path) -> Vec<TtsVoice> {
	let Ok(entries) = std::fs::read_dir(voices_dir) else {
		return vec![];
	};

	let mut voices = entries
		.filter_map(|entry| entry.ok())
		.filter_map(|entry| {
			let path = entry.path();
			if path.extension().and_then(|ext| ext.to_str()) != Some("onnx") {
				return None;
			}
			let id = path.file_stem()?.to_str()?.to_string();
			if id.is_empty() || !piper_tts::voice_config_path(&path).is_file() {
				return None;
			}
			Some(TtsVoice {
				label: id.replace('-', " ").replace('_', " "),
				id,
			})
		})
		.collect::<Vec<_>>();

	voices.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()));
	voices
}

/// Language of a Piper voice from its file name (`hu_HU-anna-medium` → `hu`).
fn piper_voice_language(voice_id: &str) -> String {
	voice_id
		.split(['_', '-'])
		.next()
		.unwrap_or_default()
		.to_ascii_lowercase()
}

/// Supertonic languages to offer: `supertonic_languages` from the config (`all` or a
/// comma-separated list), else English plus the languages of the Piper voices.
/// Sorted by language name.
fn supertonic_languages(
	setting: Option<&str>,
	piper_voices: &[TtsVoice],
) -> Vec<&'static str> {
	let all = supertonic_tts::LANGUAGES.iter().map(|(code, _)| *code);
	let mut languages: Vec<&'static str> = match setting.map(str::trim) {
		Some(list) if list.eq_ignore_ascii_case("all") => all.collect(),
		Some(list) => {
			let wanted: Vec<String> = list
				.split(',')
				.map(|code| code.trim().to_ascii_lowercase())
				.collect();
			all.filter(|code| wanted.iter().any(|wanted| wanted == code))
				.collect()
		},
		None => all
			.filter(|code| {
				*code == "en"
					|| piper_voices
						.iter()
						.any(|voice| piper_voice_language(&voice.id) == *code)
			})
			.collect(),
	};
	languages.sort_by_key(|code| supertonic_tts::language_name(code));
	languages
}

/// Supertonic model folders directly inside the voices directory, by folder name.
fn supertonic_models(voices_dir: &Path) -> Vec<(String, supertonic_tts::ModelInfo)> {
	let Ok(entries) = std::fs::read_dir(voices_dir) else {
		return vec![];
	};
	let mut models = entries
		.filter_map(|entry| entry.ok())
		.filter(|entry| entry.path().is_dir())
		.filter_map(|entry| {
			let name = entry.file_name().to_str()?.to_string();
			// The folder name is part of voice ids, which use `:` as the separator.
			if !is_safe_path_segment(&name) || name.contains(':') {
				return None;
			}
			Some((name, supertonic_tts::find_model(&entry.path())?))
		})
		.collect::<Vec<_>>();
	models.sort_by(|a, b| a.0.cmp(&b.0));
	models
}

/// Readable model name from its folder: `supertonic-3` → `Supertonic 3`.
fn model_label(folder: &str) -> String {
	let label = folder.replace(['-', '_'], " ");
	let mut chars = label.chars();
	chars
		.next()
		.map(|first| first.to_uppercase().chain(chars).collect())
		.unwrap_or_default()
}

/// One voice per model, language and voice style, with ids like `supertonic-3:hu:F1`.
/// File names cannot contain `:` on Windows, so these never collide with Piper ids.
fn list_supertonic_voices(voices_dir: &Path, languages: &[&str]) -> Vec<TtsVoice> {
	let mut voices = Vec::new();
	for (folder, model) in supertonic_models(voices_dir) {
		let model_label = model_label(&folder);
		for lang in languages {
			let language = supertonic_tts::language_name(lang).unwrap_or(lang);
			for style in &model.voices {
				voices.push(TtsVoice {
					id: format!("{folder}:{lang}:{style}"),
					label: format!("{model_label} {language} {style}"),
				});
			}
		}
	}
	voices
}

/// All usable voices: Piper voices (when espeak-ng works), then Supertonic voices.
async fn available_voices(config: &StumpConfig) -> Vec<TtsVoice> {
	let voices_dir = config.get_piper_voices_dir();
	let piper_voices = list_piper_voices(&voices_dir);
	let languages =
		supertonic_languages(config.supertonic_languages.as_deref(), &piper_voices);
	let supertonic_voices = list_supertonic_voices(&voices_dir, &languages);

	let mut voices =
		if !piper_voices.is_empty() && espeak_available(espeak_config(config)).await {
			piper_voices
		} else {
			vec![]
		};
	voices.extend(supertonic_voices);
	voices
}

#[derive(Debug, PartialEq)]
enum ResolvedVoice {
	Piper(PathBuf),
	Supertonic {
		model_dir: PathBuf,
		lang: String,
		style: String,
	},
}

fn is_safe_path_segment(value: &str) -> bool {
	!value.is_empty()
		&& !value.contains("..")
		&& !value.contains('/')
		&& !value.contains('\\')
}

fn resolve_voice(voices_dir: &Path, voice_id: &str) -> APIResult<ResolvedVoice> {
	let invalid = || APIError::BadRequest("Invalid voice id".to_string());
	let not_found = || APIError::NotFound(format!("Voice '{voice_id}' was not found"));

	if let Some((folder, rest)) = voice_id.split_once(':') {
		let (lang, style) = rest.split_once(':').ok_or_else(invalid)?;
		if !is_safe_path_segment(folder) || supertonic_tts::language_name(lang).is_none()
		{
			return Err(invalid());
		}
		let model =
			supertonic_tts::find_model(&voices_dir.join(folder)).ok_or_else(not_found)?;
		if !model.voices.iter().any(|voice| voice == style) {
			return Err(not_found());
		}
		return Ok(ResolvedVoice::Supertonic {
			model_dir: model.dir,
			lang: lang.to_string(),
			style: style.to_string(),
		});
	}

	if !is_safe_path_segment(voice_id) {
		return Err(invalid());
	}
	let model_path = voices_dir.join(format!("{voice_id}.onnx"));
	if !model_path.is_file() {
		return Err(not_found());
	}
	Ok(ResolvedVoice::Piper(model_path))
}

fn espeak_config(config: &StumpConfig) -> EspeakConfig {
	EspeakConfig {
		// espeak-ng is built in, but reads its data from files unpacked here.
		data_dir: Some(config.get_config_dir().join("espeak-ng")),
	}
}

/// Whether the built-in espeak-ng (needed by every Piper voice) is ready. Logs the
/// reason once so a failure is visible without spamming each status poll.
async fn espeak_available(config: EspeakConfig) -> bool {
	static WARNED: AtomicBool = AtomicBool::new(false);

	let result = tokio::task::spawn_blocking(move || piper_tts::check_espeak(&config))
		.await
		.unwrap_or_else(|error| {
			Err(PiperError::EspeakUnavailable(format!(
				"check task failed: {error}"
			)))
		});

	match result {
		Ok(()) => true,
		Err(error) => {
			if !WARNED.swap(true, Ordering::Relaxed) {
				warn!(%error, "Piper voices are unavailable");
			}
			false
		},
	}
}

fn piper_error_to_api(error: PiperError) -> APIError {
	match error {
		PiperError::EspeakUnavailable(_) => {
			warn!(%error, "Server TTS is unavailable");
			APIError::ServiceUnavailable(format!(
				"Server text-to-speech is unavailable: {error}"
			))
		},
		PiperError::VoiceNotFound(_) => APIError::NotFound(error.to_string()),
		error => {
			error!(%error, "Piper failed to synthesize speech");
			APIError::InternalServerError("Piper failed to synthesize speech".to_string())
		},
	}
}

fn supertonic_error_to_api(error: SupertonicError) -> APIError {
	match error {
		SupertonicError::VoiceNotFound(_) | SupertonicError::ModelNotFound(_) => {
			APIError::NotFound(error.to_string())
		},
		SupertonicError::UnsupportedLanguage(_) => {
			APIError::BadRequest(error.to_string())
		},
		error => {
			error!(%error, "Supertonic failed to synthesize speech");
			APIError::InternalServerError(
				"Supertonic failed to synthesize speech".to_string(),
			)
		},
	}
}

async fn get_tts_status(
	State(ctx): State<AppState>,
	Extension(req): Extension<AuthContext>,
) -> APIResult<Json<TtsStatusResponse>> {
	enforce_tts_access(&req)?;

	let config = ctx.config.as_ref();
	// The engines are built in, so TTS is on whenever a usable voice is installed.
	let voices = available_voices(config).await;
	let default_voice = config
		.piper_default_voice
		.clone()
		.or_else(|| voices.first().map(|voice| voice.id.clone()));

	Ok(Json(TtsStatusResponse {
		enabled: !voices.is_empty(),
		default_voice,
		voices,
		max_chars: config.server_tts_max_chars,
	}))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpeakTtsRequest {
	text: String,
	voice: Option<String>,
	/// Playback speed multiplier (same scale as Web Speech rate, ~0.5–2.0).
	rate: Option<f32>,
}

async fn speak_tts(
	State(ctx): State<AppState>,
	Extension(req): Extension<AuthContext>,
	Json(body): Json<SpeakTtsRequest>,
) -> APIResult<Response> {
	enforce_tts_access(&req)?;

	let config = ctx.config.as_ref();

	let text = body.text.trim();
	if text.is_empty() {
		return Err(APIError::BadRequest("Text is required".to_string()));
	}
	if text.chars().count() > config.server_tts_max_chars {
		return Err(APIError::BadRequest(format!(
			"Text exceeds the maximum of {} characters",
			config.server_tts_max_chars
		)));
	}

	let requested = body
		.voice
		.filter(|value| !value.trim().is_empty())
		.or_else(|| config.piper_default_voice.clone());
	let voice_id = match requested {
		Some(voice_id) => voice_id,
		None => available_voices(config)
			.await
			.into_iter()
			.next()
			.map(|voice| voice.id)
			.ok_or_else(|| {
				APIError::ServiceUnavailable(
					"No TTS voices are installed on this server".to_string(),
				)
			})?,
	};

	let voice = resolve_voice(&config.get_piper_voices_dir(), &voice_id)?;
	let rate = body.rate.unwrap_or(1.0).clamp(0.5, 2.0);

	let hungarian = match &voice {
		ResolvedVoice::Piper(_) => tts_hu::is_hungarian_voice(&voice_id),
		ResolvedVoice::Supertonic { lang, .. } => lang == "hu",
	};
	let spoken_text = if hungarian {
		tts_hu::apply_pronunciation(text)
	} else {
		text.to_string()
	};

	let permit = tts_semaphore().acquire_owned().await.map_err(|_| {
		APIError::ServiceUnavailable("TTS queue is unavailable".to_string())
	})?;

	let espeak = espeak_config(config);
	let supertonic_steps = config.supertonic_steps;
	let wav = tokio::task::spawn_blocking(move || {
		// Held by the worker so a disconnected client cannot free the slot while
		// synthesis is still running.
		let _permit = permit;
		match voice {
			ResolvedVoice::Piper(model_path) => {
				// Piper length_scale: lower speaks faster.
				let length_scale = (1.0 / rate).clamp(0.5, 2.0);
				let options = piper_tts::SynthesisOptions {
					// Only override when it changes duration; keeps the voice's own
					// prosody at 1.0x.
					length_scale: ((length_scale - 1.0).abs() > f32::EPSILON)
						.then_some(length_scale),
					..Default::default()
				};
				piper_tts::synthesize_wav(&espeak, &model_path, &spoken_text, &options)
					.map_err(piper_error_to_api)
			},
			ResolvedVoice::Supertonic {
				model_dir,
				lang,
				style,
			} => {
				let options = supertonic_tts::SynthesisOptions {
					speed: Some(supertonic_tts::DEFAULT_SPEED * rate),
					steps: Some(supertonic_steps),
					..Default::default()
				};
				supertonic_tts::synthesize_wav(
					&model_dir,
					&style,
					&lang,
					&spoken_text,
					&options,
				)
				.map_err(supertonic_error_to_api)
			},
		}
	})
	.await
	.map_err(|error| {
		error!(?error, "TTS worker task failed");
		APIError::InternalServerError("TTS worker task failed".to_string())
	})??;

	let mut response = wav.into_response();
	response
		.headers_mut()
		.insert(header::CONTENT_TYPE, HeaderValue::from_static("audio/wav"));
	response
		.headers_mut()
		.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
	*response.status_mut() = StatusCode::OK;

	Ok(response)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn voice(id: &str) -> TtsVoice {
		TtsVoice {
			id: id.to_string(),
			label: id.to_string(),
		}
	}

	#[test]
	fn reads_piper_voice_language() {
		assert_eq!(piper_voice_language("hu_HU-anna-medium"), "hu");
		assert_eq!(piper_voice_language("en_US-lessac-high"), "en");
	}

	#[test]
	fn defaults_supertonic_languages_to_english_and_piper_languages() {
		let piper = [
			voice("hu_HU-anna-medium"),
			voice("no_NO-talesyntese-medium"),
		];
		// Norwegian has no Supertonic voice; sorted by language name.
		assert_eq!(supertonic_languages(None, &piper), vec!["en", "hu"]);
		assert_eq!(supertonic_languages(None, &[]), vec!["en"]);
	}

	#[test]
	fn reads_supertonic_languages_setting() {
		assert_eq!(
			supertonic_languages(Some(" HU, de ,xx"), &[]),
			vec!["de", "hu"]
		);
		assert_eq!(supertonic_languages(Some("all"), &[]).len(), 31);
	}

	#[test]
	fn labels_model_folders() {
		assert_eq!(model_label("supertonic-3"), "Supertonic 3");
	}

	#[test]
	fn rejects_unsafe_voice_ids() {
		let dir = Path::new("voices");
		for id in [
			"../x",
			"a/b",
			"a\\b",
			"..:hu:F1",
			"supertonic-3:xx:F1",
			"x:hu",
		] {
			assert!(
				matches!(resolve_voice(dir, id), Err(APIError::BadRequest(_))),
				"{id}"
			);
		}
	}
}
