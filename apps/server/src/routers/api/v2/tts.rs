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
use piper_tts::{EspeakConfig, PiperError, SynthesisOptions};
use serde::{Deserialize, Serialize};
use stump_core::config::StumpConfig;
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

/// Shared limit so a few readers cannot saturate the host with Piper jobs.
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

fn list_voices(voices_dir: &Path) -> Vec<TtsVoice> {
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

fn resolve_model_path(voices_dir: &Path, voice_id: &str) -> APIResult<PathBuf> {
	if voice_id.is_empty()
		|| voice_id.contains("..")
		|| voice_id.contains('/')
		|| voice_id.contains('\\')
	{
		return Err(APIError::BadRequest("Invalid voice id".to_string()));
	}

	let model_path = voices_dir.join(format!("{voice_id}.onnx"));
	if !model_path.is_file() {
		return Err(APIError::NotFound(format!(
			"Voice '{voice_id}' was not found"
		)));
	}

	Ok(model_path)
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
				warn!(%error, "Server TTS is unavailable");
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

async fn get_tts_status(
	State(ctx): State<AppState>,
	Extension(req): Extension<AuthContext>,
) -> APIResult<Json<TtsStatusResponse>> {
	enforce_tts_access(&req)?;

	let config = ctx.config.as_ref();
	// Piper is built in, so TTS is on whenever voices and espeak-ng are present.
	let voices_dir = config.get_piper_voices_dir();
	let voices = list_voices(&voices_dir);
	let default_voice = config
		.piper_default_voice
		.clone()
		.or_else(|| voices.first().map(|voice| voice.id.clone()));

	let enabled = !voices.is_empty() && espeak_available(espeak_config(config)).await;

	Ok(Json(TtsStatusResponse {
		enabled,
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

	let voices_dir = config.get_piper_voices_dir();
	let voices = list_voices(&voices_dir);
	if voices.is_empty() {
		return Err(APIError::ServiceUnavailable(
			"No Piper voices are installed on this server".to_string(),
		));
	}

	let voice_id = body
		.voice
		.filter(|value| !value.trim().is_empty())
		.or_else(|| config.piper_default_voice.clone())
		.or_else(|| voices.first().map(|voice| voice.id.clone()))
		.ok_or_else(|| {
			APIError::ServiceUnavailable("No Piper voice is available".to_string())
		})?;

	let model_path = resolve_model_path(&voices_dir, &voice_id)?;
	let rate = body.rate.unwrap_or(1.0).clamp(0.5, 2.0);
	// Piper length_scale: lower speaks faster.
	let length_scale = (1.0 / rate).clamp(0.5, 2.0);

	let permit = tts_semaphore().acquire_owned().await.map_err(|_| {
		APIError::ServiceUnavailable("TTS queue is unavailable".to_string())
	})?;

	let spoken_text = if tts_hu::is_hungarian_voice(&voice_id) {
		tts_hu::apply_pronunciation(text)
	} else {
		text.to_string()
	};
	let options = SynthesisOptions {
		// Only override when it changes duration; keeps the voice's own prosody at 1.0x.
		length_scale: ((length_scale - 1.0).abs() > f32::EPSILON).then_some(length_scale),
		..Default::default()
	};
	let espeak = espeak_config(config);

	let wav = tokio::task::spawn_blocking(move || {
		// Held by the worker so a disconnected client cannot free the slot while
		// synthesis is still running.
		let _permit = permit;
		piper_tts::synthesize_wav(&espeak, &model_path, &spoken_text, &options)
	})
	.await
	.map_err(|error| {
		error!(?error, "TTS worker task failed");
		APIError::InternalServerError("TTS worker task failed".to_string())
	})?
	.map_err(piper_error_to_api)?;

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
