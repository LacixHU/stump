use crate::common::{series::setup_single_series_with_n_books, TestApp};

use axum::http::StatusCode;
use models::entity::{media, media_save_state, user};
use sea_orm::{prelude::*, ActiveValue};
use tests::fake_data;

/// Create a server with one retro book (a `.d64`) in it, plus the initial admin user.
async fn setup_retro_book() -> (TestApp, media::Model) {
	let app = TestApp::new_with_default_user().await;
	let conn = app.conn();

	let series = fake_data::Series {
		id: Some("turrican".to_string()),
		name: Some("Turrican".to_string()),
		..Default::default()
	}
	.insert(conn)
	.await;

	// `fake_data::Media` derives `path` from the name + extension, and the save state
	// routes gate on the path's extension, so this is what makes the book "retro".
	let book = fake_data::Media {
		id: Some("turrican_disk_1".to_string()),
		name: Some("Turrican".to_string()),
		series_id: series.id.clone(),
		extension: Some("d64".to_string()),
		..Default::default()
	}
	.insert(conn)
	.await;

	(app, book)
}

async fn current_user_id(app: &TestApp) -> String {
	user::Entity::find()
		.one(app.conn())
		.await
		.expect("could not query users")
		.expect("expected the initial admin user to exist")
		.id
}

fn save_state_url(book_id: &str) -> String {
	format!("/api/v2/media/{book_id}/save-state")
}

async fn count_rows(app: &TestApp, book_id: &str) -> u64 {
	media_save_state::Entity::find()
		.filter(media_save_state::Column::MediaId.eq(book_id))
		.count(app.conn())
		.await
		.expect("could not count save states")
}

/// a user who has never saved this game should get a 404, not an error
#[tokio::test]
async fn test_get_without_save_state_is_not_found() {
	let (app, book) = setup_retro_book().await;

	let response = app.get(&save_state_url(&book.id)).await;

	assert_eq!(response.status_code(), StatusCode::NOT_FOUND);
	assert_eq!(count_rows(&app, &book.id).await, 0);
}

/// the exact snapshot bytes that went in should come back out
#[tokio::test]
async fn test_put_then_get_round_trips_bytes() {
	let (app, book) = setup_retro_book().await;
	let snapshot: Vec<u8> = (0..=255u8).cycle().take(4096).collect();

	let put = app
		.put_bytes(&save_state_url(&book.id), snapshot.clone())
		.await;
	put.assert_status_ok();

	let get = app.get(&save_state_url(&book.id)).await;
	get.assert_status_ok();
	assert_eq!(get.as_bytes().to_vec(), snapshot);

	// the metadata row should agree with what was actually stored
	let row = media_save_state::Entity::find()
		.filter(media_save_state::Column::MediaId.eq(book.id.clone()))
		.one(app.conn())
		.await
		.expect("could not query save states")
		.expect("expected a save state row");
	assert_eq!(row.size_bytes as usize, snapshot.len());
	assert_eq!(row.user_id, current_user_id(&app).await);
}

/// saving twice should replace the snapshot rather than accumulate rows
#[tokio::test]
async fn test_put_twice_replaces_the_save_state() {
	let (app, book) = setup_retro_book().await;

	app.put_bytes(&save_state_url(&book.id), vec![1u8; 512])
		.await
		.assert_status_ok();
	app.put_bytes(&save_state_url(&book.id), vec![2u8; 256])
		.await
		.assert_status_ok();

	assert_eq!(count_rows(&app, &book.id).await, 1);

	let get = app.get(&save_state_url(&book.id)).await;
	get.assert_status_ok();
	assert_eq!(get.as_bytes().to_vec(), vec![2u8; 256]);
}

