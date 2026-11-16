//! The standalone HTML document served for one page: the page as inline SVG, a
//! transparent text layer on top for selection and search, and a small script that
//! fits the page into the frame. The document loads nothing, so it works inside a
//! sandboxed iframe with a `default-src 'none'` policy.
//!
//! The embedding page talks to it with `postMessage`:
//! - in: `{ type: "stump-pdf:view", fit: "page" | "width" | "none", zoom: number }`
//! - out: `{ type: "stump-pdf:ready", page, width, height }` once laid out, and
//!   `{ type: "stump-pdf:key", key }` for navigation keys pressed inside the frame,
//!   which would otherwise never reach the reader.
//!
//! The initial view can also be set with the `fit` and `zoom` query parameters.

use std::fmt::Write;

use crate::text::TextSpan;

/// Text sits this far (in ems) below the top of its line box. A generic sans-serif
/// at `line-height: 1` puts its baseline at roughly 0.8-0.9 em.
const ASCENT: f64 = 0.85;

pub(crate) struct PageHtml<'a> {
	pub page_number: usize,
	pub title: Option<&'a str>,
	pub width: f64,
	pub height: f64,
	pub svg: &'a str,
	pub spans: &'a [TextSpan],
}

pub(crate) fn render(page: &PageHtml<'_>) -> String {
	let mut out = String::with_capacity(page.svg.len() + page.spans.len() * 96 + 4096);
	let title = match page.title {
		Some(title) => format!("{} – {}", escape(title), page.page_number),
		None => format!("Page {}", page.page_number),
	};
	let (w, h) = (page.width, page.height);

	let _ = write!(
		out,
		r#"<!doctype html>
<html lang="und">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>
html,body{{margin:0;padding:0;background:transparent;height:100%}}
body{{overflow:hidden;display:flex;align-items:center}}
body.fit-width,body.fit-none{{overflow:auto;align-items:flex-start}}
#sizer{{position:relative;margin:auto;flex:none}}
#page{{position:absolute;left:0;top:0;width:{w:.2}px;height:{h:.2}px;transform-origin:0 0;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.25);overflow:hidden}}
#page>svg{{position:absolute;inset:0;width:100%;height:100%;display:block}}
#text{{position:absolute;inset:0;line-height:1;font-family:sans-serif;color:transparent;-webkit-text-size-adjust:none;text-size-adjust:none}}
#text>span{{position:absolute;white-space:pre;transform-origin:0 0;cursor:text}}
#text ::selection{{background:rgba(0,90,255,.3);color:transparent}}
</style>
</head>
<body class="fit-page">
<div id="sizer"><div id="page" data-page="{page_number}">
"#,
		page_number = page.page_number,
	);

	out.push_str(page.svg);
	out.push_str("\n<div id=\"text\">");
	for span in page.spans {
		write_span(&mut out, span);
	}
	out.push_str("</div>\n</div></div>\n");

	let _ = write!(
		out,
		r#"<script>
(function () {{
	var W = {w:.2}, H = {h:.2}, PAGE = {page_number}, MARGIN = 8;
	var body = document.body, sizer = document.getElementById('sizer'), page = document.getElementById('page');
	var params = new URLSearchParams(location.search);
	var view = {{ fit: params.get('fit') || 'page', zoom: parseFloat(params.get('zoom')) || 1 }};

	var spans = document.querySelectorAll('#text>span');
	for (var i = 0; i < spans.length; i++) {{
		var s = spans[i], natural = s.offsetWidth, target = parseFloat(s.dataset.w);
		var t = s.dataset.r ? 'rotate(' + s.dataset.r + 'rad) ' : '';
		if (natural > 0 && target > 0) t += 'scaleX(' + (target / natural) + ')';
		if (t) s.style.transform = t;
	}}

	function layout() {{
		var vw = document.documentElement.clientWidth - 2 * MARGIN;
		var vh = document.documentElement.clientHeight - 2 * MARGIN;
		var scale = view.fit === 'width' ? vw / W : view.fit === 'none' ? 1 : Math.min(vw / W, vh / H);
		scale = Math.max(0.05, scale * view.zoom);
		body.className = 'fit-' + view.fit;
		if (view.zoom > 1) body.style.overflow = 'auto';
		else body.style.overflow = '';
		sizer.style.width = W * scale + 'px';
		sizer.style.height = H * scale + 'px';
		sizer.style.margin = MARGIN + 'px auto';
		page.style.transform = 'scale(' + scale + ')';
	}}

	window.addEventListener('resize', layout);
	window.addEventListener('message', function (e) {{
		var d = e.data;
		if (!d || d.type !== 'stump-pdf:view') return;
		if (d.fit === 'page' || d.fit === 'width' || d.fit === 'none') view.fit = d.fit;
		if (typeof d.zoom === 'number' && d.zoom > 0) view.zoom = d.zoom;
		layout();
	}});
	var KEYS = ['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Escape', ' '];
	window.addEventListener('keydown', function (e) {{
		if (KEYS.indexOf(e.key) < 0 || window.parent === window) return;
		var scrollable = body.scrollHeight > body.clientHeight + 1;
		if (scrollable && (e.key === 'PageUp' || e.key === 'PageDown' || e.key === ' ')) return;
		e.preventDefault();
		window.parent.postMessage({{ type: 'stump-pdf:key', key: e.key, shiftKey: e.shiftKey }}, '*');
	}});

	layout();
	if (window.parent !== window) {{
		window.parent.postMessage({{ type: 'stump-pdf:ready', page: PAGE, width: W, height: H }}, '*');
	}}
}})();
</script>
</body>
</html>
"#,
		page_number = page.page_number,
	);
	out
}

