//! Server-side emulator save states.
//!
//! A save state is the complete memory image of the emulated machine. The bytes live on
//! disk under [`StumpConfig::get_save_states_dir`]; the database only carries a small
//! metadata row so we can answer "does this user have a save for this game?" without
//! touching the filesystem, and so the rows disappear with the user or the book.
//!
//! There is exactly one save state per (user, book) -- a unique index enforces it.

use std::path::Path;

use axum::{
	body::Bytes,
	http::{header, StatusCode},
	response::{IntoResponse, Response},
	Json,
};
use graphql::data::AuthContext;
use models::entity::{media, media_save_state, user::AuthUser};
use sea_orm::{prelude::*, ActiveValue, IntoActiveModel};
use serde::Serialize;
use stump_core::{
	config::StumpConfig,
	filesystem::{
		media::{
			read_save_state, remove_save_state, save_state_path, write_save_state,
			RETRO_SAVE_STATE_MAX_BYTES,
		},
		ContentType, FileError, FileParts, PathUtils,
	},
};

use crate::errors::{APIError, APIResult};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveStateResponse {
	pub media_id: String,
	pub size_bytes: i32,
	pub updated_at: String,
}

impl From<media_save_state::Model> for SaveStateResponse {
	fn from(model: media_save_state::Model) -> Self {
		Self {
			media_id: model.media_id,
			size_bytes: model.size_bytes,
			updated_at: model.updated_at.to_rfc3339(),
		}
	}
}

/// Resolve the book being played, enforcing the same access rules as `play-file`.
///
/// Library access is all that is required: a save state is the user's own data about a
/// book they can already reach, so this deliberately does not demand `DownloadFile` (or
/// any other permission) the way a real download does.
async fn resolve_retro_book(
	req: &AuthContext,
	conn: &DatabaseConnection,
	media_id: String,
) -> APIResult<(AuthUser, media::MediaIdentSelect)> {
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
			"save states are only available for retro disk/tape images".to_string(),
		));
	}

	Ok((user, book))
}

/// Fetch the save state bytes for the current user.
///
/// Answers `404` when there is no save. That is the normal state of affairs for a game
/// the user has not saved yet, so it is returned as a bare status rather than an
/// [`APIError`] -- every `APIError` response is logged at error level, and a user
/// clicking Load on a fresh game is not an error.
pub async fn get_save_state(
	req: AuthContext,
	conn: &DatabaseConnection,
	config: &StumpConfig,
	media_id: String,
) -> APIResult<Response> {
	let (user, book) = resolve_retro_book(&req, conn, media_id).await?;

	let Some(row) = media_save_state::Entity::find_for_user_and_media_id(&user, &book.id)
		.one(conn)
		.await?
	else {
		return Ok(StatusCode::NOT_FOUND.into_response());
	};

	let save_states_dir = config.get_save_states_dir();
	let Some(bytes) = read_save_state(&save_states_dir, &book.id, &user.id).await? else {
		// The row outlived its file -- a restored backup, a wiped config dir, a manual
		// cleanup. The filesystem is the source of truth for the bytes, so drop the
		// stale row and report what is actually true: there is no save.
		tracing::warn!(
			media_id = %book.id,
			path = %save_state_path(&save_states_dir, &book.id, &user.id).display(),
			"Save state row has no file on disk, removing the stale row"
		);
		row.into_active_model().delete(conn).await?;
		return Ok(StatusCode::NOT_FOUND.into_response());
	};

	Ok((
		[
			(header::CONTENT_TYPE, "application/octet-stream"),
			// A stale snapshot is worse than no snapshot: it would silently rewind the
			// player to a state they already moved past.
			(header::CACHE_CONTROL, "no-store"),
		],
		bytes,
	)
		.into_response())
}

