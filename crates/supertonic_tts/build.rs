//! The prebuilt ONNX Runtime for Windows imports DirectML/D3D12 even though only the
//! CPU is used. Delay-load them so this crate's examples and tests start on machines
//! without them. Link args do not propagate, so final binaries that link this crate
//! need the same flags (see apps/server/build.rs).

fn main() {
	if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
		for dll in ["DirectML.dll", "d3d12.dll", "dxgi.dll"] {
			println!("cargo:rustc-link-arg=/DELAYLOAD:{dll}");
		}
		println!("cargo:rustc-link-lib=delayimp");
	}
}
