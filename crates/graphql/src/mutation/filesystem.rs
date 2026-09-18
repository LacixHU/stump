use std::path::{Component, Path, PathBuf};

use async_graphql::{Context, InputObject, Object, Result, Upload, UploadValue};
use chrono::Utc;
use models::{
	entity::{library, media, series},
	shared::enums::UserPermission,
};
use sea_orm::{
	prelude::*, ActiveValue::Set, ColumnTrait, EntityTrait, IntoActiveModel, QueryFilter,
};
use stump_core::job::stump_job::StumpJob;
use tokio::fs;

use crate::{
	data::{AuthContext, CoreContext},
	guard::PermissionGuard,
};

#[derive(Default)]
pub struct FilesystemMutation;

#[derive(InputObject)]
struct CreateDirectoryInput {
	library_id: String,
	place_at: String,
	name: String,
}

#[derive(InputObject)]
struct RenamePathInput {
	library_id: String,
	path: String,
	new_name: String,
}

#[derive(InputObject)]
struct DeletePathInput {
	library_id: String,
	path: String,
}

#[derive(InputObject)]
struct UploadFilesInput {
	library_id: String,
	place_at: String,
	uploads: Vec<Upload>,
}

#[Object]
impl FilesystemMutation {
	/// Create an empty directory under a library path.
	#[graphql(guard = "PermissionGuard::one(UserPermission::ManageLibrary)")]
	async fn create_directory(
		&self,
		ctx: &Context<'_>,
		input: CreateDirectoryInput,
	) -> Result<bool> {
		let AuthContext { user, .. } = ctx.data()?;
		let core = ctx.data::<CoreContext>()?;
		let conn = core.conn.as_ref();

		validate_entry_name(&input.name)?;

		let library = library::Entity::find_for_user(user)
			.filter(library::Column::Id.eq(input.library_id))
			.one(conn)
			.await?
			.ok_or("Library not found")?;

		let parent = resolve_path_in_library(&library.path, &input.place_at)?;
		if !fs::metadata(&parent).await?.is_dir() {
			return Err("Path is not a directory".into());
		}

		let target = parent.join(&input.name);
		ensure_within_library(&library.path, &target)?;

		if fs::metadata(&target).await.is_ok() {
			return Err(format!(
				"A file or folder already exists at {}",
				target.display()
			)
			.into());
		}

		fs::create_dir(&target).await?;

		Ok(true)
	}

	/// Copy uploaded files into a directory under a library path.
	#[graphql(guard = "PermissionGuard::one(UserPermission::ManageLibrary)")]
	async fn upload_files(
		&self,
		ctx: &Context<'_>,
		input: UploadFilesInput,
	) -> Result<bool> {
		let AuthContext { user, .. } = ctx.data()?;
		let core = ctx.data::<CoreContext>()?;
		let conn = core.conn.as_ref();

		let library = library::Entity::find_for_user(user)
			.filter(library::Column::Id.eq(input.library_id))
			.one(conn)
			.await?
			.ok_or("Library not found")?;

		let parent = resolve_path_in_library(&library.path, &input.place_at)?;
		if !fs::metadata(&parent).await?.is_dir() {
			return Err("Path is not a directory".into());
		}

		for upload in input.uploads {
			let value = upload.value(ctx)?;
			let file_name = Path::new(&value.filename)
				.file_name()
				.and_then(|name| name.to_str())
				.ok_or("Invalid file name")?;
			validate_entry_name(file_name)?;

			let size = value
				.content
				.metadata()
				.map(|metadata| metadata.len() as usize)
				.unwrap_or(0);
			if size > core.config.max_file_upload_size {
				return Err(format!(
					"File {file_name} exceeds maximum upload size of {} bytes",
					core.config.max_file_upload_size
				)
				.into());
			}

			let target = parent.join(file_name);
			ensure_within_library(&library.path, &target)?;
			copy_upload_to_path(value, &target).await?;
		}

		enqueue_library_scan(core, &library).await?;

		Ok(true)
	}

