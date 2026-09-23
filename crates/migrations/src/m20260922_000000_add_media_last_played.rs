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
					.table(MediaLastPlayed::Table)
					.if_not_exists()
					.col(
						ColumnDef::new(MediaLastPlayed::Id)
							.text()
							.not_null()
							.primary_key(),
					)
					.col(ColumnDef::new(MediaLastPlayed::UserId).text().not_null())
					.col(ColumnDef::new(MediaLastPlayed::MediaId).text().not_null())
					.col(
						ColumnDef::new(MediaLastPlayed::LastPlayedAt)
							.timestamp_with_time_zone()
							.not_null()
							.default(Expr::current_timestamp()),
					)
					.foreign_key(
						ForeignKey::create()
							.name("fk-media-last-played-user")
							.from(MediaLastPlayed::Table, MediaLastPlayed::UserId)
							.to(Users::Table, Users::Id)
							.on_delete(ForeignKeyAction::Cascade)
							.on_update(ForeignKeyAction::Cascade),
					)
					.foreign_key(
						ForeignKey::create()
							.name("fk-media-last-played-media")
							.from(MediaLastPlayed::Table, MediaLastPlayed::MediaId)
							.to(Media::Table, Media::Id)
							.on_delete(ForeignKeyAction::Cascade)
							.on_update(ForeignKeyAction::Cascade),
					)
					.to_owned(),
			)
			.await?;

		let db = manager.get_connection();
		db.execute(Statement::from_string(
			db.get_database_backend(),
			"CREATE UNIQUE INDEX IF NOT EXISTS media_last_played_user_media_idx ON media_last_played(user_id, media_id)".to_string(),
		))
		.await?;

		Ok(())
	}

	async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
		let db = manager.get_connection();
		db.execute(Statement::from_string(
			db.get_database_backend(),
			"DROP INDEX IF EXISTS media_last_played_user_media_idx".to_string(),
		))
		.await?;

		manager
			.drop_table(Table::drop().table(MediaLastPlayed::Table).to_owned())
			.await
	}
}

#[derive(Iden)]
enum MediaLastPlayed {
	Table,
	Id,
	UserId,
	MediaId,
	LastPlayedAt,
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
