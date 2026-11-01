use async_graphql::{InputObject, InputType, OneofObject};
use filter_gen::IntoFilter;
use models::shared::enums::{FileStatus, LibraryType, ReadingStatus};
use sea_orm::{
	prelude::DateTimeWithTimeZone,
	sea_query::{
		ConditionExpression, Expr as QExpr, Func, IntoColumnRef, LikeExpr, SimpleExpr,
	},
	Condition, Value,
};
use serde::{Deserialize, Serialize};
use stump_core::utils::serde::COMPANY_SUFFIXES;

pub mod library;
pub mod log;
pub mod media;
pub mod media_metadata;
pub mod series;
pub mod series_metadata;

// TODO: This probably needs a rewrite to make it more compatible with async-graphql. The big issue is generics
// with input objects. Look at and yoink from seaography for how they are doing things

// Note: See https://github.com/serde-rs/json/issues/501

// NOTE: I originally went for IntoCondition, but that is a trait for sea-query and
// I wanted to avoid conflicts in the naming
pub trait IntoFilter {
	fn into_filter(self) -> sea_orm::Condition;
}

#[derive(OneofObject, Clone, Debug, Serialize, Deserialize)]
#[graphql(concrete(name = "FieldFilterString", params(String)))]
#[graphql(concrete(name = "FieldFilterFileStatus", params(FileStatus)))]
#[serde(rename_all = "camelCase")]
pub enum StringLikeFilter<T>
where
	T: InputType,
{
	Eq(T),
	Neq(T),
	AnyOf(Vec<T>),
	NoneOf(Vec<T>),
	Like(T),
	LikeAnyOf(Vec<T>),
	LikeNoneOf(Vec<T>),
	/// An entry of a comma-separated list (genres, platforms, publishers, ...) equals any of
	/// these, ignoring case. Unlike `likeAnyOf`, `Game Boy` does not match `Game Boy Color`.
	/// A company suffix stays with its name: `Atari` does not match `Atari, Inc.`
	HasAnyOf(Vec<T>),
	Contains(T),
	Excludes(T),
	StartsWith(T),
	EndsWith(T),
}

/// Lowercases `value` for use in a `LIKE` pattern against `LOWER(column)`.
///
/// SQLite's `LOWER()` and `LIKE` fold ASCII only, so `LOWER('KÖNYV')` is `kÖnyv` and a pattern
/// containing `ö` never matches it. Non-ASCII characters become `_` (any one character), which
/// matches them in either case. ASCII is lowercased as before.
fn fold_case(value: &str) -> String {
	value
		.chars()
		.flat_map(|c| c.to_lowercase())
		.map(|c| if c.is_ascii() { c } else { '_' })
		.collect()
}

/// Escapes `LIKE` wildcards so `value` only matches itself, with `\` as the escape character
fn escape_like(value: &str) -> String {
	value
		.replace('\\', "\\\\")
		.replace('%', "\\%")
		.replace('_', "\\_")
}

/// `LOWER(column)` wrapped in commas, each company suffix joined to its name (`, inc.,` to
/// ` inc.,`, as `comma_separated_list_to_vec` splits) and every remaining separator collapsed
/// to a bare comma. `Atari, Inc., Game Boy` becomes `,atari inc.,game boy,`, so an entry
/// matches `%,entry,%` exactly. [`normalize_list_entry`] does the same to the searched value.
fn comma_wrapped_list(column: impl IntoColumnRef) -> SimpleExpr {
	let joined = COMPANY_SUFFIXES
		.iter()
		.fold(String::from("',' || LOWER(?) || ','"), |sql, suffix| {
			format!("REPLACE({sql}, ', {suffix},', ' {suffix},')")
		});
	QExpr::cust_with_exprs(
		format!("REPLACE(REPLACE({joined}, ', ', ','), ' ,', ',')"),
		[QExpr::col(column).into()],
	)
}

/// `value` as [`comma_wrapped_list`] writes it inside the commas, still unescaped
fn normalize_list_entry(value: &str) -> String {
	let wrapped = format!(",{},", value.trim().to_ascii_lowercase());
	let joined = COMPANY_SUFFIXES.iter().fold(wrapped, |acc, suffix| {
		acc.replace(&format!(", {suffix},"), &format!(" {suffix},"))
	});
	let collapsed = joined.replace(", ", ",").replace(" ,", ",");
	collapsed[1..collapsed.len() - 1].to_string()
}

