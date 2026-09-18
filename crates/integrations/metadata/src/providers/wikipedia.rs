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
	///
	/// The game's own article is tried first: its lead image is the box art for the title
	/// as a whole, and matching an article pins down *which game* this is. The
	/// per-platform cover category is the fallback, because its file search matches on
	/// loose token overlap and will happily offer "Shadow of the Beast 3" for "Shadow of
	/// the Beast".
	///
	/// When the platform is known the search stops there. The cross-platform file search
	/// that ends the unhinted path is skipped entirely -- a bare `"{title} cover video
	/// game"` query is what used to hand a C64 game its Spectrum cover.
	pub async fn lookup_cover_url(
		&self,
		title: &str,
		platform: Option<&str>,
	) -> MetadataResult<Option<String>> {
		let cleaned = sanitize_game_title(title);
		if cleaned.len() < 2 {
			return Ok(None);
		}

		let resolved = resolve_cover_platform(platform);
		let category = resolved.map_or(GENERIC_COVER_CATEGORY, |p| p.category);

		if let Some(url) = self.lookup_article_cover(&cleaned, resolved).await? {
			return Ok(Some(url));
		}

		let mut file_title = self.search_cover_file(&cleaned, Some(category)).await?;

		if resolved.is_none() && file_title.is_none() {
			file_title = self.search_cover_file(&cleaned, None).await?;
		}

		let Some(file_title) = file_title else {
			return Ok(None);
		};

		self.fetch_thumb_url(&file_title).await
	}

	/// Infobox / lead images live on the article, not in Category:Video game covers.
	///
	/// Three searches are tried in order of how well they pin down *this* game: the bare
	/// title, the title plus the machine it runs on, then the title plus "video game".
	/// They all run: a generic name like "Pirates" fills every slot of the bare search
	/// with the wrong subject (Piracy, Pittsburgh Pirates) without ever coming back empty,
	/// so a fallback that fires only on zero hits never fires when it is needed most.
	/// Adding the platform is what lifts "Sid Meier's Pirates!" to the top of the list.
	async fn lookup_article_cover(
		&self,
		title: &str,
		platform: Option<CoverPlatform>,
	) -> MetadataResult<Option<String>> {
		if let Some(url) = self.cover_from_article_title(title, platform).await? {
			return Ok(Some(url));
		}

		let mut queries = vec![title.to_string()];
		if let Some(p) = platform {
			queries.push(format!("{title} {}", p.search_term));
		}
		queries.push(format!("{title} video game"));

		// Each accepted candidate costs a summary request, and the same article turns up
		// in more than one search, so titles already tried are not tried again and the
		// whole lookup is capped -- this runs once per book in a library-wide job.
		let mut seen = Vec::new();
		for query in queries {
			for hit in self.search_articles(&query).await?.into_iter().take(5) {
				if seen.len() >= MAX_ARTICLE_SUMMARY_FETCHES {
					return Ok(None);
				}
				if !could_be_same_game(title, &hit.title) {
					continue;
				}
				if seen.iter().any(|t: &String| t == &hit.title) {
					continue;
				}
				seen.push(hit.title.clone());

				if let Some(url) =
					self.cover_from_article_title(&hit.title, platform).await?
				{
					return Ok(Some(url));
				}
			}
		}

		Ok(None)
	}

	async fn cover_from_article_title(
		&self,
		title: &str,
		platform: Option<CoverPlatform>,
	) -> MetadataResult<Option<String>> {
		let Some(summary) = self.fetch_page_summary(title).await? else {
			return Ok(None);
		};
		if !is_video_game_page(&summary, platform) {
			return Ok(None);
		}
		let article = summary.title.as_deref().unwrap_or(title);

		// A title that matches outright stands on its own. A title the article merely ends
		// with -- the disk is "Pirates", the game is "Sid Meier's Pirates!" -- is only
		// trusted when the page also names the machine we are looking for. That second
		// signal is what separates the 1987 Commodore 64 original, whose article says so,
		// from the 2004 remake of the same name, whose article does not.
		let accepted = titles_similar(title, article)
			|| (article_ends_with_title(article, title)
				&& summary_mentions_platform(&summary, platform));
		if !accepted {
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

/// How an article describes a game when it does not use the words "video game". Articles
/// on home-computer titles usually lead with the genre instead -- Shadow of the Beast is
/// "a platform game", not "a video game" -- which used to make them invisible here.
const GAME_GENRE_PHRASES: &[&str] = &[
	"video game",
	"arcade game",
	"computer game",
	"platform game",
	"action game",
	"adventure game",
	"strategy game",
	"puzzle game",
	"racing game",
	"sports game",
	"fighting game",
	"shooter game",
	"simulation game",
	"role-playing game",
	"shoot 'em up",
	"beat 'em up",
	"text adventure",
];

/// Whether a summary is about a game rather than the thing the game was named after.
///
/// The genre list is backed up by the machine itself: a page that says it was published
/// for the Commodore 64 is a game page whatever it calls its genre. That second signal is
/// what stops a sparse article being passed over, while still rejecting "Piracy" for a
/// disk named "Pirates" -- nothing on that page mentions a C64.
fn is_video_game_page(summary: &PageSummary, platform: Option<CoverPlatform>) -> bool {
	if summary
		.page_type
		.as_deref()
		.is_some_and(|t| t.eq_ignore_ascii_case("disambiguation"))
	{
		return false;
	}

	if summary_mentions_platform(summary, platform) {
		return true;
	}

	let haystack = format!(
		"{} {}",
		summary.description.as_deref().unwrap_or(""),
		summary.extract.as_deref().unwrap_or("")
	)
	.to_lowercase();

	GAME_GENRE_PHRASES
		.iter()
		.any(|phrase| haystack.contains(phrase))
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

/// Drop the parenthetical Wikipedia adds only to keep two articles apart, e.g.
/// `Elite (video game)` or `Sid Meier's Pirates! (2004 video game)`. It is never part of
/// the name on the box, and leaving it in makes a short title look nothing like its own
/// article.
fn strip_title_qualifier(article: &str) -> &str {
	match article.rfind(" (") {
		Some(idx) if article.ends_with(')') => article[..idx].trim_end(),
		_ => article,
	}
}

/// Whether `article` names a different entry in a series than the one asked for, e.g.
/// "Shadow of the Beast II" for a disk called "Shadow of the Beast".
///
/// This has to be checked before anything else, because the sequel's title *contains* the
/// original's and so sails through both the substring shortcut and the edit-distance score
/// -- and its box art is a different game's box art.
///
/// Only small numbers and unambiguous roman numerals count. A four-digit year is a
/// disambiguating date, not an entry number, and a bare `v` or `x` is as likely to be a
/// letter as a numeral.
fn introduces_sequel(query: &str, article: &str) -> bool {
	let in_query = sequel_markers(query);
	sequel_markers(strip_title_qualifier(article))
		.iter()
		.any(|marker| !in_query.contains(marker))
}

fn sequel_markers(s: &str) -> Vec<String> {
	title_words(s)
		.into_iter()
		.filter(|word| {
			matches!(
				word.as_str(),
				"ii" | "iii" | "iv" | "vi" | "vii" | "viii" | "ix"
			) || word.parse::<u32>().is_ok_and(|n| (2..=9).contains(&n))
		})
		.collect()
}

fn titles_similar(query: &str, article: &str) -> bool {
	if introduces_sequel(query, article) {
		return false;
	}
	titles_similar_exact(query, article)
		|| titles_similar_exact(query, strip_title_qualifier(article))
}

fn titles_similar_exact(query: &str, article: &str) -> bool {
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

/// Split a title into lowercase word tokens, so matching happens on word boundaries.
fn title_words(s: &str) -> Vec<String> {
	s.to_lowercase()
		.split(|c: char| !c.is_ascii_alphanumeric())
		.filter(|w| !w.is_empty())
		.map(str::to_string)
		.collect()
}

/// Whether `article` is `query` with something in front of it, e.g. `Sid Meier's Pirates!`
/// for a disk named `Pirates`, or `The Last Ninja` for `Last Ninja`.
///
/// The match is anchored at the *end* on purpose. Dropping a publisher or author prefix is
/// how these filenames get shortened, whereas an article that merely starts with the query
/// is a different, longer title -- `Pirates of the Barbary Coast` and `Pirates! Gold` are
/// other games, not this one. The length floor keeps a two- or three-letter stem from
/// matching half of Wikipedia.
fn article_ends_with_title(article: &str, query: &str) -> bool {
	if normalize_title(query).len() < 4 {
		return false;
	}

	let article_words = title_words(strip_title_qualifier(article));
	let query_words = title_words(query);

	if query_words.is_empty() || article_words.len() <= query_words.len() {
		return false;
	}

	article_words.ends_with(&query_words)
}

/// A cheap pre-filter: is this search hit worth spending a summary request on? The
/// authoritative decision needs the summary, so this only has to avoid being narrower
/// than the checks in [`WikipediaCoverClient::cover_from_article_title`].
fn could_be_same_game(query: &str, article: &str) -> bool {
	titles_similar(query, article) || article_ends_with_title(article, query)
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

/// The category to search when the platform is unknown, or is one Wikipedia has no
/// dedicated cover category for.
pub const GENERIC_COVER_CATEGORY: &str = "Video game covers";

/// The most article summaries a single cover lookup will request. Each one is an HTTP
/// round trip and this runs once per book in a library-wide thumbnail job.
const MAX_ARTICLE_SUMMARY_FETCHES: usize = 8;

/// Everything the lookup needs to know about the machine a game runs on: the Wikipedia
/// category that holds its box art, how the machine is written in an article search, and
/// the names it goes by in article prose.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CoverPlatform {
	pub category: &'static str,
	pub search_term: &'static str,
	pub aliases: &'static [&'static str],
}

/// Map a platform hint (`c64`, `spectrum`, `amiga`, `dos`, or a looser spelling) onto the
/// one machine Wikipedia knows it by. `None` means there is nothing to narrow the search
/// with, which is what puts the lookup back on its cross-platform path.
pub fn resolve_cover_platform(platform: Option<&str>) -> Option<CoverPlatform> {
	let p = platform?.to_ascii_lowercase();

	let resolved = if p == "c64" || p.contains("commodore") {
		CoverPlatform {
			category: "Commodore 64 game covers",
			search_term: "Commodore 64",
			aliases: &["commodore 64", "c64"],
		}
	} else if p == "spectrum" || p.contains("zx") || p.contains("sinclair") {
		CoverPlatform {
			category: "ZX Spectrum game covers",
			search_term: "ZX Spectrum",
			aliases: &["zx spectrum", "sinclair spectrum"],
		}
	} else if p.contains("amiga") {
		CoverPlatform {
			category: "Amiga game covers",
			search_term: "Amiga",
			aliases: &["amiga"],
		}
	} else if p == "dos" || p == "pc" || p.contains("msdos") || p.contains("ms-dos") {
		CoverPlatform {
			category: "MS-DOS game covers",
			search_term: "MS-DOS",
			aliases: &["ms-dos", "msdos"],
		}
	} else {
		return None;
	};

	Some(resolved)
}

/// Whether an article's own prose names the machine we are looking for. Articles about a
/// home-computer game name the machine it came out on, so this is a cheap and surprisingly
/// sharp way to tell two same-named games on different systems apart.
fn summary_mentions_platform(
	summary: &PageSummary,
	platform: Option<CoverPlatform>,
) -> bool {
	let Some(platform) = platform else {
		return false;
	};

	let haystack = format!(
		"{} {}",
		summary.description.as_deref().unwrap_or(""),
		summary.extract.as_deref().unwrap_or("")
	)
	.to_lowercase();

	platform
		.aliases
		.iter()
		.any(|alias| haystack.contains(alias))
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

	fn category(platform: &str) -> &'static str {
		resolve_cover_platform(Some(platform))
			.map_or(GENERIC_COVER_CATEGORY, |p| p.category)
	}

	#[test]
	fn test_platform_categories() {
		assert_eq!(category("c64"), "Commodore 64 game covers");
		assert_eq!(category("spectrum"), "ZX Spectrum game covers");
		assert_eq!(category("amiga"), "Amiga game covers");
		assert_eq!(category("dos"), "MS-DOS game covers");
		assert_eq!(resolve_cover_platform(None), None);
	}

	/// `lookup_cover_url` keeps the search to one system only while the platform resolves,
	/// so every platform the emulator supports must resolve -- otherwise its search
	/// silently widens to every system again.
	#[test]
	fn every_supported_platform_resolves() {
		for platform in ["c64", "spectrum", "amiga", "dos"] {
			let resolved = resolve_cover_platform(Some(platform));
			assert!(
				resolved.is_some(),
				"{platform} would fall back to a cross-platform cover search"
			);
			// The search term is what pins an article search to this machine, and the
			// aliases are what confirm a loosely matched article really is about it
			let resolved = resolved.unwrap();
			assert!(!resolved.search_term.is_empty());
			assert!(!resolved.aliases.is_empty());
		}

		// An unrecognised hint has nothing to narrow by and must not pretend otherwise
		assert_eq!(resolve_cover_platform(Some("atari-st")), None);
	}

	#[test]
	fn a_sequel_is_a_different_game() {
		// The sequel's title contains the original's, which is exactly why the substring
		// shortcut used to accept it
		assert!(!titles_similar(
			"Shadow of the Beast",
			"Shadow of the Beast II"
		));
		assert!(!titles_similar("Turrican", "Turrican 2"));
		assert!(!titles_similar("Doom", "Doom II"));

		// The game actually asked for, however it is disambiguated
		assert!(titles_similar(
			"Shadow of the Beast",
			"Shadow of the Beast (1989 video game)"
		));
		assert!(titles_similar("Turrican II", "Turrican II"));

		// A year is a date, not an entry number
		assert!(!introduces_sequel("Pirates", "Sid Meier's Pirates! (1987)"));
		assert!(introduces_sequel("Pirates", "Pirates 2"));
	}

	#[test]
	fn qualifier_is_not_part_of_the_name_on_the_box() {
		assert_eq!(strip_title_qualifier("Elite (video game)"), "Elite");
		assert_eq!(
			strip_title_qualifier("Sid Meier's Pirates! (2004 video game)"),
			"Sid Meier's Pirates!"
		);
		// Nothing to strip, and a stray '(' must not eat the title
		assert_eq!(strip_title_qualifier("Turrican"), "Turrican");
		assert_eq!(strip_title_qualifier("Wizard of Wor ("), "Wizard of Wor (");

		// The whole point: a short title now matches its own disambiguated article
		assert!(titles_similar("Elite", "Elite (video game)"));
		assert!(titles_similar("Booty", "Booty (video game)"));
	}

	#[test]
	fn a_dropped_prefix_still_matches_but_a_longer_title_does_not() {
		// The filename drops the author/publisher that the real title carries
		assert!(article_ends_with_title("Sid Meier's Pirates!", "Pirates"));
		assert!(article_ends_with_title("The Last Ninja", "Last Ninja"));
		assert!(article_ends_with_title(
			"Sid Meier's Pirates! (2004 video game)",
			"Pirates"
		));

		// These are different, longer games that merely start with the same word
		assert!(!article_ends_with_title(
			"Pirates of the Barbary Coast",
			"Pirates"
		));
		assert!(!article_ends_with_title("Pirates! Gold", "Pirates"));
		assert!(!article_ends_with_title(
			"Pirates of the Caribbean (video game)",
			"Pirates"
		));

		// An unrelated game that happens to be on the same machine
		assert!(!article_ends_with_title("Booty (video game)", "Pirates"));

		// A one-word stem is fine as long as it is a real word: a disk called "Field" for
		// "Track and Field" is the same dropped-prefix shape, and the platform check is
		// still what decides it
		assert!(article_ends_with_title("Track and Field", "Field"));

		// A stem too short to mean anything must not match half of Wikipedia
		assert!(!article_ends_with_title("Sid Meier's Pirates!", "es"));
		assert!(!article_ends_with_title("The Great Escape", "ape"));

		// An exact title is handled by `titles_similar`, not by this
		assert!(!article_ends_with_title("Turrican", "Turrican"));
	}

	#[test]
	fn platform_confirmation_separates_two_games_of_the_same_name() {
		let c64 = resolve_cover_platform(Some("c64"));

		let original = PageSummary {
			title: Some("Sid Meier's Pirates!".into()),
			description: Some("1987 video game".into()),
			extract: Some(
				"Sid Meier's Pirates! is a 1987 action-adventure strategy video game 				 developed and published by MicroProse for the Commodore 64."
					.into(),
			),
			page_type: None,
			thumbnail: None,
			originalimage: None,
		};
		let remake = PageSummary {
			title: Some("Sid Meier's Pirates! (2004 video game)".into()),
			description: Some("2004 video game".into()),
			extract: Some(
				"Sid Meier's Pirates! is a 2004 strategy, action and adventure video 				 game developed by Firaxis Games."
					.into(),
			),
			page_type: None,
			thumbnail: None,
			originalimage: None,
		};

		assert!(summary_mentions_platform(&original, c64));
		assert!(!summary_mentions_platform(&remake, c64));

		// Without a platform there is nothing to confirm against, so the loose path is
		// never taken
		assert!(!summary_mentions_platform(&original, None));
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
		assert!(is_video_game_page(
			&PageSummary {
				page_type: Some("standard".into()),
				title: Some("Wizard of Wor".into()),
				description: Some("1981 video game".into()),
				extract: None,
				thumbnail: None,
				originalimage: None,
			},
			None
		));
		assert!(!is_video_game_page(
			&PageSummary {
				page_type: Some("disambiguation".into()),
				title: Some("Wor".into()),
				description: None,
				extract: Some("Wor may refer to".into()),
				thumbnail: None,
				originalimage: None,
			},
			None
		));

		// The article that started this: it never says "video game", only "platform game",
		// and the machine it names is the one we are looking for
		let beast = PageSummary {
			page_type: Some("standard".into()),
			title: Some("Shadow of the Beast (1989 video game)".into()),
			description: Some("Platform game".into()),
			extract: Some(
				"Shadow of the Beast is a platform game developed by Reflections and 				 published in 1989 by Psygnosis for the Amiga."
					.into(),
			),
			thumbnail: None,
			originalimage: None,
		};
		assert!(is_video_game_page(
			&beast,
			resolve_cover_platform(Some("amiga"))
		));
		assert!(is_video_game_page(&beast, None));

		// A page about the thing the game was named after is still not a game page
		let piracy = PageSummary {
			page_type: Some("standard".into()),
			title: Some("Piracy".into()),
			description: Some("Acts of robbery or criminality at sea".into()),
			extract: Some("Piracy is an act of robbery committed at sea.".into()),
			thumbnail: None,
			originalimage: None,
		};
		assert!(!is_video_game_page(
			&piracy,
			resolve_cover_platform(Some("c64"))
		));
	}
}
