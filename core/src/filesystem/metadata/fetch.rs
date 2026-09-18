use std::collections::HashMap;

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
		media::{platform_from_path_hints, resolve_retro_platform, RetroPlatform},
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

/// Filters provider configs down to those that support the given library type, and,
/// if `provider_filter` is given, further down to just that one provider. When the entity
/// is a retro game, providers that do not cover its system are dropped as well -- a C64
/// title has no business being looked up in the Spectrum or Amiga databases.
fn filter_providers(
	provider_configs: Vec<metadata_provider_config::Model>,
	library_type: &LibraryType,
	provider_filter: Option<MetadataProvider>,
	retro_platform: Option<RetroPlatform>,
) -> Vec<metadata_provider_config::Model> {
	provider_configs
		.into_iter()
		.filter(|c| library_type.has_provider_overlap(&c.provider_type))
		.filter(|c| match retro_platform {
			Some(platform) => platform.is_covered_by(c.provider_type),
			None => true,
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

	let provider_configs =
		filter_providers(provider_configs, &library_type, None, retro_platform);

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
pub async fn fetch_media_metadata(
	conn: &DatabaseConnection,
	media_id: &str,
	mut search: SearchQuery,
	provider_cache: &ProviderClientCache,
	provider_filter: Option<MetadataProvider>,
	skip_auto_apply: bool,
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
	let retro_platform = retro_platform_for_media(conn, media_id).await;
	if let Some(platform) = retro_platform {
		search
			.provider_hints
			.insert("platform".to_string(), platform.as_str().to_string());
	}

	let provider_configs = metadata_provider_config::Entity::find()
		.filter(metadata_provider_config::Column::Enabled.eq(true))
		.all(conn)
		.await?;

	let provider_configs = filter_providers(
		provider_configs,
		&library_type,
		provider_filter,
		retro_platform,
	);

	if provider_configs.is_empty() {
		return Err(no_provider_configs_error(&library_type, provider_filter));
	}

	let mut all_candidates: Vec<MatchCandidate> = Vec::new();
	let mut was_rate_limited = false;
	let mut raw_hits: i32 = 0;

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