pub(crate) fn apply_string_filter<C, T>(
	column: C,
	filter: StringLikeFilter<T>,
) -> Condition
where
	C: sea_orm::ColumnTrait + Copy,
	T: InputType + Into<Value> + Into<String>,
{
	match filter {
		StringLikeFilter::Eq(value) => Condition::all().add(column.eq(value)),
		StringLikeFilter::Neq(value) => Condition::all().add(column.ne(value)),
		StringLikeFilter::AnyOf(values) => Condition::all().add(column.is_in(values)),
		StringLikeFilter::NoneOf(values) => {
			Condition::all().add(column.is_not_in(values))
		},
		// FIXME: a bunch of these string filters have different case sensitivity depending on sqlite vs pgsql,
		// so to align them a bit i just lowercased the column and the value for all of them. honestly
		// not ideal, i'd rather use the dedicated fns for each, but for now leaving
		// like this
		StringLikeFilter::Like(value) => {
			let v: String = value.into();
			Condition::all().add(
				QExpr::expr(Func::lower(QExpr::col(column.as_column_ref())))
					.like(format!("%{}%", fold_case(&v))),
			)
		},
		StringLikeFilter::Contains(value) => {
			let v: String = value.into();
			Condition::all().add(
				QExpr::expr(Func::lower(QExpr::col(column.as_column_ref())))
					.like(format!("%{}%", fold_case(&v))),
			)
		},
		StringLikeFilter::Excludes(value) => {
			let v: String = value.into();
			Condition::all().add(
				QExpr::expr(Func::lower(QExpr::col(column.as_column_ref())))
					.not_like(format!("%{}%", fold_case(&v))),
			)
		},
		StringLikeFilter::StartsWith(value) => {
			let v: String = value.into();
			Condition::all().add(
				QExpr::expr(Func::lower(QExpr::col(column.as_column_ref())))
					.like(format!("{}%", fold_case(&v))),
			)
		},
		StringLikeFilter::EndsWith(value) => {
			let v: String = value.into();
			Condition::all().add(
				QExpr::expr(Func::lower(QExpr::col(column.as_column_ref())))
					.like(format!("%{}", fold_case(&v))),
			)
		},
		StringLikeFilter::LikeAnyOf(values) => {
			values.into_iter().fold(Condition::any(), |acc, value| {
				let v: String = value.into();
				acc.add(
					QExpr::expr(Func::lower(QExpr::col(column.as_column_ref())))
						.like(format!("%{}%", fold_case(&v))),
				)
			})
		},
		StringLikeFilter::LikeNoneOf(values) => values
			.into_iter()
			.fold(Condition::any(), |acc, value| {
				let v: String = value.into();
				acc.add(
					QExpr::expr(Func::lower(QExpr::col(column.as_column_ref())))
						.like(format!("%{}%", fold_case(&v))),
				)
			})
			.not(),
		StringLikeFilter::HasAnyOf(values) => {
			values.into_iter().fold(Condition::any(), |acc, value| {
				let v: String = value.into();
				let entry = normalize_list_entry(&v);
				// Still holding a comma, it is several entries and can never equal one
				if entry.contains(',') {
					return acc.add(QExpr::cust("1 = 0"));
				}
				let pattern = format!("%,{},%", fold_case(&escape_like(&entry)));
				acc.add(
					QExpr::expr(comma_wrapped_list(column.as_column_ref()))
						.like(LikeExpr::new(pattern).escape('\\')),
				)
			})
		},
	}
}

#[derive(InputObject, Clone, Debug, Serialize, Deserialize)]
#[graphql(concrete(name = "NumericRangeF32", params(f32)))]
#[graphql(concrete(name = "NumericRangeI32", params(i32)))]
#[graphql(concrete(name = "NumericRangeI64", params(i64)))]
#[graphql(concrete(name = "NumericRangeU32", params(u32)))]
#[graphql(concrete(name = "NumericRangeU64", params(u64)))]
#[graphql(concrete(name = "NumericRangeDateTime", params(DateTimeWithTimeZone)))]
#[serde(rename_all = "camelCase")]
pub struct NumericRange<T>
where
	T: InputType,
{
	pub from: T,
	pub to: T,
	pub inclusive: bool,
}

