use std::path::{Component, Path};

use axum::{
	body::Body,
	extract::{Path as AxumPath, Request, State},
	http::{header, HeaderMap},
	middleware,
	response::IntoResponse,
	routing::get,
	Extension, Router,
};
use graphql::data::AuthContext;
use tower_http::services::ServeFile;

use crate::{
	config::state::AppState,
	errors::{APIError, APIResult},
	middleware::auth::auth_middleware,
};

pub(crate) fn mount(app_state: AppState) -> Router<AppState> {
	Router::new()
		.route("/firmware/{file_name}", get(get_firmware_file))
		.layer(middleware::from_fn_with_state(app_state, auth_middleware))
}

/// Serve a user-supplied firmware/BIOS file from `STUMP_FIRMWARE_DIR`.
///
/// Auth: any authenticated user. Path is restricted to a single basename under the
/// firmware directory (rejects `..`, absolute paths, nested paths).
async fn get_firmware_file(
	AxumPath(file_name): AxumPath<String>,
	State(ctx): State<AppState>,
	Extension(_req): Extension<AuthContext>,
	headers: HeaderMap,
) -> APIResult<impl IntoResponse> {
	let safe_name = sanitize_firmware_basename(&file_name)
		.ok_or_else(|| APIError::BadRequest("Invalid firmware file name".to_string()))?;

	let firmware_dir = ctx.config.get_firmware_dir();
	let full_path = firmware_dir.join(&safe_name);

	// Ensure resolved path stays under firmware_dir (defense in depth)
	let canonical_dir = match tokio::fs::canonicalize(&firmware_dir).await {
		Ok(p) => p,
		Err(_) => {
			return Err(APIError::NotFound("Firmware not found".to_string()));
		},
	};

	if !full_path.exists() {
		return Err(APIError::NotFound("Firmware not found".to_string()));
	}

	let canonical_file = tokio::fs::canonicalize(&full_path)
		.await
		.map_err(|_| APIError::NotFound("Firmware not found".to_string()))?;

	if !canonical_file.starts_with(&canonical_dir) {
		tracing::error!(
			?canonical_file,
			?canonical_dir,
			"Firmware path escaped firmware directory"
		);
		return Err(APIError::BadRequest(
			"Invalid firmware file name".to_string(),
		));
	}

	let mut serve_req = Request::new(Body::empty());
	*serve_req.headers_mut() = headers;

	match ServeFile::new(&canonical_file).try_call(serve_req).await {
		Ok(mut response) => {
			response.headers_mut().insert(
				header::CONTENT_DISPOSITION,
				format!("inline; filename=\"{}\"", safe_name)
					.parse()
					.unwrap_or_else(|_| "inline".parse().unwrap()),
			);
			Ok(response)
		},
		Err(e) => {
			tracing::error!(error = ?e, path = ?canonical_file, "Error serving firmware");
			Err(APIError::InternalServerError(format!(
				"Failed to serve firmware: {}",
				e
			)))
		},
	}
}

/// Accept only a single path component (basename). Reject empty, `.`, `..`, separators.
fn sanitize_firmware_basename(name: &str) -> Option<String> {
	if name.is_empty() || name == "." || name == ".." {
		return None;
	}
	if name.contains('/') || name.contains('\\') || name.contains('\0') {
		return None;
	}

	let path = Path::new(name);
	let mut components = path.components();
	match (components.next(), components.next()) {
		(Some(Component::Normal(os)), None) => {
			let s = os.to_str()?;
			if s.is_empty() || s == "." || s == ".." {
				None
			} else {
				Some(s.to_string())
			}
		},
		_ => None,
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn test_sanitize_basename() {
		assert_eq!(
			sanitize_firmware_basename("kickstart.rom"),
			Some("kickstart.rom".into())
		);
		assert_eq!(sanitize_firmware_basename("../etc/passwd"), None);
		assert_eq!(sanitize_firmware_basename("/etc/passwd"), None);
		assert_eq!(sanitize_firmware_basename("a/b"), None);
		assert_eq!(sanitize_firmware_basename(".."), None);
		assert_eq!(sanitize_firmware_basename(""), None);
	}
}
