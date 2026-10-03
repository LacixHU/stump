//! Reading a field out of a Wikipedia article's infobox wikitext.
//!
//! Wikidata is the structured source and is asked first. Its coverage of who wrote a game's
//! music is thin for home-computer titles, though, where the article's infobox usually has
//! it -- `| composer = Matthew Alan Kane <br /> Chris Grigg (C64)`. Infobox values are
//! free-form wikitext, so this reads just enough of it: links, list templates, line breaks,
//! and the per-machine notes that say which version a name belongs to.

/// The names in an infobox parameter, for the machine `platform_names` describes.
///
/// A name may carry a note saying which version it is for: `Chris Grigg (C64)`, a `C64:`
/// prefix, or a bold `'''NES'''` heading over the names that follow. When some names are
/// noted for this machine, those are the answer. Otherwise names noted for another machine
/// are dropped and the unnoted ones -- usually the original version's -- are kept. With no
/// machine to go by, every name is returned.
pub fn infobox_names(
	wikitext: &str,
	param: &str,
	platform_names: &[&str],
) -> Vec<String> {
	let Some(value) = param_value(wikitext, param) else {
		return vec![];
	};

	let entries = entries(&plain_text(value));
	let is_ours = |note: &str| note_names_platform(note, platform_names);

	let mut names: Vec<String> = if platform_names.is_empty() {
		entries.into_iter().map(|e| e.name).collect()
	} else if entries
		.iter()
		.any(|e| e.note.as_deref().is_some_and(is_ours))
	{
		entries
			.into_iter()
			.filter(|e| e.note.as_deref().is_some_and(is_ours))
			.map(|e| e.name)
			.collect()
	} else {
		entries
			.into_iter()
			.filter(|e| e.note.is_none())
			.map(|e| e.name)
			.collect()
	};
	names.dedup();
	names
}

/// Whether a note such as `C64`, `MS-DOS version` or `ZX Spectrum` names one of
/// `platform_names`. A one-word name has to be a whole word of the note, so `dos` matches
/// `MS-DOS` but `pc` would never match `PC Engine` by accident.
fn note_names_platform(note: &str, platform_names: &[&str]) -> bool {
	let note = note.to_lowercase();
	let words: Vec<&str> = note
		.split(|c: char| !c.is_alphanumeric())
		.filter(|w| !w.is_empty())
		.collect();
	platform_names.iter().any(|name| {
		if name.contains(|c: char| !c.is_alphanumeric()) {
			note.contains(name)
		} else {
			words.contains(name)
		}
	})
}

/// The raw value of `| param = ...`, up to the next parameter or the end of the infobox.
fn param_value<'a>(wikitext: &'a str, param: &str) -> Option<&'a str> {
	let mut search_from = 0;
	let start = loop {
		let at = wikitext[search_from..].find('|')? + search_from;
		let rest = &wikitext[at + 1..];
		let trimmed = rest.trim_start_matches([' ', '\t']);
		if let Some(after) = trimmed.strip_prefix(param) {
			let after = after.trim_start_matches([' ', '\t']);
			if let Some(value) = after.strip_prefix('=') {
				break wikitext.len() - value.len();
			}
		}
		search_from = at + 1;
	};

	// The value runs until a `|` or `}}` that is not inside a link or template of its own.
	//
	// This walks bytes, never `&str` slices: `i + 2` can land inside a multi-byte
	// character ("François"), and slicing a string there panics -- which, in a scan's
	// metadata job, took the whole server down. Every marker is ASCII, and a UTF-8
	// continuation byte never equals an ASCII one, so the indices this stops at are
	// always character boundaries.
	let bytes = wikitext.as_bytes();
	let (mut braces, mut brackets) = (0usize, 0usize);
	let mut i = start;
	while i < bytes.len() {
		let pair = &bytes[i..bytes.len().min(i + 2)];
		match pair {
			b"{{" => {
				braces += 1;
				i += 2;
				continue;
			},
			b"}}" if braces == 0 => break,
			b"}}" => {
				braces -= 1;
				i += 2;
				continue;
			},
			b"[[" => {
				brackets += 1;
				i += 2;
				continue;
			},
			b"]]" => {
				brackets = brackets.saturating_sub(1);
				i += 2;
				continue;
			},
			_ => {},
		}
		if bytes[i] == b'|' && braces == 0 && brackets == 0 {
			break;
		}
		i += 1;
	}
	Some(wikitext[start..i].trim())
}

/// Wikitext reduced to its visible text, one name per line: comments and references gone,
/// links replaced by their labels, list templates and `<br>` turned into line breaks.
fn plain_text(value: &str) -> String {
	let mut text = remove_between(value, "<!--", "-->");
	text = remove_refs(&text);
	text = replace_links(&text);
	text = expand_templates(&text);
	for br in ["<br />", "<br/>", "<br>", "<BR>", "<BR />", "<BR/>"] {
		text = text.replace(br, "\n");
	}
	text
}

