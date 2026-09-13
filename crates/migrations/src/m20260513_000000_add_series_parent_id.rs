use sea_orm_migration::prelude::*;

/// Placeholder for a migration that was applied locally then renamed to
/// `m20260809_000000_nested_series`. SeaORM requires the original version file
/// to remain in the migrator list.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
	async fn up(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
		Ok(())
	}

	async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
		Ok(())
	}
}
