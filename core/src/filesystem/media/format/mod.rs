pub mod epub;
pub mod pdf;
pub mod rar;
pub mod retro;
pub mod zip;

pub use retro::{
	find_series_controls_json, find_sidecar_cover, parse_retro_controls,
	parse_retro_extra_keys, resolve_retro_platform, sanitize_retro_overlay_keys,
	series_controls_json_write_path, RetroOverlayKey, RETRO_CONTROLS_MAX_BYTES,
};
