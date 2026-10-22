//! Command-line interface for foreground runs and daemon lifecycle operations.

use std::path::PathBuf;

use anyhow::{anyhow, Context};
use clap::{Parser, Subcommand};

use crate::bridge_runtime::run_connector;
use crate::config::load_config;
use crate::daemon::{
    daemon_logs, daemon_status, list_daemons, restart_daemon, start_daemon, stop_daemon,
    DaemonStatusReport, StartDaemonOptions,
};

#[derive(Debug, Parser)]
#[command(name = "cce-acp-connector")]
#[command(about = "Cheers ACP connector daemon")]
#[command(version)]
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
    Status {
        /// Emit only the versioned JSON status report.
        #[arg(long)]
        json: bool,
    },
    List {
        /// Emit only the versioned JSON status inventory.
        #[arg(long)]
        json: bool,
    },
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
        Command::Status { json } => {
            let status = daemon_status(&args.name, args.home.as_deref()).await?;
            if json {
                println!(
                    "{}",
                    serde_json::to_string(&DaemonStatusReport::new(vec![status]))?
                );
                return Ok(());
            }
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
                print_update_notice(&metadata.config_path).await;
            } else {
                println!("metadata: {}", status.paths.metadata_path.display());
            }
            Ok(())
        }
        Command::List { json } => {
            let instances = list_daemons(args.home.as_deref()).await?;
            if json {
                println!(
                    "{}",
                    serde_json::to_string(&DaemonStatusReport::new(instances))?
                );
            } else {
                for status in instances {
                    println!(
                        "{}: {}",
                        status.name,
                        if status.running { "running" } else { "stopped" }
                    );
                }
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

/// `status` addendum: surface a persisted "newer release available" notice
/// (written by the running daemon when a gateway hello advertises one). Silent
/// on any failure — status must keep working with a broken or missing config.
async fn print_update_notice(config_path: &std::path::Path) {
    let Ok(daemon_config) = crate::config::load_daemon_file_config(config_path).await else {
        return;
    };
    let Some(state_dir) = daemon_config.state_path.parent() else {
        return;
    };
    let Some(notice) = crate::self_update::available_update(state_dir) else {
        return;
    };
    println!(
        "update available: {} (running {})",
        notice.latest,
        crate::self_update::current_version()
    );
    if let Some(url) = notice.download_url() {
        println!("  download: {url}");
    }
    println!("  then: replace the binary and run `cce-acp-connector restart`");
    println!("  or:   set `[update] auto = true` in the connector config");
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn machine_readable_status_and_inventory_are_explicit_cli_options() {
        let args =
            Args::try_parse_from(["cce-acp-connector", "--name", "helper", "status", "--json"])
                .unwrap();
        assert!(matches!(args.command, Some(Command::Status { json: true })));
        let args = Args::try_parse_from(["cce-acp-connector", "list", "--json"]).unwrap();
        assert!(matches!(args.command, Some(Command::List { json: true })));
        let args = Args::try_parse_from(["cce-acp-connector", "status"]).unwrap();
        assert!(matches!(
            args.command,
            Some(Command::Status { json: false })
        ));
    }
}
