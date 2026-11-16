//! Text normalization and chunking, ported from Supertonic's reference helpers
//! (`preprocess_text` and `chunk_text` in `rust/src/helper.rs`).
//!
//! Supertonic reads characters directly (no phonemizer): text is NFKD-normalized, so
//! accented letters become a base letter plus a combining mark, wrapped in a language
//! tag such as `<hu>…</hu>`, and each character is mapped through the model's
//! `unicode_indexer.json`.

use unicode_normalization::UnicodeNormalization;

/// Longest chunk sent to the model at once; longer text is split and joined with a
/// short pause. Matches the reference implementation.
const MAX_CHUNK_CHARS: usize = 300;
/// Korean and Japanese pack more speech into each character.
const MAX_CHUNK_CHARS_CJK: usize = 120;

pub(crate) fn max_chunk_chars(lang: &str) -> usize {
	if lang == "ko" || lang == "ja" {
		MAX_CHUNK_CHARS_CJK
	} else {
		MAX_CHUNK_CHARS
	}
}

fn is_emoji(c: char) -> bool {
	matches!(
		c as u32,
		0x1F600..=0x1F64F
			| 0x1F300..=0x1F5FF
			| 0x1F680..=0x1F6FF
			| 0x1F700..=0x1F77F
			| 0x1F780..=0x1F7FF
			| 0x1F800..=0x1F8FF
			| 0x1F900..=0x1F9FF
			| 0x1FA00..=0x1FA6F
			| 0x1FA70..=0x1FAFF
			| 0x2600..=0x26FF
			| 0x2700..=0x27BF
			| 0x1F1E6..=0x1F1FF
	)
}

/// Single-character replacements. Applied before NFKD, which would otherwise turn
/// `´` into a space plus a combining accent.
fn replace_char(c: char) -> Option<char> {
	Some(match c {
		'–' | '‑' | '—' => '-',
		'_' | '[' | ']' | '|' | '/' | '#' | '→' | '←' => ' ',
		// „ and ‟ are not in the model's character table; Hungarian and German use „…”.
		'\u{201C}' | '\u{201D}' | '\u{201E}' | '\u{201F}' => '"',
		'\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' | '´' | '`' => '\'',
		'♥' | '☆' | '♡' | '©' | '\\' => return None,
		c if is_emoji(c) => return None,
		c => c,
	})
}

fn ends_with_punctuation(text: &str) -> bool {
	text.chars().next_back().is_some_and(|c| {
		matches!(
			c,
			'.' | '!'
				| '?' | ';' | ':'
				| ',' | '\'' | '"'
				| '\u{201C}' | '\u{201D}'
				| '\u{2018}' | '\u{2019}'
				| ')' | ']' | '}'
				| '…' | '。' | '」'
				| '』' | '】'
				| '〉' | '》'
				| '›' | '»'
		)
	})
}

/// Normalizes `text` the way Supertonic was trained and wraps it in `<lang>` tags.
pub(crate) fn preprocess(text: &str, lang: &str) -> String {
	let mut text: String = text.chars().filter_map(replace_char).collect();
	text = text.nfkd().collect();

	if lang == "en" {
		for (from, to) in [
			("@", " at "),
			("e.g.,", "for example, "),
			("i.e.,", "that is, "),
		] {
			text = text.replace(from, to);
		}
	}

	// Collapse whitespace, then drop spaces before punctuation and repeated quotes.
	let mut out = String::with_capacity(text.len() + lang.len() * 2 + 6);
	for word in text.split_whitespace() {
		if !out.is_empty() {
			out.push(' ');
		}
		out.push_str(word);
	}
	let mut cleaned = String::with_capacity(out.len());
	let mut chars = out.chars().peekable();
	while let Some(c) = chars.next() {
		if c == ' '
			&& matches!(chars.peek(), Some(',' | '.' | '!' | '?' | ';' | ':' | '\''))
		{
			continue;
		}
		if (c == '"' || c == '\'') && cleaned.ends_with(c) {
			continue;
		}
		cleaned.push(c);
	}

	if !cleaned.is_empty() && !ends_with_punctuation(&cleaned) {
		cleaned.push('.');
	}

	format!("<{lang}>{cleaned}</{lang}>")
}

