/// Hungarian-voice pronunciation helpers for Piper.
///
/// Piper + espeak-ng phonemize every token as Hungarian. English names and
/// loanwords therefore get letter-to-sound rules that do not match English.
/// Rewrite those tokens to Hungarian orthography so the same `hu_*` voice
/// produces something a listener recognizes.

pub fn is_hungarian_voice(voice_id: &str) -> bool {
	let lower = voice_id.to_ascii_lowercase();
	lower.starts_with("hu_")
		|| lower.starts_with("hu-")
		|| lower.contains("_hu_")
		|| lower.contains("-hu-")
		|| lower.contains("hu_hu")
		|| lower.contains("hu-hu")
}

/// Longer phrases first so "new york" wins over "new".
const PHRASES: &[(&str, &str)] = &[
	("united kingdom", "junájted kingdom"),
	("united states", "junájted sztétsz"),
	("los angeles", "losz andzselesz"),
	("new york", "njú jork"),
	("great britain", "gréjt briten"),
	("harry potter", "herri poter"),
];

const WORDS: &[(&str, &str)] = &[
	("arthur", "artur"),
	("bellatrix", "bellatrix"),
	("bill", "bil"),
	("black", "blek"),
	("cedric", "szedrik"),
	("chang", "csang"),
	("charlie", "csárli"),
	("cho", "csó"),
	("christopher", "krisztofer"),
	("chris", "krisz"),
	("dobby", "dobi"),
	("draco", "drakó"),
	("dumbledore", "dambldór"),
	("dursley", "dörszli"),
	("dudley", "dadli"),
	("elizabeth", "elizabet"),
	("filch", "filcs"),
	("flitwick", "flitvik"),
	("fred", "fred"),
	("fudge", "fadz"),
	("george", "dzsódzs"),
	("ginny", "dzsini"),
	("goyle", "gojl"),
	("granger", "gréndzser"),
	("grindelwald", "grindelvold"),
	("hagrid", "hagrid"),
	("harry", "herri"),
	("hedwig", "hedvig"),
	("hermione", "hermioni"),
	("jack", "dzsek"),
	("jacob", "dzsékob"),
	("james", "dzsémsz"),
	("jane", "dzséjn"),
	("john", "dzson"),
	("lily", "lili"),
	("lockhart", "lokhart"),
	("longbottom", "longbottom"),
	("lucius", "lúciusz"),
	("lupin", "lupin"),
	("malfoy", "malfoj"),
	("mary", "méri"),
	("mcgonagall", "mekgenegel"),
	("michael", "májkel"),
	("miss", "misz"),
	("moody", "múdi"),
	("mr", "miszter"),
	("mrs", "misziz"),
	("ms", "miz"),
	("narcissa", "narcissza"),
	("neville", "nevil"),
	("newt", "njút"),
	("parker", "parker"),
	("parkinson", "parkinson"),
	("percy", "pörszi"),
	("peter", "píter"),
	("petunia", "petúnia"),
	("potter", "poter"),
	("queenie", "kvíni"),
	("quirrell", "kvirrel"),
	("richard", "ricsard"),
	("robert", "robert"),
	("ronald", "ronald"),
	("ron", "ron"),
	("scamander", "szkemender"),
	("sirius", "szíriusz"),
	("slughorn", "szlaghorn"),
	("smith", "szmit"),
	("snape", "sznép"),
	("sprout", "szpraut"),
	("steve", "sztív"),
	("steven", "sztíven"),
	("thomas", "tomesz"),
	("tonks", "tonksz"),
	("trelawney", "trelóni"),
	("umbridge", "ambridzs"),
	("vernon", "vernon"),
	("voldemort", "voldemort"),
	("weasley", "víszli"),
	("william", "viliem"),
	("washington", "vasington"),
	("london", "london"),
	("america", "amerika"),
	("england", "inglend"),
	("the", "dö"),
	("they", "déj"),
	("them", "dem"),
	("their", "déör"),
	("there", "deör"),
	("this", "disz"),
	("that", "det"),
	("these", "díz"),
	("those", "dóuz"),
	("you", "jú"),
	("your", "jór"),
	("we", "ví"),
	("with", "vit"),
	("from", "fróm"),
	("what", "vot"),
	("when", "ven"),
	("where", "veör"),
	("who", "hú"),
	("why", "váj"),
	("how", "hau"),
	("not", "nat"),
	("but", "bat"),
	("his", "hiz"),
	("her", "hör"),
	("she", "sí"),
	("he", "hí"),
	("are", "ár"),
	("was", "voz"),
	("were", "vör"),
	("been", "bín"),
	("have", "hev"),
	("has", "hez"),
	("will", "vil"),
	("would", "vud"),
	("could", "kud"),
	("should", "sud"),
	("my", "máj"),
	("me", "mí"),
	("and", "end"),
	("of", "ov"),
	("for", "fór"),
	("i'm", "ájm"),
	("don't", "dóunt"),
	("it's", "ítsz"),
	("that's", "detsz"),
];

