use async_graphql::{Enum, SimpleObject};
use sea_orm::FromJsonQueryResult;
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::HashSet;

fn default_true() -> bool {
	true
}

#[derive(Eq, Copy, Hash, Debug, Clone, PartialEq, Enum, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum HomeSectionKind {
	InProgressBooks,
	LastPlayedGames,
	OnDeck,
	RecentlyAddedBooks,
	RecentlyAddedSeries,
}

impl HomeSectionKind {
	pub const ALL: [Self; 5] = [
		Self::InProgressBooks,
		Self::LastPlayedGames,
		Self::OnDeck,
		Self::RecentlyAddedBooks,
		Self::RecentlyAddedSeries,
	];

	pub fn parse(value: &str) -> Option<Self> {
		match value {
			"IN_PROGRESS_BOOKS" => Some(Self::InProgressBooks),
			"LAST_PLAYED_GAMES" => Some(Self::LastPlayedGames),
			"ON_DECK" => Some(Self::OnDeck),
			"RECENTLY_ADDED_BOOKS" => Some(Self::RecentlyAddedBooks),
			"RECENTLY_ADDED_SERIES" => Some(Self::RecentlyAddedSeries),
			_ => None,
		}
	}

	pub fn default_index(self) -> usize {
		Self::ALL.iter().position(|kind| *kind == self).unwrap_or(0)
	}
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, SimpleObject)]
pub struct HomeSection {
	pub kind: HomeSectionKind,
	#[serde(default = "default_true")]
	pub visible: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, SimpleObject, FromJsonQueryResult)]
pub struct HomeArrangement {
	pub locked: bool,
	pub sections: Vec<HomeSection>,
}

impl Default for HomeArrangement {
	fn default() -> Self {
		Self {
			locked: true,
			sections: HomeSectionKind::ALL
				.iter()
				.copied()
				.map(|kind| HomeSection {
					kind,
					visible: true,
				})
				.collect(),
		}
	}
}

impl<'de> Deserialize<'de> for HomeArrangement {
	fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
	where
		D: Deserializer<'de>,
	{
		let value = serde_json::Value::deserialize(deserializer)?;
		Ok(Self::normalize(&value))
	}
}

impl HomeArrangement {
	pub fn normalize(value: &serde_json::Value) -> Self {
		let Some(object) = value.as_object() else {
			return Self::default();
		};

		let locked = object
			.get("locked")
			.and_then(|locked| locked.as_bool())
			.unwrap_or(true);
		let raw_sections = object
			.get("sections")
			.and_then(|sections| sections.as_array())
			.map(|sections| sections.as_slice())
			.unwrap_or(&[]);

		let mut sections = Vec::new();
		let mut seen = HashSet::new();
		for section in raw_sections {
			let Some((kind, visible)) = classify_section(section) else {
				continue;
			};
			if !seen.insert(kind) {
				continue;
			}
			sections.push(HomeSection { kind, visible });
		}

		for kind in HomeSectionKind::ALL {
			if seen.contains(&kind) {
				continue;
			}
			let index = kind.default_index().min(sections.len());
			sections.insert(
				index,
				HomeSection {
					kind,
					visible: true,
				},
			);
			seen.insert(kind);
		}

		Self { locked, sections }
	}

	pub fn try_replace_sections(
		self,
		sections: Vec<HomeSection>,
	) -> Result<Self, &'static str> {
		if self.locked {
			return Err("Home arrangement is locked");
		}
		validate_sections(&sections)?;
		Ok(Self {
			locked: self.locked,
			sections,
		})
	}
}

fn validate_sections(sections: &[HomeSection]) -> Result<(), &'static str> {
	if sections.len() != HomeSectionKind::ALL.len() {
		return Err("Home arrangement must include each section exactly once");
	}

	let mut seen = HashSet::new();
	for section in sections {
		if !seen.insert(section.kind) {
			return Err("Home arrangement must include each section exactly once");
		}
	}

	if seen.len() != HomeSectionKind::ALL.len() {
		return Err("Home arrangement must include each section exactly once");
	}

	Ok(())
}

