use std::{collections::HashMap, path::Path};

use metadata_integrations::{MatchCandidate, SearchQuery};
use models::{
	entity::{
		library_config, media, metadata_fetch_record, metadata_provider_config, series,
		series_metadata,
	},
	shared::enums::{LibraryType, MetadataFetchStatus, MetadataProvider},
};
use sea_orm::{
	prelude::*,
	sea_query::{OnConflict, Query},
	QuerySelect, Set,
};

use super::{apply, ProviderClientCache};
use crate::{
	filesystem::{
		media::{
			platform_from_path_hints, resolve_retro_platform, retro_title_candidates,
			RetroPlatform,
		},
		ContentType,
	},
	CoreError,
};

async fn library_type_for_series(
	conn: &DatabaseConnection,
	series_id: &str,
) -> Result<LibraryType, CoreError> {
	let library_id = series::Entity::find_by_id(series_id)
		.select_only()
		.column(series::Column::LibraryId)
		.into_tuple::<String>()
		.one(conn)
		.await?
		.ok_or_else(|| CoreError::NotFound(format!("Series {series_id}")))?;

	let config = library_config::Entity::find()
		.filter(library_config::Column::LibraryId.eq(library_id))
		.one(conn)
		.await
		.map_err(|e| CoreError::InternalError(e.to_string()))?
		.ok_or_else(|| CoreError::NotFound("Library missing config!".into()))?;

	Ok(config.library_type)
}

// TODO: This is terrible, I should just bite the bullet and put a direct fk on media
async fn library_type_for_media(
	conn: &DatabaseConnection,
	media_id: &str,
) -> Result<LibraryType, CoreError> {
	let tuple = media::Entity::find()
		.filter(media::Column::Id.eq(media_id))
		.find_also_related(series::Entity)
		.one(conn)
		.await?
		.ok_or_else(|| CoreError::NotFound(format!("Media {media_id}")))?;

	let (_, Some(series)) = tuple else {
		return Err(CoreError::NotFound(format!("Series for media {media_id}")));
	};

	library_type_for_series(conn, &series.id).await
}

/// The retro system a media item runs on, or `None` when it is not a disk/tape image.
///
/// The platform is not stored on the row, so it is resolved from the path the same way the
/// thumbnail job resolves it. The extension is checked first because
/// [`resolve_retro_platform`] falls back to C64 for anything it does not recognise, which
/// would otherwise label every comic and EPUB a Commodore 64 game.
async fn retro_platform_for_media(
	conn: &DatabaseConnection,
	media_id: &str,
) -> Option<RetroPlatform> {
	let (path, extension) = media::Entity::find_by_id(media_id)
		.select_only()
		.column(media::Column::Path)
		.column(media::Column::Extension)
		.into_tuple::<(String, String)>()
		.one(conn)
		.await
		.ok()
		.flatten()?;

	ContentType::is_retro_extension(&extension)
		.then(|| resolve_retro_platform(&path, &extension))
}

/// The retro system a series holds, inferred from its path (e.g. `.../Retro/C64/...`).
///
/// A series has no extension to go on, so an unhinted path yields `None` and the search is
/// left unfiltered rather than guessed at.
async fn retro_platform_for_series(
	conn: &DatabaseConnection,
	series_id: &str,
) -> Option<RetroPlatform> {
	let path = series::Entity::find_by_id(series_id)
		.select_only()
		.column(series::Column::Path)
		.into_tuple::<String>()
		.one(conn)
		.await
		.ok()
		.flatten()?;

	platform_from_path_hints(&path)
}

/// What the entity being looked up is, as far as the retro providers are concerned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum RetroTarget {
	/// A game for this machine
	Game(RetroPlatform),
	/// A media item that is not a disk/tape image, e.g. a book in a Mixed library
	NotAGame,
	/// A series whose path does not say what it holds
	Unknown,
}

impl RetroTarget {
	/// A media item is a game exactly when it has a retro extension.
	pub(super) async fn for_media(conn: &DatabaseConnection, media_id: &str) -> Self {
		retro_platform_for_media(conn, media_id)
			.await
			.map_or(Self::NotAGame, Self::Game)
	}

	pub(super) fn platform(self) -> Option<RetroPlatform> {
		match self {
			Self::Game(platform) => Some(platform),
			_ => None,
		}
	}
}

