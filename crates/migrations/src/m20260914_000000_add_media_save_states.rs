use sea_orm_migration::prelude::*;
use sea_orm_migration::sea_orm::Statement;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
	async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
		manager
			.create_table(
				Table::create()
					.table(MediaSaveStates::Table)
					.if_not_exists()
					.col(
						ColumnDef::new(MediaSaveStates::Id)
							.text()
							.not_null()
							.primary_key(),
					)
					.col(ColumnDef::new(MediaSaveStates::UserId).text().not_null())
					.col(ColumnDef::new(MediaSaveStates::MediaId).text().not_null())
					.col(
						ColumnDef::new(MediaSaveStates::SizeBytes)
							.integer()
							.not_null(),
					)
					.col(
						ColumnDef::new(MediaSaveStates::CreatedAt)
							.timestamp_with_time_zone()
							.not_null()
							.default(Expr::current_timestamp()),
					)
					.col(
						ColumnDef::new(MediaSaveStates::UpdatedAt)
							.timestamp_with_time_zone()
							.not_null()
							.default(Expr::current_timestamp()),
					)
					.foreign_key(
						ForeignKey::create()
							.name("fk-media-save-state-user")
							.from(MediaSaveStates::Table, MediaSaveStates::UserId)
							.to(Users::Table, Users::Id)
							.on_delete(ForeignKeyAction::Cascade)
							.on_update(ForeignKeyAction::Cascade),
					)
					.foreign_key(
						ForeignKey::create()
							.name("fk-media-save-state-media")
							.from(MediaSaveStates::Table, MediaSaveStates::MediaId)
							.to(Media::Table, Media::Id)
							.on_delete(ForeignKeyAction::Cascade)
							.on_update(ForeignKeyAction::Cascade),
					)
					.to_owned(),
			)
			.await?;

		// One save state per user per book. This is what makes the single-slot
		// behaviour a database invariant rather than a convention in the handler.
		let db = manager.get_connection();
		db.execute(Statement::from_string(
			db.get_database_backend(),
			"CREATE UNIQUE INDEX IF NOT EXISTS media_save_states_user_media_idx ON media_save_states(user_id, media_id)".to_string(),
		))
		.await?;

		Ok(())
	}

	async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
		let db = manager.get_connection();
		db.execute(Statement::from_string(
			db.get_database_backend(),
			"DROP INDEX IF EXISTS media_save_states_user_media_idx".to_string(),
		))
		.await?;

		manager
			.drop_table(Table::drop().table(MediaSaveStates::Table).to_owned())
			.await
	}
}

#[derive(Iden)]
enum MediaSaveStates {
	Table,
	Id,
	UserId,
	MediaId,
	SizeBytes,
	CreatedAt,
	UpdatedAt,
}

#[derive(Iden)]
enum Users {
	Table,
	Id,
}

#[derive(Iden)]
enum Media {
	Table,
	Id,
}
