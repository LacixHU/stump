//! Builds espeak-ng (GPL-3.0) from the `espeak-ng` git submodule and links it into
//! this crate, then compiles its phoneme and dictionary data and packs it into a
//! zstd archive that `src/espeak.rs` embeds and unpacks on first use.
//!
//! This mirrors espeak-ng's own CMake build (`cmake/data.cmake`) without needing
//! CMake: a host copy of the `espeak-ng` command-line tool is compiled with the same
//! sources and run to produce the data, exactly like `make data` does.
//!
//! `ESPEAK_NG_SOURCE_DIR` overrides the source location (defaults to the submodule).

use std::{
	env, fs,
	io::Write,
	path::{Path, PathBuf},
	process::Command,
	sync::{
		atomic::{AtomicUsize, Ordering},
		Mutex,
	},
};

const ESPEAK_NG_VERSION: &str = "1.53.0";

/// `src/libespeak-ng/CMakeLists.txt` with async, mbrola, klatt and speech-player off.
const LIBRARY_SOURCES: &[&str] = &[
	"common.c",
	"mnemonics.c",
	"error.c",
	"ieee80.c",
	"compiledata.c",
	"compiledict.c",
	"dictionary.c",
	"encoding.c",
	"intonation.c",
	"langopts.c",
	"numbers.c",
	"phoneme.c",
	"phonemelist.c",
	"readclause.c",
	"setlengths.c",
	"soundicon.c",
	"spect.c",
	"ssml.c",
	"synthdata.c",
	"synthesize.c",
	"tr_languages.c",
	"translate.c",
	"translateword.c",
	"voices.c",
	"wavegen.c",
	"speech.c",
	"espeak_api.c",
];

const UCD_SOURCES: &[&str] = &[
	"case.c",
	"categories.c",
	"ctype.c",
	"proplist.c",
	"scripts.c",
	"tostring.c",
];

/// `_dict_compile_list` from `cmake/data.cmake`.
const DICTIONARIES: &[&str] = &[
	"ab", "af", "am", "an", "ar", "as", "az", "ba", "be", "bg", "bn", "bpy", "bs", "ca",
	"chr", "cmn", "crh", "cs", "cv", "cy", "da", "de", "el", "en", "eo", "es", "et",
	"eu", "fa", "fi", "fo", "fr", "ga", "gd", "gn", "grc", "gu", "hak", "haw", "he",
	"hi", "hr", "ht", "hu", "hy", "ia", "id", "io", "is", "it", "ja", "jbo", "ka", "kaa",
	"kk", "kl", "kn", "kok", "ko", "ku", "ky", "la", "lb", "lfn", "lij", "lt", "lv",
	"mi", "mk", "ml", "mn", "mr", "ms", "mto", "mt", "my", "nci", "ne", "nl", "nog",
	"no", "om", "or", "pap", "pa", "piqd", "pl", "ps", "pt", "py", "qdb", "quc", "qu",
	"qya", "ro", "ru", "rup", "sd", "shn", "si", "sjn", "sk", "sl", "smj", "sq", "sr",
	"sv", "sw", "ta", "te", "ti", "th", "tk", "tn", "tr", "tt", "ug", "uk", "ur", "uz",
	"vi", "xex", "yue",
];

