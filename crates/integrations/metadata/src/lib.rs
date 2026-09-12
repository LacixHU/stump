pub mod client;
pub mod error;
pub mod merge;
mod provider;
mod providers;
pub mod rate_limit;
pub mod scoring;
pub(crate) mod serde_utils;
pub mod types;

pub use client::build_client_with_retry;
pub use error::{MetadataProviderError, MetadataResult};
pub use merge::{AutoApplyConfig, FieldMerger, MergeStrategy, MetadataFieldOverride};
pub use provider::{MetadataProvider, ProviderCredentialVerification};
pub use rate_limit::RateLimiter;
pub use scoring::MatchScorer;
pub use types::{
	ConfidenceFactor, ExternalMediaMetadata, ExternalMetadata, ExternalSeriesMetadata,
	MatchCandidate, MediaType, MetadataField, PublicationStatus, SearchOutcome,
	SearchQuery,
};

use providers::{
	ComicVineClient, HardcoverClient, Lemon64Client, LemonAmigaClient,
	WikipediaCoverClient, WorldOfSpectrumClient,
};

pub use providers::wikipedia::{
	download_cover_bytes, lookup_wikipedia_game_cover, sanitize_game_title,
};

pub fn create_provider(
	provider_type: &str,
	api_token: String,
) -> MetadataResult<Box<dyn MetadataProvider + Send + Sync>> {
	match provider_type {
		"COMIC_VINE" => Ok(Box::new(ComicVineClient::new(api_token, None))),
		"HARDCOVER" => Ok(Box::new(HardcoverClient::new(api_token, None))),
		// Public HTML sources — no token required (api_token ignored)
		"LEMON64" => Ok(Box::new(Lemon64Client::new())),
		"WORLD_OF_SPECTRUM" => Ok(Box::new(WorldOfSpectrumClient::new())),
		"LEMON_AMIGA" => Ok(Box::new(LemonAmigaClient::new())),
		"WIKIPEDIA" => Ok(Box::new(WikipediaCoverClient::new())),
		_ => Err(MetadataProviderError::UnsupportedProvider(
			provider_type.to_string(),
		)),
	}
}
