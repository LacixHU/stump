use std::{
	collections::HashMap,
	path::{Path, PathBuf},
};

use data_encoding::HEXLOWER;
use ring::digest::{Context, SHA256};

use crate::{
	config::StumpConfig,
	filesystem::{
		error::FileError,
		media::{
			process::{AnalyzedPage, FileProcessor, FileProcessorOptions, ProcessedFile},
			ProcessedFileHashes, ProcessedMediaMetadata,
		},
		ContentType, FileParts, PathUtils,
	},
};

/// Platform for retro computer disk/tape images.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RetroPlatform {
	C64,
	Spectrum,
	Amiga,
}

impl RetroPlatform {
	pub fn as_str(self) -> &'static str {
		match self {
			Self::C64 => "c64",
			Self::Spectrum => "spectrum",
			Self::Amiga => "amiga",
		}
	}

	pub fn tag(self) -> String {
		format!("platform:{}", self.as_str())
	}
}

impl std::fmt::Display for RetroPlatform {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		write!(f, "{}", self.as_str())
	}
}

/// Resolve the retro platform from path and extension.
///
/// Algorithm (locked):
/// 1. Unique extension map
/// 2. Ambiguous (`tap`): path-segment hints
/// 3. Optional series inherit is caller-side (no DB here)
/// 4. Bare `.tap` defaults to C64 with a warning
pub fn resolve_retro_platform(path: &str, extension: &str) -> RetroPlatform {
	let ext = extension.to_lowercase();
	match ext.as_str() {
		"d64" | "t64" | "prg" | "g64" => RetroPlatform::C64,
		"tzx" | "z80" | "sna" => RetroPlatform::Spectrum,
		"adf" | "adz" => RetroPlatform::Amiga,
		"tap" => resolve_tap_platform(path),
		_ => {
			tracing::warn!(
				?path,
				?extension,
				"Unknown retro extension; defaulting platform to C64"
			);
			RetroPlatform::C64
		},
	}
}

fn resolve_tap_platform(path: &str) -> RetroPlatform {
	if let Some(platform) = platform_from_path_hints(path) {
		return platform;
	}

	tracing::warn!(
		?path,
		"Ambiguous .tap without path hint; defaulting to C64. Prefer folders named C64/ or Spectrum/."
	);
	RetroPlatform::C64
}

/// Scan path segments (case-insensitive) for platform hints.
pub fn platform_from_path_hints(path: &str) -> Option<RetroPlatform> {
	let lower = path.replace('\\', "/").to_lowercase();
	let segments: Vec<&str> = lower.split('/').filter(|s| !s.is_empty()).collect();

	for segment in segments.iter().rev() {
		if *segment == "c64"
			|| *segment == "commodore"
			|| segment.starts_with("c64")
			|| segment.contains("commodore")
		{
			return Some(RetroPlatform::C64);
		}
		if *segment == "spectrum"
			|| *segment == "zx"
			|| *segment == "sinclair"
			|| segment.contains("spectrum")
			|| segment.contains("sinclair")
		{
			return Some(RetroPlatform::Spectrum);
		}
		if *segment == "amiga" || segment.contains("amiga") {
			return Some(RetroPlatform::Amiga);
		}
	}

	None
}

/// Inherit platform from sibling media tags (`platform:c64` etc.) when present.
pub fn platform_from_series_tags<'a, I>(tags: I) -> Option<RetroPlatform>
where
	I: IntoIterator<Item = &'a str>,
{
	for tag in tags {
		let lower = tag.to_lowercase();
		match lower.as_str() {
			"platform:c64" => return Some(RetroPlatform::C64),
			"platform:spectrum" => return Some(RetroPlatform::Spectrum),
			"platform:amiga" => return Some(RetroPlatform::Amiga),
			_ => {},
		}
	}
	None
}

/// Full resolve including optional series-tag inheritance for ambiguous extensions.
pub fn resolve_retro_platform_with_series<'a, I>(
	path: &str,
	extension: &str,
	series_tags: I,
) -> RetroPlatform
where
	I: IntoIterator<Item = &'a str>,
{
	let ext = extension.to_lowercase();
	match ext.as_str() {
		"d64" | "t64" | "prg" | "g64" => RetroPlatform::C64,
		"tzx" | "z80" | "sna" => RetroPlatform::Spectrum,
		"adf" | "adz" => RetroPlatform::Amiga,
		"tap" => {
			if let Some(p) = platform_from_path_hints(path) {
				return p;
			}
			if let Some(p) = platform_from_series_tags(series_tags) {
				return p;
			}
			tracing::warn!(
				?path,
				"Ambiguous .tap without path hint or series platform; defaulting to C64"
			);
			RetroPlatform::C64
		},
		_ => RetroPlatform::C64,
	}
}