fn main() {
	delay_load_directml();

	let source = source_dir();
	println!("cargo:rerun-if-changed=build.rs");
	println!("cargo:rerun-if-env-changed=ESPEAK_NG_SOURCE_DIR");
	for path in [
		"src/libespeak-ng",
		"src/ucd-tools/src",
		"src/include",
		"src/espeak-ng.c",
		"phsource",
		"dictsource",
		"espeak-ng-data",
	] {
		println!("cargo:rerun-if-changed={}", source.join(path).display());
	}

	let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR is set"));
	let target = env::var("TARGET").expect("TARGET is set");
	let host = env::var("HOST").expect("HOST is set");

	// The library that ends up in the server binary.
	let target_config = out_dir.join("config-target");
	write_config_header(&target_config, &target);
	espeak_build(&source, &target_config, &target, &host).compile("espeak-ng");
	if target.contains("windows") {
		// espeak-ng reads its registry key when no data path is given.
		println!("cargo:rustc-link-lib=advapi32");
	} else {
		println!("cargo:rustc-link-lib=m");
	}

	// A host copy of the espeak-ng tool, run below to compile the data.
	let host_config = out_dir.join("config-host");
	write_config_header(&host_config, &host);
	let tool = build_tool(&source, &host_config, &host, &out_dir.join("tool"));

	let data_root = out_dir.join("data");
	compile_data(&tool, &source, &data_root);

	let archive = pack_data(&data_root.join("espeak-ng-data"));
	fs::write(out_dir.join("espeak-ng-data.zst"), &archive)
		.expect("failed to write the espeak-ng data archive");
	println!(
		"cargo:rustc-env=PIPER_ESPEAK_DATA_ID={ESPEAK_NG_VERSION}-{:016x}",
		fnv1a(&archive)
	);
}

/// The prebuilt ONNX Runtime for Windows imports DirectML/D3D12 even though Piper only
/// runs on the CPU. Delay-load them so binaries start on machines without them. Final
/// binaries that link this crate need the same flags (link args do not propagate):
/// see apps/server/build.rs.
fn delay_load_directml() {
	if env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
		for dll in ["DirectML.dll", "d3d12.dll", "dxgi.dll"] {
			println!("cargo:rustc-link-arg=/DELAYLOAD:{dll}");
		}
		println!("cargo:rustc-link-lib=delayimp");
	}
}

fn source_dir() -> PathBuf {
	let source = env::var_os("ESPEAK_NG_SOURCE_DIR")
		.map(PathBuf::from)
		.unwrap_or_else(|| {
			PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("manifest dir"))
				.join("espeak-ng")
		});
	if !source.join("src/libespeak-ng/speech.c").is_file() {
		panic!(
			"espeak-ng sources not found in {}. Run `git submodule update --init \
			 crates/piper_tts/espeak-ng` or set ESPEAK_NG_SOURCE_DIR.",
			source.display()
		);
	}
	source
}

/// `config.h` as espeak-ng's CMake build would generate it for `triple`.
fn write_config_header(dir: &Path, triple: &str) {
	let windows = triple.contains("windows");
	let bsd = ["freebsd", "netbsd", "openbsd", "dragonfly"]
		.iter()
		.any(|os| triple.contains(os));
	let flag = |value: bool| u8::from(value);
	let header = format!(
		"#define HAVE_MKSTEMP {}\n\
		 #define HAVE_NBTOOL_CONFIG_H 0\n\
		 #define HAVE_DECL_OPTRESET 0\n\
		 #define HAVE_SYS_ENDIAN_H {}\n\
		 #define HAVE_ISWBLANK 1\n\
		 #define USE_ASYNC 0\n\
		 #define USE_KLATT 0\n\
		 #define USE_LIBPCAUDIO 0\n\
		 #define USE_LIBSONIC 0\n\
		 #define USE_MBROLA 0\n\
		 #define USE_SPEECHPLAYER 0\n\
		 #define PACKAGE_VERSION \"{ESPEAK_NG_VERSION}\"\n",
		flag(!windows),
		flag(bsd),
	);
	fs::create_dir_all(dir).expect("failed to create the config.h directory");
	fs::write(dir.join("config.h"), header).expect("failed to write config.h");
}

