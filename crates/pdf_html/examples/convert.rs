//! Convert a PDF into `page-N.html` + `thumb-N.webp` files plus an `index.html` that
//! shows them one page at a time in an iframe.
//!
//! cargo run -p pdf_html --release --example convert -- book.pdf out/ [first-n-pages]

use std::{fmt::Write, path::PathBuf, time::Instant};

use pdf_html::{HtmlOptions, PdfHtmlDocument};

fn main() {
	let mut args = std::env::args().skip(1);
	let input =
		PathBuf::from(args.next().expect("usage: convert <pdf> <out-dir> [pages]"));
	let out = PathBuf::from(args.next().unwrap_or_else(|| "pdf_html_out".into()));
	let limit: Option<usize> = args.next().and_then(|n| n.parse().ok());
	std::fs::create_dir_all(&out).unwrap();

	let started = Instant::now();
	let doc = PdfHtmlDocument::from_bytes(std::fs::read(&input).unwrap()).unwrap();
	let info = doc.info();
	let count = limit.unwrap_or(usize::MAX).min(doc.page_count());
	println!(
		"{} pages ({:?}), parsed in {:?}",
		doc.page_count(),
		info,
		started.elapsed()
	);

	let options = HtmlOptions {
		title: info.title.clone(),
		..Default::default()
	};
	for index in 0..count {
		let t = Instant::now();
		let html = doc.page_html(index, &options).unwrap();
		let html_time = t.elapsed();
		let t = Instant::now();
		let thumb = doc.render_thumbnail(index, 240, 75.0).unwrap();
		println!(
			"page {:>4}: html {:>8} B in {:>6.1?}, thumb {:>6} B in {:>6.1?}",
			index + 1,
			html.len(),
			html_time,
			thumb.len(),
			t.elapsed()
		);
		std::fs::write(out.join(format!("page-{}.html", index + 1)), html).unwrap();
		std::fs::write(out.join(format!("thumb-{}.webp", index + 1)), thumb).unwrap();
	}

	let mut thumbs = String::new();
	for n in 1..=count {
		let _ = write!(
			thumbs,
			r#"<img src="thumb-{n}.webp" onclick="go({n})" title="{n}">"#
		);
	}
	let index = format!(
		r#"<!doctype html><meta charset="utf-8"><title>pdf_html preview</title>
<style>body{{margin:0;display:flex;height:100vh;background:#333}}
nav{{width:140px;overflow:auto;padding:8px;box-sizing:border-box}}
nav img{{width:100%;margin-bottom:8px;cursor:pointer;box-shadow:0 1px 3px #000}}
iframe{{flex:1;border:0}}</style>
<nav>{thumbs}</nav><iframe id="f" sandbox="allow-scripts"></iframe>
<script>var n=1,max={count},f=document.getElementById('f');
function go(p){{n=Math.min(max,Math.max(1,p));f.src='page-'+n+'.html';}}
addEventListener('message',function(e){{if(e.source!==f.contentWindow||!e.data)return;
if(e.data.type==='stump-pdf:key'){{if(e.data.key==='ArrowRight'||e.data.key==='PageDown')go(n+1);
if(e.data.key==='ArrowLeft'||e.data.key==='PageUp')go(n-1);}}}});
addEventListener('keydown',function(e){{if(e.key==='ArrowRight')go(n+1);if(e.key==='ArrowLeft')go(n-1);}});
go(1);</script>"#
	);
	std::fs::write(out.join("index.html"), index).unwrap();
	println!(
		"done in {:?} -> {}",
		started.elapsed(),
		out.join("index.html").display()
	);
}