	/// Rename a file or directory on disk and update matching media/series paths.
	#[graphql(guard = "PermissionGuard::one(UserPermission::ManageLibrary)")]
	async fn rename_path(
		&self,
		ctx: &Context<'_>,
		input: RenamePathInput,
	) -> Result<bool> {
		let AuthContext { user, .. } = ctx.data()?;
		let core = ctx.data::<CoreContext>()?;
		let conn = core.conn.as_ref();

		validate_entry_name(&input.new_name)?;

		let library = library::Entity::find_for_user(user)
			.filter(library::Column::Id.eq(input.library_id))
			.one(conn)
			.await?
			.ok_or("Library not found")?;

		let source = resolve_path_in_library(&library.path, &input.path)?;
		assert_not_library_root(&library.path, &source)?;

		let metadata = fs::metadata(&source)
			.await
			.map_err(|_| format!("Path does not exist: {}", source.display()))?;

		let destination = source
			.parent()
			.ok_or("Cannot rename a path with no parent")?
			.join(&input.new_name);
		ensure_within_library(&library.path, &destination)?;

		if fs::metadata(&destination).await.is_ok() {
			return Err(format!(
				"A file or folder already exists at {}",
				destination.display()
			)
			.into());
		}

		fs::rename(&source, &destination).await?;

		let old_path = source.to_string_lossy().to_string();
		let new_path = destination.to_string_lossy().to_string();
		rewrite_indexed_paths(conn, &old_path, &new_path, metadata.is_dir()).await?;

		enqueue_library_scan(core, &library).await?;

		Ok(true)
	}

	/// Delete a file or directory on disk and soft-delete matching media/series records.
	#[graphql(guard = "PermissionGuard::one(UserPermission::ManageLibrary)")]
	async fn delete_path(
		&self,
		ctx: &Context<'_>,
		input: DeletePathInput,
	) -> Result<bool> {
		let AuthContext { user, .. } = ctx.data()?;
		let core = ctx.data::<CoreContext>()?;
		let conn = core.conn.as_ref();

		let library = library::Entity::find_for_user(user)
			.filter(library::Column::Id.eq(input.library_id))
			.one(conn)
			.await?
			.ok_or("Library not found")?;

		let target = resolve_path_in_library(&library.path, &input.path)?;
		assert_not_library_root(&library.path, &target)?;

		let metadata = fs::metadata(&target)
			.await
			.map_err(|_| format!("Path does not exist: {}", target.display()))?;

		if metadata.is_dir() {
			fs::remove_dir_all(&target).await?;
		} else {
			fs::remove_file(&target).await?;
		}

		let old_path = target.to_string_lossy().to_string();
		soft_delete_indexed_paths(conn, &old_path).await?;

		enqueue_library_scan(core, &library).await?;

		Ok(true)
	}
}

async fn copy_upload_to_path(data: UploadValue, target_path: &Path) -> Result<()> {
	if fs::metadata(target_path).await.is_ok() {
		return Err(format!("File already exists at {}", target_path.display()).into());
	}

	let mut temp_file = fs::File::from_std(data.content);
	let mut target_file = fs::File::create(target_path).await?;
	tokio::io::copy(&mut temp_file, &mut target_file).await?;

	Ok(())
}

async fn enqueue_library_scan(
	core: &CoreContext,
	library: &library::Model,
) -> Result<()> {
	core.enqueue(StumpJob::library_scan(
		library.id.clone(),
		library.path.clone(),
		None,
	))
	.await
	.map_err(|e| {
		tracing::error!(?e, "Failed to enqueue library scan job");
		"Failed to enqueue library scan job".to_string()
	})?;
	Ok(())
}

fn is_subpath_secure(params: &str) -> bool {
	Path::new(params)
		.components()
		.all(|component| component != Component::ParentDir)
}