fn remove_between(text: &str, open: &str, close: &str) -> String {
	let mut out = String::with_capacity(text.len());
	let mut rest = text;
	while let Some(start) = rest.find(open) {
		out.push_str(&rest[..start]);
		match rest[start..].find(close) {
			Some(end) => rest = &rest[start + end + close.len()..],
			None => {
				rest = "";
			},
		}
	}
	out.push_str(rest);
	out
}

/// `<ref>...</ref>` and `<ref name="x" />` both go.
fn remove_refs(text: &str) -> String {
	let mut out = String::with_capacity(text.len());
	let mut rest = text;
	while let Some(start) = rest.find("<ref") {
		out.push_str(&rest[..start]);
		let tag_end = rest[start..].find('>').map(|i| start + i);
		match tag_end {
			Some(end) if rest[..end].ends_with('/') => rest = &rest[end + 1..],
			Some(end) => match rest[end..].find("</ref>") {
				Some(close) => rest = &rest[end + close + "</ref>".len()..],
				None => rest = "",
			},
			None => rest = "",
		}
	}
	out.push_str(rest);
	out
}

/// `[[David Wise (composer)|David Wise]]` -> `David Wise`; `[[Rob Hubbard]]` -> `Rob Hubbard`.
fn replace_links(text: &str) -> String {
	let mut out = String::with_capacity(text.len());
	let mut rest = text;
	while let Some(start) = rest.find("[[") {
		out.push_str(&rest[..start]);
		let Some(len) = rest[start + 2..].find("]]") else {
			out.push_str(&rest[start..]);
			return out;
		};
		let inner = &rest[start + 2..start + 2 + len];
		out.push_str(inner.rsplit('|').next().unwrap_or(inner));
		rest = &rest[start + 2 + len + 2..];
	}
	out.push_str(rest);
	out
}

/// Templates that only lay their items out as a list.
const LIST_TEMPLATES: &[&str] = &[
	"ubl",
	"unbulleted list",
	"plainlist",
	"plain list",
	"flatlist",
	"flat list",
	"hlist",
	"collapsible list",
];

/// Innermost first, each template is replaced by what it shows: a list template by its
/// items, one per line; a wrapper such as `{{nowrap|...}}` by its text; anything else
/// (footnotes, "citation needed") by nothing.
fn expand_templates(text: &str) -> String {
	let mut text = text.to_string();
	while let Some(close) = text.find("}}") {
		let Some(open) = text[..close].rfind("{{") else {
			text.replace_range(close..close + 2, "");
			continue;
		};
		let inner = &text[open + 2..close];
		let mut parts = inner.split('|');
		let name = parts.next().unwrap_or("").trim().to_lowercase();
		// Named arguments (`class=...`) are styling, never a name
		let args: Vec<&str> = parts.filter(|p| !is_named_arg(p)).collect();

		let shown = if LIST_TEMPLATES.contains(&name.as_str()) {
			args.join("\n")
		} else if args.len() == 1 && !matches!(name.as_str(), "efn" | "refn" | "sfn") {
			args[0].to_string()
		} else {
			String::new()
		};
		text.replace_range(open..close + 2, &shown);
	}
	text
}

fn is_named_arg(arg: &str) -> bool {
	arg.split_once('=').is_some_and(|(key, _)| {
		!key.trim().is_empty()
			&& key.trim().chars().all(|c| c.is_alphanumeric() || c == '_')
	})
}

#[derive(Debug, PartialEq)]
struct Entry {
	name: String,
	/// Which version the name is for, when the infobox says
	note: Option<String>,
}

/// One entry per name, each with the machine note that applies to it.
fn entries(text: &str) -> Vec<Entry> {
	let mut entries = Vec::new();
	// A bold heading (`'''NES'''`) or `NES:` line notes every name under it
	let mut heading: Option<String> = None;

	for line in text.split(['\n', ',', ';']) {
		let line = line.trim().trim_start_matches(['*', '#']).trim();
		if line.is_empty() {
			continue;
		}

		let is_bold = line.starts_with("'''") && line.ends_with("'''") && line.len() > 6;
		let unmarked = line.replace("'''", "").replace("''", "");
		let unmarked = unmarked.trim();
		if is_bold {
			heading = Some(unmarked.trim_end_matches(':').trim().to_string());
			continue;
		}
		if let Some(label) = unmarked.strip_suffix(':') {
			heading = Some(label.trim().to_string());
			continue;
		}

		// `C64: Rob Hubbard`
		let (prefix_note, rest) = match unmarked.split_once(':') {
			Some((note, name)) if note.len() <= 20 && !name.trim().is_empty() => {
				(Some(note.trim().to_string()), name.trim())
			},
			_ => (None, unmarked),
		};
		// `Chris Grigg (C64)`
		let (name, suffix_note) = match rest.rsplit_once('(') {
			Some((name, note)) if note.ends_with(')') && !name.trim().is_empty() => (
				name.trim(),
				Some(note.trim_end_matches(')').trim().to_string()),
			),
			_ => (rest, None),
		};

		// A long "name" is a sentence that slipped through, not a person
		if name.is_empty() || name.len() > 60 {
			continue;
		}
		entries.push(Entry {
			name: name.to_string(),
			note: suffix_note.or(prefix_note).or_else(|| heading.clone()),
		});
	}
	entries
}

