//! The one HTTP client every Wikimedia request goes through: Wikipedia, Wikidata and the
//! cover images on upload.wikimedia.org.
//!
//! Wikimedia asks API clients to send requests one after another rather than in parallel,
//! and answers a burst with 429. A library scan runs the thumbnail job's cover lookups and
//! the metadata job's game lookups at the same time, each with several books in flight, so
//! the pace has to hold for the whole process rather than per client: every lookup shares
//! one limiter. A 429 that still gets through is retried with backoff, and one that
//! outlasts the retries is reported as [`MetadataProviderError::RateLimited`] so the fetch
//! record says so instead of claiming there was no match.

use std::sync::LazyLock;

use reqwest_middleware::ClientWithMiddleware;

use crate::{
	client::{build_client_with_retry, RetryClientConfig},
	error::{MetadataProviderError, MetadataResult},
	RateLimiter,
};

/// Wikimedia's User-Agent policy wants a way to reach whoever runs the client.
pub const USER_AGENT: &str =
	"Stump/0.1 (https://github.com/stumpapp/stump; retro-cover-lookup)";

/// Requests per second across the whole server. A library-wide lookup is a background job,
/// so there is nothing to gain from going faster and a ban to lose.
const REQUESTS_PER_SECOND: u32 = 4;

static LIMITER: LazyLock<RateLimiter> =
	LazyLock::new(|| RateLimiter::new(REQUESTS_PER_SECOND));

static CLIENT: LazyLock<ClientWithMiddleware> = LazyLock::new(|| {
	let inner = reqwest::Client::builder()
		.user_agent(USER_AGENT)
		.build()
		.unwrap_or_default();
	build_client_with_retry(inner, RetryClientConfig::default())
});

/// GET `url` at the shared pace. A 429 that survives the retries becomes
/// [`MetadataProviderError::RateLimited`]; every other status is left to the caller.
pub async fn get(url: reqwest::Url) -> MetadataResult<reqwest::Response> {
	LIMITER.until_ready().await;
	let response = CLIENT.get(url).send().await?;
	if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
		return Err(MetadataProviderError::RateLimited);
	}
	Ok(response)
}
