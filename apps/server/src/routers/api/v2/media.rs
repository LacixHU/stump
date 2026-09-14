use axum::{
	body::Bytes,
	extract::{DefaultBodyLimit, Path, State},
	http::HeaderMap,
	middleware,
	response::IntoResponse,
	routing::get,
	Extension, Json, Router,
};
use graphql::data::AuthContext;
use models::{
	entity::{library, library_config, media, series, user::AuthUser},
	shared::image_processor_options::SupportedImageFormat,
};
use sea_orm::{prelude::*, sea_query::Query, QuerySelect};
use stump_core::{
	config::StumpConfig,
	filesystem::{
		get_saved_thumbnail, get_thumbnail,
		media::{get_page_async, RETRO_SAVE_STATE_MAX_BYTES},
		ContentType, FileError,
	},
	Ctx,
};

use crate::{
	config::state::AppState,
	errors::{APIError, APIResult},
	middleware::auth::auth_middleware,
	utils::{http::ImageResponse, retro_save_state, serve_media},
};

pub(crate) fn mount(app_state: AppState) -> Router<AppState> {
	Router::new()
		.route(
			"/media/{id}/retro-controls",
			get(get_media_retro_controls)
				.put(put_media_retro_controls)
				.post(put_media_retro_controls),
		)
		.route(
			"/media/{id}/save-state",
			get(get_media_save_state)
				.put(put_media_save_state)
				.delete(delete_media_save_state)
				// Axum's implicit body limit is 2 MiB, which is under the size of an
				// Amiga snapshot. Layered on the method router, not the parent, so the
				// other media routes keep the default.
				.layer(DefaultBodyLimit::max(RETRO_SAVE_STATE_MAX_BYTES)),
		)
		.nest(
			"/media/{id}",
			Router::new()
				.route("/thumbnail", get(get_media_thumbnail_handler))
				.route("/page/{page}", get(get_media_page))
				.route("/file", get(get_media_file))
				.route("/play-file", get(get_media_play_file)),
		)
		.layer(middleware::from_fn_with_state(app_state, auth_middleware))
}

/// Download the file associated with the media.
pub(crate) async fn get_media_file(
	Path(id): Path<String>,
	State(ctx): State<AppState>,
	Extension(req): Extension<AuthContext>,
	headers: HeaderMap,
) -> APIResult<impl IntoResponse> {
	serve_media::serve_media_file(req, headers, ctx.conn.as_ref(), id).await
}

/// Serve a retro disk/tape image for in-browser play (library access; no DownloadFile).
pub(crate) async fn get_media_play_file(
	Path(id): Path<String>,
	State(ctx): State<AppState>,
	Extension(req): Extension<AuthContext>,
	headers: HeaderMap,
) -> APIResult<impl IntoResponse> {
	serve_media::serve_media_play_file(req, headers, ctx.conn.as_ref(), id).await
}

/// Optional series-folder overlay keys for the retro player (library access).
pub(crate) async fn get_media_retro_controls(
	Path(id): Path<String>,
	State(ctx): State<AppState>,
	Extension(req): Extension<AuthContext>,
) -> APIResult<impl IntoResponse> {
	serve_media::serve_retro_controls(req, ctx.conn.as_ref(), id).await
}

/// Save series-folder overlay layout (ManageLibrary).
pub(crate) async fn put_media_retro_controls(
	Path(id): Path<String>,
	State(ctx): State<AppState>,
	Extension(req): Extension<AuthContext>,
	Json(body): Json<serve_media::RetroControlsBody>,
) -> APIResult<impl IntoResponse> {
	serve_media::save_retro_controls(req, ctx.conn.as_ref(), id, body).await
}

/// Fetch the current user's save state for a retro book (library access).
pub(crate) async fn get_media_save_state(
	Path(id): Path<String>,
	State(ctx): State<AppState>,
	Extension(req): Extension<AuthContext>,
) -> APIResult<impl IntoResponse> {
	retro_save_state::get_save_state(req, ctx.conn.as_ref(), &ctx.config, id).await
}

/// Store the current user's save state for a retro book (library access).
pub(crate) async fn put_media_save_state(
	Path(id): Path<String>,
	State(ctx): State<AppState>,
	Extension(req): Extension<AuthContext>,
	body: Bytes,
) -> APIResult<impl IntoResponse> {
	retro_save_state::put_save_state(req, ctx.conn.as_ref(), &ctx.config, id, body).await
}

