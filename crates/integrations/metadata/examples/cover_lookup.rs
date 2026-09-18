//! Manual probe: resolve a cover URL for a game title on a given platform.
//!
//! `cargo run -p metadata_integrations --example cover_lookup -- "Pirates" c64`
use metadata_integrations::lookup_wikipedia_game_cover;

#[tokio::main]
async fn main() {
	let mut args = std::env::args().skip(1);
	let title = args.next().expect("usage: cover_lookup <title> [platform]");
	let platform = args.next();

	match lookup_wikipedia_game_cover(&title, platform.as_deref()).await {
		Ok(Some(url)) => println!("FOUND {title:?} [{platform:?}]\n  {url}"),
		Ok(None) => println!("NONE  {title:?} [{platform:?}]"),
		Err(e) => println!("ERROR {title:?} [{platform:?}]: {e}"),
	}
}