/// One candidate per article, best first. Searching a game by its folder's name and by its
/// file's often turns up the same article twice; the more confident of the two is kept.
/// The sort is stable, so equally good candidates keep the order the providers gave.
pub(super) fn merge_candidates(candidates: Vec<MatchCandidate>) -> Vec<MatchCandidate> {
	let mut merged: Vec<MatchCandidate> = Vec::new();
	for candidate in candidates {
		match merged.iter_mut().find(|m| {
			m.provider == candidate.provider && m.external_id == candidate.external_id
		}) {
			Some(existing) if candidate.confidence > existing.confidence => {
				*existing = candidate
			},
			Some(_) => {},
			None => merged.push(candidate),
		}
	}
	merged.sort_by(|a, b| b.confidence.total_cmp(&a.confidence));
	merged
}

/// The titles to search for a media item by, best first; a search stops at the first one
/// that matches.
///
/// Anything but a game is searched by `title` alone. A game is also searched by its
/// folder's name, the way the thumbnail job looks up its cover, because the disk is often
/// named `ZAK-1` or `bar2` while the folder says what the game is. `title` goes first only
/// when it is more than the file name the candidates already cover, e.g. a title the user
/// typed or one an earlier match filled in.
pub(super) async fn search_titles(
	conn: &DatabaseConnection,
	media_id: &str,
	target: RetroTarget,
	title: &str,
) -> Vec<String> {
	let path = match target {
		RetroTarget::Game(_) => media::Entity::find_by_id(media_id)
			.select_only()
			.column(media::Column::Path)
			.into_tuple::<String>()
			.one(conn)
			.await
			.ok()
			.flatten(),
		_ => None,
	};
	let Some(path) = path else {
		return vec![title.to_string()];
	};

	let path = Path::new(&path);
	let is_file_name = path
		.file_stem()
		.and_then(|s| s.to_str())
		.is_some_and(|stem| stem.eq_ignore_ascii_case(title));

	let mut titles = Vec::new();
	if !is_file_name && !title.trim().is_empty() {
		titles.push(title.to_string());
	}
	for candidate in retro_title_candidates(path) {
		if !titles.iter().any(|t| t.eq_ignore_ascii_case(&candidate)) {
			titles.push(candidate);
		}
	}
	if titles.is_empty() {
		titles.push(title.to_string());
	}
	titles
}

/// Filters provider configs down to those that support the given library type, and,
/// if `provider_filter` is given, further down to just that one provider. When the entity
/// is a retro game, providers that do not cover its system are dropped as well -- a C64
/// title has no business being looked up in the Spectrum or Amiga databases. When it is
/// not a game, the game providers are dropped: a Mixed library overlaps every provider,
/// and a book has no Wikipedia video game article to find.
pub(super) fn filter_providers(
	provider_configs: Vec<metadata_provider_config::Model>,
	library_type: &LibraryType,
	provider_filter: Option<MetadataProvider>,
	target: RetroTarget,
) -> Vec<metadata_provider_config::Model> {
	provider_configs
		.into_iter()
		.filter(|c| library_type.has_provider_overlap(&c.provider_type))
		.filter(|c| match target {
			RetroTarget::Game(platform) => platform.is_covered_by(c.provider_type),
			RetroTarget::NotAGame => !c
				.provider_type
				.supported_library_types()
				.contains(&LibraryType::Retro),
			RetroTarget::Unknown => true,
		})
		.filter(|c| match provider_filter {
			Some(provider) => c.provider_type == provider,
			None => true,
		})
		.collect()
}

/// The error to return when [filter_providers] leaves nothing to search, worded
/// according to whether a specific provider was requested or not.
fn no_provider_configs_error(
	library_type: &LibraryType,
	provider_filter: Option<MetadataProvider>,
) -> CoreError {
	match provider_filter {
		Some(provider) => {
			tracing::warn!(
				?library_type,
				?provider,
				"No enabled metadata providers match the requested provider filter"
			);
			CoreError::InternalError(
				"No enabled metadata providers for configured filters".to_string(),
			)
		},
		None => {
			tracing::warn!(
				?library_type,
				"No enabled metadata providers configured for this library type"
			);
			CoreError::InternalError(
				"No enabled metadata providers configured for this library type"
					.to_string(),
			)
		},
	}
}

