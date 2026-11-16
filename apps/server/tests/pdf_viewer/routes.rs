use crate::common::TestApp;

use axum::http::StatusCode;
use models::entity::media;
use sea_orm::{prelude::*, ActiveValue::Set};
use serde_json::Value;
use tests::fake_data;

/// A server with the core test PDF (the Rust book) as a book, plus the admin user.
async fn setup_pdf_book() -> (TestApp, media::Model) {
	let app = TestApp::new_with_default_user().await;
	let conn = app.conn();

	let series = fake_data::Series {
		id: Some("rust".to_string()),
		name: Some("Rust".to_string()),
		..Default::default()
	}
	.insert(conn)
	.await;
	let book = fake_data::Media {
		id: Some("rust_book".to_string()),
		name: Some("The Rust Programming Language".to_string()),
		series_id: series.id.clone(),
		extension: Some("pdf".to_string()),
		..Default::default()
	}
	.insert(conn)
	.await;

	let pdf = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
		.join("../../core/integration-tests/data/rust_book.pdf")
		.canonicalize()
		.expect("the core test PDF should exist");
	let book = media::ActiveModel {
		id: Set(book.id),
		path: Set(pdf.to_string_lossy().to_string()),
		..Default::default()
	}
	.update(conn)
	.await
	.expect("could not point the book at the test PDF");

	(app, book)
}

#[tokio::test]
async fn test_pdf_info_lists_pages() {
	let (app, book) = setup_pdf_book().await;

	let response = app
		.get(&format!("/api/v2/media/{}/pdf/info", book.id))
		.await;

	assert_eq!(response.status_code(), StatusCode::OK);
	let info: Value = response.json();
	let page_count = info["pageCount"].as_u64().unwrap();
	assert!(page_count > 100);
	assert_eq!(info["pages"].as_array().unwrap().len() as u64, page_count);
	assert!(info["pages"][0]["width"].as_f64().unwrap() > 0.0);
}

#[tokio::test]
async fn test_pdf_page_is_sandboxed_html() {
	let (app, book) = setup_pdf_book().await;

	let response = app
		.get(&format!("/api/v2/media/{}/pdf/page/5", book.id))
		.await;

	assert_eq!(response.status_code(), StatusCode::OK);
	assert_eq!(
		response.header("content-type").to_str().unwrap(),
		"text/html; charset=utf-8"
	);
	let csp = response.header("content-security-policy");
	let csp = csp.to_str().unwrap();
	assert!(csp.starts_with("sandbox allow-scripts;"));
	assert!(csp.contains("default-src 'none'"));

	let html = response.text();
	assert!(html.starts_with("<!doctype html>"));
	assert!(html.contains("<svg"));
	assert!(html.contains("The Rust Programming Language – 5"));
	// the text layer carries the page's text
	assert!(html.contains("How to Use This Book"));
}

#[tokio::test]
async fn test_pdf_thumbnail_is_webp() {
	let (app, book) = setup_pdf_book().await;

	let response = app
		.get(&format!(
			"/api/v2/media/{}/pdf/thumbnail/1?size=120",
			book.id
		))
		.await;

	assert_eq!(response.status_code(), StatusCode::OK);
	assert_eq!(
		response.header("content-type").to_str().unwrap(),
		"image/webp"
	);
	assert_eq!(&response.as_bytes()[..4], b"RIFF");
}

#[tokio::test]
async fn test_pdf_page_out_of_range_is_not_found() {
	let (app, book) = setup_pdf_book().await;

	let response = app
		.get(&format!("/api/v2/media/{}/pdf/page/100000", book.id))
		.await;

	assert_eq!(response.status_code(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn test_pdf_routes_reject_other_formats() {
	let app = TestApp::new_with_default_user().await;
	let conn = app.conn();
	let series = fake_data::Series {
		id: Some("comics".to_string()),
		..Default::default()
	}
	.insert(conn)
	.await;
	let book = fake_data::Media {
		id: Some("a_comic".to_string()),
		series_id: series.id.clone(),
		extension: Some("cbz".to_string()),
		..Default::default()
	}
	.insert(conn)
	.await;

	let response = app
		.get(&format!("/api/v2/media/{}/pdf/page/1", book.id))
		.await;

	assert_eq!(response.status_code(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn test_pdf_page_svg_is_an_inert_image() {
	let (app, book) = setup_pdf_book().await;

	let response = app
		.get(&format!("/api/v2/media/{}/pdf/svg/5", book.id))
		.await;

	assert_eq!(response.status_code(), StatusCode::OK);
	assert_eq!(
		response.header("content-type").to_str().unwrap(),
		"image/svg+xml"
	);
	let csp = response.header("content-security-policy");
	assert!(csp.to_str().unwrap().starts_with("sandbox;"));
	let svg = response.text();
	assert!(svg.starts_with("<svg"));
	assert!(!svg.contains("<script"));
}

#[tokio::test]
async fn test_pdf_page_text_has_positions() {
	let (app, book) = setup_pdf_book().await;

	let response = app
		.get(&format!("/api/v2/media/{}/pdf/text/5", book.id))
		.await;

	assert_eq!(response.status_code(), StatusCode::OK);
	let text: Value = response.json();
	let width = text["width"].as_f64().unwrap();
	assert!(width > 0.0);
	let spans = text["spans"].as_array().unwrap();
	assert!(!spans.is_empty());
	let first = &spans[0];
	assert!(!first["text"].as_str().unwrap().is_empty());
	for key in ["x", "y", "size", "angle", "width"] {
		assert!(first[key].is_number(), "{key} should be a number");
	}
	let offsets = first["offsets"].as_array().unwrap();
	assert_eq!(
		offsets.len(),
		first["text"].as_str().unwrap().encode_utf16().count()
	);

	let response = app
		.get(&format!("/api/v2/media/{}/pdf/text/100000", book.id))
		.await;
	assert_eq!(response.status_code(), StatusCode::NOT_FOUND);
}
