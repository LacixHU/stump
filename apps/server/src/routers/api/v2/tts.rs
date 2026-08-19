use std::{
	io::Write,
	path::{Path, PathBuf},
	process::{Command, Stdio},
	sync::Arc,
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
use serde::{Deserialize, Serialize};
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
			if id.is_empty() {
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

async fn get_tts_status(
	State(ctx): State<AppState>,
	Extension(req): Extension<AuthContext>,
) -> APIResult<Json<TtsStatusResponse>> {
	enforce_tts_access(&req)?;

	let config = ctx.config.as_ref();
	if !config.enable_server_tts {
		return Ok(Json(TtsStatusResponse {
			enabled: false,
			default_voice: None,
			voices: vec![],
			max_chars: config.server_tts_max_chars,
		}));
	}

	let voices_dir = config.get_piper_voices_dir();
	let voices = list_voices(&voices_dir);
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
	if !config.enable_server_tts {
		return Err(APIError::ServiceUnavailable(
			"Server text-to-speech is disabled".to_string(),
		));
	}

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

	let piper_path = config.get_piper_path();
	let spoken_text = if tts_hu::is_hungarian_voice(&voice_id) {
		tts_hu::apply_pronunciation(text)
	} else {
		text.to_string()
	};

	let wav =
		match synthesize_with_piper(&piper_path, &model_path, &spoken_text, length_scale)
			.await
		{
			Ok(bytes) => bytes,
			Err(err) => {
				drop(permit);
				return Err(err);
			},
		};
	drop(permit);

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

async fn synthesize_with_piper(
	piper_path: &Path,
	model_path: &Path,
	text: &str,
	length_scale: f32,
) -> APIResult<Vec<u8>> {
	let piper_path = piper_path.to_path_buf();
	let model_path = model_path.to_path_buf();
	let text = text.to_string();

	tokio::task::spawn_blocking(move || {
		// Write to a temp WAV file. Piper stdout (`-`) is unreliable on some
		// Windows builds and can yield non-WAV/raw bytes that browsers play as noise.
		let temp_dir = std::env::temp_dir();
		let temp_path = temp_dir.join(format!(
			"stump-tts-{}-{}.wav",
			std::process::id(),
			std::time::SystemTime::now()
				.duration_since(std::time::UNIX_EPOCH)
				.map(|d| d.as_nanos())
				.unwrap_or(0)
		));

		let mut command = Command::new(&piper_path);
		command
			.arg("--model")
			.arg(&model_path)
			.arg("--output_file")
			.arg(&temp_path)
			.stdin(Stdio::piped())
			.stdout(Stdio::null())
			.stderr(Stdio::piped());

		// Only pass length_scale when it changes duration; keeps default prosody at 1.0x.
		if (length_scale - 1.0).abs() > f32::EPSILON {
			command.arg("--length_scale").arg(length_scale.to_string());
		}

		let result = (|| {
			let mut child = command.spawn().map_err(|error| {
				error!(?error, ?piper_path, "Failed to spawn Piper");
				APIError::ServiceUnavailable(format!(
					"Failed to start Piper ({}): {error}",
					piper_path.display()
				))
			})?;

			if let Some(mut stdin) = child.stdin.take() {
				stdin.write_all(text.as_bytes()).map_err(|error| {
					error!(?error, "Failed to write text to Piper stdin");
					APIError::InternalServerError(
						"Failed to send text to Piper".to_string(),
					)
				})?;
				drop(stdin);
			} else {
				return Err(APIError::InternalServerError(
					"Failed to open Piper stdin".to_string(),
				));
			}

			let output = child.wait_with_output().map_err(|error| {
				error!(?error, "Failed waiting for Piper");
				APIError::InternalServerError("Piper process failed".to_string())
			})?;

			if !output.status.success() {
				let stderr = String::from_utf8_lossy(&output.stderr);
				warn!(%stderr, code = ?output.status.code(), "Piper exited with error");
				return Err(APIError::InternalServerError(
					"Piper failed to synthesize speech".to_string(),
				));
			}

			let bytes = std::fs::read(&temp_path).map_err(|error| {
				error!(?error, ?temp_path, "Failed to read Piper WAV output");
				APIError::InternalServerError(
					"Failed to read Piper audio output".to_string(),
				)
			})?;

			if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
				warn!(bytes = bytes.len(), "Piper output is not a valid WAV file");
				return Err(APIError::InternalServerError(
					"Piper returned invalid audio (expected WAV)".to_string(),
				));
			}

			Ok(bytes)
		})();

		if let Err(error) = std::fs::remove_file(&temp_path) {
			// File may not exist if Piper failed before writing.
			tracing::debug!(?error, ?temp_path, "Temp Piper WAV cleanup skipped");
		}

		result
	})
	.await
	.map_err(|error| {
		error!(?error, "TTS worker task failed");
		APIError::InternalServerError("TTS worker task failed".to_string())
	})?
}
