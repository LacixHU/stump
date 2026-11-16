use axum::{
	body::Bytes,
	extract::{DefaultBodyLimit, Path, Query as QueryParams, State},
	http::{header, HeaderMap},
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
use serde::Deserialize;
use stump_core::{
	config::StumpConfig,
	filesystem::{
		get_saved_thumbnail, get_thumbnail,
		media::{
			get_page_async,
			pdf_viewer::{
				get_pdf_html_info, get_pdf_html_page as get_pdf_html_page_document,
				get_pdf_html_thumbnail, get_pdf_page_text, get_pdf_svg_page, PdfHtmlInfo,
				PdfPageText,
			},
			RETRO_SAVE_STATE_MAX_BYTES,
		},
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
				.head(head_media_save_state)
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
				.route("/pdf/info", get(get_pdf_info))
				.route("/pdf/page/{page}", get(get_pdf_html_page))
				.route("/pdf/thumbnail/{page}", get(get_pdf_page_thumbnail))
				.route("/pdf/svg/{page}", get(get_pdf_page_svg))
				.route("/pdf/text/{page}", get(get_pdf_page_text_layer))
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

/// Check whether the current user has a save state, without transferring the snapshot.
pub(crate) async fn head_media_save_state(
	Path(id): Path<String>,
	State(ctx): State<AppState>,
	Extension(req): Extension<AuthContext>,
) -> APIResult<impl IntoResponse> {
	retro_save_state::head_save_state(req, ctx.conn.as_ref(), &ctx.config, id).await
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

/// The page documents run their own script, so they are locked into an opaque origin
/// (`sandbox`) even when opened directly, and may load nothing from anywhere.
const PDF_PAGE_CSP: &str = "sandbox allow-scripts; default-src 'none'; img-src data:; \
	style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
/// Page SVGs are only meant for `<img>`, where they cannot run scripts anyway; this
/// keeps them inert when opened directly too.
const PDF_SVG_CSP: &str = "sandbox; default-src 'none'; img-src data:; 	style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
const PDF_VIEWER_CACHE_CONTROL: &str = "private,max-age=3600";

async fn find_pdf_for_user(
	ctx: &AppState,
	req: &AuthContext,
	id: String,
) -> APIResult<media::Model> {
	let book = media::Entity::find_for_user(&req.user())
		.filter(media::Column::Id.eq(id))
		.one(ctx.conn.as_ref())
		.await?
		.ok_or(APIError::NotFound("Book not found".to_string()))?;
	if !book.extension.eq_ignore_ascii_case("pdf") {
		return Err(APIError::BadRequest("Book is not a PDF".to_string()));
	}
	Ok(book)
}

fn pdf_viewer_error(error: FileError) -> APIError {
	match error {
		FileError::PdfProcessingError(message) if message.contains("out of range") => {
			APIError::NotFound(message)
		},
		error => APIError::InternalServerError(error.to_string()),
	}
}

/// Page count and page sizes of a PDF, for the HTML PDF reader.
async fn get_pdf_info(
	Path(id): Path<String>,
	State(ctx): State<AppState>,
	Extension(req): Extension<AuthContext>,
) -> APIResult<Json<PdfHtmlInfo>> {
	let book = find_pdf_for_user(&ctx, &req, id).await?;
	let info = get_pdf_html_info(&book.path)
		.await
		.map_err(pdf_viewer_error)?;
	Ok(Json(info))
}

/// One page of a PDF as a standalone HTML document (vector SVG + text layer), meant
/// for an iframe.
async fn get_pdf_html_page(
	Path((id, page)): Path<(String, u32)>,
	State(ctx): State<AppState>,
	Extension(req): Extension<AuthContext>,
) -> APIResult<impl IntoResponse> {
	let book = find_pdf_for_user(&ctx, &req, id).await?;
	let html = get_pdf_html_page_document(
		&book.path,
		page.try_into()?,
		Some(book.name.clone()),
		ctx.config.as_ref(),
	)
	.await
	.map_err(pdf_viewer_error)?;

	Ok((
		[
			(header::CONTENT_TYPE, "text/html; charset=utf-8"),
			(header::CONTENT_SECURITY_POLICY, PDF_PAGE_CSP),
			(header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
			(header::CACHE_CONTROL, PDF_VIEWER_CACHE_CONTROL),
		],
		html,
	))
}

/// One page of a PDF as a vector SVG image (white background, sized in points).
async fn get_pdf_page_svg(
	Path((id, page)): Path<(String, u32)>,
	State(ctx): State<AppState>,
	Extension(req): Extension<AuthContext>,
) -> APIResult<impl IntoResponse> {
	let book = find_pdf_for_user(&ctx, &req, id).await?;
	let svg = get_pdf_svg_page(&book.path, page.try_into()?, ctx.config.as_ref())
		.await
		.map_err(pdf_viewer_error)?;

	Ok((
		[
			(header::CONTENT_TYPE, "image/svg+xml"),
			(header::CONTENT_SECURITY_POLICY, PDF_SVG_CSP),
			(header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
			(header::CACHE_CONTROL, PDF_VIEWER_CACHE_CONTROL),
		],
		svg,
	))
}

/// The text of one PDF page with positions, for read aloud.
async fn get_pdf_page_text_layer(
	Path((id, page)): Path<(String, u32)>,
	State(ctx): State<AppState>,
	Extension(req): Extension<AuthContext>,
) -> APIResult<Json<PdfPageText>> {
	let book = find_pdf_for_user(&ctx, &req, id).await?;
	let text = get_pdf_page_text(&book.path, page.try_into()?)
		.await
		.map_err(pdf_viewer_error)?;
	Ok(Json(text))
}

#[derive(Deserialize)]
struct PdfThumbnailQuery {
	/// Longer edge of the preview, in pixels.
	size: Option<u32>,
}

/// A WebP preview of one PDF page.
async fn get_pdf_page_thumbnail(
	Path((id, page)): Path<(String, u32)>,
	QueryParams(PdfThumbnailQuery { size }): QueryParams<PdfThumbnailQuery>,
	State(ctx): State<AppState>,
	Extension(req): Extension<AuthContext>,
) -> APIResult<impl IntoResponse> {
	let book = find_pdf_for_user(&ctx, &req, id).await?;
	let webp =
		get_pdf_html_thumbnail(&book.path, page.try_into()?, size, ctx.config.as_ref())
			.await
			.map_err(pdf_viewer_error)?;

	Ok((
		[
			(header::CONTENT_TYPE, "image/webp"),
			(header::CACHE_CONTROL, PDF_VIEWER_CACHE_CONTROL),
		],
		webp,
	))
}