/// Delete the current user's save state for a retro book (library access).
pub(crate) async fn delete_media_save_state(
	Path(id): Path<String>,
	State(ctx): State<AppState>,
	Extension(req): Extension<AuthContext>,
) -> APIResult<impl IntoResponse> {
	retro_save_state::delete_save_state(req, ctx.conn.as_ref(), &ctx.config, id).await
}

pub(crate) async fn get_media_thumbnail(
	book: &media::MediaThumbSelect,
	image_format: Option<SupportedImageFormat>,
	config: &StumpConfig,
) -> APIResult<(ContentType, Vec<u8>)> {
	// Note: This doesn't hard-fail because if the saved thumbnail is missing or corrupt, we want
	// to just pull something else instead of erroring out entirely.
	if let Some(path) = &book.thumbnail_path {
		match get_saved_thumbnail(std::path::Path::new(path)).await {
			Ok(result) => return Ok(result),
			Err(_) => {
				tracing::warn!(path = ?path, "Failed to get saved thumbnail");
			},
		}
	}

	let generated_thumb =
		get_thumbnail(config.get_thumbnails_dir(), &book.id, image_format).await?;

	let adjusted_config = StumpConfig {
		pdf_prerender_range: 0, // Disable PDF prerendering for thumbnails since we only need the first page
		..config.clone()
	};

	if let Some((content_type, bytes)) = generated_thumb {
		Ok((content_type, bytes))
	} else if book.pages < 1 {
		Err(APIError::NotFound(
			"No thumbnail available for this media".to_string(),
		))
	} else {
		Ok(get_page_async(&book.path, 1, &adjusted_config).await?)
	}
}

pub(crate) async fn get_media_thumbnail_by_id(
	ctx: &Ctx,
	user: &AuthUser,
	book_id: String,
) -> APIResult<ImageResponse> {
	let book = media::Entity::find_for_user(user)
		.columns(media::MediaThumbSelect::columns())
		.filter(media::Column::Id.eq(book_id))
		.into_model::<media::MediaThumbSelect>()
		.one(ctx.conn.as_ref())
		.await?
		.ok_or(APIError::NotFound("Book not found".to_string()))?;

	// Note: This doesn't hard-fail because if the saved thumbnail is missing or corrupt, we want
	// to just pull something else instead of erroring out entirely.
	if let Some(path) = &book.thumbnail_path {
		match get_saved_thumbnail(std::path::Path::new(path)).await {
			Ok(result) => return Ok(result.into()),
			Err(_) => {
				tracing::warn!(path = ?path, "Failed to get saved thumbnail");
			},
		}
	}

	let library_config = library_config::Entity::find()
		.filter(
			library_config::Column::LibraryId.in_subquery(
				Query::select()
					.column(library::Column::Id)
					.from(library::Entity)
					.and_where(
						library::Column::Id.in_subquery(
							Query::select()
								.column(series::Column::LibraryId)
								.from(series::Entity)
								.and_where(series::Column::Id.eq(book.series_id.clone()))
								.to_owned(),
						),
					)
					.to_owned(),
			),
		)
		.one(ctx.conn.as_ref())
		.await?;
	let image_format = library_config.and_then(|o| o.thumbnail_config.map(|c| c.format));

	get_media_thumbnail(&book, image_format, ctx.config.as_ref())
		.await
		.map(ImageResponse::from)
}

pub(crate) async fn get_media_thumbnail_handler(
	Path(id): Path<String>,
	State(ctx): State<AppState>,
	Extension(req): Extension<AuthContext>,
) -> APIResult<ImageResponse> {
	get_media_thumbnail_by_id(&ctx, &req.user(), id).await
}

async fn get_media_page(
	Path((id, page)): Path<(String, u32)>,
	State(ctx): State<AppState>,
	Extension(req): Extension<AuthContext>,
) -> APIResult<ImageResponse> {
	let book = media::Entity::find_for_user(&req.user())
		.filter(media::Column::Id.eq(id.clone()))
		.one(ctx.conn.as_ref())
		.await?
		.ok_or(APIError::NotFound("Book not found".to_string()))?;

	let content =
		match get_page_async(&book.path, page.try_into()?, ctx.config.as_ref()).await {
			Ok(result) => result,
			Err(e) => {
				if matches!(e, FileError::NoImageError) {
					return Err(APIError::NotFound("Page not found".to_string()));
				}
				return Err(APIError::InternalServerError(e.to_string()));
			},
		};

	Ok(ImageResponse::from(content))
}
