fn main() {
	// The bundled server links ONNX Runtime (Piper TTS), whose Windows build imports
	// DirectML/D3D12 that are never used. See apps/server/build.rs.
	if std::env::var_os("CARGO_FEATURE_BUNDLED_SERVER").is_some()
		&& std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
	{
		for dll in ["DirectML.dll", "d3d12.dll", "dxgi.dll"] {
			println!("cargo:rustc-link-arg=/DELAYLOAD:{dll}");
		}
		println!("cargo:rustc-link-lib=delayimp");
	}

	tauri_build::build()
}
