//! Structured facts about a video game from its Wikidata item.
//!
//! A Wikipedia article summary names the Wikidata item it describes (`wikibase_item`), and
//! that item carries what the article prose only mentions in passing: who developed and
//! published the game, the machines it came out on, when, and in which genre. The claims
//! point at other items by id, so a second request turns those ids into names.

use std::collections::HashMap;

use serde_json::Value;

use super::wikimedia;
use crate::error::{MetadataProviderError, MetadataResult};

const API_URL: &str = "https://www.wikidata.org/w/api.php";

const DEVELOPER: &str = "P178";
const PUBLISHER: &str = "P123";
const PLATFORM: &str = "P400";
const PUBLICATION_DATE: &str = "P577";
const GENRE: &str = "P136";
const COMPOSER: &str = "P86";

/// `wbgetentities` accepts at most this many ids per request.
const MAX_IDS_PER_REQUEST: usize = 50;

/// When a game first came out, to whatever precision Wikidata knows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReleaseDate {
	pub year: i32,
	pub month: Option<i32>,
	pub day: Option<i32>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GameFacts {
	pub developers: Vec<String>,
	pub publishers: Vec<String>,
	pub platforms: Vec<String>,
	pub genres: Vec<String>,
	pub composers: Vec<String>,
	pub released: Option<ReleaseDate>,
	/// Whether the item lists the machine the game file is for among its platforms
	pub on_platform: bool,
}

/// The item ids each claim points at, before they are given names.
#[derive(Debug, Default, PartialEq, Eq)]
struct GameClaims {
	developers: Vec<String>,
	publishers: Vec<String>,
	platforms: Vec<String>,
	genres: Vec<String>,
	composers: Vec<String>,
	released: Option<ReleaseDate>,
	on_platform: bool,
}

impl GameClaims {
	fn item_ids(&self) -> Vec<String> {
		let mut ids = Vec::new();
		for id in self
			.developers
			.iter()
			.chain(&self.publishers)
			.chain(&self.platforms)
			.chain(&self.genres)
			.chain(&self.composers)
		{
			if !ids.contains(id) {
				ids.push(id.clone());
			}
		}
		ids
	}

	/// Swap each id for its name. An id with no English label is dropped rather than shown
	/// as a bare `Q12345`.
	fn resolve(self, labels: &HashMap<String, String>) -> GameFacts {
		let named = |ids: Vec<String>| -> Vec<String> {
			ids.into_iter()
				.filter_map(|id| labels.get(&id).cloned())
				.collect()
		};
		GameFacts {
			developers: named(self.developers),
			publishers: named(self.publishers),
			platforms: named(self.platforms),
			genres: named(self.genres),
			composers: named(self.composers),
			released: self.released,
			on_platform: self.on_platform,
		}
	}
}

/// `platform_items` are the Wikidata items for the machine the game file runs on (see
/// [`parse_claims`]); empty when it is not known.
pub async fn fetch_game_facts(
	item_id: &str,
	platform_items: &[&str],
) -> MetadataResult<GameFacts> {
	let entities = get_entities(&[item_id.to_string()], "claims").await?;
	let claims = entities
		.get("entities")
		.and_then(|e| e.get(item_id))
		.and_then(|e| e.get("claims"))
		.map(|c| parse_claims(c, platform_items))
		.unwrap_or_default();

	let mut labels = HashMap::new();
	for chunk in claims.item_ids().chunks(MAX_IDS_PER_REQUEST) {
		let body = get_entities(chunk, "labels").await?;
		labels.extend(parse_labels(&body));
	}

	Ok(claims.resolve(&labels))
}

async fn get_entities(ids: &[String], props: &str) -> MetadataResult<Value> {
	let ids = ids.join("|");
	let url = reqwest::Url::parse_with_params(
		API_URL,
		&[
			("action", "wbgetentities"),
			("ids", ids.as_str()),
			("props", props),
			// Names that read the same in every language (most companies, id Software
			// among them) carry only a language-neutral `mul` label and no `en` one
			("languages", "en|mul"),
			("format", "json"),
		],
	)
	.map_err(|e| MetadataProviderError::Other(e.to_string()))?;

	let response = wikimedia::get(url).await?;
	let status = response.status();
	if !status.is_success() {
		return Err(MetadataProviderError::Other(format!(
			"Wikidata HTTP {status}"
		)));
	}
	Ok(response.json().await?)
}