/// Image basenames commonly used as covers next to disk/tape images.
const SIDECAR_COVER_NAMES: &[&str] =
	&["cover", "folder", "poster", "front", "box", "boxart"];

const SIDECAR_COVER_EXTS: &[&str] = &["jpg", "jpeg", "png", "webp", "gif"];

/// Find a local cover image beside the media file or in its parent (series) folder.
///
/// Looks for:
/// - `{stem}.jpg|png|webp|gif` next to the disk image
/// - `cover` / `folder` / `poster` / `front` / `box` / `boxart` with those extensions
///   in the media directory and the parent directory
pub fn find_sidecar_cover(media_path: &Path) -> Option<PathBuf> {
	let parent = media_path.parent()?;
	let stem = media_path.file_stem()?.to_str()?;

	// Prefer same-stem image next to the media file
	for ext in SIDECAR_COVER_EXTS {
		let candidate = parent.join(format!("{stem}.{ext}"));
		if candidate.is_file() {
			return Some(candidate);
		}
	}

	for dir in [parent, parent.parent().unwrap_or(parent)] {
		for name in SIDECAR_COVER_NAMES {
			for ext in SIDECAR_COVER_EXTS {
				let candidate = dir.join(format!("{name}.{ext}"));
				if candidate.is_file() {
					return Some(candidate);
				}
			}
		}
	}

	None
}

pub struct RetroProcessor;

impl FileProcessor for RetroProcessor {
	fn get_sample_size(path: &str) -> Result<u64, FileError> {
		let size = std::fs::metadata(path)?.len();
		if size == 0 {
			return Err(FileError::UnknownError(
				"Retro media file is empty".to_string(),
			));
		}
		// Full-file hash for disk images (they are typically small)
		Ok(size)
	}

	fn generate_stump_hash(path: &str) -> Option<String> {
		let data = std::fs::read(path).ok()?;
		let mut context = Context::new(&SHA256);
		context.update(&data);
		let digest = context.finish();
		Some(HEXLOWER.encode(digest.as_ref()))
	}

	fn generate_hashes(
		path: &str,
		FileProcessorOptions {
			generate_file_hashes,
			..
		}: FileProcessorOptions,
	) -> Result<ProcessedFileHashes, FileError> {
		let hash = generate_file_hashes
			.then(|| RetroProcessor::generate_stump_hash(path))
			.flatten();

		Ok(ProcessedFileHashes {
			hash,
			koreader_hash: None,
		})
	}

	fn process_metadata(path: &str) -> Result<Option<ProcessedMediaMetadata>, FileError> {
		let FileParts { file_stem, .. } = Path::new(path).file_parts();
		if file_stem.is_empty() {
			return Ok(None);
		}
		Ok(Some(ProcessedMediaMetadata {
			title: Some(file_stem),
			..Default::default()
		}))
	}

	fn process(
		path: &str,
		options: FileProcessorOptions,
		_config: &StumpConfig,
	) -> Result<ProcessedFile, FileError> {
		let meta = std::fs::metadata(path)?;
		if !meta.is_file() {
			return Err(FileError::UnknownError(
				"Path is not a regular file".to_string(),
			));
		}

		let FileParts { extension, .. } = Path::new(path).file_parts();
		if !ContentType::is_retro_extension(&extension) {
			return Err(FileError::UnsupportedFileType(path.to_string()));
		}

		let _platform = resolve_retro_platform(path, &extension);

		let metadata = if options.process_metadata {
			RetroProcessor::process_metadata(path)?
		} else {
			None
		};

		let ProcessedFileHashes {
			hash,
			koreader_hash,
		} = RetroProcessor::generate_hashes(path, options)?;

		Ok(ProcessedFile {
			path: PathBuf::from(path),
			hash,
			koreader_hash,
			metadata,
			// -1: not page-oriented media (disk/tape image)
			pages: -1,
		})
	}

	fn get_page(
		_path: &str,
		_page: i32,
		_config: &StumpConfig,
	) -> Result<(ContentType, Vec<u8>), FileError> {
		Err(FileError::UnknownError(
			"Retro media does not support page extraction; use play-file".to_string(),
		))
	}

	fn get_page_count(_path: &str, _config: &StumpConfig) -> Result<i32, FileError> {
		Err(FileError::UnknownError(
			"Retro media does not have pages".to_string(),
		))
	}

