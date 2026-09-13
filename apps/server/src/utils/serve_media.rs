//! Utilities for serving media files, thumbnails, etc.

use std::path::Path;

use axum::{
	body::Body,
	extract::Request,
	http::{header, HeaderMap},
	response::IntoResponse,
	Json,
};
use graphql::data::AuthContext;
use models::{
	entity::media::{self},
	shared::enums::UserPermission,
};
use serde::{Deserialize, Serialize};
use stump_core::filesystem::{
	media::{
		find_series_controls_json, parse_retro_controls, sanitize_retro_overlay_keys,
		series_controls_json_write_path, RetroOverlayKey, RETRO_CONTROLS_MAX_BYTES,
	},
	ContentType, FileParts, PathUtils,
};
use tower_http::services::ServeFile;

use sea_orm::prelude::*;

use crate::errors::{APIError, APIResult};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetroControlsResponse {
	keys: Vec<RetroOverlayKey>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetroControlsBody {
	keys: Vec<RetroOverlayKey>,
}

enum Disposition {
	Attachment,
	Inline,
}

/// Looks up a piece of media in the database, checks that the user has permission to
/// download it, and serves the media file to the client.
pub async fn serve_media_file(
	req: AuthContext,
	headers: HeaderMap,
	conn: &DatabaseConnection,
	media_id: String,
) -> APIResult<impl IntoResponse> {
	let user = req
		.user_and_enforce_permissions(&[UserPermission::DownloadFile])
		.map_err(|_| {
			tracing::error!("User does not have permission to download file");
			APIError::forbidden_discreet()
		})?;

	let book = media::Entity::find_for_user(&user)
		.filter(media::Column::Id.eq(media_id))
		.into_model::<media::MediaIdentSelect>()
		.one(conn)
		.await?
		.ok_or(APIError::NotFound("Book not found".to_string()))?;

	serve_path(&book.path, headers, Disposition::Attachment).await
}

/// Serve a retro disk/tape image for in-browser play.
///
/// Auth: library access only (same as page read). Does **not** require `DownloadFile`.
/// Defense in depth: only retro extensions are allowed so this path cannot exfiltrate books.
pub async fn serve_media_play_file(
	req: AuthContext,
	headers: HeaderMap,
	conn: &DatabaseConnection,
	media_id: String,
) -> APIResult<impl IntoResponse> {
	let user = req.user();

	let book = media::Entity::find_for_user(&user)
		.filter(media::Column::Id.eq(media_id))
		.into_model::<media::MediaIdentSelect>()
		.one(conn)
		.await?
		.ok_or_else(APIError::forbidden_discreet)?;

	let FileParts { extension, .. } = std::path::Path::new(&book.path).file_parts();
	if !ContentType::is_retro_extension(&extension) {
		tracing::warn!(
			path = %book.path,
			extension = %extension,
			"play-file rejected for non-retro media"
		);
		return Err(APIError::BadRequest(
			"play-file is only available for retro disk/tape images".to_string(),
		));
	}

	serve_path(&book.path, headers, Disposition::Inline).await
}

/// Serve optional series-folder `controls.json` extra overlay keys for the retro player.
///
/// Auth: library access only. Missing, oversized, or invalid files yield an empty list.
pub async fn serve_retro_controls(
	req: AuthContext,
	conn: &DatabaseConnection,
	media_id: String,
) -> APIResult<Json<RetroControlsResponse>> {
	let user = req.user();

	let book = media::Entity::find_for_user(&user)
		.filter(media::Column::Id.eq(media_id))
		.into_model::<media::MediaIdentSelect>()
		.one(conn)
		.await?
		.ok_or_else(APIError::forbidden_discreet)?;

	let FileParts { extension, .. } = Path::new(&book.path).file_parts();
	if !ContentType::is_retro_extension(&extension) {
		return Err(APIError::BadRequest(
			"retro-controls is only available for retro disk/tape images".to_string(),
		));
	}

	let empty = || Json(RetroControlsResponse { keys: Vec::new() });

	let Some(path) = find_series_controls_json(Path::new(&book.path)) else {
		return Ok(empty());
	};

	let meta = match tokio::fs::metadata(&path).await {
		Ok(m) => m,
		Err(_) => return Ok(empty()),
	};
	if meta.len() > RETRO_CONTROLS_MAX_BYTES {
		tracing::warn!(
			path = %path.display(),
			size = meta.len(),
			"controls.json exceeds size limit"
		);
		return Ok(empty());
	}

	let bytes = match tokio::fs::read(&path).await {
		Ok(b) => b,
		Err(_) => return Ok(empty()),
	};

	Ok(Json(RetroControlsResponse {
		keys: parse_retro_controls(&bytes),
	}))
}

/// Write series-folder overlay layout. Requires ManageLibrary.
pub async fn save_retro_controls(
	req: AuthContext,
	conn: &DatabaseConnection,
	media_id: String,
	body: RetroControlsBody,
) -> APIResult<Json<RetroControlsResponse>> {
	let user = req
		.user_and_enforce_permissions(&[UserPermission::ManageLibrary])
		.map_err(|_| APIError::forbidden_discreet())?;

	let book = media::Entity::find_for_user(&user)
		.filter(media::Column::Id.eq(media_id))
		.into_model::<media::MediaIdentSelect>()
		.one(conn)
		.await?
		.ok_or_else(APIError::forbidden_discreet)?;

	let FileParts { extension, .. } = Path::new(&book.path).file_parts();
	if !ContentType::is_retro_extension(&extension) {
		return Err(APIError::BadRequest(
			"retro-controls is only available for retro disk/tape images".to_string(),
		));
	}

	let keys = sanitize_retro_overlay_keys(&body.keys);
	let payload = serde_json::to_vec_pretty(&serde_json::json!({ "keys": keys }))
		.map_err(|e| APIError::InternalServerError(e.to_string()))?;
	if payload.len() as u64 > RETRO_CONTROLS_MAX_BYTES {
		return Err(APIError::BadRequest(
			"controls.json would exceed size limit".to_string(),
		));
	}

	let path =
		series_controls_json_write_path(Path::new(&book.path)).ok_or_else(|| {
			APIError::InternalServerError(
				"Could not resolve controls.json path".to_string(),
			)
		})?;

	tokio::fs::write(&path, &payload).await.map_err(|e| {
		tracing::error!(error = ?e, path = %path.display(), "Failed to write controls.json");
		APIError::InternalServerError(format!("Failed to write {}: {e}", path.display()))
	})?;

	Ok(Json(RetroControlsResponse { keys }))
}

async fn serve_path(
	path: &str,
	headers: HeaderMap,
	disposition: Disposition,
) -> APIResult<impl IntoResponse> {
	// Note: I am reusing the original headers to support range requests
	let mut serve_req = Request::new(Body::empty());
	*serve_req.headers_mut() = headers;

	match ServeFile::new(path).try_call(serve_req).await {
		Ok(mut response) => {
			if let Some(filename) = std::path::Path::new(path)
				.file_name()
				.and_then(|os_str| os_str.to_str())
			{
				let value = match disposition {
					Disposition::Attachment => {
						format!("attachment; filename=\"{}\"", filename)
					},
					Disposition::Inline => {
						format!("inline; filename=\"{}\"", filename)
					},
				};
				response.headers_mut().insert(
					header::CONTENT_DISPOSITION,
					value.parse().unwrap_or_else(|_| match disposition {
						Disposition::Attachment => "attachment".parse().unwrap(),
						Disposition::Inline => "inline".parse().unwrap(),
					}),
				);
			}
			Ok(response)
		},
		Err(e) => {
			tracing::error!(error = ?e, path = %path, "Error serving media file");
			Err(APIError::InternalServerError(format!(
				"Failed to serve file: {}",
				e
			)))
		},
	}
}
