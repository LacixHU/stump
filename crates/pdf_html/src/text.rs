//! Text layer extraction: a hayro [`Device`] that ignores all painting and records,
//! for every glyph, its Unicode text and where it sits on the page. Consecutive glyphs
//! on the same baseline are merged into [`TextSpan`]s, the same model PDF.js uses for
//! its selectable text layer.
//!
//! Glyphs drawn in the invisible text render mode (`3 Tr`) are kept: that is how OCR'd
//! scans carry their text, and it is exactly what the text layer is for.

use hayro::hayro_interpret::{
	font::{Glyph, GlyphRun},
	BlendMode, ClipPath, Device, DrawMode, DrawProps, Image, ImageDrawProps, SoftMask,
};
use hayro::kurbo::{Affine, BezPath, Point, Shape, Vec2};

/// Glyph space in hayro is 1000 units per em.
const UNITS_PER_EM: f64 = 1000.0;

/// A run of text on one baseline, in page coordinates (PDF points, y down, origin at
/// the top-left of the rendered page).
#[derive(Debug, Clone, PartialEq)]
pub struct TextSpan {
	pub text: String,
	/// Baseline origin of the first glyph.
	pub x: f64,
	pub y: f64,
	/// Font size (em height) in points.
	pub size: f64,
	/// Rotation of the baseline in radians, clockwise (y points down).
	pub angle: f64,
	/// Length of the span along its baseline, in points.
	pub width: f64,
	/// Where each UTF-16 code unit of `text` starts, in points along the baseline from
	/// the span origin, so a part of the span can be located exactly.
	pub offsets: Vec<f64>,
}

struct SpanBuilder {
	text: String,
	origin: Point,
	/// Unit vector along the baseline.
	dir: Vec2,
	angle: f64,
	size: f64,
	/// Distance from `origin` along `dir` where the last glyph ends.
	end: f64,
	/// Start of each UTF-16 code unit of `text`, see [`TextSpan::offsets`].
	offsets: Vec<f64>,
}

impl SpanBuilder {
	fn push(&mut self, text: &str, offset: f64) {
		self.text.push_str(text);
		let units = text.encode_utf16().count();
		self.offsets.extend(std::iter::repeat_n(offset, units));
	}

	fn finish(mut self) -> Option<TextSpan> {
		let trimmed = self.text.trim_end().len();
		self.text.truncate(trimmed);
		if self.text.is_empty() {
			return None;
		}
		self.offsets.truncate(self.text.encode_utf16().count());
		Some(TextSpan {
			text: self.text,
			x: self.origin.x,
			y: self.origin.y,
			size: self.size,
			angle: self.angle,
			width: self.end.max(0.0),
			offsets: self.offsets,
		})
	}
}

#[derive(Default)]
pub(crate) struct TextCollector {
	spans: Vec<TextSpan>,
	current: Option<SpanBuilder>,
}

impl TextCollector {
	pub(crate) fn finish(mut self) -> Vec<TextSpan> {
		self.flush();
		self.spans
	}

	fn flush(&mut self) {
		if let Some(span) = self.current.take().and_then(SpanBuilder::finish) {
			self.spans.push(span);
		}
	}

	fn push_glyph(&mut self, text: &str, transform: Affine, advance_units: f64) {
		let origin = transform * Point::ORIGIN;
		let along = (transform * Point::new(UNITS_PER_EM, 0.0)) - origin;
		let up = (transform * Point::new(0.0, UNITS_PER_EM)) - origin;

		let size = up.hypot();
		let along_len = along.hypot();
		if !size.is_finite() || size < 0.5 || along_len < 1e-6 {
			return;
		}
		let dir = along / along_len;
		let angle = dir.y.atan2(dir.x);
		let advance = advance_units / UNITS_PER_EM * along_len;

		if let Some(current) = self.current.as_mut() {
			let delta = origin - current.origin;
			let offset = delta.dot(current.dir);
			let drift = delta.cross(current.dir).abs();
			let gap = offset - current.end;
			let same_line = (angle - current.angle).abs() < 0.02
				&& (size / current.size - 1.0).abs() < 0.25
				&& drift < current.size * 0.3
				&& gap > -current.size * 0.6
				// wider gaps are columns or table cells, which must not share a span
				&& gap < current.size * 1.0;

			if same_line {
				let is_space = text.chars().all(char::is_whitespace);
				if gap > current.size * 0.15
					&& !is_space && !current.text.ends_with(char::is_whitespace)
				{
					let space_at = current.end;
					current.push(" ", space_at);
				}
				current.push(text, offset.max(0.0));
				current.end = current.end.max(offset + advance);
				return;
			}
		}

		self.flush();
		if text.chars().all(char::is_whitespace) {
			return;
		}
		let mut span = SpanBuilder {
			text: String::new(),
			origin,
			dir,
			angle,
			size,
			end: advance,
			offsets: Vec::new(),
		};
		span.push(text, 0.0);
		self.current = Some(span);
	}
}

