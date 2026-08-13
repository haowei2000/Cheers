//! Cheers ACP Connector daemon.
//!
//! The binary supervises local stdio ACP agents, translates their sessions to
//! the Cheers Agent Bridge, enforces the local TOML security policy, and owns
//! daemon lifecycle and signed self-update behavior.
//!
//! ACP agent filesystem and terminal methods are deliberately not exposed by
//! the connector. Platform resource access remains authorized by the gateway.

#![warn(missing_docs)]

mod acp_adapter;
mod acp_runtime;
mod acp_semantics;
mod bridge;
mod bridge_runtime;
mod bridge_session;
mod cli;
mod config;
mod daemon;
mod runtime_adapter;
mod self_update;
mod state;

use std::io::IsTerminal;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // The dependency tree enables more than one rustls crypto backend, so rustls
    // cannot auto-select a process-level provider and panics on the first TLS
    // (wss://) connection. Pin ring explicitly before anything touches TLS.
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("install rustls ring CryptoProvider before any TLS use");

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "cce_acp_connector=info,info".into()),
        )
        .with_target(false)
        // The desktop app redirects the connector's stdout into a log file.
        // Only emit terminal colour escapes for an actual interactive terminal;
        // otherwise the raw log is polluted with visible ANSI control codes.
        .with_ansi(std::io::stdout().is_terminal())
        .init();

    cli::run().await
}
