use std::path::Path;

use axum::response::Response;
use axum::{
	body::Body,
	extract::State,
	http::{HeaderMap, Request},
	response::IntoResponse,
	routing::get,
	Router,
};
use tower_http::services::{ServeDir, ServeFile};

use crate::{
	config::state::AppState,
	errors::{APIError, APIResult},
};

pub const FAVICON: &str = "/favicon.ico";
const REGISTER_SW: &str = "/registerSW.js";
const SW: &str = "/sw.js";
const MANIFEST: &str = "/manifest.webmanifest";
const ASSETS: &str = "/assets";
const DIST: &str = "/dist";

pub(crate) fn mount(app_state: AppState) -> Router<AppState> {
	let dist_path = Path::new(&app_state.config.client_dir);

	Router::new()
		.route(FAVICON, get(favicon))
		.route(REGISTER_SW, get(register_sw))
		.route(SW, get(sw))
		.route(MANIFEST, get(manifest))
		.nest_service(ASSETS, ServeDir::new(dist_path.join("assets")))
		.nest_service(DIST, ServeDir::new(dist_path))
		.fallback_service(ServeFile::new(dist_path.join("index.html")))
}

pub(crate) fn relative_favicon_path() -> String {
	format!("{ASSETS}{FAVICON}")
}

// https://github.com/tokio-rs/axum/discussions/608#discussioncomment-7772294
async fn favicon(
	State(ctx): State<AppState>,
	headers: HeaderMap,
) -> APIResult<impl IntoResponse> {
	serve_file_with_headers(
		headers,
		Path::new(&ctx.config.client_dir).join("favicon.ico"),
		"favicon.ico",
	)
	.await
}

async fn register_sw(
	State(ctx): State<AppState>,
	headers: HeaderMap,
) -> APIResult<impl IntoResponse> {
	let dist = Path::new(&ctx.config.client_dir);
	serve_first_existing_file(
		headers,
		vec![
			dist.join("registerSW.js"),
			dist.join("assets/registerSW.js"),
		],
		"registerSW.js",
	)
	.await
}

async fn sw(
	State(ctx): State<AppState>,
	headers: HeaderMap,
) -> APIResult<impl IntoResponse> {
	let dist = Path::new(&ctx.config.client_dir);
	serve_first_existing_file(
		headers,
		vec![dist.join("sw.js"), dist.join("assets/sw.js")],
		"sw.js",
	)
	.await
}

async fn manifest(
	State(ctx): State<AppState>,
	headers: HeaderMap,
) -> APIResult<impl IntoResponse> {
	let dist = Path::new(&ctx.config.client_dir);
	serve_first_existing_file(
		headers,
		vec![
			dist.join("manifest.webmanifest"),
			dist.join("assets/manifest.webmanifest"),
		],
		"manifest.webmanifest",
	)
	.await
}

async fn serve_first_existing_file(
	headers: HeaderMap,
	paths: Vec<std::path::PathBuf>,
	filename: &str,
) -> APIResult<Response> {
	for file_path in paths {
		if file_path.exists() {
			return serve_file_with_headers(headers, file_path, filename)
				.await
				.map(IntoResponse::into_response);
		}
	}

	tracing::debug!(filename, "Static file not found, returning 404");
	Ok(axum::response::Response::builder()
		.status(axum::http::StatusCode::NOT_FOUND)
		.body(axum::body::Body::empty())
		.unwrap())
}

async fn serve_file_with_headers(
	headers: HeaderMap,
	path: std::path::PathBuf,
	label: &str,
) -> APIResult<impl IntoResponse> {
	let mut req = Request::new(Body::empty());
	*req.headers_mut() = headers;

	match ServeFile::new(path).try_call(req).await {
		Ok(res) => Ok(res),
		Err(e) => {
			tracing::error!(error = ?e, file = label, "Error serving static file");
			Err(APIError::InternalServerError(e.to_string()))
		},
	}
}
