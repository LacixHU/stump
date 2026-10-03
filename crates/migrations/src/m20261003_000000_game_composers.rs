use sea_orm_migration::prelude::*;

/// Who wrote a game's music, from Wikidata or the game's Wikipedia infobox.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
	async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
		manager
			.alter_table(
				Table::alter()
					.table(MediaMetadata::Table)
					.add_column(ColumnDef::new(MediaMetadata::Composers).text().null())
					.to_owned(),
			)
			.await
	}

	async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
		manager
			.alter_table(
				Table::alter()
					.table(MediaMetadata::Table)
					.drop_column(MediaMetadata::Composers)
					.to_owned(),
			)
			.await
	}
}

#[derive(DeriveIden)]
enum MediaMetadata {
	Table,
	Composers,
}