	fn get_page_content_types(
		_path: &str,
		_pages: Vec<i32>,
	) -> Result<HashMap<i32, ContentType>, FileError> {
		Err(FileError::UnknownError(
			"Retro media does not support page content types".to_string(),
		))
	}

	fn analyze_page(
		_path: &str,
		_page: i32,
		_config: &StumpConfig,
	) -> Result<AnalyzedPage, FileError> {
		Err(FileError::UnknownError(
			"Retro media does not support page analysis".to_string(),
		))
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::io::Write;
	use tempfile::NamedTempFile;

	#[test]
	fn test_resolve_unique_extensions() {
		assert_eq!(
			resolve_retro_platform("/games/foo.d64", "d64"),
			RetroPlatform::C64
		);
		assert_eq!(
			resolve_retro_platform("/games/foo.t64", "t64"),
			RetroPlatform::C64
		);
		assert_eq!(
			resolve_retro_platform("/games/foo.prg", "prg"),
			RetroPlatform::C64
		);
		assert_eq!(
			resolve_retro_platform("/games/foo.tzx", "tzx"),
			RetroPlatform::Spectrum
		);
		assert_eq!(
			resolve_retro_platform("/games/foo.z80", "z80"),
			RetroPlatform::Spectrum
		);
		assert_eq!(
			resolve_retro_platform("/games/foo.sna", "sna"),
			RetroPlatform::Spectrum
		);
		assert_eq!(
			resolve_retro_platform("/games/foo.adf", "adf"),
			RetroPlatform::Amiga
		);
		assert_eq!(
			resolve_retro_platform("/games/foo.adz", "adz"),
			RetroPlatform::Amiga
		);
	}

	#[test]
	fn test_resolve_tap_path_hints() {
		assert_eq!(
			resolve_retro_platform("/Retro/Spectrum/Manic/manic.tap", "tap"),
			RetroPlatform::Spectrum
		);
		assert_eq!(
			resolve_retro_platform("/Retro/C64/game/side.tap", "tap"),
			RetroPlatform::C64
		);
		assert_eq!(
			resolve_retro_platform("/Retro/commodore/x.tap", "tap"),
			RetroPlatform::C64
		);
		assert_eq!(
			resolve_retro_platform("/Retro/zx/x.tap", "tap"),
			RetroPlatform::Spectrum
		);
	}

	#[test]
	fn test_resolve_tap_default_c64() {
		assert_eq!(
			resolve_retro_platform("/games/unknown/foo.tap", "tap"),
			RetroPlatform::C64
		);
	}

	#[test]
	fn test_resolve_with_series_tags() {
		assert_eq!(
			resolve_retro_platform_with_series(
				"/games/foo.tap",
				"tap",
				["platform:spectrum"]
			),
			RetroPlatform::Spectrum
		);
	}

	#[test]
	fn test_process_sets_pages_negative_one() {
		let mut tmp = NamedTempFile::new().unwrap();
		tmp.write_all(b"fake-d64-bytes").unwrap();
		// Rename-like path with .d64 extension via path string manipulation
		let path = tmp.path().with_extension("d64");
		std::fs::copy(tmp.path(), &path).unwrap();

		let result = RetroProcessor::process(
			path.to_str().unwrap(),
			FileProcessorOptions {
				generate_file_hashes: true,
				process_metadata: true,
				..Default::default()
			},
			&StumpConfig::debug(),
		);
		let _ = std::fs::remove_file(&path);

		assert!(result.is_ok());
		let processed = result.unwrap();
		assert_eq!(processed.pages, -1);
		assert!(processed.hash.is_some());
		assert_eq!(
			processed.metadata.as_ref().and_then(|m| m.title.clone()),
			Some(path.file_stem().unwrap().to_string_lossy().to_string())
		);
	}

	#[test]
	fn test_get_page_errors() {
		let err = RetroProcessor::get_page("x.d64", 1, &StumpConfig::debug());
		assert!(err.is_err());
	}

	#[test]
	fn test_find_sidecar_cover_stem_and_cover_name() {
		let dir = tempfile::tempdir().unwrap();
		let media = dir.path().join("Elite.d64");
		std::fs::write(&media, b"disk").unwrap();
		assert!(find_sidecar_cover(&media).is_none());

		let cover = dir.path().join("Elite.png");
		std::fs::write(&cover, b"fake-png").unwrap();
		assert_eq!(find_sidecar_cover(&media), Some(cover));

		std::fs::remove_file(dir.path().join("Elite.png")).unwrap();
		let named = dir.path().join("cover.jpg");
		std::fs::write(&named, b"jpg").unwrap();
		assert_eq!(find_sidecar_cover(&media), Some(named));
	}
}
