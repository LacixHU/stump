//! hayro-svg embeds every raster image as a lossless base64 PNG. For scanned books that
//! turns a 300 KB JPEG page into a 10+ MB SVG, so large images are downscaled and
//! re-encoded as lossy WebP before the page is sent to a client.

use base64::{engine::general_purpose::STANDARD, Engine};
use image::{imageops::FilterType, DynamicImage, GenericImageView};

const PNG_PREFIX: &str = "data:image/png;base64,";

#[derive(Debug, Clone, Copy)]
pub struct ImageOptions {
	/// Embedded PNGs at most this many bytes are left untouched (line art, icons).
	pub keep_below_bytes: usize,
	/// Longest edge, in pixels, an embedded image is downscaled to.
	pub max_dimension: u32,
	/// Lossy WebP quality (0-100).
	pub quality: f32,
}

impl Default for ImageOptions {
	fn default() -> Self {
		Self {
			keep_below_bytes: 96 * 1024,
			max_dimension: 2400,
			quality: 80.0,
		}
	}
}

/// Rewrite every large `data:image/png` URI in `svg` as a (possibly smaller) WebP.
pub(crate) fn recompress_embedded_images(svg: String, options: &ImageOptions) -> String {
	if !svg.contains(PNG_PREFIX) {
		return svg;
	}

	let mut out = String::with_capacity(svg.len());
	let mut rest = svg.as_str();
	while let Some(start) = rest.find(PNG_PREFIX) {
		let data_start = start + PNG_PREFIX.len();
		let Some(len) = rest[data_start..].find('"') else {
			break;
		};
		let data = &rest[data_start..data_start + len];
		out.push_str(&rest[..start]);
		match recompress(data, options) {
			Some(uri) => out.push_str(&uri),
			None => out.push_str(&rest[start..data_start + len]),
		}
		rest = &rest[data_start + len..];
	}
	out.push_str(rest);
	out
}

fn recompress(base64_png: &str, options: &ImageOptions) -> Option<String> {
	// base64 is 4/3 the size of the bytes it encodes
	if base64_png.len() / 4 * 3 <= options.keep_below_bytes {
		return None;
	}
	let png = STANDARD.decode(base64_png).ok()?;
	let mut image =
		image::load_from_memory_with_format(&png, image::ImageFormat::Png).ok()?;

	let (width, height) = image.dimensions();
	if width.max(height) > options.max_dimension {
		image = image.resize(
			options.max_dimension,
			options.max_dimension,
			FilterType::Triangle,
		);
	}

	let webp = encode_webp(&image, options.quality)?;
	if webp.len() >= png.len() {
		return None;
	}
	Some(format!("data:image/webp;base64,{}", STANDARD.encode(webp)))
}

pub(crate) fn encode_webp(image: &DynamicImage, quality: f32) -> Option<Vec<u8>> {
	let image = if image.color().has_alpha() {
		DynamicImage::ImageRgba8(image.to_rgba8())
	} else {
		DynamicImage::ImageRgb8(image.to_rgb8())
	};
	let encoder = webp::Encoder::from_image(&image).ok()?;
	Some(encoder.encode(quality).to_vec())
}

#[cfg(test)]
mod tests {
	use super::*;
	use image::{ImageBuffer, Rgb};

	#[test]
	fn rewrites_large_png_and_keeps_small_ones() {
		let noisy = ImageBuffer::from_fn(600, 600, |x, y| {
			Rgb([
				(x * 7 % 251) as u8,
				(y * 13 % 241) as u8,
				((x ^ y) % 255) as u8,
			])
		});
		let mut png = Vec::new();
		DynamicImage::ImageRgb8(noisy)
			.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
			.unwrap();
		let big = format!("{PNG_PREFIX}{}", STANDARD.encode(&png));
		let small = format!("{PNG_PREFIX}AAAA");
		let svg = format!(
			r#"<svg><image xlink:href="{big}"/><image xlink:href="{small}"/></svg>"#
		);

		let options = ImageOptions {
			keep_below_bytes: 1024,
			max_dimension: 300,
			quality: 70.0,
		};
		let out = recompress_embedded_images(svg.clone(), &options);
		assert!(out.contains("data:image/webp;base64,"));
		assert!(out.contains(&small));
		assert!(out.len() < svg.len());
	}
}