/// Read the claims, keeping to the release on `platform_items` (the Wikidata items for
/// the machine the game file runs on; empty when unknown).
///
/// A game ported to a dozen machines lists every port's developer and publisher, each
/// qualified with the machine it was for -- Doom's publishers are Atari for the Jaguar,
/// Ocean for the SNES and so on, and none of them for DOS. Only statements for the whole
/// game (no platform qualifier) or for this machine are kept, because a port's publisher
/// shown as the game's publisher is simply wrong. The platform list itself is not
/// filtered: it is meant to name every machine.
fn parse_claims(claims: &Value, platform_items: &[&str]) -> GameClaims {
	let for_platform =
		|s: &&Value| platform_items.is_empty() || applies_to_platform(s, platform_items);
	let earliest = |dates: Vec<ReleaseDate>| {
		dates
			.into_iter()
			.min_by_key(|d| (d.year, d.month.unwrap_or(0), d.day.unwrap_or(0)))
	};
	let dates = |keep: &dyn Fn(&&Value) -> bool| -> Vec<ReleaseDate> {
		statements(claims, PUBLICATION_DATE)
			.filter(|s| keep(s))
			.filter_map(statement_value)
			.filter_map(parse_time)
			.collect()
	};

	let platforms = item_ids(statements(claims, PLATFORM));
	GameClaims {
		developers: item_ids(statements(claims, DEVELOPER).filter(for_platform)),
		publishers: item_ids(statements(claims, PUBLISHER).filter(for_platform)),
		on_platform: platforms
			.iter()
			.any(|id| platform_items.contains(&id.as_str())),
		platforms,
		genres: item_ids(statements(claims, GENRE)),
		// Like a port's developer, a port's composer did not write this version's music
		composers: item_ids(statements(claims, COMPOSER).filter(for_platform)),
		// The date of this machine's own release when one is recorded, otherwise the
		// earliest of any. Unqualified dates are no better than that: Bomb Jack's is a
		// 2015 re-release, and the 1984 original is only there qualified as arcade
		released: earliest(dates(&|s| {
			!platform_items.is_empty() && is_qualified_for(s, platform_items)
		}))
		.or_else(|| earliest(dates(&|_| true))),
	}
}

/// Every statement for a property that has not been marked wrong.
fn statements<'a>(claims: &'a Value, property: &str) -> impl Iterator<Item = &'a Value> {
	claims
		.get(property)
		.and_then(Value::as_array)
		.into_iter()
		.flatten()
		.filter(|s| s.get("rank").and_then(Value::as_str) != Some("deprecated"))
}

fn statement_value(statement: &Value) -> Option<&Value> {
	statement.pointer("/mainsnak/datavalue/value")
}

/// Whether a statement is about the release on one of `platform_items`. A statement with
/// no platform qualifier is about the game as a whole, so it applies everywhere.
fn applies_to_platform(statement: &Value, platform_items: &[&str]) -> bool {
	let qualified = platform_qualifiers(statement);
	qualified.is_empty() || qualified.iter().any(|id| platform_items.contains(id))
}

/// Whether a statement is qualified as being about one of `platform_items` in particular.
fn is_qualified_for(statement: &Value, platform_items: &[&str]) -> bool {
	platform_qualifiers(statement)
		.iter()
		.any(|id| platform_items.contains(id))
}

fn platform_qualifiers(statement: &Value) -> Vec<&str> {
	statement
		.pointer(&format!("/qualifiers/{PLATFORM}"))
		.and_then(Value::as_array)
		.into_iter()
		.flatten()
		.filter_map(|q| q.pointer("/datavalue/value/id").and_then(Value::as_str))
		.collect()
}

fn item_ids<'a>(statements: impl Iterator<Item = &'a Value>) -> Vec<String> {
	let mut ids: Vec<String> = Vec::new();
	for id in statements
		.filter_map(statement_value)
		.filter_map(|v| v.get("id").and_then(Value::as_str))
	{
		if !ids.iter().any(|existing| existing == id) {
			ids.push(id.to_string());
		}
	}
	ids
}