/// deleting should remove both the row and the file on disk
#[tokio::test]
async fn test_delete_removes_row_and_file() {
	let (app, book) = setup_retro_book().await;
	let user_id = current_user_id(&app).await;

	app.put_bytes(&save_state_url(&book.id), vec![7u8; 128])
		.await
		.assert_status_ok();

	let path = stump_core::filesystem::media::save_state_path(
		&app.ctx.config.get_save_states_dir(),
		&book.id,
		&user_id,
	);
	assert!(path.exists(), "expected the snapshot to be written to disk");

	let delete = app.delete(&save_state_url(&book.id)).await;
	assert_eq!(delete.status_code(), StatusCode::NO_CONTENT);

	assert_eq!(count_rows(&app, &book.id).await, 0);
	assert!(
		!path.exists(),
		"expected the snapshot to be removed from disk"
	);

	// deleting again is a 404, not a 500
	let delete_again = app.delete(&save_state_url(&book.id)).await;
	assert_eq!(delete_again.status_code(), StatusCode::NOT_FOUND);
}

/// save states are only for retro images -- a comic should be rejected outright
#[tokio::test]
async fn test_non_retro_book_is_rejected() {
	let app = TestApp::new_with_default_user().await;
	let (_, books) = setup_single_series_with_n_books(
		&app,
		fake_data::Series {
			id: Some("black_science".to_string()),
			name: Some("Black Science".to_string()),
			..Default::default()
		},
		1,
	)
	.await;
	let book = books
		.into_iter()
		.next()
		.expect("should have created a book");

	let put = app
		.put_bytes(&save_state_url(&book.id), vec![1u8; 32])
		.await;
	assert_eq!(put.status_code(), StatusCode::BAD_REQUEST);

	let get = app.get(&save_state_url(&book.id)).await;
	assert_eq!(get.status_code(), StatusCode::BAD_REQUEST);
}

/// an empty snapshot is never valid -- storing one would hand the emulator a broken
/// save to choke on later
#[tokio::test]
async fn test_empty_save_state_is_rejected() {
	let (app, book) = setup_retro_book().await;

	let put = app.put_bytes(&save_state_url(&book.id), Vec::new()).await;

	assert_eq!(put.status_code(), StatusCode::BAD_REQUEST);
	assert_eq!(count_rows(&app, &book.id).await, 0);
}

/// if the file behind a row disappears, the read should report "no save" and drop the
/// stale row rather than failing
#[tokio::test]
async fn test_row_without_file_self_heals() {
	let (app, book) = setup_retro_book().await;
	let user_id = current_user_id(&app).await;

	app.put_bytes(&save_state_url(&book.id), vec![9u8; 64])
		.await
		.assert_status_ok();

	let path = stump_core::filesystem::media::save_state_path(
		&app.ctx.config.get_save_states_dir(),
		&book.id,
		&user_id,
	);
	std::fs::remove_file(&path).expect("could not remove the snapshot");

	let get = app.get(&save_state_url(&book.id)).await;

	assert_eq!(get.status_code(), StatusCode::NOT_FOUND);
	assert_eq!(
		count_rows(&app, &book.id).await,
		0,
		"expected the stale row to have been removed"
	);
}

/// one user's save state must never be served to another
#[tokio::test]
async fn test_save_states_are_per_user() {
	let (app, book) = setup_retro_book().await;
	let conn = app.conn();

	app.put_bytes(&save_state_url(&book.id), vec![1u8; 100])
		.await
		.assert_status_ok();

	// a second player saves the same game
	let other = fake_data::User::new("player-two").insert(conn).await;
	stump_core::filesystem::media::write_save_state(
		&app.ctx.config.get_save_states_dir(),
		&book.id,
		&other.id,
		&vec![2u8; 200],
	)
	.await
	.expect("could not write the other user's snapshot");
	media_save_state::ActiveModel {
		user_id: ActiveValue::Set(other.id.clone()),
		media_id: ActiveValue::Set(book.id.clone()),
		size_bytes: ActiveValue::Set(200),
		..Default::default()
	}
	.insert(conn)
	.await
	.expect("could not insert the other user's save state");

	assert_eq!(count_rows(&app, &book.id).await, 2);

	// the admin still gets their own snapshot back, untouched
	let get = app.get(&save_state_url(&book.id)).await;
	get.assert_status_ok();
	assert_eq!(get.as_bytes().to_vec(), vec![1u8; 100]);
}