fn glyph_text(glyph: &Glyph<'_>) -> Option<String> {
	let text: String = match glyph.as_unicode()? {
		hayro::hayro_interpret::hayro_cmap::BfString::Char(c) => c.to_string(),
		hayro::hayro_interpret::hayro_cmap::BfString::String(s) => s,
	};
	let text: String = text
		.chars()
		.map(|c| if c.is_control() { ' ' } else { c })
		.filter(|c| *c != '\u{FFFD}')
		.collect();
	(!text.is_empty()).then_some(text)
}

/// Advance of a glyph in glyph units: the font's width for it, or the right edge of
/// its outline when the font does not say.
fn glyph_advance(glyph: &Glyph<'_>) -> f64 {
	let advance = match glyph {
		Glyph::Outline(outline) => outline
			.advance_width()
			.map(f64::from)
			.filter(|w| *w > 0.0)
			.unwrap_or_else(|| outline.outline().bounding_box().x1),
		Glyph::Type3(t3) => t3.advance_width().map(f64::from).unwrap_or(0.0),
	};
	if advance.is_finite() && advance > 0.0 {
		advance
	} else {
		UNITS_PER_EM * 0.5
	}
}

impl<'a> Device<'a> for TextCollector {
	fn draw_path(&mut self, _: &BezPath, _: DrawProps<'a>, _: &DrawMode) {}

	fn push_clip_path(&mut self, _: &ClipPath) {}

	fn push_transparency_group(&mut self, _: f32, _: Option<SoftMask<'a>>, _: BlendMode) {
	}

	fn draw_glyph_run(
		&mut self,
		glyph_run: &GlyphRun<'_, 'a>,
		props: DrawProps<'a>,
		_: &DrawMode,
	) {
		for glyph in glyph_run.glyphs() {
			let Some(text) = glyph_text(glyph) else {
				continue;
			};
			let transform = props.transform * glyph.transform();
			self.push_glyph(&text, transform, glyph_advance(glyph));
		}
	}

	fn draw_image(&mut self, _: Image<'a, '_>, _: ImageDrawProps<'a>) {}

	fn pop_clip(&mut self) {}

	fn pop_transparency_group(&mut self) {}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn glyph_at(c: &mut TextCollector, text: &str, x: f64, y: f64, size: f64) {
		let transform = Affine::translate((x, y)) * Affine::scale(size / UNITS_PER_EM);
		c.push_glyph(text, transform, 500.0);
	}

	#[test]
	fn merges_glyphs_on_one_baseline() {
		let mut c = TextCollector::default();
		glyph_at(&mut c, "H", 10.0, 100.0, 12.0);
		glyph_at(&mut c, "i", 16.0, 100.0, 12.0);
		// a word gap
		glyph_at(&mut c, "y", 30.0, 100.0, 12.0);
		// next line
		glyph_at(&mut c, "x", 10.0, 120.0, 12.0);
		let spans = c.finish();
		assert_eq!(spans.len(), 2);
		assert_eq!(spans[0].text, "Hi y");
		assert_eq!(spans[0].x, 10.0);
		assert!((spans[0].width - 26.0).abs() < 1e-6);
		// the inserted space starts where "i" ends
		assert_eq!(spans[0].offsets, vec![0.0, 6.0, 12.0, 20.0]);
		assert_eq!(spans[1].text, "x");
	}
}