/// Answer whether the current user has a save state, without sending the bytes.
///
/// Used by the player to prompt before overwriting. 404 is the normal "never saved"
/// case and is a bare status so it is not logged as an error.
pub async fn head_save_state(
	req: AuthContext,
	conn: &DatabaseConnection,
	config: &StumpConfig,
	media_id: String,
) -> APIResult<Response> {
	let (user, book) = resolve_retro_book(&req, conn, media_id).await?;

	let Some(row) = media_save_state::Entity::find_for_user_and_media_id(&user, &book.id)
		.one(conn)
		.await?
	else {
		return Ok(StatusCode::NOT_FOUND.into_response());
	};

	let path = save_state_path(&config.get_save_states_dir(), &book.id, &user.id);
	let exists = tokio::fs::try_exists(&path)
		.await
		.map_err(FileError::from)?;

	if !exists {
		tracing::warn!(
			media_id = %book.id,
			path = %path.display(),
			"Save state row has no file on disk, removing the stale row"
		);
		row.into_active_model().delete(conn).await?;
		return Ok(StatusCode::NOT_FOUND.into_response());
	}

	Ok(([(header::CACHE_CONTROL, "no-store")], StatusCode::OK).into_response())
}

/// Store (or replace) the current user's save state for this book.
pub async fn put_save_state(
	req: AuthContext,
	conn: &DatabaseConnection,
	config: &StumpConfig,
	media_id: String,
	bytes: Bytes,
) -> APIResult<Json<SaveStateResponse>> {
	let (user, book) = resolve_retro_book(&req, conn, media_id).await?;

	if bytes.is_empty() {
		return Err(APIError::BadRequest(
			"a save state cannot be empty".to_string(),
		));
	}

	// The route also carries a `DefaultBodyLimit`, which rejects oversized bodies before
	// they reach us. This is the backstop for the case where the two drift apart.
	if bytes.len() > RETRO_SAVE_STATE_MAX_BYTES {
		return Err(APIError::BadRequest(format!(
			"save state exceeds the maximum size of {RETRO_SAVE_STATE_MAX_BYTES} bytes"
		)));
	}

	let size_bytes = i32::try_from(bytes.len()).map_err(|_| {
		APIError::BadRequest("save state is too large to record".to_string())
	})?;

	// Write the file before the row. A failed write then leaves the previous (row, file)
	// pair consistent; doing it the other way round would leave a row advertising a
	// snapshot that was never written.
	let save_states_dir = config.get_save_states_dir();
	write_save_state(&save_states_dir, &book.id, &user.id, &bytes).await?;

	let existing = media_save_state::Entity::find_for_user_and_media_id(&user, &book.id)
		.one(conn)
		.await?;

	// Note: this is a find-then-write rather than an upsert on the unique index. Tests
	// build their schema from the entities, which does not carry standalone indexes, so
	// an `ON CONFLICT` clause would work in production and fail in CI.
	let model = match existing {
		Some(row) => {
			let mut active = row.into_active_model();
			active.size_bytes = ActiveValue::Set(size_bytes);
			active.update(conn).await?
		},
		None => {
			media_save_state::ActiveModel {
				user_id: ActiveValue::Set(user.id.clone()),
				media_id: ActiveValue::Set(book.id.clone()),
				size_bytes: ActiveValue::Set(size_bytes),
				..Default::default()
			}
			.insert(conn)
			.await?
		},
	};

	Ok(Json(SaveStateResponse::from(model)))
}

/// Delete the current user's save state for this book.
pub async fn delete_save_state(
	req: AuthContext,
	conn: &DatabaseConnection,
	config: &StumpConfig,
	media_id: String,
) -> APIResult<Response> {
	let (user, book) = resolve_retro_book(&req, conn, media_id).await?;

	let Some(row) = media_save_state::Entity::find_for_user_and_media_id(&user, &book.id)
		.one(conn)
		.await?
	else {
		return Ok(StatusCode::NOT_FOUND.into_response());
	};

	// Row first: a file with no row is invisible to every code path, while a row with no
	// file would have to be self-healed on the next read.
	row.into_active_model().delete(conn).await?;
	remove_save_state(&config.get_save_states_dir(), &book.id, &user.id).await?;

	Ok(StatusCode::NO_CONTENT.into_response())
}
