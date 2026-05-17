use std::net::SocketAddr;

use apalis::prelude::{Monitor, WorkerBuilder, WorkerFactoryFn};
use axum::{extract::connect_info::Connected, Router};
use axum_server::tls_rustls::RustlsConfig;
use rustls::crypto::{ring::default_provider, CryptoProvider};
use stump_core::{
	config::{bootstrap_config_dir, logging::init_tracing},
	job::dispatch_job,
	StumpCore,
};
use tower_http::trace::TraceLayer;

use crate::{
	config::{cors, session::get_session_layer},
	errors::{EntryError, ServerError, ServerResult},
	routers,
	utils::shutdown_signal_with_cleanup,
};
use stump_core::config::StumpConfig;

pub async fn run_http_server(config: StumpConfig) -> ServerResult<()> {
	let core = StumpCore::new(config.clone()).await;

	// TODO: These need reorganizing, the core-specific initializations should just be
	// in some initialization function. The server-specific things, e.g. watcher, scheduler,
	// should be fully managed by the server and removed from the core...

	// Cancel any islanded jobs from a previous run
	core.get_context()
		.apalis_state
		.cancel_islanded_jobs()
		.await
		.map_err(|e| ServerError::ServerStartError(e.to_string()))?;

	// Initialize the server configuration. If it already exists, nothing will happen.
	core.init_server_config()
		.await
		.map_err(|e| ServerError::ServerStartError(e.to_string()))?;

	// Initialize the encryption key, if it doesn't exist
	core.init_encryption()
		.await
		.map_err(|e| ServerError::ServerStartError(e.to_string()))?;

	core.init_jwt_secrets()
		.await
		.map_err(|e| ServerError::ServerStartError(e.to_string()))?;

	core.init_journal_mode()
		.await
		.map_err(|e| ServerError::ServerStartError(e.to_string()))?;

	// Initialize the scheduler
	let _scheduler = core
		.init_scheduler()
		.await
		.map_err(|e| ServerError::ServerStartError(e.to_string()))?;

	core.init_library_watcher()
		.await
		.map_err(|e| ServerError::ServerStartError(e.to_string()))?;

	let server_ctx = core.get_context();
	let job_worker_handle = {
		let job_storage = server_ctx.job_storage.clone();
		let apalis_state = server_ctx.apalis_state.clone();
		tokio::spawn(async move {
			let result = Monitor::new()
				.register(
					WorkerBuilder::new("stump-job-worker")
						.data(apalis_state)
						.backend(job_storage)
						.build_fn(dispatch_job),
				)
				.run()
				.await;

			if let Err(error) = result {
				tracing::error!(?error, "Job worker exited unexpectedly");
			}
		})
	};
	let app_state = server_ctx.arced();
	let cors_layer = cors::get_cors_layer(config.clone());

	println!("{}", core.get_shadow_text());

	let app_router = routers::mount(app_state.clone()).await;
	let app = Router::new()
		.merge(app_router)
		.with_state(app_state.clone())
		.layer(get_session_layer(app_state.clone()))
		.layer(cors_layer)
		.layer(TraceLayer::new_for_http());

	// TODO: Refactor to use https://docs.rs/async-shutdown/latest/async_shutdown/
	let cleanup = {
		|| async move {
			println!("Initializing graceful shutdown...");
			let _ = core.get_context().library_watcher.stop().await;
			job_worker_handle.abort();
		}
	};

	let addr = SocketAddr::from(([0, 0, 0, 0], config.port));
	if config.tls_enabled {
		if CryptoProvider::get_default().is_none() {
			default_provider().install_default().map_err(|_| {
				ServerError::ServerStartError(
					"Failed to install rustls ring crypto provider".to_string(),
				)
			})?;
		}

		let cert_path = config.tls_cert_path.as_ref().ok_or_else(|| {
			ServerError::ServerStartError(
				"TLS is enabled but tls_cert_path is not configured".to_string(),
			)
		})?;
		let key_path = config.tls_key_path.as_ref().ok_or_else(|| {
			ServerError::ServerStartError(
				"TLS is enabled but tls_key_path is not configured".to_string(),
			)
		})?;

		let tls_config = RustlsConfig::from_pem_file(cert_path, key_path)
			.await
			.map_err(|e| ServerError::ServerStartError(e.to_string()))?;

		let handle = axum_server::Handle::new();
		let shutdown_handle = handle.clone();
		tokio::spawn(async move {
			shutdown_signal_with_cleanup(Some(cleanup)).await;
			shutdown_handle.graceful_shutdown(None);
		});

		tracing::info!("⚡️ Stump HTTPS server starting on https://{}", addr);

		axum_server::bind_rustls(addr, tls_config)
			.handle(handle)
			.serve(app.into_make_service_with_connect_info::<StumpRequestInfo>())
			.await
			.map_err(|e| ServerError::ServerStartError(e.to_string()))?;
	} else {
		let handle = axum_server::Handle::new();
		let shutdown_handle = handle.clone();
		tokio::spawn(async move {
			shutdown_signal_with_cleanup(Some(cleanup)).await;
			shutdown_handle.graceful_shutdown(None);
		});

		tracing::info!("⚡️ Stump HTTP server starting on http://{}", addr);

		axum_server::bind(addr)
			.handle(handle)
			.serve(app.into_make_service_with_connect_info::<StumpRequestInfo>())
			.await
			.map_err(|e| ServerError::ServerStartError(e.to_string()))?;
	}

	Ok(())
}

#[allow(dead_code)]
pub async fn bootstrap_http_server_config() -> Result<StumpConfig, EntryError> {
	// Get STUMP_CONFIG_DIR to bootstrap startup
	let config_dir = bootstrap_config_dir();

	let config = StumpCore::init_config(config_dir)
		.map_err(|e| EntryError::InvalidConfig(e.to_string()))?;

	// Note: init_tracing after loading the environment so the correct verbosity
	// level is used for logging.
	init_tracing(&config);

	if config.verbosity >= 3 {
		tracing::trace!(?config, "App config");
	}

	Ok(config)
}

#[derive(Clone, Debug)]
pub struct StumpRequestInfo {
	pub ip_addr: std::net::IpAddr,
}

impl Connected<SocketAddr> for StumpRequestInfo {
	fn connect_info(target: SocketAddr) -> Self {
		StumpRequestInfo {
			ip_addr: target.ip(),
		}
	}
}
