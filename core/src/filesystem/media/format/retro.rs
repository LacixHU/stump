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

pub const RETRO_CONTROLS_FILENAME: &str = "controls.json";
pub const RETRO_CONTROLS_MAX_BYTES: u64 = 16 * 1024;

const RETRO_CONTROL_EXTRA_KEYS: &[&str] = &[
	"commodore",
	"ctrl",
	"f1",
	"f3",
	"f5",
	"f7",
	"restore",
	"instdel",
	"home",
	"shift",
	"capsshift",
	"symbolshift",
	"f9",
	"f10",
	"tab",
	"alt",
	"help",
	"delete",
	"capslock",
];

/// Placeable overlay controls that are not a single character. `joystick` is the odd one
/// out: it is not a key at all but the one stick the player slides a finger across, which
/// the client resolves into the four direction keys as the finger moves.
const RETRO_OVERLAY_SPECIAL_IDS: &[&str] = &[
	"joystick",
	"up",
	"down",
	"left",
	"right",
	"fire",
	"runstop",
	"space",
	"return",
	"commodore",
	"ctrl",
	"shift",
	"shiftright",
	// The Spectrum's two shifts. Every other legend on that machine is one of these plus
	// a key that is already in the list.
	"capsshift",
	"symbolshift",
	"restore",
	"instdel",
	"home",
	"f1",
	"f2",
	"f3",
	"f4",
	"f5",
	"f6",
	"f7",
	"f8",
	"f9",
	"f10",
	"pound",
	"at",
	"star",
	"plus",
	"minus",
	"equals",
	"colon",
	"semicolon",
	"comma",
	"period",
	"slash",
	"backslash",
	"bracketleft",
	"bracketright",
	"quote",
	"backquote",
	"tab",
	"alt",
	"help",
	"delete",
	"capslock",
	"arrowleft",
	"arrowup",
	"cursorup",
	"cursordown",
	"cursorleft",
	"cursorright",
];

const MAX_OVERLAY_KEYS: usize = 80;

