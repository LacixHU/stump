//! Convert PDF pages to standalone HTML documents and thumbnails, in pure Rust.
//!
//! Built on [hayro](https://github.com/LaurenzV/hayro) (Apache-2.0 / MIT):
//!
//! - [`PdfHtmlDocument::page_html`]: the page as vector SVG (`hayro-svg`) with a
//!   transparent, selectable text layer on top, wrapped in a self-contained HTML
//!   document meant to be shown one page at a time in an iframe (see [`html`] for
//!   the `postMessage` protocol).
//! - [`PdfHtmlDocument::render_thumbnail`]: a raster preview of the page (`hayro`),
//!   encoded as WebP.
//!
//! Unlike the PDFium-based renderer in `stump_core`, nothing here needs a native
//! library at runtime. Encrypted PDFs are supported when they open with an empty
//! password, which covers the common "owner password only" case.

mod html;
mod images;
mod text;

use std::sync::Arc;

use hayro::hayro_interpret::{
	hayro_syntax::{LoadPdfError, Pdf},
	interpret_page,
	util::TransformExt,
	Context, InterpreterCache, InterpreterSettings,
};
use hayro::kurbo::Rect;
use hayro::vello_cpu::color::palette::css::WHITE;
use image::{DynamicImage, RgbaImage};

pub use images::ImageOptions;
pub use text::TextSpan;

#[derive(Debug, thiserror::Error)]
pub enum PdfHtmlError {
	#[error("The PDF is encrypted with a user password")]
	Encrypted,
	#[error("The PDF could not be parsed")]
	Invalid,
	#[error("Page {0} is out of range (the document has {1} pages)")]
	PageOutOfRange(usize, usize),
	#[error("Failed to encode image: {0}")]
	Encode(String),
}

pub type PdfHtmlResult<T> = Result<T, PdfHtmlError>;

/// Options for [`PdfHtmlDocument::page_html`].
#[derive(Debug, Clone, Default)]
pub struct HtmlOptions {
	/// Shown in the page's `<title>` as "{title} – {page}".
	pub title: Option<String>,
	/// Skip the selectable text layer.
	pub without_text_layer: bool,
	pub images: ImageOptions,
}

/// Size of a page as displayed (crop box, rotation applied), in PDF points.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PageSize {
	pub width: f32,
	pub height: f32,
}

/// Title and author from the document information dictionary.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DocumentInfo {
	pub title: Option<String>,
	pub author: Option<String>,
}

/// A parsed PDF. Cheap to share (`Send + Sync`); keep one around per open book and
/// render pages from any thread.
pub struct PdfHtmlDocument {
	pdf: Pdf,
	settings: InterpreterSettings,
}

impl PdfHtmlDocument {
	pub fn from_bytes(data: Vec<u8>) -> PdfHtmlResult<Self> {
		let pdf = Pdf::new(data).map_err(|e| match e {
			LoadPdfError::Decryption(_) => PdfHtmlError::Encrypted,
			_ => PdfHtmlError::Invalid,
		})?;
		Ok(Self {
			pdf,
			settings: InterpreterSettings::default(),
		})
	}

	pub fn page_count(&self) -> usize {
		self.pdf.pages().len()
	}

	pub fn page_sizes(&self) -> Vec<PageSize> {
		self.pdf
			.pages()
			.iter()
			.map(|page| {
				let (width, height) = page.render_dimensions();
				PageSize { width, height }
			})
			.collect()
	}

	pub fn info(&self) -> DocumentInfo {
		let metadata = self.pdf.metadata();
		DocumentInfo {
			title: metadata.title.as_deref().and_then(decode_text_string),
			author: metadata.author.as_deref().and_then(decode_text_string),
		}
	}

	/// The page as an SVG document on a white background, sized in PDF points.
	/// Glyphs are outlines and images are embedded, so it has no external references
	/// and can be shown with a plain `<img>`. `index` is zero-based.
	pub fn page_svg(&self, index: usize, images: &ImageOptions) -> PdfHtmlResult<String> {
		let page = self.page(index)?;
		let cache = hayro_svg::RenderCache::new();
		let svg = hayro_svg::convert(
			page,
			&cache,
			&self.settings,
			&hayro_svg::SvgRenderSettings {
				bg_color: [255, 255, 255, 255],
			},
		);
		Ok(images::recompress_embedded_images(svg, images))
	}

