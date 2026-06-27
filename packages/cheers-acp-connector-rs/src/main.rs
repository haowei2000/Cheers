mod acp_adapter;
mod acp_runtime;
mod bridge;
mod bridge_runtime;
mod bridge_session;
mod cli;
mod config;
mod daemon;
mod loopback;
mod runtime_adapter;
mod state;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "cce_acp_connector=info,info".into()),
        )
        .with_target(false)
        .init();

    cli::run().await
}
