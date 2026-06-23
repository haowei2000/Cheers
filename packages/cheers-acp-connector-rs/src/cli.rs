use std::path::PathBuf;

use anyhow::{anyhow, Context};
use clap::{Parser, Subcommand};

use crate::bridge_runtime::run_connector;
use crate::config::load_config;
use crate::daemon::{
    daemon_logs, daemon_status, restart_daemon, start_daemon, stop_daemon, StartDaemonOptions,
};

#[derive(Debug, Parser)]
#[command(name = "cce-acp-connector")]
#[command(about = "Cheers ACP connector daemon")]
pub struct Args {
    #[command(subcommand)]
    command: Option<Command>,

    #[arg(short, long, global = true)]
    config: Option<PathBuf>,

    #[arg(short, long, global = true, default_value = "default")]
    name: String,

    #[arg(long, global = true)]
    home: Option<PathBuf>,

    #[arg(long, global = true, default_value_t = 120)]
    lines: usize,
}

#[derive(Debug, Clone, Copy, Subcommand)]
enum Command {
    Run,
    Start,
    Stop,
    Restart,
    Status,
    Logs,
}

pub async fn run() -> anyhow::Result<()> {
    let args = Args::parse();
    match args.command.unwrap_or(Command::Run) {
        Command::Run => run_foreground(args.config).await,
        Command::Start => {
            let config_path = args
                .config
                .ok_or_else(|| anyhow!("start requires --config <path>"))?;
            let metadata = start_daemon(StartDaemonOptions {
                name: args.name,
                config_path,
                home_dir: args.home,
            })
            .await?;
            println!(
                "started cce-acp-connector name={} pid={}",
                metadata.name, metadata.pid
            );
            println!("config: {}", metadata.config_path.display());
            println!("stdout: {}", metadata.stdout_log_path.display());
            println!("stderr: {}", metadata.stderr_log_path.display());
            Ok(())
        }
        Command::Stop => {
            let before = daemon_status(&args.name, args.home.as_deref()).await?;
            let status = stop_daemon(&args.name, args.home.as_deref(), None).await?;
            if before.running {
                if let Some(metadata) = before.metadata {
                    println!(
                        "stopped cce-acp-connector name={} pid={}",
                        before.name, metadata.pid
                    );
                }
            } else {
                println!("cce-acp-connector name={} is not running", status.name);
            }
            Ok(())
        }
        Command::Restart => {
            let config_path =
                resolve_restart_config(args.config, &args.name, args.home.as_deref()).await?;
            let metadata = restart_daemon(StartDaemonOptions {
                name: args.name,
                config_path,
                home_dir: args.home,
            })
            .await?;
            println!(
                "restarted cce-acp-connector name={} pid={}",
                metadata.name, metadata.pid
            );
            println!("config: {}", metadata.config_path.display());
            Ok(())
        }
        Command::Status => {
            let status = daemon_status(&args.name, args.home.as_deref()).await?;
            println!(
                "cce-acp-connector name={} status={}",
                status.name,
                if status.running { "running" } else { "stopped" }
            );
            if let Some(metadata) = status.metadata {
                println!("pid: {}", metadata.pid);
                println!("started_at: {}", metadata.started_at);
                println!("config: {}", metadata.config_path.display());
                println!("stdout: {}", metadata.stdout_log_path.display());
                println!("stderr: {}", metadata.stderr_log_path.display());
            } else {
                println!("metadata: {}", status.paths.metadata_path.display());
            }
            Ok(())
        }
        Command::Logs => {
            println!(
                "{}",
                daemon_logs(&args.name, args.home.as_deref(), args.lines).await?
            );
            Ok(())
        }
    }
}

async fn run_foreground(config_path: Option<PathBuf>) -> anyhow::Result<()> {
    let config_path = config_path.ok_or_else(|| anyhow!("--config is required"))?;
    let config = load_config(&config_path)
        .await
        .with_context(|| format!("failed to load config {}", config_path.display()))?;
    tracing::info!(
        accounts = config.accounts.len(),
        state_path = %config.state_path.display(),
        "validated connector config"
    );
    run_connector(config).await
}

async fn resolve_restart_config(
    provided: Option<PathBuf>,
    name: &str,
    home: Option<&std::path::Path>,
) -> anyhow::Result<PathBuf> {
    if let Some(path) = provided {
        return Ok(path);
    }
    let status = daemon_status(name, home).await?;
    status
        .metadata
        .map(|metadata| metadata.config_path)
        .ok_or_else(|| {
            anyhow!("restart requires --config <path> when no previous daemon metadata exists")
        })
}
