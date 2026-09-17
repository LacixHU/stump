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

		if let Some(url) = self.lookup_article_cover(&cleaned).await? {
			return Ok(Some(url));
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

	/// Infobox / lead images live on the article, not in Category:Video game covers.
	async fn lookup_article_cover(&self, title: &str) -> MetadataResult<Option<String>> {
		if let Some(url) = self.cover_from_article_title(title).await? {
			return Ok(Some(url));
		}

		let mut hits = self.search_articles(title).await?;
		if hits.is_empty() {
			hits = self.search_articles(&format!("{title} video game")).await?;
		}

		for hit in hits.into_iter().take(5) {
			if !titles_similar(title, &hit.title) {
				continue;
			}
			if let Some(url) = self.cover_from_article_title(&hit.title).await? {
				return Ok(Some(url));
			}
		}

		Ok(None)
	}

	async fn cover_from_article_title(
		&self,
		title: &str,
	) -> MetadataResult<Option<String>> {
		let Some(summary) = self.fetch_page_summary(title).await? else {
			return Ok(None);
		};
		if !is_video_game_page(&summary) {
			return Ok(None);
		}
		let article = summary.title.as_deref().unwrap_or(title);
		if !titles_similar(title, article) {
			return Ok(None);
		}
		Ok(cover_url_from_summary(&summary))
	}

	async fn fetch_page_summary(
		&self,
		title: &str,
	) -> MetadataResult<Option<PageSummary>> {
		let url = summary_url(title)?;
		let response = self
			.http
			.get(url)
			.header(reqwest::header::ACCEPT, "application/json")
			.send()
			.await?;

		let status = response.status();
		// Wikipedia rejects titles it considers malformed with 400/403 rather than 404
		// (e.g. a stem that still carries a `[Sir 13]` release tag). None of those mean
		// "retry" -- they mean this candidate simply has no page. 429 is the exception:
		// it is a client error we *do* want to surface as a failure.
		if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
			return Err(MetadataProviderError::Other(
				"Wikipedia summary HTTP 429 (rate limited)".to_string(),
			));
		}
		if status.is_client_error() {
			return Ok(None);
		}
		if !status.is_success() {
			return Err(MetadataProviderError::Other(format!(
				"Wikipedia summary HTTP {status}"
			)));
		}

		Ok(Some(response.json().await?))
	}

	async fn search_articles(&self, title: &str) -> MetadataResult<Vec<SearchHit>> {
		let url = api_url(&[
			("action", "query"),
			("list", "search"),
			("srnamespace", "0"),
			("srlimit", "5"),
			("format", "json"),
			("srsearch", title),
		])?;
		let response = self.http.get(url).send().await?;

		if !response.status().is_success() {
			return Err(MetadataProviderError::Other(format!(
				"Wikipedia article search HTTP {}",
				response.status()
			)));
		}

		let body: SearchResponse = response.json().await?;
		Ok(body.query.map(|q| q.search).unwrap_or_default())
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
						let mime = info.mime.unwrap_or_default();
						if !mime.starts_with("image/") {
							return None;
						}
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

const SUMMARY_URL: &str = "https://en.wikipedia.org/api/rest_v1/page/summary/";

fn summary_url(title: &str) -> MetadataResult<reqwest::Url> {
	let mut url = reqwest::Url::parse(SUMMARY_URL)
		.map_err(|e| MetadataProviderError::Other(e.to_string()))?;
	{
		let mut segments = url.path_segments_mut().map_err(|_| {
			MetadataProviderError::Other("invalid Wikipedia summary URL".into())
		})?;
		segments.pop_if_empty();
		segments.push(&title.replace(' ', "_"));
	}
	Ok(url)
}

fn is_video_game_page(summary: &PageSummary) -> bool {
	if summary
		.page_type
		.as_deref()
		.is_some_and(|t| t.eq_ignore_ascii_case("disambiguation"))
	{
		return false;
	}

	let haystack = format!(
		"{} {}",
		summary.description.as_deref().unwrap_or(""),
		summary.extract.as_deref().unwrap_or("")
	)
	.to_lowercase();

	haystack.contains("video game")
		|| haystack.contains("arcade game")
		|| haystack.contains("computer game")
}

fn cover_url_from_summary(summary: &PageSummary) -> Option<String> {
	summary
		.originalimage
		.as_ref()
		.or(summary.thumbnail.as_ref())
		.and_then(|img| img.source.clone())
		.filter(|u| !u.is_empty())
}

fn normalize_title(s: &str) -> String {
	s.to_lowercase()
		.replace("mac", "mc")
		.chars()
		.filter(|c| c.is_ascii_alphanumeric())
		.collect()
}

fn titles_similar(query: &str, article: &str) -> bool {
	let q = normalize_title(query);
	let a = normalize_title(article);
	if q.len() < 2 || a.len() < 2 {
		return false;
	}
	if a == q {
		return true;
	}
	if q.len() >= 8 && (a.contains(&q) || q.contains(&a)) {
		return true;
	}
	strsim::normalized_levenshtein(&q, &a) >= 0.72
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

/// Remove bracketed release-group / dump tags from a filename stem, e.g. the
/// `[Sir 13]` in `Operation Wolf [Sir 13]` or the `(1988)(Ocean)` in TOSEC-style
/// names. These are never part of the real title and derail every search.
fn strip_release_tags(raw: &str) -> String {
	let mut out = String::with_capacity(raw.len());
	let mut depth = 0usize;
	for c in raw.chars() {
		match c {
			'[' | '(' | '{' => depth += 1,
			']' | ')' | '}' => depth = depth.saturating_sub(1),
			_ if depth == 0 => out.push(c),
			_ => {},
		}
	}
	out
}

pub fn sanitize_game_title(raw: &str) -> String {
	// Guard against a name that is *entirely* a tag: fall back to treating the
	// brackets as plain separators rather than returning nothing.
	let stripped = strip_release_tags(raw);
	let base = if stripped.trim().len() >= 2 {
		stripped
	} else {
		raw.replace(['[', ']', '(', ')', '{', '}'], " ")
	};

	let mut s = base.replace(['_', '-'], " ");
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
		Some(p)
			if p == "dos" || p == "pc" || p.contains("msdos") || p.contains("ms-dos") =>
		{
			"MS-DOS game covers"
		},
		_ => "Video game covers",
	}
}

const TITLE_STOPWORDS: &[&str] = &["of", "the", "and", "a", "an", "for", "to", "in"];

fn significant_title_tokens(query: &str) -> Vec<String> {
	query
		.to_lowercase()
		.split_whitespace()
		.filter(|t| t.len() > 2 && !TITLE_STOPWORDS.contains(t))
		.map(str::to_string)
		.collect()
}

fn is_rejected_file_title(title: &str) -> bool {
	let t = title.to_lowercase();
	t.ends_with(".pdf")
		|| t.ends_with(".djvu")
		|| t.contains("entertainer")
		|| t.contains("magazine")
		|| t.contains("newsletter")
}

fn pick_best_file_title(query: &str, hits: Vec<SearchHit>) -> Option<String> {
	if hits.is_empty() {
		return None;
	}
	let tokens = significant_title_tokens(query);
	if tokens.is_empty() {
		return None;
	}
	hits.into_iter()
		.filter(|h| h.ns == 6 || h.title.to_lowercase().starts_with("file:"))
		.filter(|h| !is_rejected_file_title(&h.title))
		.filter(|h| {
			let title = h.title.to_lowercase();
			tokens.iter().all(|t| title.contains(t))
		})
		.max_by_key(|h| {
			let title = h.title.to_lowercase();
			let mut score =
				tokens.iter().filter(|t| title.contains(t.as_str())).count() * 10;
			if title.contains("cover") {
				score += 3;
			}
			score
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
struct PageSummary {
	#[serde(rename = "type")]
	page_type: Option<String>,
	title: Option<String>,
	description: Option<String>,
	extract: Option<String>,
	thumbnail: Option<SummaryImage>,
	originalimage: Option<SummaryImage>,
}

#[derive(Debug, Deserialize)]
struct SummaryImage {
	source: Option<String>,
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
	mime: Option<String>,
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
	fn test_sanitize_strips_release_tags() {
		// The tag that made the Operation Wolf lookup fail outright
		assert_eq!(
			sanitize_game_title("Operation Wolf [Sir 13]"),
			"Operation Wolf"
		);
		// TOSEC-style names
		assert_eq!(
			sanitize_game_title("Turrican (1990)(Rainbow Arts)"),
			"Turrican"
		);
		assert_eq!(
			sanitize_game_title("The Last Ninja {cr TCF}"),
			"The Last Ninja"
		);
		// Tags combined with the separators we already handled
		assert_eq!(sanitize_game_title("Zamzara-TCF"), "Zamzara TCF");
		assert_eq!(sanitize_game_title("Uridium_[Hewson]_Side_A"), "Uridium");
		// A name that is nothing but a tag falls back to the bare words
		assert_eq!(sanitize_game_title("[Bosszu]"), "Bosszu");
		// Unbalanced brackets must not swallow the title
		assert_eq!(sanitize_game_title("Wizard of Wor ]"), "Wizard of Wor");
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
		assert_eq!(
			cover_category_for_platform(Some("dos")),
			"MS-DOS game covers"
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

	#[test]
	fn test_pick_rejects_magazine_pdf() {
		let hits = vec![
			SearchHit {
				ns: 6,
				title: "File:Computer Entertainer 5-11.pdf".into(),
			},
			SearchHit {
				ns: 6,
				title: "File:Unrelated cover video game.png".into(),
			},
		];
		assert!(pick_best_file_title("Wizard of Wor", hits).is_none());
	}

	#[test]
	fn test_pick_requires_significant_tokens() {
		let hits = vec![SearchHit {
			ns: 6,
			title: "File:Wizard of Wor cover.jpg".into(),
		}];
		assert_eq!(
			pick_best_file_title("Wizard of Wor", hits).as_deref(),
			Some("File:Wizard of Wor cover.jpg")
		);
	}

	#[test]
	fn test_titles_similar_handles_misspellings() {
		assert!(titles_similar("Wizard of Wor", "Wizard of Wor"));
		assert!(titles_similar(
			"Zack MacKraken and the alien mindbenders",
			"Zak McKracken and the Alien Mindbenders"
		));
		assert!(!titles_similar("Zack", "Zack Snyder"));
	}

	#[test]
	fn test_is_video_game_page() {
		assert!(is_video_game_page(&PageSummary {
			page_type: Some("standard".into()),
			title: Some("Wizard of Wor".into()),
			description: Some("1981 video game".into()),
			extract: None,
			thumbnail: None,
			originalimage: None,
		}));
		assert!(!is_video_game_page(&PageSummary {
			page_type: Some("disambiguation".into()),
			title: Some("Wor".into()),
			description: None,
			extract: Some("Wor may refer to".into()),
			thumbnail: None,
			originalimage: None,
		}));
	}
}
