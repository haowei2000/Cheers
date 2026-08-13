#!/usr/bin/env bash
set -uo pipefail

# Run or preview the eight Agent x OAuth-mode cases. Full execution is
# intentionally sequential because each interactive case requires a distinct
# human consent decision and must not share OAuth state with another case.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
phase="full"
dry_run=false
keep_artifacts=false

usage() {
  cat <<'EOF'
Usage: scripts/run-mcp-direct-oauth-matrix.sh [options]

Options:
  --phase capability|session|full
  --dry-run
  --keep-artifacts

For client-credentials cases, define the documented per-Agent inputs as JSON:
  CHEERS_SPIKE_CODEX_AGENT_ENV_JSON
  CHEERS_SPIKE_CLAUDE_AGENT_ENV_JSON
  CHEERS_SPIKE_GEMINI_AGENT_ENV_JSON
  CHEERS_SPIKE_OPENCODE_AGENT_ENV_JSON
An absent value is reported as unsupported instead of injecting a private shim.
EOF
}

while (($#)); do
  case "$1" in
    --phase) phase="${2:-}"; shift 2 ;;
    --dry-run) dry_run=true; shift ;;
    --keep-artifacts) keep_artifacts=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done
case "$phase" in capability|session|full) ;; *) echo "invalid --phase" >&2; exit 2 ;; esac

status=0
for agent in codex claude gemini opencode; do
  for mode in interactive client-credentials; do
    args=(--agent "$agent" --mode "$mode" --phase "$phase")
    $dry_run && args+=(--dry-run)
    $keep_artifacts && args+=(--keep-artifacts)
    case "$agent" in
      codex) env_name="CHEERS_SPIKE_CODEX_AGENT_ENV_JSON" ;;
      claude) env_name="CHEERS_SPIKE_CLAUDE_AGENT_ENV_JSON" ;;
      gemini) env_name="CHEERS_SPIKE_GEMINI_AGENT_ENV_JSON" ;;
      opencode) env_name="CHEERS_SPIKE_OPENCODE_AGENT_ENV_JSON" ;;
    esac
    agent_env="${!env_name:-}"
    echo "==> ${agent} / ${mode}" >&2
    if ! $dry_run && [[ "$mode" == client-credentials && "$phase" != capability && -z "$agent_env" ]]; then
      echo "unsupported_client_credentials: ${env_name} is unset" >&2
      status=1
      continue
    fi
    if $dry_run && [[ "$mode" == client-credentials && "$phase" != capability && -z "$agent_env" ]]; then
      CHEERS_SPIKE_AGENT_ENV_JSON='{}' "$repo_root/scripts/run-mcp-direct-oauth-spike.sh" "${args[@]}" || status=1
    elif [[ -n "$agent_env" ]]; then
      CHEERS_SPIKE_AGENT_ENV_JSON="$agent_env" "$repo_root/scripts/run-mcp-direct-oauth-spike.sh" "${args[@]}" || status=1
    else
      "$repo_root/scripts/run-mcp-direct-oauth-spike.sh" "${args[@]}" || status=1
    fi
  done
done
exit "$status"
