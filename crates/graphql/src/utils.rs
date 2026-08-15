use models::entity::user::AuthUser;
use sea_orm::{
	prelude::DateTimeWithTimeZone, ConnectionTrait, DatabaseConnection, Statement, Value,
};
use tower_sessions::Session;

use crate::data::ServiceContext;

pub async fn save_user_session(session: &Session, user: AuthUser) {
	if let Err(error) = session.insert("user", user).await {
		tracing::error!(?error, "Failed to save user session");
	}
}

/// Build a raw SQL [`Statement`] using the actual database backend of `conn`.
/// Write SQL with `$1`, `$2`, … placeholders — they work for both PostgreSQL
/// and SQLite (SQLite treats them as named parameters).
pub fn db_statement(
	conn: &DatabaseConnection,
	sql: impl Into<String>,
	values: impl IntoIterator<Item = Value>,
) -> Statement {
	Statement::from_sql_and_values(conn.get_database_backend(), sql, values)
}

/// Build a thumbnail URL that changes when the entity's `updated_at` changes so
/// browsers and AuthImage caches do not keep serving a replaced image at a stable path.
pub fn versioned_thumbnail_url(
	service: &ServiceContext,
	path: impl AsRef<str>,
	updated_at: Option<DateTimeWithTimeZone>,
) -> String {
	let base = service.format_url(path);
	match updated_at {
		Some(ts) => format!("{base}?v={}", ts.timestamp_millis()),
		None => base,
	}
}