/// Read a Wikidata time value such as `+1986-01-01T00:00:00Z`. Its `precision` says how
/// much of that to believe: 9 is a year, 10 a month, 11 a day. A year-only date is stored
/// as January 1st, so without the precision every game would appear to come out on New
/// Year's Day.
fn parse_time(value: &Value) -> Option<ReleaseDate> {
	let time = value.get("time")?.as_str()?;
	let precision = value.get("precision")?.as_i64()?;
	if precision < 9 {
		return None;
	}

	let unsigned = time.strip_prefix('+')?;
	let mut parts = unsigned.split(['-', 'T']);
	let year = parts.next()?.parse::<i32>().ok()?;
	let month = parts.next()?.parse::<i32>().ok()?;
	let day = parts.next()?.parse::<i32>().ok()?;

	Some(ReleaseDate {
		year,
		month: (precision >= 10 && month > 0).then_some(month),
		day: (precision >= 11 && day > 0).then_some(day),
	})
}

fn parse_labels(body: &Value) -> HashMap<String, String> {
	body.get("entities")
		.and_then(Value::as_object)
		.into_iter()
		.flatten()
		.filter_map(|(id, entity)| {
			entity
				.pointer("/labels/en/value")
				.or_else(|| entity.pointer("/labels/mul/value"))
				.and_then(Value::as_str)
				.map(|label| (id.clone(), label.to_string()))
		})
		.collect()
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::*;

	fn item(id: &str) -> Value {
		json!({
			"mainsnak": { "datavalue": { "value": { "id": id } } },
			"rank": "normal"
		})
	}

	fn time(time: &str, precision: i64) -> Value {
		json!({
			"mainsnak": { "datavalue": { "value": { "time": time, "precision": precision } } },
			"rank": "normal"
		})
	}

	#[test]
	fn claims_are_read_per_property() {
		let claims = json!({
			"P178": [item("Q321681")],
			"P123": [item("Q634677")],
			"P400": [item("Q99775"), item("Q48493"), item("Q99775")],
			"P136": [item("Q1044478")],
			"P86": [item("Q7614173")],
			"P577": [time("+1986-01-01T00:00:00Z", 9)],
		});

		let parsed = parse_claims(&claims, &[]);
		assert_eq!(parsed.developers, vec!["Q321681"]);
		assert_eq!(parsed.publishers, vec!["Q634677"]);
		// The same machine listed twice is still one platform
		assert_eq!(parsed.platforms, vec!["Q99775", "Q48493"]);
		// No machine was asked about, so none can be confirmed
		assert!(!parsed.on_platform);
		assert!(parse_claims(&claims, &["Q99775"]).on_platform);
		assert!(!parse_claims(&claims, &["Q23882"]).on_platform);
		assert_eq!(parsed.genres, vec!["Q1044478"]);
		assert_eq!(parsed.composers, vec!["Q7614173"]);
		assert_eq!(
			parsed.released,
			Some(ReleaseDate {
				year: 1986,
				month: None,
				day: None
			})
		);
	}

	#[test]
	fn a_missing_property_is_empty_not_an_error() {
		let parsed = parse_claims(&json!({}), &[]);
		assert_eq!(parsed, GameClaims::default());
	}

	#[test]
	fn deprecated_statements_are_ignored() {
		let mut wrong = item("Q1");
		wrong["rank"] = json!("deprecated");
		let parsed = parse_claims(&json!({ "P178": [wrong, item("Q2")] }), &[]);
		assert_eq!(parsed.developers, vec!["Q2"]);
	}

	#[test]
	fn date_precision_decides_how_much_of_the_date_is_kept() {
		let at =
			|t: &str, p: i64| parse_time(&time(t, p)["mainsnak"]["datavalue"]["value"]);

		assert_eq!(
			at("+1987-03-15T00:00:00Z", 11),
			Some(ReleaseDate {
				year: 1987,
				month: Some(3),
				day: Some(15)
			})
		);
		assert_eq!(
			at("+1987-03-01T00:00:00Z", 10),
			Some(ReleaseDate {
				year: 1987,
				month: Some(3),
				day: None
			})
		);
		// A decade (precision 8) is too vague to call a release year
		assert_eq!(at("+1980-01-01T00:00:00Z", 8), None);
		// Month and day of zero mean "unknown", whatever the precision claims
		assert_eq!(
			at("+1984-00-00T00:00:00Z", 11),
			Some(ReleaseDate {
				year: 1984,
				month: None,
				day: None
			})
		);
	}

	#[test]
	fn the_earliest_release_is_the_original_one() {
		// A port listed alongside the original must not replace its release date
		let claims = json!({
			"P577": [
				time("+1990-06-01T00:00:00Z", 10),
				time("+1987-01-01T00:00:00Z", 9),
			]
		});
		assert_eq!(
			parse_claims(&claims, &[]).released.map(|d| d.year),
			Some(1987)
		);
	}

	#[test]
	fn ids_without_a_label_are_dropped() {
		let claims = parse_claims(
			&json!({
				"P178": [item("Q1"), item("Q2")],
				"P400": [item("Q3")],
			}),
			&[],
		);
		assert_eq!(claims.item_ids(), vec!["Q1", "Q2", "Q3"]);

		let labels = parse_labels(&json!({
			"entities": {
				"Q1": { "labels": { "en": { "value": "Hewson Consultants" } } },
				"Q2": { "labels": {} },
				"Q3": { "labels": { "en": { "value": "Commodore 64" } } },
			}
		}));
		let facts = claims.resolve(&labels);
		assert_eq!(facts.developers, vec!["Hewson Consultants"]);
		assert_eq!(facts.platforms, vec!["Commodore 64"]);
	}

	#[test]
	fn a_language_neutral_label_names_an_item_with_no_english_one() {
		// id Software's item: it has a `mul` label and no `en` one
		let labels = parse_labels(&json!({
			"entities": {
				"Q204474": { "labels": { "mul": { "value": "id Software" } } },
				"Q1": { "labels": {
					"en": { "value": "English" },
					"mul": { "value": "Neutral" }
				} },
			}
		}));
		assert_eq!(labels["Q204474"], "id Software");
		assert_eq!(labels["Q1"], "English");
	}

	fn on_platforms(mut statement: Value, platforms: &[&str]) -> Value {
		let qualifiers: Vec<Value> = platforms
			.iter()
			.map(|id| json!({ "datavalue": { "value": { "id": id } } }))
			.collect();
		statement["qualifiers"] = json!({ "P400": qualifiers });
		statement
	}

	#[test]
	fn a_port_publisher_is_not_the_games_publisher() {
		const DOS: &str = "Q47604";
		const SNES: &str = "Q183259";
		const JAGUAR: &str = "Q650601";

		// Doom, as Wikidata has it: every publisher is some port's
		let claims = json!({
			"P178": [item("Q204474"), on_platforms(item("Q1058704"), &["Q48263"])],
			"P123": [
				on_platforms(item("Q1408498"), &[SNES]),
				on_platforms(item("Q207922"), &[JAGUAR]),
			],
			"P577": [
				on_platforms(time("+1995-01-01T00:00:00Z", 9), &[SNES]),
				time("+1993-12-10T00:00:00Z", 11),
			],
		});

		let dos = parse_claims(&claims, &[DOS]);
		// id Software made the game; Nerve Software only made the Xbox 360 port
		assert_eq!(dos.developers, vec!["Q204474"]);
		// Better no publisher than a port's
		assert!(dos.publishers.is_empty());
		assert_eq!(dos.released.map(|d| d.year), Some(1993));

		let snes = parse_claims(&claims, &[SNES]);
		assert_eq!(snes.publishers, vec!["Q1408498"]);

		// With no machine to go by, nothing is filtered
		assert_eq!(parse_claims(&claims, &[]).publishers.len(), 2);
	}

	#[test]
	fn a_re_release_is_not_the_release_date() {
		// Bomb Jack: the one unqualified date is a 2015 re-release
		let claims = json!({
			"P577": [
				time("+2015-01-01T00:00:00Z", 9),
				on_platforms(time("+1984-01-01T00:00:00Z", 9), &["Q192851"]),
			]
		});
		assert_eq!(
			parse_claims(&claims, &["Q23882"]).released.map(|d| d.year),
			Some(1984)
		);

		// This machine's own date wins over an earlier one elsewhere
		let claims = json!({
			"P577": [
				on_platforms(time("+1984-01-01T00:00:00Z", 9), &["Q192851"]),
				on_platforms(time("+1986-01-01T00:00:00Z", 9), &["Q23882"]),
			]
		});
		assert_eq!(
			parse_claims(&claims, &["Q23882"]).released.map(|d| d.year),
			Some(1986)
		);
	}

	#[test]
	fn another_machines_date_beats_no_date() {
		let claims = json!({
			"P577": [on_platforms(time("+1988-01-01T00:00:00Z", 9), &["Q23882"])],
		});
		assert_eq!(
			parse_claims(&claims, &["Q99775"]).released.map(|d| d.year),
			Some(1988)
		);
	}
}