/// Fetch metadata candidates for a series from all enabled providers
pub async fn fetch_series_metadata(
	conn: &DatabaseConnection,
	models: series::ModelWithMetadata,
	provider_cache: &ProviderClientCache,
) -> Result<Vec<MatchCandidate>, CoreError> {
	let library_type = library_type_for_series(conn, &models.series.id).await?;

	let search_name = models
		.metadata
		.as_ref()
		.and_then(|m| m.title.clone())
		.unwrap_or_else(|| models.series.name.clone());

	let comicid = models.metadata.as_ref().and_then(|m| m.comicid);
	let retro_platform = retro_platform_for_series(conn, &models.series.id).await;

	let provider_configs = metadata_provider_config::Entity::find()
		.filter(metadata_provider_config::Column::Enabled.eq(true))
		.all(conn)
		.await?;

	let target = retro_platform.map_or(RetroTarget::Unknown, RetroTarget::Game);
	let provider_configs =
		filter_providers(provider_configs, &library_type, None, target);

	if provider_configs.is_empty() {
		return Err(no_provider_configs_error(&library_type, None));
	}

	let mut all_candidates: Vec<MatchCandidate> = Vec::new();
	let mut was_rate_limited = false;
	let mut raw_hits: i32 = 0;

	for config in &provider_configs {
		match provider_cache.get_or_create(config).await {
			Ok(provider) => {
				let mut provider_hints = HashMap::new();
				if let Some(id) = comicid {
					provider_hints
						.insert("comic_vine_volume_id".to_string(), id.to_string());
				}
				if let Some(platform) = retro_platform {
					provider_hints
						.insert("platform".to_string(), platform.as_str().to_string());
				}
				let query = SearchQuery {
					title: search_name.to_string(),
					limit: Some(10),
					provider_hints,
					..Default::default()
				};

				match provider.search_series(&query).await {
					Ok(outcome) => {
						raw_hits += outcome.requested as i32;
						all_candidates.extend(outcome.candidates);
					},
					Err(e) if e.is_rate_limited() => {
						was_rate_limited = true;
						tracing::warn!(
							provider = ?config.provider_type,
							"Rate limited after retries for series metadata"
						);
					},
					Err(e) => {
						tracing::error!(
							provider = ?config.provider_type,
							error = ?e,
							"Failed to search provider for series metadata"
						);
					},
				}
			},
			Err(e) => {
				tracing::error!(
					provider = ?config.provider_type,
					error = ?e,
					"Failed to get provider client"
				);
			},
		}
	}

	let status = if was_rate_limited && all_candidates.is_empty() {
		MetadataFetchStatus::RateLimited
	} else if all_candidates.is_empty() {
		MetadataFetchStatus::NoMatch
	} else {
		MetadataFetchStatus::AwaitingReview
	};

	let candidates_json = serde_json::to_value(&all_candidates)
		.map_err(|e| CoreError::InternalError(e.to_string()))?;

	let active_model = metadata_fetch_record::ActiveModel {
		series_id: Set(Some(models.series.id.clone())),
		status: Set(status),
		match_candidates: Set(Some(candidates_json)),
		raw_hits: Set(raw_hits),
		..Default::default()
	};

	metadata_fetch_record::Entity::insert(active_model)
		.on_conflict(
			OnConflict::column(metadata_fetch_record::Column::SeriesId)
				.update_columns([
					metadata_fetch_record::Column::Status,
					metadata_fetch_record::Column::MatchCandidates,
					metadata_fetch_record::Column::RawHits,
					metadata_fetch_record::Column::UpdatedAt,
				])
				.to_owned(),
		)
		.exec(conn)
		.await?;

	if let Some((candidate, config)) =
		apply::find_auto_apply_candidate(&all_candidates, &provider_configs)
	{
		tracing::info!(
			series_id = ?models.series.id,
			provider = candidate.provider,
			confidence = candidate.confidence,
			"Auto-applying series metadata match"
		);
		if let Err(e) = apply::apply_series_match(
			conn,
			&models.series.id,
			&candidate,
			config.strategy,
			config.exclude_fields,
			vec![],
		)
		.await
		{
			tracing::error!(
				series_id = ?models.series.id,
				error = ?e,
				"Failed to auto-apply series metadata"
			);
		}
	}

	Ok(all_candidates)
}

