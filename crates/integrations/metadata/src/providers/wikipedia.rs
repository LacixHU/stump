//! Wikipedia / Wikimedia cover lookup for video games.
//!
//! Uses the MediaWiki API (not HTML scrape) against
//! [Category:Video game covers](https://en.wikipedia.org/wiki/Category:Video_game_covers)
//! and platform subcategories (e.g. Commodore 64, ZX Spectrum, Amiga).

use async_trait::async_trait;
use serde::Deserialize;

use crate::{
	error::{MetadataProviderError, MetadataResult},
	provider::{MetadataProvider, ProviderCredentialVerification},
	types::{
		ExternalMediaMetadata, ExternalMetadata, ExternalSeriesMetadata, MatchCandidate,
		MediaType, SearchOutcome, SearchQuery,
	},
};

const API_URL: &str = "https://en.wikipedia.org/w/api.php";
const USER_AGENT: &str =
	"Stump/0.1 (https://github.com/stumpapp/stump; retro-cover-lookup)";

pub struct WikipediaCoverClient {
	http: reqwest::Client,
}

impl WikipediaCoverClient {
	pub fn new() -> Self {
		Self {
			http: reqwest::Client::builder()
				.user_agent(USER_AGENT)
				.build()
				.unwrap_or_default(),
		}
	}

	/// Find a cover image URL for a game title (filename stem is fine).
	/// `platform` may be `c64`, `spectrum`, `amiga`, or a Wikipedia category suffix.
	pub async fn lookup_cover_url(
		&self,
		title: &str,
		platform: Option<&str>,
	) -> MetadataResult<Option<String>> {
		let cleaned = sanitize_game_title(title);
		if cleaned.len() < 2 {
			return Ok(None);
		}

		let category = cover_category_for_platform(platform);
		let mut file_title = self.search_cover_file(&cleaned, Some(category)).await?;
		if file_title.is_none() {
			file_title = self.search_cover_file(&cleaned, None).await?;
		}
		let Some(file_title) = file_title else {
			return Ok(None);
		};

		self.fetch_thumb_url(&file_title).await
	}

	async fn search_cover_file(
		&self,
		title: &str,
		category: Option<&str>,
	) -> MetadataResult<Option<String>> {
		let srsearch = match category {
			Some(cat) => format!("incategory:\"{cat}\" {title}"),
			None => format!("{title} cover video game"),
		};

		let url = api_url(&[
			("action", "query"),
			("list", "search"),
			("srnamespace", "6"),
			("srlimit", "8"),
			("format", "json"),
			("srsearch", &srsearch),
		])?;
		let response = self.http.get(url).send().await?;

		if !response.status().is_success() {
			return Err(MetadataProviderError::Other(format!(
				"Wikipedia search HTTP {}",
				response.status()
			)));
		}

		let body: SearchResponse = response.json().await?;
		let hits = body.query.map(|q| q.search).unwrap_or_default();
		Ok(pick_best_file_title(title, hits))
	}

	async fn fetch_thumb_url(&self, file_title: &str) -> MetadataResult<Option<String>> {
		let url = api_url(&[
			("action", "query"),
			("prop", "imageinfo"),
			("iiprop", "url|mime"),
			("iiurlwidth", "512"),
			("format", "json"),
			("titles", file_title),
		])?;
		let response = self.http.get(url).send().await?;

		if !response.status().is_success() {
			return Err(MetadataProviderError::Other(format!(
				"Wikipedia imageinfo HTTP {}",
				response.status()
			)));
		}

		let body: ImageInfoResponse = response.json().await?;
		Ok(body.query.and_then(|q| q.pages).and_then(|pages| {
			pages.into_values().find_map(|page| {
				page.imageinfo.and_then(|infos| {
					infos.into_iter().next().and_then(|info| {
						info.thumburl.or(info.url).filter(|u| !u.is_empty())
					})
				})
			})
		}))
	}
}

fn api_url(params: &[(&str, &str)]) -> MetadataResult<reqwest::Url> {
	reqwest::Url::parse_with_params(API_URL, params)
		.map_err(|e| MetadataProviderError::Other(e.to_string()))
}

impl Default for WikipediaCoverClient {
	fn default() -> Self {
		Self::new()
	}
}

/// Public helper for scan/thumbnail jobs (no API token).
pub async fn lookup_wikipedia_game_cover(
	title: &str,
	platform: Option<&str>,
) -> MetadataResult<Option<String>> {
	WikipediaCoverClient::new()
		.lookup_cover_url(title, platform)
		.await
}

/// Download image bytes with the Wikipedia-compliant User-Agent.
pub async fn download_cover_bytes(url: &str) -> MetadataResult<Vec<u8>> {
	let response = reqwest::Client::builder()
		.user_agent(USER_AGENT)
		.build()
		.unwrap_or_default()
		.get(url)
		.send()
		.await?;

	if !response.status().is_success() {
		return Err(MetadataProviderError::Other(format!(
			"Cover download HTTP {}",
			response.status()
		)));
	}

	let content_type = response
		.headers()
		.get(reqwest::header::CONTENT_TYPE)
		.and_then(|v| v.to_str().ok())
		.unwrap_or_default()
		.to_string();
	if !content_type.starts_with("image/") {
		return Err(MetadataProviderError::Other(format!(
			"Cover was not an image ({content_type})"
		)));
	}

	Ok(response.bytes().await?.to_vec())
}

