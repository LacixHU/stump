//! Lemon Amiga metadata provider stub.
//!
//! Filename-only catalog remains usable; empty search must not block play.

use async_trait::async_trait;

use crate::{
	error::{MetadataProviderError, MetadataResult},
	provider::{MetadataProvider, ProviderCredentialVerification},
	types::{
		ExternalMediaMetadata, ExternalSeriesMetadata, MediaType, SearchOutcome,
		SearchQuery,
	},
};

pub struct LemonAmigaClient;

impl LemonAmigaClient {
	pub fn new() -> Self {
		Self
	}
}

impl Default for LemonAmigaClient {
	fn default() -> Self {
		Self::new()
	}
}

#[async_trait]
impl MetadataProvider for LemonAmigaClient {
	fn id(&self) -> &'static str {
		"lemon_amiga"
	}

	fn name(&self) -> &'static str {
		"Lemon Amiga"
	}

	fn supported_media_types(&self) -> Vec<MediaType> {
		vec![MediaType::Retro]
	}

	async fn search_series(&self, _query: &SearchQuery) -> MetadataResult<SearchOutcome> {
		Ok(SearchOutcome {
			candidates: vec![],
			requested: 0,
		})
	}

	async fn search_media(&self, query: &SearchQuery) -> MetadataResult<SearchOutcome> {
		self.search_series(query).await
	}

	async fn fetch_series_metadata(
		&self,
		external_id: &str,
	) -> MetadataResult<ExternalSeriesMetadata> {
		Err(MetadataProviderError::NotFound(external_id.to_string()))
	}

	async fn fetch_media_metadata(
		&self,
		external_id: &str,
	) -> MetadataResult<ExternalMediaMetadata> {
		Err(MetadataProviderError::NotFound(external_id.to_string()))
	}

	async fn verify_credentials(&self) -> MetadataResult<ProviderCredentialVerification> {
		Ok(ProviderCredentialVerification {
			response_status: 200,
			is_valid: true,
			error: None,
		})
	}
}
