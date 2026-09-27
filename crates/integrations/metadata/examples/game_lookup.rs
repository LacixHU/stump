//! Manual probe: look a game up the way a metadata fetch does and print what it finds.
//!
//! `cargo run -p metadata_integrations --example game_lookup -- "Uridium" c64`
use metadata_integrations::{create_provider, ExternalMetadata, SearchQuery};

#[tokio::main]
async fn main() {
	let args: Vec<String> = std::env::args().skip(1).collect();
	// `--all` searches the way the Fetch game info dialog does and lists every candidate
	let interactive = args.iter().any(|a| a == "--all");
	let mut args = args.into_iter().filter(|a| a != "--all");
	let title = args
		.next()
		.expect("usage: game_lookup [--all] <title> [platform]");
	let platform = args.next();

	let provider = create_provider("WIKIPEDIA", String::new()).expect("provider");
	let mut query = SearchQuery {
		title: title.clone(),
		interactive,
		..Default::default()
	};
	if let Some(platform) = &platform {
		query
			.provider_hints
			.insert("platform".to_string(), platform.clone());
	}

	let outcome = match provider.search_media(&query).await {
		Ok(outcome) => outcome,
		Err(e) => return println!("ERROR {title:?} [{platform:?}]: {e}"),
	};
	if interactive {
		for c in &outcome.candidates {
			if let ExternalMetadata::Media(m) = &c.metadata {
				println!(
					"{:.1}  {:?} {:?} {:?}",
					c.confidence, m.title, m.year, m.platforms
				);
			}
		}
		return;
	}
	let Some(candidate) = outcome.candidates.first() else {
		return println!("NONE  {title:?} [{platform:?}]");
	};
	let ExternalMetadata::Media(m) = &candidate.metadata else {
		return println!("UNEXPECTED series candidate for {title:?}");
	};

	println!(
		"FOUND {title:?} [{platform:?}] confidence {}",
		candidate.confidence
	);
	println!("  title      {:?}", m.title);
	println!("  released   {:?}-{:?}-{:?}", m.year, m.month, m.day);
	println!("  developers {:?}", m.developers);
	println!("  publisher  {:?}", m.publisher);
	println!("  platforms  {:?}", m.platforms);
	println!("  genres     {:?}", m.genres);
	println!("  cover      {:?}", m.cover_url);
	println!("  url        {:?}", m.provider_url);
	println!(
		"  summary    {:?}",
		m.summary
			.as_deref()
			.map(|s| s.chars().take(120).collect::<String>())
	);
}