pub fn sanitize_game_title(raw: &str) -> String {
	let mut s = raw.replace('_', " ").replace('-', " ");
	for suffix in [
		" side a", " side b", " side 1", " side 2", " disk 1", " disk 2", " disk 3",
		" disc 1", " disc 2", " tape 1", " tape 2",
	] {
		if let Some(idx) = s.to_lowercase().find(suffix) {
			s.truncate(idx);
		}
	}
	s.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn cover_category_for_platform(platform: Option<&str>) -> &'static str {
	match platform.map(|p| p.to_ascii_lowercase()) {
		Some(p) if p == "c64" || p.contains("commodore") => "Commodore 64 game covers",
		Some(p) if p == "spectrum" || p.contains("zx") || p.contains("sinclair") => {
			"ZX Spectrum game covers"
		},
		Some(p) if p.contains("amiga") => "Amiga game covers",
		_ => "Video game covers",
	}
}

fn pick_best_file_title(query: &str, hits: Vec<SearchHit>) -> Option<String> {
	if hits.is_empty() {
		return None;
	}
	let q = query.to_lowercase();
	let tokens: Vec<&str> = q.split_whitespace().filter(|t| t.len() > 1).collect();
	hits.into_iter()
		.filter(|h| h.ns == 6 || h.title.to_lowercase().starts_with("file:"))
		.max_by_key(|h| {
			let title = h.title.to_lowercase();
			tokens.iter().filter(|t| title.contains(**t)).count()
		})
		.map(|h| h.title)
}

#[async_trait]
impl MetadataProvider for WikipediaCoverClient {
	fn id(&self) -> &'static str {
		"wikipedia"
	}

	fn name(&self) -> &'static str {
		"Wikipedia (video game covers)"
	}

	fn supported_media_types(&self) -> Vec<MediaType> {
		vec![MediaType::Retro]
	}

	async fn search_series(&self, query: &SearchQuery) -> MetadataResult<SearchOutcome> {
		self.search_media(query).await
	}

	async fn search_media(&self, query: &SearchQuery) -> MetadataResult<SearchOutcome> {
		let platform = query.provider_hints.get("platform").map(String::as_str);
		let url = self.lookup_cover_url(&query.title, platform).await?;
		let Some(cover_url) = url else {
			return Ok(SearchOutcome {
				candidates: vec![],
				requested: 1,
			});
		};

		Ok(SearchOutcome {
			requested: 1,
			candidates: vec![MatchCandidate {
				provider: self.id().to_string(),
				external_id: cover_url.clone(),
				metadata: ExternalMetadata::Media(ExternalMediaMetadata {
					provider: self.id().to_string(),
					external_id: cover_url.clone(),
					title: Some(sanitize_game_title(&query.title)),
					cover_url: Some(cover_url),
					provider_url: Some(
						"https://en.wikipedia.org/wiki/Category:Video_game_covers"
							.to_string(),
					),
					..Default::default()
				}),
				confidence: 0.7,
				confidence_factors: vec![],
			}],
		})
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
		Ok(ExternalMediaMetadata {
			provider: self.id().to_string(),
			external_id: external_id.to_string(),
			cover_url: Some(external_id.to_string()),
			..Default::default()
		})
	}

	async fn verify_credentials(&self) -> MetadataResult<ProviderCredentialVerification> {
		Ok(ProviderCredentialVerification {
			response_status: 200,
			is_valid: true,
			error: None,
		})
	}
}

#[derive(Debug, Deserialize)]
struct SearchResponse {
	query: Option<SearchQueryBody>,
}

#[derive(Debug, Deserialize)]
struct SearchQueryBody {
	search: Vec<SearchHit>,
}

#[derive(Debug, Deserialize)]
struct SearchHit {
	ns: i32,
	title: String,
}

#[derive(Debug, Deserialize)]
struct ImageInfoResponse {
	query: Option<ImageInfoQuery>,
}

#[derive(Debug, Deserialize)]
struct ImageInfoQuery {
	pages: Option<std::collections::HashMap<String, ImagePage>>,
}

#[derive(Debug, Deserialize)]
struct ImagePage {
	imageinfo: Option<Vec<ImageInfo>>,
}

#[derive(Debug, Deserialize)]
struct ImageInfo {
	url: Option<String>,
	thumburl: Option<String>,
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn test_sanitize_strips_disk_sides() {
		assert_eq!(sanitize_game_title("Uridium_Side_A"), "Uridium");
		assert_eq!(sanitize_game_title("Elite disk 1"), "Elite");
		assert_eq!(sanitize_game_title("Last Ninja"), "Last Ninja");
	}

	#[test]
	fn test_platform_categories() {
		assert_eq!(
			cover_category_for_platform(Some("c64")),
			"Commodore 64 game covers"
		);
		assert_eq!(
			cover_category_for_platform(Some("spectrum")),
			"ZX Spectrum game covers"
		);
		assert_eq!(
			cover_category_for_platform(Some("amiga")),
			"Amiga game covers"
		);
		assert_eq!(cover_category_for_platform(None), "Video game covers");
	}

	#[test]
	fn test_pick_best_file_title() {
		let hits = vec![
			SearchHit {
				ns: 6,
				title: "File:Unrelated.png".into(),
			},
			SearchHit {
				ns: 6,
				title: "File:Uridium cover art (Commodore 64).jpg".into(),
			},
		];
		assert_eq!(
			pick_best_file_title("Uridium", hits).as_deref(),
			Some("File:Uridium cover art (Commodore 64).jpg")
		);
	}
}
