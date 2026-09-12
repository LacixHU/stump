//! Lemon64 metadata provider (C64).
//!
//! Public HTML source—no API token. Search is stubbed until fixture-backed
//! scrapers are implemented; verify_credentials is a soft OK.

use async_trait::async_trait;

use crate::{
	error::{MetadataProviderError, MetadataResult},
	provider::{MetadataProvider, ProviderCredentialVerification},
	types::{
		ExternalMediaMetadata, ExternalSeriesMetadata, MediaType, SearchOutcome,
		SearchQuery,
	},
};

pub struct Lemon64Client {
	#[allow(dead_code)]
	http: reqwest::Client,
}

impl Lemon64Client {
	pub fn new() -> Self {
		Self {
			http: reqwest::Client::builder()
				.user_agent("Stump/0.1 (+https://stumpapp.dev)")
				.build()
				.unwrap_or_default(),
		}
	}
}

impl Default for Lemon64Client {
	fn default() -> Self {
		Self::new()
	}
}

#[async_trait]
impl MetadataProvider for Lemon64Client {
	fn id(&self) -> &'static str {
		"lemon64"
	}

	fn name(&self) -> &'static str {
		"Lemon64"
	}

	fn supported_media_types(&self) -> Vec<MediaType> {
		vec![MediaType::Retro]
	}

	async fn search_series(&self, _query: &SearchQuery) -> MetadataResult<SearchOutcome> {
		// HTML scrape + fixtures TBD; empty result must not block play
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