fn espeak_build(source: &Path, config_dir: &Path, target: &str, host: &str) -> cc::Build {
	let mut build = cc::Build::new();
	build
		.target(target)
		.host(host)
		// Phonemization speed matters even in debug builds of the server.
		.opt_level(2)
		.warnings(false)
		.cargo_warnings(false)
		.include(config_dir)
		.include(source.join("src/include"))
		.include(source.join("src/include/compat"))
		.include(source.join("src/ucd-tools/src/include"))
		// Selects dllexport over dllimport in the headers; harmless when static.
		.define("LIBESPEAK_NG_EXPORT", "1")
		// Never used: Piper always passes the data path explicitly.
		.define("PATH_ESPEAK_DATA", "\"espeak-ng-data\"");
	if !build.get_compiler().is_like_msvc() {
		build
			.flag_if_supported("-fwrapv")
			.flag_if_supported("-fno-exceptions")
			.flag_if_supported("-fvisibility=hidden");
	}
	for file in LIBRARY_SOURCES {
		build.file(source.join("src/libespeak-ng").join(file));
	}
	for file in UCD_SOURCES {
		build.file(source.join("src/ucd-tools/src").join(file));
	}
	build
}

/// Compiles and links the `espeak-ng` command-line tool for the build host.
fn build_tool(source: &Path, config_dir: &Path, host: &str, dir: &Path) -> PathBuf {
	fs::create_dir_all(dir).expect("failed to create the tool directory");
	let mut build = espeak_build(source, config_dir, host, host);
	build
		.cargo_metadata(false)
		.out_dir(dir)
		.file(source.join("src/espeak-ng.c"));
	let compiler = build.get_compiler();
	if compiler.is_like_msvc() {
		build.file(source.join("src/compat/getopt.c"));
	}
	let objects = build.compile_intermediates();

	let exe = dir.join(if host.contains("windows") {
		"espeak-ng.exe"
	} else {
		"espeak-ng"
	});
	let mut link = Command::new(compiler.path());
	link.envs(compiler.env().iter().cloned()).args(&objects);
	if compiler.is_like_msvc() {
		link.arg("/nologo")
			.arg(format!("/Fe{}", exe.display()))
			.arg("/link")
			.arg("advapi32.lib");
	} else {
		link.arg("-o").arg(&exe).arg("-lm");
	}
	run(&mut link, "link the espeak-ng tool");
	exe
}

/// Produces `data_root/espeak-ng-data` like `cmake/data.cmake`.
fn compile_data(tool: &Path, source: &Path, data_root: &Path) {
	if data_root.exists() {
		fs::remove_dir_all(data_root).expect("failed to clear old espeak-ng data");
	}
	let data_dir = data_root.join("espeak-ng-data");
	copy_dir(&source.join("espeak-ng-data/lang"), &data_dir.join("lang"));
	copy_dir(
		&source.join("espeak-ng-data/voices/!v"),
		&data_dir.join("voices/!v"),
	);
	// Phoneme compilation reads `<data>/../phsource`.
	copy_dir(&source.join("phsource"), &data_root.join("phsource"));

	let espeak = |args: &[&str], cwd: &Path, what: &str| {
		let mut command = Command::new(tool);
		command
			.args(args)
			.current_dir(cwd)
			.env("ESPEAK_DATA_PATH", data_root);
		run(&mut command, what);
	};
	let phsource = source.join("phsource");
	espeak(&["--compile-intonations"], &phsource, "compile intonations");
	espeak(&["--compile-phonemes"], &phsource, "compile phonemes");

	// Dictionaries are independent of each other, so compile them in parallel, each
	// in its own working directory holding just its sources.
	let dict_source = source.join("dictsource");
	let dict_tmp = data_root.join("dictsource");
	let next = AtomicUsize::new(0);
	let failure = Mutex::new(None);
	let workers = std::thread::available_parallelism().map_or(4, |n| n.get());
	std::thread::scope(|scope| {
		for _ in 0..workers {
			scope.spawn(|| loop {
				let index = next.fetch_add(1, Ordering::Relaxed);
				let Some(name) = DICTIONARIES.get(index) else {
					break;
				};
				let cwd = dict_tmp.join(name);
				fs::create_dir_all(&cwd)
					.expect("failed to create a dictionary directory");
				let mut inputs = vec![
					dict_source.join(format!("{name}_rules")),
					dict_source.join(format!("{name}_list")),
				];
				let extra = dict_source.join(format!("extra/{name}_listx"));
				let listx = dict_source.join(format!("{name}_listx"));
				if extra.is_file() {
					inputs.push(extra);
				} else if listx.is_file() {
					inputs.push(listx);
				}
				let emoji = dict_source.join(format!("{name}_emoji"));
				if emoji.is_file() {
					inputs.push(emoji);
				}
				for input in &inputs {
					fs::copy(input, cwd.join(input.file_name().expect("file name")))
						.unwrap_or_else(|error| {
							panic!("failed to copy {}: {error}", input.display())
						});
				}

				let output = Command::new(tool)
					.arg(format!("--compile={name}"))
					.current_dir(&cwd)
					.env("ESPEAK_DATA_PATH", data_root)
					.output();
				let failed = match output {
					Ok(output) if output.status.success() => None,
					Ok(output) => Some(format!(
						"compiling the {name} dictionary failed ({}): {}",
						output.status,
						String::from_utf8_lossy(&output.stderr)
					)),
					Err(error) => {
						Some(format!("failed to run {}: {error}", tool.display()))
					},
				};
				if let Some(message) = failed {
					failure
						.lock()
						.unwrap_or_else(|p| p.into_inner())
						.get_or_insert(message);
					break;
				}
			});
		}
	});
	if let Some(message) = failure.into_inner().unwrap_or_else(|p| p.into_inner()) {
		panic!("{message}");
	}
}

