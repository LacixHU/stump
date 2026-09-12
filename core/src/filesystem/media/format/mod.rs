pub mod epub;
pub mod pdf;
pub mod rar;
pub mod retro;
pub mod zip;

pub use retro::{find_sidecar_cover, resolve_retro_platform};
