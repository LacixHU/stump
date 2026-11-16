//! Pure-Rust PDF page conversion for the PDF readers, see the `pdf_html` crate:
//!
//! - each page as a vector SVG image (shown like a comic page, with pinch zoom),
//! - its text with positions (for read aloud and highlighting),
//! - a standalone HTML document (SVG + selectable text layer) for iframes,
//! - small WebP previews for the page strip.
//!
//! Independent of PDFium, so it works without `PDFIUM_PATH`. Results go to the PDF
//! page cache directory (when `pdf_cache_pages` is on) and count towards its size limit.

use std::{
	collections::hash_map::DefaultHasher,
	hash::{Hash, Hasher},
	path::{Path, PathBuf},
	sync::{Arc, Mutex},
	time::UNIX_EPOCH,
};

use pdf_html::{HtmlOptions, PdfHtmlDocument, PdfHtmlError};
use serde::Serialize;

use crate::{
	config::StumpConfig,
	filesystem::{error::FileError, media::pdf::PdfProcessor},
};

/// Bump when the generated HTML or thumbnails change, so stale cache entries are ignored.
const OUTPUT_VERSION: u32 = 3;
/// Parsed documents kept in memory, so turning pages does not re-read the file.
const OPEN_DOCUMENTS: usize = 4;
pub const PDF_HTML_THUMBNAIL_DEFAULT_SIZE: u32 = 240;
const THUMBNAIL_MAX_SIZE: u32 = 1200;
const THUMBNAIL_QUALITY: f32 = 75.0;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfHtmlPageSize {
	pub width: f32,
	pub height: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfHtmlInfo {
	pub page_count: usize,
	pub title: Option<String>,
	pub pages: Vec<PdfHtmlPageSize>,
}

/// A run of text on one baseline, in PDF points from the top-left of the page.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfTextSpan {
	pub text: String,
	/// Baseline origin of the first glyph.
	pub x: f32,
	pub y: f32,
	/// Font size (em height).
	pub size: f32,
	/// Clockwise rotation of the baseline, in radians.
	pub angle: f32,
	/// Length of the run along its baseline.
	pub width: f32,
	/// Where each UTF-16 code unit of `text` starts, along the baseline from `x`/`y`.
	pub offsets: Vec<f32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfPageText {
	pub width: f32,
	pub height: f32,
	/// In content stream order, which is reading order for most documents.
	pub spans: Vec<PdfTextSpan>,
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct FileStamp {
	path: PathBuf,
	size: u64,
	modified: u64,
}

impl FileStamp {
	fn of(path: &Path) -> Result<Self, FileError> {
		let metadata = std::fs::metadata(path)?;
		let modified = metadata
			.modified()?
			.duration_since(UNIX_EPOCH)
			.map(|d| d.as_secs())
			.unwrap_or_default();
		Ok(Self {
			path: path.to_path_buf(),
			size: metadata.len(),
			modified,
		})
	}

	fn cache_key(&self, kind: &str, page: usize, extra: u32) -> String {
		let mut hasher = DefaultHasher::new();
		(self, OUTPUT_VERSION, kind, page, extra).hash(&mut hasher);
		format!("pdfhtml_{:016x}_{page}", hasher.finish())
	}
}

static DOCUMENTS: Mutex<Vec<(FileStamp, Arc<PdfHtmlDocument>)>> = Mutex::new(Vec::new());

fn open_document(stamp: &FileStamp) -> Result<Arc<PdfHtmlDocument>, FileError> {
	{
		let mut docs = DOCUMENTS.lock().unwrap_or_else(|e| e.into_inner());
		if let Some(pos) = docs.iter().position(|(s, _)| s == stamp) {
			// most recently used last
			let entry = docs.remove(pos);
			let doc = entry.1.clone();
			docs.push(entry);
			return Ok(doc);
		}
	}

	let bytes = std::fs::read(&stamp.path)?;
	let doc = Arc::new(PdfHtmlDocument::from_bytes(bytes).map_err(into_file_error)?);

	let mut docs = DOCUMENTS.lock().unwrap_or_else(|e| e.into_inner());
	docs.retain(|(s, _)| s.path != stamp.path);
	if docs.len() >= OPEN_DOCUMENTS {
		docs.remove(0);
	}
	docs.push((stamp.clone(), doc.clone()));
	Ok(doc)
}

fn into_file_error(error: PdfHtmlError) -> FileError {
	FileError::PdfProcessingError(error.to_string())
}

/// Validates a 1-based page number and returns the zero-based index.
fn page_index(doc: &PdfHtmlDocument, page: i32) -> Result<usize, FileError> {
	let count = doc.page_count();
	if page < 1 || page as usize > count {
		return Err(FileError::PdfProcessingError(format!(
			"Page {page} is out of range (the document has {count} pages)"
		)));
	}
	Ok(page as usize - 1)
}

async fn blocking<T: Send + 'static>(
	f: impl FnOnce() -> Result<T, FileError> + Send + 'static,
) -> Result<T, FileError> {
	tokio::task::spawn_blocking(f).await.map_err(|e| {
		FileError::PdfProcessingError(format!("PDF conversion task failed: {e}"))
	})?
}

async fn read_cached(config: &StumpConfig, file_name: &str) -> Option<Vec<u8>> {
	if !config.pdf_cache_pages {
		return None;
	}
	let bytes = tokio::fs::read(config.get_pdf_cache_dir().join(file_name))
		.await
		.ok()?;
	(!bytes.is_empty()).then_some(bytes)
}

async fn write_cached(config: &StumpConfig, file_name: &str, bytes: &[u8]) {
	if !config.pdf_cache_pages || bytes.is_empty() {
		return;
	}
	let dir = config.get_pdf_cache_dir();
	if let Err(error) = tokio::fs::create_dir_all(&dir).await {
		tracing::warn!(?dir, ?error, "Failed to create the PDF cache directory");
		return;
	}
	let target = dir.join(file_name);
	let temp = dir.join(format!("{file_name}.tmp"));
	let written = tokio::fs::write(&temp, bytes).await.is_ok()
		&& tokio::fs::rename(&temp, &target).await.is_ok();
	if !written {
		tracing::warn!(?target, "Failed to cache converted PDF page");
		let _ = tokio::fs::remove_file(&temp).await;
		return;
	}
	if config.pdf_cache_max_size_bytes > 0 {
		let config = config.clone();
		tokio::spawn(
			async move { PdfProcessor::enforce_pdf_cache_size_limit(&config).await },
		);
	}
}

/// Page count, page sizes and title of a PDF.
pub async fn get_pdf_html_info(path: &str) -> Result<PdfHtmlInfo, FileError> {
	let path = PathBuf::from(path);
	blocking(move || {
		let doc = open_document(&FileStamp::of(&path)?)?;
		let pages = doc
			.page_sizes()
			.into_iter()
			.map(|size| PdfHtmlPageSize {
				width: size.width,
				height: size.height,
			})
			.collect();
		Ok(PdfHtmlInfo {
			page_count: doc.page_count(),
			title: doc.info().title,
			pages,
		})
	})
	.await
}

/// The 1-based `page` of a PDF as a standalone HTML document.
pub async fn get_pdf_html_page(
	path: &str,
	page: i32,
	title: Option<String>,
	config: &StumpConfig,
) -> Result<String, FileError> {
	let stamp = FileStamp::of(Path::new(path))?;
	let title_hash = {
		let mut hasher = DefaultHasher::new();
		title.hash(&mut hasher);
		hasher.finish() as u32
	};
	let file_name = format!(
		"{}.html",
		stamp.cache_key("page", page as usize, title_hash)
	);
	if let Some(bytes) = read_cached(config, &file_name).await {
		if let Ok(html) = String::from_utf8(bytes) {
			return Ok(html);
		}
	}

	let html = blocking(move || {
		let doc = open_document(&stamp)?;
		let index = page_index(&doc, page)?;
		let options = HtmlOptions {
			title,
			..Default::default()
		};
		doc.page_html(index, &options).map_err(into_file_error)
	})
	.await?;

	write_cached(config, &file_name, html.as_bytes()).await;
	Ok(html)
}

/// The 1-based `page` of a PDF as an SVG image.
pub async fn get_pdf_svg_page(
	path: &str,
	page: i32,
	config: &StumpConfig,
) -> Result<String, FileError> {
	let stamp = FileStamp::of(Path::new(path))?;
	let file_name = format!("{}.svg", stamp.cache_key("svg", page as usize, 0));
	if let Some(bytes) = read_cached(config, &file_name).await {
		if let Ok(svg) = String::from_utf8(bytes) {
			return Ok(svg);
		}
	}

	let svg = blocking(move || {
		let doc = open_document(&stamp)?;
		let index = page_index(&doc, page)?;
		doc.page_image_svg(index, &Default::default())
			.map_err(into_file_error)
	})
	.await?;

	write_cached(config, &file_name, svg.as_bytes()).await;
	Ok(svg)
}

/// The text of the 1-based `page` of a PDF, with positions.
pub async fn get_pdf_page_text(path: &str, page: i32) -> Result<PdfPageText, FileError> {
	let stamp = FileStamp::of(Path::new(path))?;
	blocking(move || {
		let doc = open_document(&stamp)?;
		let index = page_index(&doc, page)?;
		let size = doc.page_size(index).map_err(into_file_error)?;
		let spans = doc
			.page_text(index)
			.map_err(into_file_error)?
			.into_iter()
			.map(|span| PdfTextSpan {
				text: span.text,
				x: round(span.x),
				y: round(span.y),
				size: round(span.size),
				angle: (span.angle * 1e4).round() as f32 / 1e4,
				width: round(span.width),
				offsets: span.offsets.into_iter().map(round).collect(),
			})
			.collect();
		Ok(PdfPageText {
			width: size.width,
			height: size.height,
			spans,
		})
	})
	.await
}

/// Hundredths of a point are plenty, and keep the JSON small.
fn round(value: f64) -> f32 {
	((value * 100.0).round() / 100.0) as f32
}

/// A WebP preview of the 1-based `page` whose longer edge is `size` pixels.
pub async fn get_pdf_html_thumbnail(
	path: &str,
	page: i32,
	size: Option<u32>,
	config: &StumpConfig,
) -> Result<Vec<u8>, FileError> {
	let size = size
		.unwrap_or(PDF_HTML_THUMBNAIL_DEFAULT_SIZE)
		.clamp(16, THUMBNAIL_MAX_SIZE);
	let stamp = FileStamp::of(Path::new(path))?;
	let file_name = format!("{}.webp", stamp.cache_key("thumb", page as usize, size));
	if let Some(bytes) = read_cached(config, &file_name).await {
		return Ok(bytes);
	}

	let webp = blocking(move || {
		let doc = open_document(&stamp)?;
		let index = page_index(&doc, page)?;
		doc.render_thumbnail(index, size, THUMBNAIL_QUALITY)
			.map_err(into_file_error)
	})
	.await?;

	write_cached(config, &file_name, &webp).await;
	Ok(webp)
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::filesystem::media::tests::get_test_pdf_path;

	#[tokio::test]
	async fn converts_pages_and_thumbnails() {
		let path = get_test_pdf_path();
		let temp_dir = tempfile::tempdir().unwrap();
		let mut config = StumpConfig::debug();
		config.pdf_cache_pages = true;
		config.config_dir = temp_dir.path().to_string_lossy().to_string();

		let info = get_pdf_html_info(&path).await.unwrap();
		assert!(info.page_count > 0);
		assert_eq!(info.pages.len(), info.page_count);

		let html = get_pdf_html_page(&path, 1, Some("Test".into()), &config)
			.await
			.unwrap();
		assert!(html.starts_with("<!doctype html>"));
		assert!(html.contains("<svg"));
		// second call is served from the cache
		let cached = get_pdf_html_page(&path, 1, Some("Test".into()), &config)
			.await
			.unwrap();
		assert_eq!(html, cached);

		let svg = get_pdf_svg_page(&path, 1, &config).await.unwrap();
		assert!(svg.starts_with("<svg"));
		assert!(!svg.contains("<script"));
		// sized for <img> in pixels, not points, so readers show it large
		let page = &info.pages[0];
		let expected_width = (page.width
			* pdf_html::IMAGE_SCALE
				.max(pdf_html::IMAGE_MIN_LONG_EDGE / page.width.max(page.height)))
		.round();
		assert!(svg.contains(&format!(r#" width="{expected_width}""#)));

		let text = get_pdf_page_text(&path, 1).await.unwrap();
		assert!(text.width > 0.0 && text.height > 0.0);
		assert!(!text.spans.is_empty());
		assert!(text
			.spans
			.iter()
			.all(|s| s.x >= -1.0 && s.x <= text.width + 1.0));
		assert!(text
			.spans
			.iter()
			.all(|s| s.offsets.len() == s.text.encode_utf16().count()));

		let thumb = get_pdf_html_thumbnail(&path, 1, Some(120), &config)
			.await
			.unwrap();
		assert_eq!(&thumb[..4], b"RIFF");

		assert!(get_pdf_html_page(&path, 0, None, &config).await.is_err());
		let past_end = info.page_count as i32 + 1;
		assert!(get_pdf_html_thumbnail(&path, past_end, None, &config)
			.await
			.is_err());
	}
}