pub fn apply_pronunciation(text: &str) -> String {
	let chars: Vec<char> = text.chars().collect();
	let mut result = String::with_capacity(text.len() + 16);
	let mut i = 0;

	while i < chars.len() {
		if is_word_char(chars[i]) {
			if let Some((end, replacement)) = match_at(&chars, i) {
				result.push_str(&replacement);
				i = end;
				continue;
			}

			let start = i;
			i += 1;
			while i < chars.len() && is_word_char(chars[i]) {
				i += 1;
			}
			let word: String = chars[start..i].iter().collect();
			result.push_str(&rewrite_word(&word));
		} else {
			result.push(chars[i]);
			i += 1;
		}
	}

	result
}

fn is_word_char(c: char) -> bool {
	c.is_alphabetic() || c == '\'' || c == '’'
}

fn match_at(chars: &[char], start: usize) -> Option<(usize, String)> {
	for (phrase, replacement) in PHRASES {
		let word_count = phrase.split(' ').count();
		if let Some((words, end)) = next_words(chars, start, word_count) {
			let joined = words
				.iter()
				.map(|word| word.to_lowercase())
				.collect::<Vec<_>>()
				.join(" ");
			if joined == *phrase {
				let rendered = replacement
					.split(' ')
					.zip(words.iter())
					.map(|(repl, original)| apply_casing(original, repl))
					.collect::<Vec<_>>()
					.join(" ");
				return Some((end, rendered));
			}
		}
	}
	None
}

fn next_words(chars: &[char], start: usize, n: usize) -> Option<(Vec<String>, usize)> {
	let mut i = start;
	let mut words = Vec::with_capacity(n);
	for word_idx in 0..n {
		if word_idx > 0 {
			if i >= chars.len() || !chars[i].is_whitespace() {
				return None;
			}
			while i < chars.len() && chars[i].is_whitespace() {
				i += 1;
			}
		}
		if i >= chars.len() || !is_word_char(chars[i]) {
			return None;
		}
		let word_start = i;
		while i < chars.len() && is_word_char(chars[i]) {
			i += 1;
		}
		words.push(chars[word_start..i].iter().collect());
	}
	Some((words, i))
}

fn rewrite_word(word: &str) -> String {
	if word.chars().all(|c| c.is_ascii_digit()) {
		return word.to_string();
	}

	let lower = word.to_lowercase();
	if let Some(replacement) = lookup_word(&lower) {
		return apply_casing(word, replacement);
	}

	if looks_foreign(&lower) {
		return apply_casing(word, &approx_foreign_word(&lower));
	}

	word.to_string()
}

fn lookup_word(lower: &str) -> Option<&'static str> {
	WORDS
		.iter()
		.find_map(|(from, to)| (*from == lower).then_some(*to))
}