fn validate_entry_name(name: &str) -> Result<()> {
	let trimmed = name.trim();
	if trimmed.is_empty() {
		return Err("Name cannot be empty".into());
	}
	if trimmed != name {
		return Err("Name cannot start or end with whitespace".into());
	}
	if name == "." || name == ".." {
		return Err("Name is not allowed".into());
	}
	if name
		.chars()
		.any(|c| c.is_control() || c == '/' || c == '\\')
	{
		return Err("Name contains invalid characters".into());
	}

	#[cfg(windows)]
	{
		if name.chars().any(|c| "<>:\"|?*".contains(c)) {
			return Err("Name contains invalid characters".into());
		}
		if name.ends_with([' ', '.']) {
			return Err("Name cannot end with a space or period".into());
		}
		let stem = name.split('.').next().unwrap_or(name);
		const RESERVED: &[&str] = &[
			"CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6",
			"COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6",
			"LPT7", "LPT8", "LPT9",
		];
		if RESERVED
			.iter()
			.any(|reserved| stem.eq_ignore_ascii_case(reserved))
		{
			return Err("Name is a reserved Windows device name".into());
		}
	}

	Ok(())
}

fn normalize_components(path: &Path) -> PathBuf {
	let mut out = PathBuf::new();
	for component in path.components() {
		match component {
			Component::CurDir => {},
			Component::ParentDir => {
				out.pop();
			},
			other => out.push(other.as_os_str()),
		}
	}
	out
}

fn resolve_path_in_library(library_path: &str, path: &str) -> Result<PathBuf> {
	if !is_subpath_secure(path) {
		return Err("Invalid path".into());
	}

	let library = PathBuf::from(library_path);
	let requested = PathBuf::from(path);
	let target = if path_is_under_library(library_path, path) || requested.is_absolute() {
		requested
	} else {
		library.join(requested)
	};

	ensure_within_library(library_path, &target)?;
	Ok(target)
}

fn path_is_under_library(library_path: &str, path: &str) -> bool {
	let library = normalize_components(Path::new(library_path));
	let target = normalize_components(Path::new(path));
	target.starts_with(&library)
}

fn ensure_within_library(library_path: &str, target: &Path) -> Result<()> {
	let library = normalize_components(Path::new(library_path));
	let target = normalize_components(target);

	if !target.starts_with(&library) {
		return Err("Path is outside the library".into());
	}

	Ok(())
}

fn assert_not_library_root(library_path: &str, target: &Path) -> Result<()> {
	let library = normalize_components(Path::new(library_path));
	let target = normalize_components(target);

	if target == library {
		return Err("Cannot modify the library root".into());
	}

	Ok(())
}

fn rewritten_path(old_path: &str, new_path: &str, candidate: &str) -> Option<String> {
	if candidate == old_path {
		return Some(new_path.to_string());
	}

	for sep in ['/', '\\'] {
		let prefix = format!("{old_path}{sep}");
		if let Some(rest) = candidate.strip_prefix(&prefix) {
			return Some(format!("{}{}{}", new_path, std::path::MAIN_SEPARATOR, rest));
		}
	}

	None
}

async fn rewrite_indexed_paths(
	conn: &DatabaseConnection,
	old_path: &str,
	new_path: &str,
	is_directory: bool,
) -> Result<()> {
	let now: DateTimeWithTimeZone = Utc::now().into();
	let new_name = Path::new(new_path)
		.file_name()
		.and_then(|name| name.to_str())
		.unwrap_or_default();

	if is_directory {
		let series_rows = series::Entity::find()
			.filter(series::Column::DeletedAt.is_null())
			.filter(
				series::Column::Path
					.eq(old_path)
					.or(series::Column::Path.starts_with(format!("{old_path}/")))
					.or(series::Column::Path.starts_with(format!("{old_path}\\"))),
			)
			.all(conn)
			.await?;

		for row in series_rows {
			let Some(updated_path) = rewritten_path(old_path, new_path, &row.path) else {
				continue;
			};
			let rename_self = row.path == old_path;
			let mut active = row.into_active_model();
			active.path = Set(updated_path);
			if rename_self && !new_name.is_empty() {
				active.name = Set(new_name.to_string());
			}
			active.updated_at = Set(Some(now));
			active.update(conn).await?;
		}
	}

	let media_rows = media::Entity::find()
		.filter(media::Column::DeletedAt.is_null())
		.filter(
			media::Column::Path
				.eq(old_path)
				.or(media::Column::Path.starts_with(format!("{old_path}/")))
				.or(media::Column::Path.starts_with(format!("{old_path}\\"))),
		)
		.all(conn)
		.await?;

	for row in media_rows {
		let Some(updated_path) = rewritten_path(old_path, new_path, &row.path) else {
			continue;
		};
		let rename_self = row.path == old_path;
		let mut active = row.into_active_model();
		active.path = Set(updated_path);
		if rename_self {
			if let Some(stem) = Path::new(new_path)
				.file_stem()
				.and_then(|stem| stem.to_str())
			{
				active.name = Set(stem.to_string());
			}
			if let Some(extension) =
				Path::new(new_path).extension().and_then(|ext| ext.to_str())
			{
				active.extension = Set(extension.to_string());
			}
		}
		active.updated_at = Set(Some(now));
		active.update(conn).await?;
	}

	Ok(())
}