#[derive(OneofObject, Clone, Debug, Serialize, Deserialize)]
#[graphql(concrete(name = "NumericFilterF32", params(f32)))]
#[graphql(concrete(name = "NumericFilterI32", params(i32)))]
#[graphql(concrete(name = "NumericFilterI64", params(i64)))]
#[graphql(concrete(name = "NumericFilterU32", params(u32)))]
#[graphql(concrete(name = "NumericFilterU64", params(u64)))]
#[graphql(concrete(name = "NumericFilterDateTime", params(DateTimeWithTimeZone)))]
#[serde(rename_all = "camelCase")]
pub enum NumericFilter<T>
where
	T: InputType,
	NumericRange<T>: InputType,
{
	Eq(T),
	Neq(T),
	AnyOf(Vec<T>),
	NoneOf(Vec<T>),
	Gt(T),
	Gte(T),
	Lt(T),
	Lte(T),
	Range(NumericRange<T>),
}

pub(crate) fn apply_numeric_filter<C, T>(
	column: C,
	filter: NumericFilter<T>,
) -> impl Into<ConditionExpression>
where
	C: sea_orm::ColumnTrait,
	T: InputType + Into<Value>,
	NumericRange<T>: InputType,
{
	match filter {
		NumericFilter::Eq(value) => column.eq(value),
		NumericFilter::Neq(value) => column.ne(value),
		NumericFilter::AnyOf(values) => column.is_in(values),
		NumericFilter::NoneOf(values) => column.is_not_in(values),
		NumericFilter::Gt(value) => column.gt(value),
		NumericFilter::Gte(value) => column.gte(value),
		NumericFilter::Lt(value) => column.lt(value),
		NumericFilter::Lte(value) => column.lte(value),
		NumericFilter::Range(range) => {
			if range.inclusive {
				column.gte(range.from).and(column.lte(range.to))
			} else {
				column.gt(range.from).and(column.lt(range.to))
			}
		},
	}
}

#[derive(OneofObject, Clone, Debug, Serialize, Deserialize)]
#[graphql(concrete(name = "ComputedFilterReadingStatus", params(ReadingStatus)))]
#[graphql(concrete(name = "ComputedFilterLibraryType", params(LibraryType)))]
#[serde(rename_all = "camelCase")]
pub enum ConceptualFilter<T>
where
	T: InputType,
{
	Is(T),
	IsNot(T),
	IsAnyOf(Vec<T>),
	IsNoneOf(Vec<T>),
}

#[cfg(test)]
mod tests {
	use super::*;
	use models::entity::media;
	use pretty_assertions::assert_eq;
	use sea_orm::{prelude::*, sea_query::SqliteQueryBuilder, QuerySelect, QueryTrait};

	#[test]
	fn test_string_like_any_of() {
		let filter =
			StringLikeFilter::LikeAnyOf(vec!["test".to_string(), "example".to_string()]);
		let condition = apply_string_filter(media::Column::Name, filter);
		let query = media::Entity::find().filter(condition);
		let sql = query
			.select_only()
			.into_query()
			.to_string(SqliteQueryBuilder);

		assert_eq!(
			sql,
			r#"SELECT  FROM "media" WHERE LOWER("media"."name") LIKE '%test%' OR LOWER("media"."name") LIKE '%example%'"#
		);
	}

	#[test]
	fn test_fold_case_matches_accented_capitals() {
		assert_eq!(fold_case("Robert Prince"), "robert prince");
		assert_eq!(fold_case("phoenix könyvkiadó"), "phoenix k_nyvkiad_");
		assert_eq!(fold_case("ÁDÁM"), "_d_m");
	}