fn is_overlay_key_id(id: &str) -> bool {
	if id.len() == 1 {
		let b = id.as_bytes()[0];
		return b.is_ascii_lowercase() || b.is_ascii_digit();
	}
	RETRO_OVERLAY_SPECIAL_IDS.contains(&id)
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct RetroOverlayKey {
	pub id: String,
	pub x: f64,
	pub y: f64,
}

fn json_f64(value: &serde_json::Value) -> Option<f64> {
	value
		.as_f64()
		.or_else(|| value.as_i64().map(|n| n as f64))
		.or_else(|| value.as_u64().map(|n| n as f64))
}

fn overlay_key(id: &str, x: f64, y: f64) -> RetroOverlayKey {
	RetroOverlayKey {
		id: id.to_string(),
		x,
		y,
	}
}

fn default_base_overlay() -> Vec<RetroOverlayKey> {
	vec![
		overlay_key("joystick", 0.15, 0.74),
		overlay_key("fire", 0.88, 0.78),
		overlay_key("runstop", 0.42, 0.92),
		overlay_key("space", 0.56, 0.92),
		overlay_key("return", 0.70, 0.92),
	]
}

/// Series-folder `controls.json` next to the disk/tape (same directory as the media file).
///
/// Canonicalizes and requires the file stay under the media parent (rejects symlink escape).
pub fn find_series_controls_json(media_path: &Path) -> Option<PathBuf> {
	let parent = media_path.parent()?;
	let candidate = parent.join(RETRO_CONTROLS_FILENAME);
	if !candidate.is_file() {
		return None;
	}

	let parent_canon = parent.canonicalize().ok()?;
	let file_canon = candidate.canonicalize().ok()?;
	if file_canon.starts_with(&parent_canon) {
		Some(file_canon)
	} else {
		None
	}
}

/// Parse `{ "extraKeys": ["f1", ...] }` and keep allowlisted unique keys (lowercase).
pub fn parse_retro_extra_keys(bytes: &[u8]) -> Vec<String> {
	let Ok(value) = serde_json::from_slice::<serde_json::Value>(bytes) else {
		return Vec::new();
	};
	let Some(arr) = value.get("extraKeys").and_then(|v| v.as_array()) else {
		return Vec::new();
	};

	let mut out = Vec::new();
	for item in arr {
		let Some(raw) = item.as_str() else {
			continue;
		};
		let key = raw.to_ascii_lowercase();
		if RETRO_CONTROL_EXTRA_KEYS.contains(&key.as_str())
			&& !out.iter().any(|k| k == &key)
		{
			out.push(key);
		}
	}
	out
}

/// Write target for series-folder `controls.json` (parent of the media file).
pub fn series_controls_json_write_path(media_path: &Path) -> Option<PathBuf> {
	let parent = media_path.parent()?;
	if let Ok(parent_canon) = parent.canonicalize() {
		return Some(parent_canon.join(RETRO_CONTROLS_FILENAME));
	}
	if parent.is_dir() {
		return Some(parent.join(RETRO_CONTROLS_FILENAME));
	}
	None
}

/// Clamp and allowlist overlay key placements.
pub fn sanitize_retro_overlay_keys(keys: &[RetroOverlayKey]) -> Vec<RetroOverlayKey> {
	let mut out = Vec::new();
	for key in keys.iter().take(MAX_OVERLAY_KEYS) {
		let id = key.id.to_ascii_lowercase();
		if !is_overlay_key_id(&id) {
			continue;
		}
		if out.iter().any(|k: &RetroOverlayKey| k.id == id) {
			continue;
		}
		out.push(RetroOverlayKey {
			id,
			x: key.x.clamp(0.0, 1.0),
			y: key.y.clamp(0.0, 1.0),
		});
	}
	out
}

/// Parse overlay layout from `controls.json`.
///
/// Prefers `{ "keys": [{ "id", "x", "y" }] }`. Falls back to default d-pad/face
/// plus `{ "extraKeys": [...] }` for older files.
pub fn parse_retro_controls(bytes: &[u8]) -> Vec<RetroOverlayKey> {
	let Ok(value) = serde_json::from_slice::<serde_json::Value>(bytes) else {
		return Vec::new();
	};

	if let Some(arr) = value.get("keys").and_then(|v| v.as_array()) {
		let parsed: Vec<RetroOverlayKey> = arr
			.iter()
			.filter_map(|item| {
				let id = item.get("id")?.as_str()?.to_string();
				let x = json_f64(item.get("x")?)?;
				let y = json_f64(item.get("y")?)?;
				Some(RetroOverlayKey { id, x, y })
			})
			.collect();
		return sanitize_retro_overlay_keys(&parsed);
	}

	let extras = parse_retro_extra_keys(bytes);
	if extras.is_empty() {
		return Vec::new();
	}

	let mut keys = default_base_overlay();
	for (i, id) in extras.into_iter().enumerate() {
		if keys.iter().any(|k| k.id == id) {
			continue;
		}
		keys.push(overlay_key(&id, 0.12 + (i as f64) * 0.12, 0.58));
	}
	sanitize_retro_overlay_keys(&keys)
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

	#[test]
	fn test_find_series_controls_json_sibling_only() {
		let dir = tempfile::tempdir().unwrap();
		let game = dir.path().join("Last Ninja");
		std::fs::create_dir(&game).unwrap();
		let media = game.join("Side A.d64");
		std::fs::write(&media, b"disk").unwrap();
		assert!(find_series_controls_json(&media).is_none());

		let controls = game.join("controls.json");
		std::fs::write(&controls, br#"{"extraKeys":["f1"]}"#).unwrap();
		let found = find_series_controls_json(&media).unwrap();
		assert_eq!(found, controls.canonicalize().unwrap());

		let outside = dir.path().join("controls.json");
		std::fs::write(&outside, br#"{"extraKeys":["ctrl"]}"#).unwrap();
		std::fs::remove_file(&controls).unwrap();
		assert!(find_series_controls_json(&media).is_none());
	}

	#[test]
	fn test_parse_retro_extra_keys_allowlist() {
		assert!(parse_retro_extra_keys(b"not json").is_empty());
		assert!(parse_retro_extra_keys(br#"{"extraKeys":"f1"}"#).is_empty());
		assert_eq!(
			parse_retro_extra_keys(
				br#"{"extraKeys":["F1","nope","ctrl","f1","commodore"]}"#
			),
			vec![
				"f1".to_string(),
				"ctrl".to_string(),
				"commodore".to_string()
			]
		);
	}

	#[test]
	fn test_parse_retro_controls_keys_and_fallback() {
		assert!(parse_retro_controls(b"nope").is_empty());
		let positioned = parse_retro_controls(
			br#"{"keys":[{"id":"Fire","x":1.5,"y":-1},{"id":"nope","x":0.2,"y":0.2}]}"#,
		);
		assert_eq!(
			positioned,
			vec![RetroOverlayKey {
				id: "fire".to_string(),
				x: 1.0,
				y: 0.0,
			}]
		);

		let fallback = parse_retro_controls(br#"{"extraKeys":["f1"]}"#);
		assert!(fallback.iter().any(|k| k.id == "joystick"));
		assert!(fallback.iter().any(|k| k.id == "f1"));

		let stick =
			parse_retro_controls(br#"{"keys":[{"id":"Joystick","x":0.2,"y":0.8}]}"#);
		assert_eq!(stick[0].id, "joystick");

		let letters = parse_retro_controls(br#"{"keys":[{"id":"a","x":0.2,"y":0.3}]}"#);
		assert_eq!(letters[0].id, "a");
	}

	#[test]
	fn test_parse_retro_controls_accepts_spectrum_shifts() {
		// CAPS SHIFT and SYMBOL SHIFT are keys of the Spectrum matrix, so a layout saved
		// for a Spectrum game has to survive the allow-list.
		let keys = parse_retro_controls(
			br#"{"keys":[{"id":"CapsShift","x":0.1,"y":0.9},{"id":"symbolshift","x":0.2,"y":0.9}]}"#,
		);
		assert_eq!(
			keys.iter().map(|k| k.id.as_str()).collect::<Vec<_>>(),
			vec!["capsshift", "symbolshift"]
		);

		let extras =
			parse_retro_extra_keys(br#"{"extraKeys":["capsshift","symbolshift"]}"#);
		assert_eq!(extras, vec!["capsshift", "symbolshift"]);
	}

	#[test]
	fn test_parse_retro_controls_accepts_amiga_keys() {
		let keys = parse_retro_controls(
			br#"{"keys":[{"id":"tab","x":0.1,"y":0.2},{"id":"alt","x":0.2,"y":0.2},{"id":"Help","x":0.3,"y":0.2}]}"#,
		);
		assert_eq!(
			keys.iter().map(|k| k.id.as_str()).collect::<Vec<_>>(),
			vec!["tab", "alt", "help"]
		);
	}

	#[test]
	fn test_series_controls_json_write_path() {
		let dir = tempfile::tempdir().unwrap();
		let media = dir.path().join("game.d64");
		std::fs::write(&media, b"disk").unwrap();
		let path = series_controls_json_write_path(&media).unwrap();
		assert_eq!(
			path,
			dir.path().canonicalize().unwrap().join("controls.json")
		);
	}
}

// ---------------------------------------------------------------------------
// Emulator save states
// ---------------------------------------------------------------------------

/// The largest snapshot the server will accept. A C64 snapshot is a few hundred KiB;
/// an Amiga snapshot with 2 MB of chip RAM is several MiB. This is deliberately well
/// above both so the cap only ever catches something pathological.
///
/// Note that axum applies an implicit 2 MiB body limit unless told otherwise, so any
/// route accepting a save state must also layer `DefaultBodyLimit::max` with this value.
pub const RETRO_SAVE_STATE_MAX_BYTES: usize = 16 * 1024 * 1024;

const SAVE_STATE_EXTENSION: &str = "savestate";

/// The directory holding every user's save state for one book.
pub fn save_state_dir_for_media(save_states_dir: &Path, media_id: &str) -> PathBuf {
	save_states_dir.join(media_id)
}

/// The path of one user's save state for one book.
///
/// Both ids come from the database (never straight off the URL), so no sanitization is
/// performed here -- callers are responsible for having resolved the book through
/// `media::Entity::find_for_user` first.
pub fn save_state_path(save_states_dir: &Path, media_id: &str, user_id: &str) -> PathBuf {
	save_state_dir_for_media(save_states_dir, media_id)
		.join(user_id)
		.with_extension(SAVE_STATE_EXTENSION)
}

/// Write a snapshot to disk, replacing any existing one.
///
/// The bytes go to a uniquely named temporary file first and are then renamed into
/// place. A crash or a full disk part way through therefore leaves the previous save
/// intact rather than a truncated snapshot that would hang the emulator on load. The
/// temp name includes a UUID so two tabs saving at once cannot clobber each other's
/// scratch file.
pub async fn write_save_state(
	save_states_dir: &Path,
	media_id: &str,
	user_id: &str,
	bytes: &[u8],
) -> Result<(), FileError> {
	let dir = save_state_dir_for_media(save_states_dir, media_id);
	tokio::fs::create_dir_all(&dir).await?;

	let target = save_state_path(save_states_dir, media_id, user_id);
	let temp = dir.join(format!(
		"{user_id}.{}.tmp",
		uuid::Uuid::new_v4().as_simple()
	));

	// Scoped so the handle is closed before the rename -- Windows will not rename a
	// file that is still open.
	{
		use tokio::io::AsyncWriteExt;
		let mut file = tokio::fs::File::create(&temp).await?;
		file.write_all(bytes).await?;
		file.sync_all().await?;
	}

	if let Err(error) = tokio::fs::rename(&temp, &target).await {
		// Best effort: do not leave the scratch file behind if the rename failed.
		let _ = tokio::fs::remove_file(&temp).await;
		return Err(error.into());
	}

	Ok(())
}

/// Read a snapshot from disk. Returns `Ok(None)` when there is no file, which is the
/// normal "this user has never saved this game" case and not an error.
pub async fn read_save_state(
	save_states_dir: &Path,
	media_id: &str,
	user_id: &str,
) -> Result<Option<Vec<u8>>, FileError> {
	let path = save_state_path(save_states_dir, media_id, user_id);
	match tokio::fs::read(&path).await {
		Ok(bytes) => Ok(Some(bytes)),
		Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
		Err(error) => Err(error.into()),
	}
}

/// Remove one user's save state for one book. Missing files are not an error.
pub async fn remove_save_state(
	save_states_dir: &Path,
	media_id: &str,
	user_id: &str,
) -> Result<(), FileError> {
	let path = save_state_path(save_states_dir, media_id, user_id);
	match tokio::fs::remove_file(&path).await {
		Ok(_) => Ok(()),
		Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
		Err(error) => Err(error.into()),
	}
}

/// Remove every user's save state for the given books. Used when media rows are really
/// deleted (as opposed to soft-deleted), where the cascade takes the metadata rows but
/// would otherwise leave the snapshots orphaned on disk.
///
/// Unlike thumbnail cleanup this does not have to scan the directory: the layout is one
/// directory per book, so each id is a single `remove_dir_all`.
pub async fn remove_save_states(
	save_states_dir: &Path,
	media_ids: &[String],
) -> Result<(), FileError> {
	for media_id in media_ids {
		let dir = save_state_dir_for_media(save_states_dir, media_id);
		match tokio::fs::remove_dir_all(&dir).await {
			Ok(_) => (),
			Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
			Err(error) => {
				tracing::error!(?error, path = %dir.display(), "Failed to remove save states for media");
			},
		}
	}

	Ok(())
}
