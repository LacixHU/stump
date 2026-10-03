//! Wikipedia / Wikimedia lookup for video games: box art, and the game's details.
//!
//! Uses the MediaWiki API (not HTML scrape) against
//! [Category:Video game covers](https://en.wikipedia.org/wiki/Category:Video_game_covers)
//! and platform subcategories (e.g. Commodore 64, ZX Spectrum, Amiga).
//!
//! Once a game's own article is matched, its summary supplies the description and its
//! Wikidata item the developer, publisher, platforms, release date and genres (see
//! [`super::wikidata`]).

use async_trait::async_trait;
use serde::Deserialize;

use super::{
	infobox::infobox_names,
	wikidata::{self, GameFacts},
	wikimedia,
};
use crate::{
	error::{MetadataProviderError, MetadataResult},
	provider::{MetadataProvider, ProviderCredentialVerification},
	types::{
		ExternalMediaMetadata, ExternalMetadata, ExternalSeriesMetadata, MatchCandidate,
		MediaType, SearchOutcome, SearchQuery,
	},
};

const API_URL: &str = "https://en.wikipedia.org/w/api.php";
/// Every request goes through [`wikimedia::get`], which paces them for the whole server,
/// so a client holds no state of its own.
pub struct WikipediaCoverClient;

impl WikipediaCoverClient {
	pub fn new() -> Self {
		Self
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

		if let Some(article) = self.find_game_article(&cleaned, resolved, true).await? {
			return Ok(cover_url_from_summary(&article.summary));
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

	/// Look up a game's article and turn it into metadata: its name, description and
	/// box art from the article, and the rest from the article's Wikidata item.
	///
	/// Only an article match counts. A file in a cover category says nothing about the game
	/// beyond its box art, which the thumbnail job already takes care of.
	pub async fn lookup_game(
		&self,
		title: &str,
		platform: Option<&str>,
	) -> MetadataResult<Option<(ExternalMediaMetadata, f32)>> {
		let cleaned = sanitize_game_title(title);
		if cleaned.len() < 2 {
			return Ok(None);
		}

		let resolved = resolve_cover_platform(platform);
		let Some(article) = self.find_game_article(&cleaned, resolved, false).await?
		else {
			return Ok(None);
		};

		Ok(Some(self.article_candidate(article, resolved).await?))
	}

	/// Every game article the searches for `title` turn up, up to `max`, best first -- for a
	/// person to choose from. Articles whose titles are nothing like `title` are offered
	/// too, at a low confidence: whoever typed "Duke Nukem" may well be after Duke Nukem 3D.
	pub async fn lookup_games(
		&self,
		title: &str,
		platform: Option<&str>,
		max: usize,
	) -> MetadataResult<Vec<(ExternalMediaMetadata, f32)>> {
		let cleaned = sanitize_game_title(title);
		if cleaned.len() < 2 {
			return Ok(vec![]);
		}

		let resolved = resolve_cover_platform(platform);
		let mut candidates = Vec::new();
		for article in self.find_game_articles(&cleaned, resolved, max).await? {
			candidates.push(self.article_candidate(article, resolved).await?);
		}
		// Stable, so equally good matches keep Wikipedia's search order
		candidates.sort_by(|a, b| b.1.total_cmp(&a.1));
		Ok(candidates)
	}

	/// The metadata of a known article, read afresh.
	async fn article_metadata(
		&self,
		article: &str,
		platform: Option<CoverPlatform>,
	) -> MetadataResult<ExternalMediaMetadata> {
		let summary = self
			.fetch_page_summary(article)
			.await?
			.ok_or_else(|| MetadataProviderError::NotFound(article.to_string()))?;
		Ok(self.game_metadata(summary, platform).await?.0)
	}

	/// An accepted article's metadata, and how sure the match is.
	///
	/// The first paragraph of an arcade game's article seldom names the home computers it
	/// was ported to (Bomb Jack's says only "arcades"), but its Wikidata item lists them.
	/// That settles a title match; it cannot settle a dropped-prefix one, since Montezuma's
	/// Revenge came out on the C64 too.
	async fn article_candidate(
		&self,
		article: GameArticle,
		platform: Option<CoverPlatform>,
	) -> MetadataResult<(ExternalMediaMetadata, f32)> {
		let GameArticle {
			summary,
			confidence,
			title_matched,
			..
		} = article;
		let (metadata, on_platform) = self.game_metadata(summary, platform).await?;
		let confidence = if title_matched && on_platform {
			TITLE_MATCH_CONFIDENCE
		} else {
			confidence
		};
		Ok((metadata, confidence))
	}

	/// Build the metadata for an article already known to be about a game. A Wikidata
	/// failure costs only the structured fields: the description and cover still come
	/// from the article itself.
	///
	/// Being rate limited is the exception. The half-filled match it would leave behind
	/// is applied like any other and never looked at again, whereas an error marks the
	/// fetch as rate limited, which is what gets it retried.
	async fn game_metadata(
		&self,
		summary: PageSummary,
		platform: Option<CoverPlatform>,
	) -> MetadataResult<(ExternalMediaMetadata, bool)> {
		let platform_items = platform.map_or(&[][..], |p| p.wikidata_items);
		let facts = match summary.wikibase_item.as_deref() {
			Some(item) => match wikidata::fetch_game_facts(item, platform_items).await {
				Ok(facts) => facts,
				Err(e) if e.is_rate_limited() => return Err(e),
				Err(e) => {
					tracing::warn!(
						item,
						error = %e,
						"Wikidata lookup failed; keeping the article details only"
					);
					GameFacts::default()
				},
			},
			None => GameFacts::default(),
		};
		let on_platform = facts.on_platform;
		let mut metadata = metadata_from_article(summary, facts);

		// Wikidata seldom knows who wrote a home-computer game's music; the article's
		// infobox usually does
		if metadata.composers.is_none() {
			let names = platform.map_or(&[][..], |p| p.note_names);
			match self
				.infobox_names(&metadata.external_id, "composer", names)
				.await
			{
				Ok(composers) => {
					metadata.composers = (!composers.is_empty()).then_some(composers)
				},
				Err(e) if e.is_rate_limited() => return Err(e),
				Err(e) => tracing::warn!(
					article = metadata.external_id,
					error = %e,
					"Infobox lookup failed; leaving the composers out"
				),
			}
		}
		Ok((metadata, on_platform))
	}

	/// The names in one parameter of the article's infobox, for the machine `platform_names`
	/// describes (see [`infobox_names`]). Only the lead section is fetched: that is where
	/// the infobox is.
	async fn infobox_names(
		&self,
		article: &str,
		param: &str,
		platform_names: &[&str],
	) -> MetadataResult<Vec<String>> {
		if article.is_empty() {
			return Ok(vec![]);
		}
		let url = api_url(&[
			("action", "query"),
			("prop", "revisions"),
			("rvprop", "content"),
			("rvslots", "main"),
			("rvsection", "0"),
			("format", "json"),
			("formatversion", "2"),
			("titles", article),
		])?;
		let response = wikimedia::get(url).await?;
		if !response.status().is_success() {
			return Err(MetadataProviderError::Other(format!(
				"Wikipedia wikitext HTTP {}",
				response.status()
			)));
		}
		let body: WikitextResponse = response.json().await?;
		let wikitext = body
			.query
			.and_then(|q| q.pages.into_iter().next())
			.and_then(|p| p.revisions.into_iter().next())
			.and_then(|r| r.slots.main.content)
			.unwrap_or_default();
		Ok(infobox_names(&wikitext, param, platform_names))
	}

	/// Infobox / lead images live on the article, not in Category:Video game covers.
	///
	/// Three searches are tried in order of how well they pin down *this* game: the bare
	/// title, the title plus the machine it runs on, then the title plus "video game".
	/// They all run: a generic name like "Pirates" fills every slot of the bare search
	/// with the wrong subject (Piracy, Pittsburgh Pirates) without ever coming back empty,
	/// so a fallback that fires only on zero hits never fires when it is needed most.
	/// Adding the platform is what lifts "Sid Meier's Pirates!" to the top of the list.
	///
	/// With `require_image`, an article with no lead image is passed over for the next
	/// candidate, which is what a cover lookup wants and a details lookup does not.
	async fn find_game_article(
		&self,
		title: &str,
		platform: Option<CoverPlatform>,
		require_image: bool,
	) -> MetadataResult<Option<GameArticle>> {
		// A matching title that never mentions the machine is kept only as a fallback
		// while the search goes on for one that does. "Barbarian" is both a 2002 PS2 game
		// and, as "Barbarian: The Ultimate Warrior", the 1987 C64 one; only the second
		// article says Commodore 64.
		//
		// Only a title match settles the search. An article that merely ends with the title
		// is a fallback even when it names the machine, and a weaker one than a title
		// match: "Mega Turrican" mentions the Amiga where "Turrican" never does, and is
		// still the wrong game.
		let mut fallback: Option<GameArticle> = None;
		let is_settled = |article: &GameArticle| {
			article.title_matched && (platform.is_none() || article.names_platform)
		};
		let keep_better = |fallback: &mut Option<GameArticle>, article: GameArticle| {
			let rank = |a: &GameArticle| (a.title_matched, a.names_platform);
			if fallback.as_ref().is_none_or(|f| rank(&article) > rank(f)) {
				*fallback = Some(article);
			}
		};

		if let Some(article) = self
			.accept_article(title, title, platform, require_image, false)
			.await?
		{
			if is_settled(&article) {
				return Ok(Some(article));
			}
			keep_better(&mut fallback, article);
		}

		let mut queries = vec![title.to_string()];
		if let Some(p) = platform {
			queries.push(format!("{title} {}", p.search_term));
		}
		queries.push(format!("{title} video game"));

		// Each accepted candidate costs a summary request, and the same article turns up
		// in more than one search, so titles already tried are not tried again and the
		// whole lookup is capped -- this runs once per book in a library-wide job.
		let mut seen = vec![title.to_string()];
		for query in queries {
			for hit in self.search_articles(&query).await?.into_iter().take(5) {
				if seen.len() > MAX_ARTICLE_SUMMARY_FETCHES {
					return Ok(fallback);
				}
				if !could_be_same_game(title, &hit.title) {
					continue;
				}
				// Exact, not case-insensitive: the summary endpoint is case-sensitive, so
				// `DUKE NUKEM 3D` having no page says nothing about `Duke Nukem 3D`
				if seen.iter().any(|t: &String| t == &hit.title) {
					continue;
				}
				seen.push(hit.title.clone());

				if let Some(article) = self
					.accept_article(title, &hit.title, platform, require_image, false)
					.await?
				{
					if is_settled(&article) {
						return Ok(Some(article));
					}
					keep_better(&mut fallback, article);
				}
			}
		}

		Ok(fallback)
	}

	/// Every game article that `title` itself, or a search for it, turns up, up to `max`,
	/// in the order found. Unlike [`Self::find_game_article`] no hit is filtered by title
	/// before its summary is fetched, so the fetches are capped instead.
	async fn find_game_articles(
		&self,
		title: &str,
		platform: Option<CoverPlatform>,
		max: usize,
	) -> MetadataResult<Vec<GameArticle>> {
		let mut queries = vec![title.to_string()];
		if let Some(p) = platform {
			queries.push(format!("{title} {}", p.search_term));
		}
		queries.push(format!("{title} video game"));
		let mut queries = queries.into_iter();

		let mut found: Vec<GameArticle> = Vec::new();
		let mut tried: Vec<String> = Vec::new();
		// The title as an article name comes first, then each search's hits in turn
		let mut names = vec![title.to_string()];

		while found.len() < max && tried.len() < MAX_INTERACTIVE_SUMMARY_FETCHES {
			let Some(name) = names.pop() else {
				let Some(query) = queries.next() else {
					break;
				};
				let hits = self.search_articles(&query).await?;
				// Taken from the back, so reversed to keep Wikipedia's ranking
				names.extend(hits.into_iter().take(5).map(|h| h.title).rev());
				continue;
			};
			// Exact, for the same reason as in `find_game_article`
			if tried.iter().any(|t| t == &name) {
				continue;
			}
			tried.push(name.clone());

			let Some(article) = self
				.accept_article(title, &name, platform, false, true)
				.await?
			else {
				continue;
			};
			// A redirect and its target are the same article
			let canonical = article.summary.title.clone();
			if found.iter().any(|f| f.summary.title == canonical) {
				continue;
			}
			if let Some(canonical) = canonical {
				tried.push(canonical);
			}
			found.push(article);
		}

		Ok(found)
	}

	/// Fetch `article` and decide whether it is the game called `title`.
	///
	/// With `loose`, any game article is accepted, at [`LOOSE_MATCH_CONFIDENCE`] when its
	/// title does not match.
	async fn accept_article(
		&self,
		title: &str,
		article: &str,
		platform: Option<CoverPlatform>,
		require_image: bool,
		loose: bool,
	) -> MetadataResult<Option<GameArticle>> {
		let Some(summary) = self.fetch_page_summary(article).await? else {
			return Ok(None);
		};
		if !is_video_game_page(&summary, platform) {
			return Ok(None);
		}
		let article = summary.title.as_deref().unwrap_or(article);

		// A title that matches outright stands on its own. A title the article merely ends
		// with -- the disk is "Pirates", the game is "Sid Meier's Pirates!" -- is only
		// trusted when the page also names the machine we are looking for. That second
		// signal is what separates the 1987 Commodore 64 original, whose article says so,
		// from the 2004 remake of the same name, whose article does not.
		let names_platform = summary_mentions_platform(&summary, platform);
		let title_matched = titles_similar(title, article);
		let confidence = if title_matched {
			if platform.is_none() || names_platform {
				TITLE_MATCH_CONFIDENCE
			} else {
				UNCONFIRMED_MATCH_CONFIDENCE
			}
		} else if article_ends_with_title(article, title)
			&& names_platform
			// "Conan the Barbarian" ends with "Barbarian" and names the C64 too; being
			// a game by its own description is what the character's page cannot claim
			&& description_names_a_game(&summary)
		{
			UNCONFIRMED_MATCH_CONFIDENCE
		} else if loose && description_names_a_game(&summary) {
			LOOSE_MATCH_CONFIDENCE
		} else {
			return Ok(None);
		};
		if require_image && cover_url_from_summary(&summary).is_none() {
			return Ok(None);
		}
		Ok(Some(GameArticle {
			summary,
			confidence,
			names_platform,
			title_matched,
		}))
	}

	async fn fetch_page_summary(
		&self,
		title: &str,
	) -> MetadataResult<Option<PageSummary>> {
		let url = summary_url(title)?;
		// A 429 never reaches here: `wikimedia::get` turns it into an error
		let response = wikimedia::get(url).await?;

		let status = response.status();
		// Wikipedia rejects titles it considers malformed with 400/403 rather than 404
		// (e.g. a stem that still carries a `[Sir 13]` release tag). None of those mean
		// "retry" -- they mean this candidate simply has no page.
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
		let response = wikimedia::get(url).await?;

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
		let response = wikimedia::get(url).await?;

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
		let response = wikimedia::get(url).await?;

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
	if describes_more_than_one_game(summary) {
		return false;
	}

	let haystack = format!(
		"{} {}",
		summary.description.as_deref().unwrap_or(""),
		summary.extract.as_deref().unwrap_or("")
	)
	.to_lowercase();

	// Naming the machine is only half the proof: Aladdin4D is 3D software "running on
	// AmigaOS", not a game. The page has to call itself a game somewhere as well.
	if summary_mentions_platform(summary, platform) && haystack.contains("game") {
		return true;
	}

	GAME_GENRE_PHRASES
		.iter()
		.any(|phrase| haystack.contains(phrase))
}

/// Whether the article is about a series, a franchise or a character rather than one game.
/// Their prose is full of "video game" and names every machine, but their Wikipedia short
/// description gives them away: "Video game franchise" for Duke Nukem, "Video game
/// series" for Wolfenstein and Gobliiins, "Video game character" -- where a game's reads
/// "1996 first-person shooter video game".
fn describes_more_than_one_game(summary: &PageSummary) -> bool {
	let description = summary
		.description
		.as_deref()
		.unwrap_or("")
		.trim()
		.to_lowercase();
	let is_list = summary
		.title
		.as_deref()
		.is_some_and(|t| t.to_lowercase().starts_with("list of"));
	is_list
		|| ["series", "franchise", "character"]
			.iter()
			.any(|word| description.ends_with(word))
}

/// Whether the article's short description says it is one game: "1986 video game",
/// "Platform game". A title match can stand without it, but a loosely related article in an
/// interactive search cannot -- the search for "Gobliins 2", which has no article of its
/// own, otherwise offers its composer and ScummVM, whose prose is all about games.
fn description_names_a_game(summary: &PageSummary) -> bool {
	summary
		.description
		.as_deref()
		.is_some_and(|d| d.trim().to_lowercase().ends_with("game"))
}

fn cover_url_from_summary(summary: &PageSummary) -> Option<String> {
	summary
		.originalimage
		.as_ref()
		.or(summary.thumbnail.as_ref())
		.and_then(|img| img.source.clone())
		.filter(|u| !u.is_empty())
}

/// How sure a match is when the article's title is the game's title and, when the machine
/// is known, the article names it. Enough to apply without review.
const TITLE_MATCH_CONFIDENCE: f32 = 0.9;
/// How sure a match is when one of those signals is missing: the title matches but the
/// article never mentions the machine, or the article only ends with the title (a dropped
/// publisher prefix, `Sid Meier's Pirates!` for `Pirates`) and does. Usually right, but
/// "Revenge" ends "Montezuma's Revenge" as well, so it waits for a person to accept it.
const UNCONFIRMED_MATCH_CONFIDENCE: f32 = 0.7;

/// How sure a match is when a person searched and the article is a game whose title is
/// nothing like the search: offered, never applied on its own.
const LOOSE_MATCH_CONFIDENCE: f32 = 0.4;

/// The most candidates an interactive search offers.
const MAX_INTERACTIVE_CANDIDATES: usize = 5;

/// The most article summaries an interactive search requests. A person is waiting on one
/// game rather than a job working through a library, so this is looser than
/// [`MAX_ARTICLE_SUMMARY_FETCHES`].
const MAX_INTERACTIVE_SUMMARY_FETCHES: usize = 12;

/// An article accepted as being about the game asked for.
struct GameArticle {
	summary: PageSummary,
	confidence: f32,
	/// Whether the article mentions the machine the game file is for
	names_platform: bool,
	/// Whether the article's title is the game's, rather than merely ending with it
	title_matched: bool,
}

fn metadata_from_article(
	summary: PageSummary,
	facts: GameFacts,
) -> ExternalMediaMetadata {
	let article = summary.title.clone().unwrap_or_default();
	let non_empty = |v: Vec<String>| (!v.is_empty()).then_some(v);

	ExternalMediaMetadata {
		provider: "wikipedia".to_string(),
		title: Some(strip_title_qualifier(&article).to_string()),
		summary: summary.extract.clone().filter(|e| !e.trim().is_empty()),
		year: facts.released.map(|d| d.year),
		month: facts.released.and_then(|d| d.month),
		day: facts.released.and_then(|d| d.day),
		genres: non_empty(facts.genres),
		publisher: non_empty(facts.publishers).map(|p| p.join(", ")),
		developers: non_empty(facts.developers),
		platforms: non_empty(facts.platforms),
		composers: non_empty(facts.composers),
		cover_url: cover_url_from_summary(&summary),
		provider_url: summary
			.content_urls
			.and_then(|u| u.desktop)
			.and_then(|d| d.page),
		external_id: article,
		..Default::default()
	}
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

/// Whether `article` names a different game in a series than the one asked for, e.g.
/// "Shadow of the Beast II" for a disk called "Shadow of the Beast", or "Duke Nukem" for
/// "Duke Nukem 3D".
///
/// This has to be checked before anything else, because the one title *contains* the
/// other's and so sails through both the substring shortcut and the edit-distance score
/// -- and its box art is a different game's box art.
///
/// It works both ways: a disk called "Barbarian 2" is not the article "Barbarian" either,
/// however close the two names are.
fn introduces_sequel(query: &str, article: &str) -> bool {
	title_numbers(query) != title_numbers(strip_title_qualifier(article))
}

/// The numbers in a title that tell one game from another: entry numbers (`2` and `II`
/// compare equal), and numbers inside words, split at the letter/digit boundary (the `3`
/// of `3D`, the `64` of `C64`).
///
/// A `1` does not count -- a first game is seldom called "1", and a stem like `barbarian1`
/// is still Barbarian. Neither does a year, which disambiguates rather than numbers, and a
/// bare `v` or `x` is as likely to be a letter as a numeral.
fn title_numbers(s: &str) -> Vec<u32> {
	let mut numbers: Vec<u32> = title_words(s)
		.iter()
		.flat_map(|word| split_letters_and_digits(word))
		.filter_map(|part| match part.as_str() {
			"ii" => Some(2),
			"iii" => Some(3),
			"iv" => Some(4),
			"vi" => Some(6),
			"vii" => Some(7),
			"viii" => Some(8),
			"ix" => Some(9),
			_ => part
				.parse::<u32>()
				.ok()
				.filter(|n| *n != 1 && !(1900..=2099).contains(n)),
		})
		.collect();
	numbers.sort_unstable();
	numbers.dedup();
	numbers
}

/// `3d` -> `3`, `d`; `c64` -> `c`, `64`; a word without digits comes back whole.
fn split_letters_and_digits(word: &str) -> Vec<String> {
	let mut parts: Vec<String> = Vec::new();
	for c in word.chars() {
		let same_kind = parts
			.last()
			.and_then(|last| last.chars().last())
			.is_some_and(|l| l.is_ascii_digit() == c.is_ascii_digit());
		match parts.last_mut() {
			Some(last) if same_kind => last.push(c),
			_ => parts.push(c.to_string()),
		}
	}
	parts
}

fn titles_similar(query: &str, article: &str) -> bool {
	if introduces_sequel(query, article) {
		return false;
	}
	titles_similar_exact(query, article)
		|| titles_similar_exact(query, strip_title_qualifier(article))
}

/// The longest tail a file name may add to a game's title and still be that game: a release
/// group's tag such as `TCF` or `FLT`, not a word of a title.
const MAX_TAG_LEN: usize = 4;

fn titles_similar_exact(query: &str, article: &str) -> bool {
	let q = normalize_title(query);
	let a = normalize_title(article);
	if q.len() < 2 || a.len() < 2 {
		return false;
	}
	if a == q {
		return true;
	}
	// An article running on past the query (`Zak McKracken` and the full title) is the
	// same game; one that merely *ends* with it is the dropped-prefix case, which needs the
	// machine confirmed first -- "Conan the Barbarian" is not "Barbarian". A query running
	// on past the article by a few letters carries a release tag (`Zamzara TCF`); by a
	// word, it names another game -- "Elite Frontier" is not Elite.
	if q.len() >= 8
		&& (a.starts_with(&q) || (q.starts_with(&a) && q.len() - a.len() <= MAX_TAG_LEN))
	{
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

/// Download a cover image, at the same shared pace as every other Wikimedia request.
pub async fn download_cover_bytes(url: &str) -> MetadataResult<Vec<u8>> {
	let url = reqwest::Url::parse(url)
		.map_err(|e| MetadataProviderError::Other(format!("Invalid cover URL: {e}")))?;
	let response = wikimedia::get(url).await?;

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
		// ASCII lowercasing keeps every byte where it was, so the index found is an index
		// into `s`; full lowercasing can change a character's length (`İ` grows a byte) and
		// would truncate mid-character, which panics
		if let Some(idx) = s.to_ascii_lowercase().find(suffix) {
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
	/// The Wikidata items for the machine, as a statement's "platform" qualifier names it.
	/// A developer or publisher qualified with some other machine made a port, not this game.
	pub wikidata_items: &'static [&'static str],
	/// How an infobox notes which version a name is for: `Chris Grigg (C64)`. A one-word
	/// name has to match a whole word of the note.
	pub note_names: &'static [&'static str],
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
			note_names: &["c64", "commodore 64"],
			wikidata_items: &["Q99775"],
		}
	} else if p == "spectrum" || p.contains("zx") || p.contains("sinclair") {
		CoverPlatform {
			category: "ZX Spectrum game covers",
			search_term: "ZX Spectrum",
			aliases: &["zx spectrum", "sinclair spectrum"],
			note_names: &["spectrum", "zx"],
			wikidata_items: &["Q23882"],
		}
	} else if p.contains("amiga") {
		CoverPlatform {
			category: "Amiga game covers",
			search_term: "Amiga",
			aliases: &["amiga"],
			note_names: &["amiga"],
			wikidata_items: &["Q100047"],
		}
	} else if p == "dos" || p == "pc" || p.contains("msdos") || p.contains("ms-dos") {
		CoverPlatform {
			category: "MS-DOS game covers",
			search_term: "MS-DOS",
			aliases: &["ms-dos", "msdos"],
			note_names: &["dos", "ms-dos", "msdos"],
			wikidata_items: &["Q47604", "Q170434"],
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
		"Wikipedia (video games)"
	}

	fn supported_media_types(&self) -> Vec<MediaType> {
		vec![MediaType::Retro]
	}

	async fn search_series(&self, query: &SearchQuery) -> MetadataResult<SearchOutcome> {
		self.search_media(query).await
	}

	async fn search_media(&self, query: &SearchQuery) -> MetadataResult<SearchOutcome> {
		let platform = query.provider_hints.get("platform").map(String::as_str);
		let found = if query.interactive {
			self.lookup_games(&query.title, platform, MAX_INTERACTIVE_CANDIDATES)
				.await?
		} else {
			self.lookup_game(&query.title, platform)
				.await?
				.into_iter()
				.collect()
		};
		let candidates = found
			.into_iter()
			.map(|(metadata, confidence)| MatchCandidate {
				provider: self.id().to_string(),
				external_id: metadata.external_id.clone(),
				metadata: ExternalMetadata::Media(metadata),
				confidence,
				confidence_factors: vec![],
			})
			.collect();

		Ok(SearchOutcome {
			requested: 1,
			candidates,
		})
	}

	async fn fetch_series_metadata(
		&self,
		external_id: &str,
	) -> MetadataResult<ExternalSeriesMetadata> {
		Err(MetadataProviderError::NotFound(external_id.to_string()))
	}

	/// `external_id` is the article title a search matched. The machine is not known here, so
	/// a port's developer, publisher or composer is not filtered out as it is in a search;
	/// [`Self::fetch_media_metadata_with_hints`] does that.
	async fn fetch_media_metadata(
		&self,
		external_id: &str,
	) -> MetadataResult<ExternalMediaMetadata> {
		self.article_metadata(external_id, None).await
	}

	async fn fetch_media_metadata_with_hints(
		&self,
		external_id: &str,
		query: &SearchQuery,
	) -> MetadataResult<ExternalMediaMetadata> {
		let platform = query.provider_hints.get("platform").map(String::as_str);
		self.article_metadata(external_id, resolve_cover_platform(platform))
			.await
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

#[derive(Debug, Default, Deserialize)]
struct PageSummary {
	#[serde(rename = "type")]
	page_type: Option<String>,
	title: Option<String>,
	description: Option<String>,
	extract: Option<String>,
	thumbnail: Option<SummaryImage>,
	originalimage: Option<SummaryImage>,
	/// The Wikidata item the article describes, e.g. `Q1665169`
	wikibase_item: Option<String>,
	content_urls: Option<ContentUrls>,
}

#[derive(Debug, Deserialize)]
struct ContentUrls {
	desktop: Option<ContentUrl>,
}

#[derive(Debug, Deserialize)]
struct ContentUrl {
	page: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SummaryImage {
	source: Option<String>,
}

#[derive(Debug, Deserialize)]
struct WikitextResponse {
	query: Option<WikitextQuery>,
}

#[derive(Debug, Deserialize)]
struct WikitextQuery {
	#[serde(default)]
	pages: Vec<WikitextPage>,
}

#[derive(Debug, Deserialize)]
struct WikitextPage {
	#[serde(default)]
	revisions: Vec<WikitextRevision>,
}

#[derive(Debug, Deserialize)]
struct WikitextRevision {
	slots: WikitextSlots,
}

#[derive(Debug, Deserialize)]
struct WikitextSlots {
	main: WikitextSlot,
}

#[derive(Debug, Deserialize)]
struct WikitextSlot {
	content: Option<String>,
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
		// A character that grows when lowercased must not shift where the cut lands
		assert_eq!(
			sanitize_game_title("\u{130}stanbul Side A"),
			"\u{130}stanbul"
		);
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

		// And the other way round: the disk is the sequel, the article the original
		assert!(!titles_similar(
			"Barbarian 2",
			"Barbarian (2002 video game)"
		));
		assert!(!titles_similar("Gobliins 2", "Gobliiins"));
		assert!(titles_similar(
			"Gobliins 2",
			"Gobliins 2: The Prince Buffoon"
		));

		// A numeral and a digit are the same entry
		assert!(!introduces_sequel(
			"Barbarian 2",
			"Barbarian II: The Dungeon of Drax"
		));
		assert!(introduces_sequel("Barbarian 2", "Barbarian III"));

		// A number inside a word tells two games apart just the same
		assert!(!titles_similar("DUKE NUKEM 3D", "Duke Nukem (video game)"));
		assert!(!titles_similar("Wolfenstein 3D", "Wolfenstein"));
		assert!(titles_similar("DUKE NUKEM 3D", "Duke Nukem 3D"));

		// A first entry is seldom numbered, and a year is not an entry number
		assert!(!introduces_sequel("barbarian1 TTF", "Barbarian"));
		assert!(!introduces_sequel("Turrican 1990", "Turrican"));
	}

	#[test]
	fn a_loose_match_has_to_describe_itself_as_a_game() {
		let described = |d: &str| PageSummary {
			description: Some(d.into()),
			..Default::default()
		};
		assert!(description_names_a_game(&described(
			"1996 first-person shooter video game"
		)));
		assert!(description_names_a_game(&described("Platform game")));
		assert!(!description_names_a_game(&described("American composer")));
		assert!(!description_names_a_game(&described(
			"Game engine recreation software"
		)));
		assert!(!description_names_a_game(&PageSummary::default()));
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
			..Default::default()
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
			..Default::default()
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
		// Running on is the same game, ending with it is not
		assert!(titles_similar(
			"Zak McKracken",
			"Zak McKracken and the Alien Mindbenders"
		));
		assert!(!titles_similar("Barbarian", "Conan the Barbarian"));
		// A release tag on the file name is still the game; a further word is another one
		assert!(titles_similar("Zamzara TCF", "Zamzara"));
		assert!(!titles_similar("Elite Frontier", "Elite (video game)"));
		assert!(titles_similar("Last Ninja", "The Last Ninja"));
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
				..Default::default()
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
				..Default::default()
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
			..Default::default()
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
			..Default::default()
		};
		assert!(!is_video_game_page(
			&piracy,
			resolve_cover_platform(Some("c64"))
		));

		// Software for the right machine is still not a game
		let aladdin4d = PageSummary {
			page_type: Some("standard".into()),
			title: Some("Aladdin4D".into()),
			description: Some("3D computer graphics software".into()),
			extract: Some(
				"Aladdin4D is a computer program for modeling and rendering three-dimensional 				 graphics and animations, currently running on AmigaOS."
					.into(),
			),
			..Default::default()
		};
		assert!(!is_video_game_page(
			&aladdin4d,
			resolve_cover_platform(Some("amiga"))
		));

		// A list of games is not a game either
		let list = PageSummary {
			page_type: Some("standard".into()),
			title: Some("List of 3D Realms games".into()),
			description: Some("Video games by developer/publisher".into()),
			extract: Some("3D Realms is an American video game publisher.".into()),
			..Default::default()
		};
		assert!(!is_video_game_page(&list, None));

		// A franchise, series or character page talks about games all the time
		for description in [
			"Video game franchise",
			"Puzzle adventure video game series",
			"Video game character",
		] {
			let page = PageSummary {
				page_type: Some("standard".into()),
				title: Some("Duke Nukem".into()),
				description: Some(description.into()),
				extract: Some("Duke Nukem is a video game series for MS-DOS.".into()),
				..Default::default()
			};
			assert!(
				!is_video_game_page(&page, resolve_cover_platform(Some("dos"))),
				"{description}"
			);
		}
		assert!(is_video_game_page(
			&PageSummary {
				page_type: Some("standard".into()),
				title: Some("Duke Nukem 3D".into()),
				description: Some("1996 first-person shooter video game".into()),
				..Default::default()
			},
			None
		));
	}
}
