use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
	async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
		manager
			.create_table(
				Table::create()
					.table(LibraryInclusions::Table)
					.if_not_exists()
					.col(
						ColumnDef::new(LibraryInclusions::Id)
							.integer()
							.not_null()
							.auto_increment()
							.primary_key(),
					)
					.col(ColumnDef::new(LibraryInclusions::UserId).text().not_null())
					.col(
						ColumnDef::new(LibraryInclusions::LibraryId)
							.text()
							.not_null(),
					)
					.foreign_key(
						ForeignKey::create()
							.name("fk-library_inclusions-library")
							.from(LibraryInclusions::Table, LibraryInclusions::LibraryId)
							.to(Libraries::Table, Libraries::Id)
							.on_delete(ForeignKeyAction::Cascade)
							.on_update(ForeignKeyAction::Cascade),
					)
					.foreign_key(
						ForeignKey::create()
							.name("fk-library_inclusions-user")
							.from(LibraryInclusions::Table, LibraryInclusions::UserId)
							.to(Users::Table, Users::Id)
							.on_delete(ForeignKeyAction::Cascade)
							.on_update(ForeignKeyAction::Cascade),
					)
					.to_owned(),
			)
			.await?;

		// Invert prior exclusions into inclusions: every non-owner user who was not
		// excluded from a library is granted access. Server owners always have access
		// and do not need inclusion rows.
		let db = manager.get_connection();
		db.execute_unprepared(
			r#"
			INSERT INTO library_inclusions (user_id, library_id)
			SELECT u.id, l.id
			FROM users u
			CROSS JOIN libraries l
			WHERE u.is_server_owner = 0
			AND NOT EXISTS (
				SELECT 1 FROM library_exclusions e
				WHERE e.user_id = u.id AND e.library_id = l.id
			)
			"#,
		)
		.await?;

		manager
			.drop_table(Table::drop().table(LibraryExclusions::Table).to_owned())
			.await
	}

	async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
		manager
			.create_table(
				Table::create()
					.table(LibraryExclusions::Table)
					.if_not_exists()
					.col(
						ColumnDef::new(LibraryExclusions::Id)
							.integer()
							.not_null()
							.auto_increment()
							.primary_key(),
					)
					.col(ColumnDef::new(LibraryExclusions::UserId).text().not_null())
					.col(
						ColumnDef::new(LibraryExclusions::LibraryId)
							.text()
							.not_null(),
					)
					.foreign_key(
						ForeignKey::create()
							.name("fk-library_exclusions-library")
							.from(LibraryExclusions::Table, LibraryExclusions::LibraryId)
							.to(Libraries::Table, Libraries::Id)
							.on_delete(ForeignKeyAction::Cascade)
							.on_update(ForeignKeyAction::Cascade),
					)
					.foreign_key(
						ForeignKey::create()
							.name("fk-library_exclusions-user")
							.from(LibraryExclusions::Table, LibraryExclusions::UserId)
							.to(Users::Table, Users::Id)
							.on_delete(ForeignKeyAction::Cascade)
							.on_update(ForeignKeyAction::Cascade),
					)
					.to_owned(),
			)
			.await?;

		// Best-effort reverse: users without an inclusion (and not owners) become excluded.
		let db = manager.get_connection();
		db.execute_unprepared(
			r#"
			INSERT INTO library_exclusions (user_id, library_id)
			SELECT u.id, l.id
			FROM users u
			CROSS JOIN libraries l
			WHERE u.is_server_owner = 0
			AND NOT EXISTS (
				SELECT 1 FROM library_inclusions i
				WHERE i.user_id = u.id AND i.library_id = l.id
			)
			"#,
		)
		.await?;

		manager
			.drop_table(Table::drop().table(LibraryInclusions::Table).to_owned())
			.await
	}
}

#[derive(Iden)]
enum LibraryInclusions {
	Table,
	Id,
	UserId,
	LibraryId,
}

#[derive(Iden)]
enum LibraryExclusions {
	Table,
	Id,
	UserId,
	LibraryId,
}

#[derive(Iden)]
enum Libraries {
	Table,
	Id,
}

#[derive(Iden)]
enum Users {
	Table,
	Id,
}