async fn soft_delete_indexed_paths(conn: &DatabaseConnection, path: &str) -> Result<()> {
	let now: DateTimeWithTimeZone = Utc::now().into();

	let series_rows = series::Entity::find()
		.filter(series::Column::DeletedAt.is_null())
		.filter(
			series::Column::Path
				.eq(path)
				.or(series::Column::Path.starts_with(format!("{path}/")))
				.or(series::Column::Path.starts_with(format!("{path}\\"))),
		)
		.all(conn)
		.await?;

	for row in series_rows {
		let mut active = row.into_active_model();
		active.deleted_at = Set(Some(now));
		active.updated_at = Set(Some(now));
		active.update(conn).await?;
	}

	let media_rows = media::Entity::find()
		.filter(media::Column::DeletedAt.is_null())
		.filter(
			media::Column::Path
				.eq(path)
				.or(media::Column::Path.starts_with(format!("{path}/")))
				.or(media::Column::Path.starts_with(format!("{path}\\"))),
		)
		.all(conn)
		.await?;

	for row in media_rows {
		let mut active = row.into_active_model();
		active.deleted_at = Set(Some(now));
		active.updated_at = Set(Some(now));
		active.update(conn).await?;
	}

	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn rejects_parent_directory_components() {
		assert!(!is_subpath_secure("../secret"));
		assert!(!is_subpath_secure("ok/../secret"));
		assert!(is_subpath_secure("ok/nested"));
	}

	#[test]
	fn rejects_invalid_entry_names() {
		assert!(validate_entry_name("").is_err());
		assert!(validate_entry_name("  padded  ").is_err());
		assert!(validate_entry_name(".").is_err());
		assert!(validate_entry_name("..").is_err());
		assert!(validate_entry_name("has/slash").is_err());
		assert!(validate_entry_name("has\\slash").is_err());
		assert!(validate_entry_name("valid-name").is_ok());
		assert!(validate_entry_name("Chapter 01.cbz").is_ok());
	}

	#[test]
	fn rewritten_path_replaces_self_and_descendants() {
		let old = "/library/Series A";
		let new = "/library/Series B";

		assert_eq!(
			rewritten_path(old, new, old).as_deref(),
			Some("/library/Series B")
		);
		let expected = format!("/library/Series B{}book.cbz", std::path::MAIN_SEPARATOR);
		assert_eq!(
			rewritten_path(old, new, "/library/Series A/book.cbz").as_deref(),
			Some(expected.as_str())
		);
		assert_eq!(rewritten_path(old, new, "/library/Series C/book.cbz"), None);
	}

	#[test]
	fn resolve_path_stays_inside_library() {
		let library = if cfg!(windows) {
			r"C:\library"
		} else {
			"/library"
		};
		let nested = if cfg!(windows) {
			r"C:\library\series"
		} else {
			"/library/series"
		};
		let outside = if cfg!(windows) { r"C:\Windows" } else { "/etc" };

		assert!(resolve_path_in_library(library, nested).is_ok());
		assert!(resolve_path_in_library(library, "series").is_ok());
		assert!(resolve_path_in_library(library, outside).is_err());
		assert!(resolve_path_in_library(library, "../outside").is_err());
	}

	#[test]
	fn cannot_modify_library_root() {
		let library = if cfg!(windows) {
			r"C:\library"
		} else {
			"/library"
		};
		let root = PathBuf::from(library);
		let child = root.join("series");

		assert!(assert_not_library_root(library, &root).is_err());
		assert!(assert_not_library_root(library, &child).is_ok());
	}
}