fn write_span(out: &mut String, span: &TextSpan) {
	// `top`/`left` is the top-left corner of the line box: one ascent "up" from the
	// baseline origin, where up is perpendicular to the (possibly rotated) baseline.
	let (sin, cos) = span.angle.sin_cos();
	let ascent = span.size * ASCENT;
	let left = span.x + sin * ascent;
	let top = span.y - cos * ascent;

	let _ = write!(
		out,
		r#"<span style="left:{left:.2}px;top:{top:.2}px;font-size:{size:.2}px" data-w="{width:.2}""#,
		size = span.size,
		width = span.width,
	);
	if span.angle.abs() > 1e-3 {
		let _ = write!(out, r#" data-r="{:.4}""#, span.angle);
	}
	out.push('>');
	out.push_str(&escape(&span.text));
	out.push_str("</span>");
}

pub(crate) fn escape(text: &str) -> String {
	let mut out = String::with_capacity(text.len());
	for c in text.chars() {
		match c {
			'&' => out.push_str("&amp;"),
			'<' => out.push_str("&lt;"),
			'>' => out.push_str("&gt;"),
			'"' => out.push_str("&quot;"),
			'\'' => out.push_str("&#39;"),
			c => out.push(c),
		}
	}
	out
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn escapes_text_and_title() {
		let spans = [TextSpan {
			text: "<script>alert('x')</script> & co".into(),
			x: 10.0,
			y: 20.0,
			size: 12.0,
			angle: 0.0,
			width: 100.0,
			offsets: Vec::new(),
		}];
		let html = render(&PageHtml {
			page_number: 3,
			title: Some("A <b>book</b>"),
			width: 612.0,
			height: 792.0,
			svg: "<svg></svg>",
			spans: &spans,
		});
		assert!(html.contains("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; &amp; co"));
		assert!(html.contains("<title>A &lt;b&gt;book&lt;/b&gt; – 3</title>"));
		assert!(!html.contains("<script>alert"));
		assert!(html.contains("width:612.00px;height:792.00px"));
	}
}