#[cfg(test)]
mod tests {
	use super::*;

	const C64: &[&str] = &["c64", "commodore 64"];
	const DOS: &[&str] = &["ms-dos", "msdos", "dos"];

	fn infobox(composer: &str) -> String {
		format!(
			"{{{{Infobox video game\n| title = Game\n| composer = {composer}\n| platforms = [[Commodore 64]]\n}}}}\nThe game is..."
		)
	}

	#[test]
	fn a_plain_link_is_its_label() {
		assert_eq!(
			infobox_names(&infobox("[[Richard Joseph]]"), "composer", C64),
			vec!["Richard Joseph"]
		);
		assert_eq!(
			infobox_names(
				&infobox("[[David Wise (composer)|David Wise]]"),
				"composer",
				&[]
			),
			vec!["David Wise"]
		);
	}

	#[test]
	fn the_name_noted_for_this_machine_wins() {
		// Zak McKracken's infobox
		let zak = infobox("Matthew Alan Kane <br /> Chris Grigg (C64)");
		assert_eq!(infobox_names(&zak, "composer", C64), vec!["Chris Grigg"]);
		// The DOS original is the unnoted one
		assert_eq!(
			infobox_names(&zak, "composer", DOS),
			vec!["Matthew Alan Kane"]
		);
		// Not knowing the machine, both are offered
		assert_eq!(
			infobox_names(&zak, "composer", &[]),
			vec!["Matthew Alan Kane", "Chris Grigg"]
		);
	}

	#[test]
	fn a_bold_heading_notes_the_names_under_it() {
		// Sid Meier's Pirates!: the NES port had its own composer
		let pirates =
			infobox("{{ubl|Ken Lagace|'''NES'''|[[David Wise (composer)|David Wise]]}}");
		assert_eq!(infobox_names(&pirates, "composer", C64), vec!["Ken Lagace"]);
		assert_eq!(
			infobox_names(&pirates, "composer", &["nes"]),
			vec!["David Wise"]
		);
	}

	#[test]
	fn list_templates_bullets_and_commas_all_separate_names() {
		let plainlist = infobox("{{plainlist|\n* [[Rob Hubbard]]\n* [[Ben Daglish]]\n}}");
		assert_eq!(
			infobox_names(&plainlist, "composer", C64),
			vec!["Rob Hubbard", "Ben Daglish"]
		);
		assert_eq!(
			infobox_names(&infobox("Ben Daglish, Anthony Lees"), "composer", C64),
			vec!["Ben Daglish", "Anthony Lees"]
		);
	}

	#[test]
	fn references_comments_and_footnotes_are_not_names() {
		let noisy = infobox(
			"[[Rob Hubbard]]<ref name=\"zzap\" /><!-- C64 version -->{{efn|Uncredited}}<ref>{{cite web|url=x|title=y}}</ref>",
		);
		assert_eq!(infobox_names(&noisy, "composer", C64), vec!["Rob Hubbard"]);
	}

	#[test]
	fn a_prefix_note_works_like_a_suffix_one() {
		let prefixed = infobox("Arcade: Tamayo Kawamoto<br>C64: [[Rob Hubbard]]");
		assert_eq!(
			infobox_names(&prefixed, "composer", C64),
			vec!["Rob Hubbard"]
		);
	}

	#[test]
	fn a_short_machine_name_has_to_be_a_whole_word() {
		assert!(note_names_platform("MS-DOS version", DOS));
		assert!(note_names_platform("C64", C64));
		assert!(note_names_platform("Commodore 64", C64));
		// A whole word, not a fragment of one
		assert!(note_names_platform("PC version", &["pc"]));
		assert!(!note_names_platform("PCE", &["pc"]));
		assert!(!note_names_platform("Amstrad CPC", C64));
	}

	#[test]
	fn names_outside_ascii_are_read_whole() {
		// The scan that crashed the server: an ASCII letter right before a two-byte `ç`
		// put the end of the two-character lookahead inside the `ç`
		assert_eq!(
			infobox_names(
				&infobox("Fran\u{e7}ois Lemaire<br>J\u{f6}rg Sch\u{fc}tz"),
				"composer",
				&[]
			),
			vec!["Fran\u{e7}ois Lemaire", "J\u{f6}rg Sch\u{fc}tz"]
		);
		// At every offset, so no other layout can land the lookahead mid-character
		for prefix in 0..4 {
			let name = format!("{}\u{e7}\u{e7}\u{e7} \u{1f3b5}", "a".repeat(prefix));
			assert_eq!(infobox_names(&infobox(&name), "composer", &[]), vec![name]);
		}
	}

	#[test]
	fn a_missing_or_empty_parameter_is_no_names() {
		assert!(infobox_names(&infobox(""), "composer", C64).is_empty());
		assert!(
			infobox_names("{{Infobox video game\n| title = X\n}}", "composer", C64)
				.is_empty()
		);
		// `composers` is a different parameter, and must not be read as `composer`
		assert!(
			infobox_names("{{Infobox\n| composers = X\n}}", "composer", C64).is_empty()
		);
	}
}