fn classify_section(section: &serde_json::Value) -> Option<(HomeSectionKind, bool)> {
	let visible = section
		.get("visible")
		.and_then(|visible| visible.as_bool())
		.unwrap_or(true);

	if section.get("kind").is_some() {
		let kind = section
			.get("kind")
			.and_then(|kind| kind.as_str())
			.and_then(HomeSectionKind::parse)?;
		return Some((kind, visible));
	}

	let config = section.get("config")?;
	classify_legacy_config(config).map(|kind| (kind, visible))
}

fn classify_legacy_config(config: &serde_json::Value) -> Option<HomeSectionKind> {
	let object = config.as_object()?;
	if object.contains_key("variant") {
		return None;
	}

	if let Some(entity) = object.get("entity").and_then(|entity| entity.as_str()) {
		return match entity {
			"BOOKS" => Some(HomeSectionKind::RecentlyAddedBooks),
			"SERIES" => Some(HomeSectionKind::RecentlyAddedSeries),
			_ => None,
		};
	}

	if object.keys().all(|key| key == "name" || key == "links") {
		return Some(HomeSectionKind::InProgressBooks);
	}

	None
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::shared::arrangement::Arrangement;

	#[test]
	fn old_default_json_becomes_five_kind_default() {
		let old = serde_json::to_value(Arrangement::default_home()).unwrap();
		let normalized = HomeArrangement::normalize(&old);
		assert_eq!(normalized, HomeArrangement::default());

		let parsed: HomeArrangement = serde_json::from_value(old).unwrap();
		assert_eq!(parsed, HomeArrangement::default());
	}

	#[test]
	fn tagged_shape_keeps_hidden_sections_and_relative_order() {
		let json = serde_json::json!({
			"locked": false,
			"sections": [
				{ "kind": "RECENTLY_ADDED_SERIES", "visible": true },
				{ "kind": "ON_DECK", "visible": false },
				{ "kind": "IN_PROGRESS_BOOKS", "visible": true }
			]
		});

		let normalized = HomeArrangement::normalize(&json);
		assert!(!normalized.locked);
		assert_eq!(
			normalized
				.sections
				.iter()
				.map(|section| (section.kind, section.visible))
				.collect::<Vec<_>>(),
			vec![
				(HomeSectionKind::RecentlyAddedSeries, true),
				(HomeSectionKind::LastPlayedGames, true),
				(HomeSectionKind::OnDeck, false),
				(HomeSectionKind::RecentlyAddedBooks, true),
				(HomeSectionKind::InProgressBooks, true),
			]
		);
	}

	#[test]
	fn duplicate_and_unknown_kinds_do_not_resurrect_or_duplicate() {
		let json = serde_json::json!({
			"locked": true,
			"sections": [
				{ "kind": "ON_DECK", "visible": false },
				{ "kind": "ON_DECK", "visible": true },
				{ "kind": "NOT_A_KIND", "visible": true },
				{ "config": { "variant": "HOME", "links": [] }, "visible": false }
			]
		});

		let normalized = HomeArrangement::normalize(&json);
		let on_deck: Vec<_> = normalized
			.sections
			.iter()
			.filter(|section| section.kind == HomeSectionKind::OnDeck)
			.collect();
		assert_eq!(on_deck.len(), 1);
		assert!(!on_deck[0].visible);
		assert_eq!(normalized.sections.len(), HomeSectionKind::ALL.len());
	}

	#[test]
	fn non_object_and_serialize_round_trip() {
		assert_eq!(
			HomeArrangement::normalize(&serde_json::json!([])),
			HomeArrangement::default()
		);

		let value = serde_json::to_value(HomeArrangement::default()).unwrap();
		assert!(value["sections"][0]["kind"].is_string());
		assert!(value["sections"][0].get("config").is_none());
	}

	#[test]
	fn replace_sections_rejects_locked_and_incomplete_input() {
		let arrangement = HomeArrangement::default();
		assert!(arrangement
			.clone()
			.try_replace_sections(arrangement.sections.clone())
			.is_err());

		let unlocked = HomeArrangement {
			locked: false,
			..HomeArrangement::default()
		};
		assert!(unlocked
			.clone()
			.try_replace_sections(vec![unlocked.sections[0].clone()])
			.is_err());

		let mut reordered = unlocked.sections.clone();
		reordered.swap(0, 1);
		let replaced = unlocked.try_replace_sections(reordered.clone()).unwrap();
		assert_eq!(replaced.sections, reordered);
	}
}