/// Archive format read by `src/espeak.rs`: for each file, a little-endian u32 path
/// length, the `/`-separated relative path, a little-endian u64 size and the bytes;
/// all of it zstd-compressed.
fn pack_data(data_dir: &Path) -> Vec<u8> {
	let mut files = Vec::new();
	collect_files(data_dir, data_dir, &mut files);
	files.sort();

	let mut raw = Vec::new();
	for relative in &files {
		let bytes = fs::read(data_dir.join(relative)).expect("failed to read data file");
		raw.extend_from_slice(&(relative.len() as u32).to_le_bytes());
		raw.extend_from_slice(relative.as_bytes());
		raw.extend_from_slice(&(bytes.len() as u64).to_le_bytes());
		raw.extend_from_slice(&bytes);
	}

	let mut encoder = zstd::Encoder::new(Vec::new(), 19).expect("zstd encoder");
	encoder.write_all(&raw).expect("zstd compression");
	encoder.finish().expect("zstd compression")
}

fn collect_files(root: &Path, dir: &Path, files: &mut Vec<String>) {
	for entry in fs::read_dir(dir).expect("failed to read data directory") {
		let path = entry.expect("directory entry").path();
		if path.is_dir() {
			collect_files(root, &path, files);
		} else {
			let relative = path.strip_prefix(root).expect("path under root");
			let relative = relative
				.components()
				.map(|part| part.as_os_str().to_str().expect("UTF-8 data file name"))
				.collect::<Vec<_>>()
				.join("/");
			files.push(relative);
		}
	}
}

fn copy_dir(from: &Path, to: &Path) {
	fs::create_dir_all(to).expect("failed to create a data directory");
	for entry in fs::read_dir(from)
		.unwrap_or_else(|error| panic!("failed to read {}: {error}", from.display()))
	{
		let entry = entry.expect("directory entry");
		let target = to.join(entry.file_name());
		if entry.file_type().expect("file type").is_dir() {
			copy_dir(&entry.path(), &target);
		} else {
			fs::copy(entry.path(), &target).expect("failed to copy a data file");
		}
	}
}

fn run(command: &mut Command, what: &str) {
	let output = command
		.output()
		.unwrap_or_else(|error| panic!("failed to {what}: {error}"));
	if !output.status.success() {
		panic!(
			"failed to {what} ({}):\n{}\n{}",
			output.status,
			String::from_utf8_lossy(&output.stdout),
			String::from_utf8_lossy(&output.stderr)
		);
	}
}

fn fnv1a(bytes: &[u8]) -> u64 {
	bytes.iter().fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
		(hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3)
	})
}
