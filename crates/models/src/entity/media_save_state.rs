use sea_orm::{entity::prelude::*, prelude::async_trait::async_trait, ActiveValue};

use super::user::AuthUser;

/// Metadata for a single emulator save state. The snapshot bytes themselves live on
/// disk under `StumpConfig::get_save_states_dir()`; this row only records that they
/// exist, how big they are, and when they were last written.
///
/// A unique index on `(user_id, media_id)` enforces one save state per user per book.
///
/// Note: this entity is intentionally **not** exposed through GraphQL. Save states are
/// served over REST so the bytes never have to be base64'd through a query.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq)]
#[sea_orm(table_name = "media_save_states")]
pub struct Model {
	#[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
	pub id: String,
	#[sea_orm(column_type = "Text")]
	pub user_id: String,
	#[sea_orm(column_type = "Text")]
	pub media_id: String,
	pub size_bytes: i32,
	pub created_at: DateTimeUtc,
	pub updated_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
	#[sea_orm(
		belongs_to = "super::media::Entity",
		from = "Column::MediaId",
		to = "super::media::Column::Id",
		on_update = "Cascade",
		on_delete = "Cascade"
	)]
	Media,
	#[sea_orm(
		belongs_to = "super::user::Entity",
		from = "Column::UserId",
		to = "super::user::Column::Id",
		on_update = "Cascade",
		on_delete = "Cascade"
	)]
	User,
}

impl Related<super::media::Entity> for Entity {
	fn to() -> RelationDef {
		Relation::Media.def()
	}
}

impl Related<super::user::Entity> for Entity {
	fn to() -> RelationDef {
		Relation::User.def()
	}
}

impl Entity {
	/// The save state belonging to this user for this book, if any. There is at most one.
	pub fn find_for_user_and_media_id(user: &AuthUser, media_id: &str) -> Select<Entity> {
		Entity::find()
			.filter(Column::UserId.eq(&user.id))
			.filter(Column::MediaId.eq(media_id))
	}
}

#[async_trait]
impl ActiveModelBehavior for ActiveModel {
	async fn before_save<C>(mut self, _db: &C, insert: bool) -> Result<Self, DbErr>
	where
		C: ConnectionTrait,
	{
		let now = chrono::Utc::now();

		if insert {
			self.created_at = ActiveValue::Set(now);
			if self.id.is_not_set() {
				self.id = ActiveValue::Set(Uuid::new_v4().to_string());
			}
		}

		// Unlike `created_at`, this has to be bumped on every write -- the whole point
		// of the row is to say when the snapshot on disk was last replaced.
		self.updated_at = ActiveValue::Set(now);

		Ok(self)
	}
}
