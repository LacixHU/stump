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
					.add_column(
						ColumnDef::new(Series::UseSingleThumbnail)
							.boolean()
							.not_null()
							.default(false),
					)
					.to_owned(),
			)
			.await
	}

	async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
		manager
			.alter_table(
				Table::alter()
					.table(Series::Table)
					.drop_column(Series::UseSingleThumbnail)
					.to_owned(),
			)
			.await
	}
}

#[derive(DeriveIden)]
enum Series {
	Table,
	UseSingleThumbnail,
}
