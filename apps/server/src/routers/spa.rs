use std::path::{Path, PathBuf};

use axum::{
	body::Body,
	extract::State,
	http::{header, HeaderMap, HeaderValue, Request, StatusCode},
	response::IntoResponse,
	response::Response,
	routing::get,
	Router,
};
use tower::ServiceBuilder;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;

use crate::{
	config::state::AppState,
	errors::{APIError, APIResult},
};

pub const FAVICON: &str = "/favicon.ico";
const REGISTER_SW: &str = "/registerSW.js";
const SW: &str = "/sw.js";
const MANIFEST: &str = "/manifest.webmanifest";
const INDEX: &str = "/";
const INDEX_HTML: &str = "/index.html";
const ASSETS: &str = "/assets";
const DIST: &str = "/dist";

pub(crate) fn mount(app_state: AppState) -> Router<AppState> {
	let dist_path = Path::new(&app_state.config.client_dir);
	let static_assets = ServiceBuilder::new()
		.layer(SetResponseHeaderLayer::if_not_present(
			header::VARY,
			HeaderValue::from_static("Accept-Encoding"),
		))
		.layer(SetResponseHeaderLayer::overriding(
			header::CACHE_CONTROL,
			HeaderValue::from_static("public, max-age=31536000, immutable, no-transform"),
		))
		.service(
			ServeDir::new(dist_path.join("assets"))
				.precompressed_br()
				.precompressed_gzip(),
		);

	let dist_files = ServiceBuilder::new()
		.layer(SetResponseHeaderLayer::if_not_present(
			header::VARY,
			HeaderValue::from_static("Accept-Encoding"),
		))
		.layer(SetResponseHeaderLayer::if_not_present(
			header::CACHE_CONTROL,
			HeaderValue::from_static("no-cache"),
		))
		.service(
			ServeDir::new(dist_path)
				.precompressed_br()
				.precompressed_gzip(),
		);

	let spa_fallback = ServiceBuilder::new()
		.layer(SetResponseHeaderLayer::if_not_present(
			header::CACHE_CONTROL,
			HeaderValue::from_static("no-cache"),
		))
		.service(ServeFile::new(dist_path.join("index.html")));

	Router::new()
		.route(INDEX, get(index_html))
		.route(INDEX_HTML, get(index_html))
		.route(FAVICON, get(favicon))
		.route(REGISTER_SW, get(register_sw))
		.route(SW, get(serve_sw))
		.route(MANIFEST, get(manifest))
		.nest_service(ASSETS, static_assets)
		.nest_service(DIST, dist_files)
		.fallback_service(spa_fallback)
}

pub(crate) fn relative_favicon_path() -> String {
	format!("{ASSETS}{FAVICON}")
}

// https://github.com/tokio-rs/axum/discussions/608#discussioncomment-7772294
async fn favicon(
	State(ctx): State<AppState>,
	headers: HeaderMap,
) -> APIResult<impl IntoResponse> {
	let mut response = serve_dist_file(ctx, headers, "favicon.ico").await?;
	response.headers_mut().insert(
		header::CACHE_CONTROL,
		HeaderValue::from_static("public, max-age=86400"),
	);

	Ok(response)
}

async fn index_html(
	State(ctx): State<AppState>,
	headers: HeaderMap,
) -> APIResult<impl IntoResponse> {
	serve_with_no_cache(ctx, headers, "index.html").await
}

async fn serve_sw(
	State(ctx): State<AppState>,
	headers: HeaderMap,
) -> APIResult<impl IntoResponse> {
	let dist = Path::new(&ctx.config.client_dir);
	serve_first_existing_no_cache(
		headers,
		vec![dist.join("sw.js"), dist.join("assets/sw.js")],
		"sw.js",
	)
	.await
}

async fn register_sw(
	State(ctx): State<AppState>,
	headers: HeaderMap,
) -> APIResult<impl IntoResponse> {
	let dist = Path::new(&ctx.config.client_dir);
	serve_first_existing_no_cache(
		headers,
		vec![
			dist.join("registerSW.js"),
			dist.join("assets/registerSW.js"),
		],
		"registerSW.js",
	)
	.await
}

async fn manifest(
	State(ctx): State<AppState>,
	headers: HeaderMap,
) -> APIResult<impl IntoResponse> {
	let dist = Path::new(&ctx.config.client_dir);
	serve_first_existing_no_cache(
		headers,
		vec![
			dist.join("manifest.webmanifest"),
			dist.join("assets/manifest.webmanifest"),
		],
		"manifest.webmanifest",
	)
	.await
}

async fn serve_with_no_cache(
	ctx: AppState,
	headers: HeaderMap,
	path: &str,
) -> APIResult<Response> {
	let mut response = serve_dist_file(ctx, headers, path).await?;
	response
		.headers_mut()
		.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));

	Ok(response)
}

async fn serve_first_existing_no_cache(
	headers: HeaderMap,
	paths: Vec<PathBuf>,
	label: &str,
) -> APIResult<Response> {
	for file_path in paths {
		if file_path.exists() {
			let mut req = Request::new(Body::empty());
			*req.headers_mut() = headers;
			return match ServeFile::new(file_path).try_call(req).await {
				Ok(res) => {
					let mut response = res.into_response();
					response.headers_mut().insert(
						header::CACHE_CONTROL,
						HeaderValue::from_static("no-cache"),
					);
					Ok(response)
				},
				Err(e) => {
					tracing::error!(error = ?e, file = label, "Error serving static file");
					Err(APIError::InternalServerError(e.to_string()))
				},
			};
		}
	}

	tracing::debug!(filename = label, "Static file not found, returning 404");
	Ok(Response::builder()
		.status(StatusCode::NOT_FOUND)
		.body(Body::empty())
		.unwrap())
}

async fn serve_dist_file(
	ctx: AppState,
	headers: HeaderMap,
	path: &str,
) -> APIResult<Response> {
	let mut req = Request::new(Body::empty());
	*req.headers_mut() = headers;

	match ServeFile::new(Path::new(&ctx.config.client_dir).join(path))
		.try_call(req)
		.await
	{
		Ok(res) => Ok(res.into_response()),
		Err(e) => {
			tracing::error!(error = ?e, path, "Error serving dist file");
			Err(APIError::InternalServerError(e.to_string()))
		},
	}
}
