use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
	async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
		manager
			.alter_table(
				Table::alter()
					.table(Series::Table)
					.add_column(ColumnDef::new(Series::ParentSeriesId).text().null())
					.to_owned(),
			)
			.await?;

		manager
			.create_index(
				Index::create()
					.name("idx_series_parent_series_id")
					.table(Series::Table)
					.col(Series::ParentSeriesId)
					.if_not_exists()
					.to_owned(),
			)
			.await?;

		manager
			.create_index(
				Index::create()
					.name("idx_series_library_parent")
					.table(Series::Table)
					.col(Series::LibraryId)
					.col(Series::ParentSeriesId)
					.if_not_exists()
					.to_owned(),
			)
			.await
	}

	async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
		manager
			.drop_index(
				Index::drop()
					.name("idx_series_library_parent")
					.table(Series::Table)
					.to_owned(),
			)
			.await?;

		manager
			.drop_index(
				Index::drop()
					.name("idx_series_parent_series_id")
					.table(Series::Table)
					.to_owned(),
			)
			.await?;

		manager
			.alter_table(
				Table::alter()
					.table(Series::Table)
					.drop_column(Series::ParentSeriesId)
					.to_owned(),
			)
			.await
	}
}

#[derive(Iden)]
enum Series {
	Table,
	ParentSeriesId,
	LibraryId,
}
