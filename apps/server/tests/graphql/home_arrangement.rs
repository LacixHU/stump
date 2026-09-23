use crate::common::TestApp;
use models::{
	entity::{media, media_last_played, user, user_preferences},
	shared::home_arrangement::{HomeArrangement, HomeSectionKind},
};
use sea_orm::{
	ActiveModelTrait, ColumnTrait, EntityTrait, PaginatorTrait, QueryFilter, Set,
};
use serde_json::json;

async fn current_user_id(app: &TestApp) -> String {
	user::Entity::find()
		.one(app.conn())
		.await
		.expect("could not query users")
		.expect("expected the initial admin user")
		.id
}

async fn insert_book(app: &TestApp, id: &str, extension: &str) -> media::Model {
	let series = tests::fake_data::Series {
		id: Some(format!("{id}-series")),
		name: Some(id.to_string()),
		..Default::default()
	}
	.insert(app.conn())
	.await;

	tests::fake_data::Media {
		id: Some(id.to_string()),
		name: Some(id.to_string()),
		series_id: series.id,
		extension: Some(extension.to_string()),
		..Default::default()
	}
	.insert(app.conn())
	.await
}

fn sections_payload(order: &[HomeSectionKind]) -> serde_json::Value {
	json!({
		"sections": order
			.iter()
			.map(|kind| json!({ "kind": kind, "visible": true }))
			.collect::<Vec<_>>()
	})
}

#[tokio::test]
async fn test_last_played_games_records_and_hides_other_users() {
	let app = TestApp::new_with_default_user().await;
	let user_id = current_user_id(&app).await;
	let game = insert_book(&app, "turrican", "d64").await;

	let other = user::ActiveModel {
		username: Set("other-player".to_string()),
		hashed_password: Set("unused".to_string()),
		is_server_owner: Set(false),
		..Default::default()
	}
	.insert(app.conn())
	.await
	.expect("could not insert other user");

	media_last_played::ActiveModel {
		user_id: Set(other.id.clone()),
		media_id: Set(game.id.clone()),
		..Default::default()
	}
	.insert(app.conn())
	.await
	.expect("could not insert other user's play");

	let record = app
		.execute_gql(
			r#"mutation Record($id: ID!) { recordMediaPlay(id: $id) }"#,
			Some(json!({ "id": game.id })),
		)
		.await;
	assert_eq!(record["data"]["recordMediaPlay"], true);

	let listed = app
		.execute_gql(
			r#"
			query LastPlayed($pagination: Pagination!) {
				lastPlayedGames(pagination: $pagination) {
					nodes { lastPlayedAt media { id } }
				}
			}
			"#,
			Some(json!({ "pagination": { "offset": { "page": 1, "pageSize": 20 } } })),
		)
		.await;
	let nodes = listed["data"]["lastPlayedGames"]["nodes"]
		.as_array()
		.expect("expected nodes");
	assert_eq!(nodes.len(), 1);
	assert_eq!(nodes[0]["media"]["id"], game.id);
	assert!(nodes[0]["lastPlayedAt"].is_string());

	let rows = media_last_played::Entity::find()
		.filter(media_last_played::Column::UserId.eq(user_id))
		.all(app.conn())
		.await
		.expect("could not load plays");
	assert_eq!(rows.len(), 1);
}

#[tokio::test]
async fn test_record_media_play_rejects_non_retro_and_missing() {
	let app = TestApp::new_with_default_user().await;
	let book = insert_book(&app, "novel", "epub").await;

	let non_retro = app
		.execute_gql(
			r#"mutation Record($id: ID!) { recordMediaPlay(id: $id) }"#,
			Some(json!({ "id": book.id })),
		)
		.await;
	assert!(non_retro.get("errors").is_some());

	let missing = app
		.execute_gql(
			r#"mutation Record($id: ID!) { recordMediaPlay(id: $id) }"#,
			Some(json!({ "id": "missing-media" })),
		)
		.await;
	assert!(missing.get("errors").is_some());

	let count = media_last_played::Entity::find()
		.count(app.conn())
		.await
		.expect("could not count plays");
	assert_eq!(count, 0);
}

#[tokio::test]
async fn test_last_played_games_rejects_cursor_pagination() {
	let app = TestApp::new_with_default_user().await;
	let result = app
		.execute_gql(
			r#"
			query LastPlayed($pagination: Pagination!) {
				lastPlayedGames(pagination: $pagination) { nodes { lastPlayedAt } }
			}
			"#,
			Some(json!({ "pagination": { "cursor": { "limit": 20 } } })),
		)
		.await;

	assert!(result.get("errors").is_some());
}

#[tokio::test]
async fn test_home_arrangement_rejects_locked_updates_then_saves_tagged_shape() {
	let app = TestApp::new_with_default_user().await;
	let prefs_before = user_preferences::Entity::find()
		.one(app.conn())
		.await
		.expect("could not load preferences")
		.expect("expected preferences");
	assert!(prefs_before.home_arrangement.is_none());

	let rejected = app
		.execute_gql(
			r#"
			mutation Update($input: HomeArrangementInput!) {
				updateHomeArrangement(input: $input) { locked }
			}
			"#,
			Some(json!({ "input": sections_payload(&HomeSectionKind::ALL) })),
		)
		.await;
	assert!(rejected.get("errors").is_some());

	let still_null = user_preferences::Entity::find()
		.one(app.conn())
		.await
		.expect("could not reload preferences")
		.expect("expected preferences");
	assert!(still_null.home_arrangement.is_none());

	let unlocked = app
		.execute_gql(
			r#"mutation Unlock($locked: Boolean!) { updateHomeArrangementLock(locked: $locked) { locked } }"#,
			Some(json!({ "locked": false })),
		)
		.await;
	assert_eq!(
		unlocked["data"]["updateHomeArrangementLock"]["locked"],
		false
	);

	let mut order = HomeSectionKind::ALL.to_vec();
	order.swap(0, 4);
	let updated = app
		.execute_gql(
			r#"
			mutation Update($input: HomeArrangementInput!) {
				updateHomeArrangement(input: $input) {
					locked
					sections { kind visible }
				}
			}
			"#,
			Some(json!({ "input": sections_payload(&order) })),
		)
		.await;
	assert_eq!(
		updated["data"]["updateHomeArrangement"]["sections"][0]["kind"],
		"RECENTLY_ADDED_SERIES"
	);

	let stored = user_preferences::Entity::find()
		.one(app.conn())
		.await
		.expect("could not reload preferences")
		.expect("expected preferences")
		.home_arrangement
		.expect("expected tagged arrangement");
	assert_eq!(
		stored,
		HomeArrangement {
			locked: false,
			sections: order
				.into_iter()
				.map(|kind| models::shared::home_arrangement::HomeSection {
					kind,
					visible: true,
				})
				.collect(),
		}
	);
}