	async fn matching_ids(conn: &DatabaseConnection, condition: Condition) -> Vec<i32> {
		use sea_orm::{
			sea_query::{Alias, Query},
			ConnectionTrait,
		};

		let query = Query::select()
			.column(Alias::new("id"))
			.from(models::entity::media_metadata::Entity)
			.cond_where(condition)
			.order_by(Alias::new("id"), sea_orm::Order::Asc)
			.to_owned();
		conn.query_all(conn.get_database_backend().build(&query))
			.await
			.unwrap()
			.iter()
			.map(|row| row.try_get::<i32>("", "id").unwrap())
			.collect()
	}

	#[tokio::test]
	async fn test_has_any_of_matches_whole_list_entries() {
		use models::entity::media_metadata::Column;
		use sea_orm::{ConnectionTrait, Database};

		let conn = Database::connect("sqlite::memory:").await.unwrap();
		conn.execute_unprepared(
			"CREATE TABLE media_metadata (id INTEGER PRIMARY KEY, platforms TEXT, publisher TEXT);
			INSERT INTO media_metadata VALUES
				(1, 'Game Boy', 'Activision'),
				(2, 'Game Boy Color, DOS', 'Activision, Electronic Arts'),
				(3, 'MS-DOS,Game Boy Advance', 'ACTIVISION'),
				(4, 'Commodore 64 ,DOS', 'Ocean_Software'),
				(5, NULL, 'Phoenix Könyvkiadó'),
				(6, 'Amiga', 'OceanXSoftware'),
				(7, NULL, 'Atari, Inc., Activision'),
				(8, NULL, 'Atari, Nintendo Co., Ltd.');",
		)
		.await
		.unwrap();

		let has = |column: Column, values: &[&str]| {
			apply_string_filter(
				column,
				StringLikeFilter::HasAnyOf(
					values.iter().map(|v| String::from(*v)).collect(),
				),
			)
		};
		let platforms = |values: &[&str]| has(Column::Platforms, values);
		let publisher = |values: &[&str]| has(Column::Publisher, values);

		assert_eq!(matching_ids(&conn, platforms(&["Game Boy"])).await, vec![1]);
		assert_eq!(matching_ids(&conn, platforms(&["dos"])).await, vec![2, 4]);
		assert_eq!(
			matching_ids(&conn, platforms(&["Game Boy Advance", "game boy color"])).await,
			vec![2, 3]
		);
		assert_eq!(
			matching_ids(&conn, platforms(&["Boy"])).await,
			Vec::<i32>::new()
		);

		assert_eq!(
			matching_ids(&conn, publisher(&["Activision"])).await,
			vec![1, 2, 3, 7]
		);
		assert_eq!(
			matching_ids(&conn, publisher(&["PHOENIX KÖNYVKIADÓ"])).await,
			vec![5]
		);
		assert_eq!(
			matching_ids(&conn, publisher(&["Ocean_Software"])).await,
			vec![4]
		);
		assert_eq!(
			matching_ids(&conn, publisher(&["atari, inc."])).await,
			vec![7]
		);
		assert_eq!(matching_ids(&conn, publisher(&["Atari"])).await, vec![8]);
		assert_eq!(
			matching_ids(&conn, publisher(&["Nintendo Co., Ltd."])).await,
			vec![8]
		);
		assert_eq!(
			matching_ids(&conn, publisher(&["Inc."])).await,
			Vec::<i32>::new()
		);
		assert_eq!(
			matching_ids(&conn, publisher(&["Activision, Electronic Arts"])).await,
			Vec::<i32>::new()
		);
		assert_eq!(
			matching_ids(&conn, publisher(&["Activision, Electronic Arts", "Atari"]))
				.await,
			vec![8]
		);
	}

	#[test]
	fn test_string_like_none_of() {
		let filter =
			StringLikeFilter::LikeNoneOf(vec!["test".to_string(), "example".to_string()]);
		let condition = apply_string_filter(media::Column::Name, filter);
		let query = media::Entity::find().filter(condition);
		let sql = query
			.select_only()
			.into_query()
			.to_string(SqliteQueryBuilder);

		assert_eq!(
			sql,
			r#"SELECT  FROM "media" WHERE NOT (LOWER("media"."name") LIKE '%test%' OR LOWER("media"."name") LIKE '%example%')"#
		);
	}
}