fn has_hungarian_diacritic(word: &str) -> bool {
	word.chars().any(|c| {
		matches!(
			c,
			'á' | 'é'
				| 'í' | 'ó' | 'ö'
				| 'ő' | 'ú' | 'ü'
				| 'ű' | 'Á' | 'É'
				| 'Í' | 'Ó' | 'Ö'
				| 'Ő' | 'Ú' | 'Ü'
				| 'Ű'
		)
	})
}

fn looks_foreign(lower: &str) -> bool {
	if has_hungarian_diacritic(lower) {
		return false;
	}
	if lower.chars().any(|c| matches!(c, 'q' | 'w' | 'x')) {
		return true;
	}
	lower.contains("th") || lower.contains("ph") || lower.contains("wh")
}

fn approx_foreign_word(lower: &str) -> String {
	let mut out = String::with_capacity(lower.len() + 4);
	let chars: Vec<char> = lower.chars().collect();
	let mut i = 0;
	while i < chars.len() {
		let rest: String = chars[i..].iter().collect();
		if rest.starts_with("wh") {
			out.push('v');
			i += 2;
		} else if rest.starts_with("th") {
			out.push('t');
			i += 2;
		} else if rest.starts_with("ph") {
			out.push('f');
			i += 2;
		} else if rest.starts_with("ck") {
			out.push('k');
			i += 2;
		} else if rest.starts_with("ee") {
			out.push('í');
			i += 2;
		} else if rest.starts_with("oo") {
			out.push('ú');
			i += 2;
		} else if rest.starts_with("qu") {
			out.push_str("kv");
			i += 2;
		} else if chars[i] == 'q' {
			out.push('k');
			i += 1;
		} else if chars[i] == 'w' {
			out.push('v');
			i += 1;
		} else if chars[i] == 'x' {
			out.push_str("ksz");
			i += 1;
		} else {
			out.push(chars[i]);
			i += 1;
		}
	}
	out
}

fn apply_casing(original: &str, replacement: &str) -> String {
	let alphabetic: Vec<char> = original.chars().filter(|c| c.is_alphabetic()).collect();
	if !alphabetic.is_empty() && alphabetic.iter().all(|c| c.is_uppercase()) {
		return replacement.to_uppercase();
	}

	let Some(first) = original.chars().find(|c| c.is_alphabetic()) else {
		return replacement.to_string();
	};
	if !first.is_uppercase() {
		return replacement.to_string();
	}

	let mut chars = replacement.chars();
	let Some(rep_first) = chars.next() else {
		return replacement.to_string();
	};
	let mut titled = rep_first.to_uppercase().to_string();
	titled.push_str(chars.as_str());
	titled
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn detects_hungarian_voice_ids() {
		assert!(is_hungarian_voice("hu_HU-anna-medium"));
		assert!(is_hungarian_voice("hu-HU-imre"));
		assert!(!is_hungarian_voice("en_US-lessac-medium"));
		assert!(!is_hungarian_voice("de_DE-thorsten-medium"));
	}

	#[test]
	fn rewrites_english_names() {
		assert_eq!(
			apply_pronunciation("Harry Potter Londonba ment."),
			"Herri Poter Londonba ment."
		);
		assert_eq!(apply_pronunciation("James and John"), "Dzsémsz end Dzson");
	}

	#[test]
	fn keeps_hungarian_words() {
		assert_eq!(
			apply_pronunciation("A kisfiú elindult az erdőbe."),
			"A kisfiú elindult az erdőbe."
		);
	}

	#[test]
	fn approximates_unknown_foreign_words() {
		assert_eq!(apply_pronunciation("Twitter"), "Tvitter");
		assert_eq!(apply_pronunciation("Maxwell"), "Makszvell");
	}

	#[test]
	fn does_not_rewrite_hungarian_is() {
		assert_eq!(apply_pronunciation("Ő is ott volt."), "Ő is ott volt.");
	}

	#[test]
	fn rewrites_new_york_phrase() {
		assert_eq!(apply_pronunciation("New York"), "Njú Jork");
	}
}
