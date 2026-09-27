use sea_orm::prelude::{DateTimeUtc, DateTimeWithTimeZone};
use sea_orm_migration::prelude::*;

/// Game details from Wikipedia: two columns the book-shaped metadata has no home for, and
/// the Wikipedia provider switched on so a retro library gets them without any setup.
#[derive(DeriveMigrationName)]
pub struct Migration;

/// Fill empty fields from a confident article match without asking. The threshold sits at
/// the provider's weaker (dropped-prefix, platform-confirmed) match, so both kinds apply.
const WIKIPEDIA_AUTO_APPLY: &str =
	r#"{"enabled":true,"threshold":0.8,"strategy":"FILL_GAPS","exclude_fields":[]}"#;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
	async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
		// SQLite takes one column per ALTER TABLE
		for column in [MediaMetadata::Developers, MediaMetadata::Platforms] {
			manager
				.alter_table(
					Table::alter()
						.table(MediaMetadata::Table)
						.add_column(ColumnDef::new(column).text().null())
						.to_owned(),
				)
				.await?;
		}

		// A server that already configured Wikipedia keeps its own settings, even disabled
		let seed = Query::insert()
			.into_table(MetadataProviderConfigs::Table)
			.columns([
				MetadataProviderConfigs::ProviderType,
				MetadataProviderConfigs::Enabled,
				MetadataProviderConfigs::AutoApplyConfig,
				MetadataProviderConfigs::CreatedAt,
			])
			.values_panic([
				"WIKIPEDIA".into(),
				true.into(),
				WIKIPEDIA_AUTO_APPLY.into(),
				DateTimeWithTimeZone::from(DateTimeUtc::from(
					std::time::SystemTime::now(),
				))
				.into(),
			])
			.on_conflict(
				OnConflict::column(MetadataProviderConfigs::ProviderType)
					.do_nothing()
					.to_owned(),
			)
			.to_owned();
		manager.exec_stmt(seed).await
	}

	async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
		for column in [MediaMetadata::Developers, MediaMetadata::Platforms] {
			manager
				.alter_table(
					Table::alter()
						.table(MediaMetadata::Table)
						.drop_column(column)
						.to_owned(),
				)
				.await?;
		}
		Ok(())
	}
}

#[derive(DeriveIden)]
enum MediaMetadata {
	Table,
	Developers,
	Platforms,
}

#[derive(DeriveIden)]
enum MetadataProviderConfigs {
	Table,
	ProviderType,
	Enabled,
	AutoApplyConfig,
	CreatedAt,
}
