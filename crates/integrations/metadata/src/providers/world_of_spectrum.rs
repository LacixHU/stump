//! World of Spectrum–style Spectrum metadata provider.
//!
//! Public HTML source—no API token. Stub until fixture-backed scrape lands.

use async_trait::async_trait;

use crate::{
	error::{MetadataProviderError, MetadataResult},
	provider::{MetadataProvider, ProviderCredentialVerification},
	types::{
		ExternalMediaMetadata, ExternalSeriesMetadata, MediaType, SearchOutcome,
		SearchQuery,
	},
};

pub struct WorldOfSpectrumClient {
	#[allow(dead_code)]
	http: reqwest::Client,
}

impl WorldOfSpectrumClient {
	pub fn new() -> Self {
		Self {
			http: reqwest::Client::builder()
				.user_agent("Stump/0.1 (+https://stumpapp.dev)")
				.build()
				.unwrap_or_default(),
		}
	}
}

impl Default for WorldOfSpectrumClient {
	fn default() -> Self {
		Self::new()
	}
}

#[async_trait]
impl MetadataProvider for WorldOfSpectrumClient {
	fn id(&self) -> &'static str {
		"world_of_spectrum"
	}

	fn name(&self) -> &'static str {
		"World of Spectrum"
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