	/// The page as an SVG meant for `<img>`: like [`Self::page_svg`], but with an intrinsic
	/// size of [`IMAGE_SCALE`] pixels per point (and at least [`IMAGE_MIN_LONG_EDGE`]
	/// pixels on the longer edge). Readers that never enlarge images past their natural
	/// size (like a comic reader fitting pages to the screen) then show the page as large
	/// as the screen allows, and being vector it stays sharp at any size.
	/// `index` is zero-based.
	pub fn page_image_svg(
		&self,
		index: usize,
		images: &ImageOptions,
	) -> PdfHtmlResult<String> {
		let size = self.page_size(index)?;
		let svg = self.page_svg(index, images)?;
		let longest = size.width.max(size.height).max(1.0);
		let scale = IMAGE_SCALE.max(IMAGE_MIN_LONG_EDGE / longest);
		Ok(set_root_size(
			svg,
			(size.width * scale).round(),
			(size.height * scale).round(),
		))
	}

	/// The text on the page, merged into baseline runs. `index` is zero-based.
	pub fn page_text(&self, index: usize) -> PdfHtmlResult<Vec<TextSpan>> {
		let page = self.page(index)?;
		let (width, height) = page.render_dimensions();
		let cache = InterpreterCache::new();
		let mut context = Context::new(
			page.initial_transform(true).to_kurbo(),
			Rect::new(0.0, 0.0, width as f64, height as f64),
			&cache,
			page.xref(),
			self.settings.clone(),
		);
		let mut collector = text::TextCollector::default();
		interpret_page(page, &mut context, &mut collector);
		Ok(collector.finish())
	}

	/// The page as a standalone HTML document. `index` is zero-based.
	pub fn page_html(
		&self,
		index: usize,
		options: &HtmlOptions,
	) -> PdfHtmlResult<String> {
		let size = self.page_size(index)?;
		let svg = self.page_svg(index, &options.images)?;
		let spans = if options.without_text_layer {
			Vec::new()
		} else {
			self.page_text(index)?
		};
		Ok(html::render(&html::PageHtml {
			page_number: index + 1,
			title: options.title.as_deref(),
			width: size.width as f64,
			height: size.height as f64,
			svg: &svg,
			spans: &spans,
		}))
	}

	/// Rasterize the page so that its longer edge is `max_dimension` pixels.
	/// `index` is zero-based.
	pub fn render_page(
		&self,
		index: usize,
		max_dimension: u32,
	) -> PdfHtmlResult<RgbaImage> {
		let page = self.page(index)?;
		let (width, height) = page.render_dimensions();
		let longest = width.max(height).max(1.0);
		// vello_cpu pixmaps are limited to u16 dimensions
		let scale = (max_dimension.clamp(1, 8192) as f32 / longest).min(16.0);

		let cache = hayro::RenderCache::new();
		let pixmap = hayro::render(
			page,
			&cache,
			&self.settings,
			&hayro::RenderSettings::default(),
			&hayro::PixmapSettings {
				x_scale: scale,
				y_scale: scale,
				bg_color: WHITE,
			},
		);

		let (w, h) = (pixmap.width() as u32, pixmap.height() as u32);
		let mut rgba = pixmap.data_as_u8_slice().to_vec();
		unpremultiply(&mut rgba);
		RgbaImage::from_raw(w, h, rgba)
			.ok_or_else(|| PdfHtmlError::Encode("pixmap size mismatch".into()))
	}

	/// A WebP preview of the page whose longer edge is `max_dimension` pixels.
	/// `index` is zero-based.
	pub fn render_thumbnail(
		&self,
		index: usize,
		max_dimension: u32,
		quality: f32,
	) -> PdfHtmlResult<Vec<u8>> {
		let image = self.render_page(index, max_dimension)?;
		images::encode_webp(&DynamicImage::ImageRgba8(image), quality)
			.ok_or_else(|| PdfHtmlError::Encode("WebP encoding failed".into()))
	}