/// Fetch metadata candidates for a media item from all enabled providers
///
/// `title_is_explicit` says the caller typed `search.title` itself, so it is searched alone.
/// Otherwise a game is also searched by its folder's name (see [`search_titles`]). When
/// `search.interactive` is set, a person is choosing among the results: every title is
/// searched and the candidates merged, rather than stopping at the first title that
/// matches.
pub async fn fetch_media_metadata(
	conn: &DatabaseConnection,
	media_id: &str,
	mut search: SearchQuery,
	provider_cache: &ProviderClientCache,
	provider_filter: Option<MetadataProvider>,
	skip_auto_apply: bool,
	title_is_explicit: bool,
) -> Result<Vec<MatchCandidate>, CoreError> {
	let library_type = library_type_for_media(conn, media_id).await?;

	let comicid = series_metadata::Entity::find()
		.select_only()
		.column(series_metadata::Column::Comicid)
		.inner_join(series::Entity)
		.filter(
			series::Column::Id.in_subquery(
				Query::select()
					.column(media::Column::SeriesId)
					.from(media::Entity)
					.and_where(media::Column::Id.eq(media_id.to_string()))
					.to_owned(),
			),
		)
		.into_tuple::<Option<i32>>()
		.one(conn)
		.await?
		.flatten();

	if let Some(id) = comicid {
		search
			.provider_hints
			.insert("comic_vine_volume_id".to_string(), id.to_string());
	}

	// Providers that look up covers by system (Wikipedia's per-platform cover categories)
	// need to be told which one, or they search every platform at once.
	let target = RetroTarget::for_media(conn, media_id).await;
	if let Some(platform) = target.platform() {
		search
			.provider_hints
			.insert("platform".to_string(), platform.as_str().to_string());
	}

	let provider_configs = metadata_provider_config::Entity::find()
		.filter(metadata_provider_config::Column::Enabled.eq(true))
		.all(conn)
		.await?;

	let provider_configs =
		filter_providers(provider_configs, &library_type, provider_filter, target);

	if provider_configs.is_empty() {
		return Err(no_provider_configs_error(&library_type, provider_filter));
	}

	let mut all_candidates: Vec<MatchCandidate> = Vec::new();
	let mut was_rate_limited = false;
	let mut raw_hits: i32 = 0;

	let titles = if title_is_explicit {
		vec![search.title.clone()]
	} else {
		search_titles(conn, media_id, target, &search.title).await
	};
	for title in titles {
		search.title = title;
		for config in &provider_configs {
			match provider_cache.get_or_create(config).await {
				Ok(provider) => match provider.search_media(&search).await {
					Ok(outcome) => {
						raw_hits += outcome.requested as i32;
						all_candidates.extend(outcome.candidates);
					},
					Err(e) if e.is_rate_limited() => {
						was_rate_limited = true;
						tracing::warn!(
							provider = ?config.provider_type,
							"Rate limited after retries for media metadata"
						);
					},
					Err(e) => {
						tracing::error!(
							provider = ?config.provider_type,
							error = ?e,
							"Failed to search provider for media metadata"
						);
					},
				},
				Err(e) => {
					tracing::error!(
						provider = ?config.provider_type,
						error = ?e,
						"Failed to get provider client"
					);
				},
			}
		}
		// Another title is only worth trying when this one came back empty -- or when a
		// person is choosing and would rather see everything -- and never while the
		// providers are asking us to slow down
		if was_rate_limited || (!search.interactive && !all_candidates.is_empty()) {
			break;
		}
	}
	if search.interactive {
		let before = all_candidates.len();
		all_candidates = merge_candidates(all_candidates);
		// Duplicates are not hits the providers failed to return
		raw_hits -= (before - all_candidates.len()) as i32;
	}

	let status = if was_rate_limited && all_candidates.is_empty() {
		MetadataFetchStatus::RateLimited
	} else if all_candidates.is_empty() {
		MetadataFetchStatus::NoMatch
	} else {
		MetadataFetchStatus::AwaitingReview
	};

	let candidates_json = serde_json::to_value(&all_candidates)
		.map_err(|e| CoreError::InternalError(e.to_string()))?;

	let active_model = metadata_fetch_record::ActiveModel {
		media_id: Set(Some(media_id.to_string())),
		status: Set(status),
		match_candidates: Set(Some(candidates_json)),
		raw_hits: Set(raw_hits),
		..Default::default()
	};

	metadata_fetch_record::Entity::insert(active_model)
		.on_conflict(
			OnConflict::column(metadata_fetch_record::Column::MediaId)
				.update_columns([
					metadata_fetch_record::Column::Status,
					metadata_fetch_record::Column::MatchCandidates,
					metadata_fetch_record::Column::RawHits,
					metadata_fetch_record::Column::UpdatedAt,
				])
				.to_owned(),
		)
		.exec(conn)
		.await?;

	if !skip_auto_apply {
		if let Some((candidate, config)) =
			apply::find_auto_apply_candidate(&all_candidates, &provider_configs)
		{
			tracing::info!(
				media_id,
				provider = candidate.provider,
				confidence = candidate.confidence,
				"Auto-applying media metadata match"
			);
			if let Err(e) = apply::apply_media_match(
				conn,
				media_id,
				&candidate,
				config.strategy,
				config.exclude_fields,
				vec![],
			)
			.await
			{
				tracing::error!(
					media_id,
					error = ?e,
					"Failed to auto-apply media metadata"
				);
			}
		}
	}

	Ok(all_candidates)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn config(provider_type: MetadataProvider) -> metadata_provider_config::Model {
		metadata_provider_config::Model {
			id: 1,
			provider_type,
			enabled: true,
			encrypted_api_token: None,
			api_token_expires_at: None,
			auto_apply_config: None,
			created_at: chrono::Utc::now().into(),
			updated_at: None,
		}
	}

	fn kept(library_type: LibraryType, target: RetroTarget) -> Vec<MetadataProvider> {
		let all = vec![
			config(MetadataProvider::Hardcover),
			config(MetadataProvider::Wikipedia),
			config(MetadataProvider::WorldOfSpectrum),
		];
		filter_providers(all, &library_type, None, target)
			.into_iter()
			.map(|c| c.provider_type)
			.collect()
	}

	fn candidate(external_id: &str, confidence: f32) -> MatchCandidate {
		MatchCandidate {
			provider: "wikipedia".to_string(),
			external_id: external_id.to_string(),
			metadata: metadata_integrations::ExternalMetadata::Media(Default::default()),
			confidence,
			confidence_factors: vec![],
		}
	}

	#[test]
	fn the_same_article_found_twice_is_offered_once() {
		let merged = merge_candidates(vec![
			candidate("Duke Nukem", 0.9),
			candidate("Duke Nukem 3D", 0.4),
			// The folder's name finds Duke Nukem 3D again, this time as the title match
			candidate("Duke Nukem 3D", 0.9),
			candidate("Duke Nukem Forever", 0.7),
		]);
		let order: Vec<_> = merged
			.iter()
			.map(|c| (c.external_id.as_str(), c.confidence))
			.collect();
		assert_eq!(
			order,
			vec![
				("Duke Nukem", 0.9),
				("Duke Nukem 3D", 0.9),
				("Duke Nukem Forever", 0.7)
			]
		);
	}

	#[test]
	fn a_book_in_a_mixed_library_is_not_looked_up_as_a_game() {
		assert_eq!(
			kept(LibraryType::Mixed, RetroTarget::NotAGame),
			vec![MetadataProvider::Hardcover]
		);
	}

	#[test]
	fn a_game_is_looked_up_only_where_its_machine_is_covered() {
		assert_eq!(
			kept(LibraryType::Mixed, RetroTarget::Game(RetroPlatform::C64)),
			vec![MetadataProvider::Wikipedia]
		);
		assert_eq!(
			kept(
				LibraryType::Retro,
				RetroTarget::Game(RetroPlatform::Spectrum)
			),
			vec![
				MetadataProvider::Wikipedia,
				MetadataProvider::WorldOfSpectrum
			]
		);
	}

	#[test]
	fn an_unhinted_series_keeps_every_provider_for_its_library() {
		assert_eq!(
			kept(LibraryType::Retro, RetroTarget::Unknown),
			vec![
				MetadataProvider::Wikipedia,
				MetadataProvider::WorldOfSpectrum
			]
		);
	}
}