/// Splits `text` into chunks of at most `max_chars` characters, preferring sentence
/// ends, then commas and semicolons, then spaces.
pub(crate) fn chunk(text: &str, max_chars: usize) -> Vec<String> {
	let mut chunks = Vec::new();
	let mut rest = text.trim();
	while rest.chars().count() > max_chars {
		let window_end = rest
			.char_indices()
			.nth(max_chars)
			.map_or(rest.len(), |(index, _)| index);
		let window = &rest[..window_end];
		// Split after the last suitable separator in the window, but not so early that
		// the chunk becomes tiny. A byte index on a character boundary.
		let min_split = window
			.char_indices()
			.nth(max_chars / 3)
			.map_or(0, |(index, _)| index);
		let split_after = |separators: &[char]| {
			window
				.char_indices()
				.filter(|(index, c)| {
					*index >= min_split
						&& separators.contains(c)
						&& rest[index + c.len_utf8()..].starts_with(char::is_whitespace)
				})
				.map(|(index, c)| index + c.len_utf8())
				.next_back()
		};
		let split = split_after(&['.', '!', '?', '…'])
			.or_else(|| split_after(&[',', ';', ':']))
			.or_else(|| {
				window[min_split..]
					.rfind(char::is_whitespace)
					.map(|index| index + min_split)
			})
			.unwrap_or(window_end);
		let (head, tail) = rest.split_at(split);
		if !head.trim().is_empty() {
			chunks.push(head.trim().to_string());
		}
		rest = tail.trim_start();
	}
	if !rest.is_empty() {
		chunks.push(rest.to_string());
	}
	chunks
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn wraps_in_language_tags_and_adds_period() {
		assert_eq!(preprocess("Hello  world", "en"), "<en>Hello world.</en>");
		assert_eq!(preprocess("Szia!", "hu"), "<hu>Szia!</hu>");
	}

	#[test]
	fn decomposes_accents() {
		assert_eq!(preprocess("á", "hu"), "<hu>a\u{301}.</hu>");
	}

	#[test]
	fn normalizes_quotes_and_dashes() {
		assert_eq!(
			preprocess("„Igen” — mondta.", "hu"),
			"<hu>\"Igen\" - mondta.</hu>"
		);
		assert_eq!(preprocess("It´s ok", "en"), "<en>It's ok.</en>");
	}

	#[test]
	fn removes_space_before_punctuation_and_duplicate_quotes() {
		assert_eq!(preprocess("Wait , what ?", "en"), "<en>Wait, what?</en>");
		assert_eq!(preprocess("\"\"Hi\"\"", "en"), "<en>\"Hi\"</en>");
	}

	#[test]
	fn expands_english_expressions_only_for_english() {
		assert_eq!(preprocess("me@home", "en"), "<en>me at home.</en>");
		assert_eq!(preprocess("me@home", "hu"), "<hu>me@home.</hu>");
	}

	#[test]
	fn keeps_short_text_whole() {
		assert_eq!(chunk("  One. Two.  ", 300), vec!["One. Two."]);
	}

	#[test]
	fn splits_long_text_at_sentences() {
		let text = "First sentence here. Second sentence here. Third one.";
		assert_eq!(
			chunk(text, 30),
			vec![
				"First sentence here.",
				"Second sentence here.",
				"Third one."
			]
		);
	}

	#[test]
	fn splits_at_commas_then_spaces() {
		assert_eq!(
			chunk("alpha beta gamma, delta epsilon zeta", 20),
			vec!["alpha beta gamma,", "delta epsilon zeta"]
		);
		assert_eq!(
			chunk("aaaa bbbb cccc dddd eeee", 10),
			vec!["aaaa bbbb", "cccc dddd", "eeee"]
		);
	}

	#[test]
	fn chunks_by_characters_not_bytes() {
		let text = "árvíztűrő tükörfúrógép árvíztűrő";
		for part in chunk(text, 12) {
			assert!(part.chars().count() <= 12, "{part}");
		}
	}
}