	fn page(&self, index: usize) -> PdfHtmlResult<&hayro::hayro_syntax::page::Page<'_>> {
		let pages = self.pdf.pages();
		pages
			.get(index)
			.ok_or(PdfHtmlError::PageOutOfRange(index + 1, pages.len()))
	}

	/// Size of the page as displayed. `index` is zero-based.
	pub fn page_size(&self, index: usize) -> PdfHtmlResult<PageSize> {
		let (width, height) = self.page(index)?.render_dimensions();
		Ok(PageSize { width, height })
	}
}

/// Intrinsic pixels per PDF point of [`PdfHtmlDocument::page_image_svg`].
pub const IMAGE_SCALE: f32 = 3.0;
/// Smallest intrinsic longer edge, in pixels, of [`PdfHtmlDocument::page_image_svg`].
pub const IMAGE_MIN_LONG_EDGE: f32 = 2000.0;

/// Replaces the `width` and `height` of the root `<svg>` element; its `viewBox` keeps
/// the drawing in points, so the content scales with it.
fn set_root_size(svg: String, width: f32, height: f32) -> String {
	let Some(start) = svg.find("<svg") else {
		return svg;
	};
	let Some(end) = svg[start..].find('>').map(|end| start + end) else {
		return svg;
	};
	let mut tag = svg[start..end].to_string();
	for (name, value) in [("width", width), ("height", height)] {
		let needle = format!(" {name}=\"");
		if let Some(at) = tag.find(&needle) {
			let value_start = at + needle.len();
			if let Some(len) = tag[value_start..].find('"') {
				tag.replace_range(value_start..value_start + len, &value.to_string());
			}
		}
	}
	format!("{}{}{}", &svg[..start], tag, &svg[end..])
}

/// Pages are rendered over an opaque background, so this is almost always a no-op,
/// but transparent pixels must not come out darkened.
fn unpremultiply(rgba: &mut [u8]) {
	for px in rgba.chunks_exact_mut(4) {
		let a = px[3] as u32;
		if a == 0 || a == 255 {
			continue;
		}
		for c in &mut px[..3] {
			*c = ((*c as u32 * 255 + a / 2) / a).min(255) as u8;
		}
	}
}

/// PDF text strings are either UTF-16BE with a BOM or PDFDocEncoding (treated as
/// Latin-1, which matches it for printable characters).
fn decode_text_string(bytes: &[u8]) -> Option<String> {
	let text = if let Some(utf16) = bytes.strip_prefix(&[0xFE, 0xFF]) {
		let units: Vec<u16> = utf16
			.chunks_exact(2)
			.map(|c| u16::from_be_bytes([c[0], c[1]]))
			.collect();
		String::from_utf16_lossy(&units)
	} else if let Some(utf8) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
		String::from_utf8_lossy(utf8).into_owned()
	} else {
		bytes.iter().map(|&b| b as char).collect()
	};
	let text = text.trim().to_string();
	(!text.is_empty()).then_some(text)
}

#[allow(dead_code)]
fn assert_send_sync() {
	fn check<T: Send + Sync>() {}
	check::<PdfHtmlDocument>();
	check::<Arc<PdfHtmlDocument>>();
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn resizes_only_the_root_svg() {
		let svg = r#"<svg viewBox="0 0 10 20" width="10" height="20"><rect width="5" height="6"/></svg>"#;
		assert_eq!(
			set_root_size(svg.to_string(), 30.0, 60.0),
			r#"<svg viewBox="0 0 10 20" width="30" height="60"><rect width="5" height="6"/></svg>"#
		);
	}

	#[test]
	fn decodes_pdf_text_strings() {
		assert_eq!(decode_text_string(b"Hello"), Some("Hello".into()));
		assert_eq!(
			decode_text_string(&[0xFE, 0xFF, 0x00, 0x48, 0x00, 0xE9]),
			Some("Hé".into())
		);
		assert_eq!(decode_text_string(b"  "), None);
	}
}
