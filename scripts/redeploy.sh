#!/usr/bin/env bash
# Redeploy the local Cheers stack to the kind cluster after a CODE change.
#
# The cluster runs a *baked image*, not your working tree — a code change only
# goes live after you (1) rebuild the image, (2) load it into the kind node, and
# (3) roll the pods. This script does those three steps for the gateway, the
# frontend, or both.
#
#   ./scripts/redeploy.sh            # both (default)
#   ./scripts/redeploy.sh gateway    # Rust backend only (server/)
#   ./scripts/redeploy.sh frontend   # React SPA only (frontend/)
#
# Notes:
#   * DB migrations (server/migrations/*.sql) apply automatically on gateway
#     startup, so rolling the gateway also runs any new migration.
#   * This is for CODE changes only. For Helm/config changes (values-*.yaml, the
#     nginx ConfigMap with the security headers, secrets) run `helm upgrade`
#     instead — see deploy/helm/cheers/README.md. Rebuilding the image does NOT
#     update the ConfigMap/Secret.
#   * Same-tag works because `kind load` overwrites the image in the node's
#     containerd, and `rollout restart` starts fresh pods that pick it up
#     (pullPolicy IfNotPresent → uses the node-local image, no registry).
set -euo pipefail

CLUSTER=cheers
NS=cheers
GATEWAY_IMAGE=cheers/gateway:dev
FRONTEND_IMAGE=cheers/frontend:dev

# Run from the repo root so the `server` / `frontend` build contexts resolve
# regardless of where you invoke the script from.
cd "$(dirname "$0")/.."

target="${1:-both}"
do_gateway=false
do_frontend=false
case "$target" in
  gateway) do_gateway=true ;;
  frontend) do_frontend=true ;;
  both) do_gateway=true; do_frontend=true ;;
  -h|--help|help) sed -n '2,18p' "$0"; exit 0 ;;
  *) echo "usage: $0 [gateway|frontend|both]" >&2; exit 1 ;;
esac

images=()
if $do_gateway; then
  echo "▸ [1/3] building $GATEWAY_IMAGE (Rust — this is the slow one)…"
  docker build -t "$GATEWAY_IMAGE" server
  images+=("$GATEWAY_IMAGE")
fi
if $do_frontend; then
  echo "▸ [1/3] building ${FRONTEND_IMAGE}…"
  docker build -t "$FRONTEND_IMAGE" --build-arg VITE_API_BASE_URL=/api/v1 frontend
  images+=("$FRONTEND_IMAGE")
fi

echo "▸ [2/3] loading image(s) into kind cluster '$CLUSTER'…"
kind load docker-image "${images[@]}" --name "$CLUSTER"

echo "▸ [3/3] rolling deployment(s)…"
if $do_gateway; then kubectl -n "$NS" rollout restart deployment/cheers-gateway; fi
if $do_frontend; then kubectl -n "$NS" rollout restart deployment/cheers-frontend; fi
if $do_gateway; then kubectl -n "$NS" rollout status deployment/cheers-gateway --timeout=300s; fi
if $do_frontend; then kubectl -n "$NS" rollout status deployment/cheers-frontend --timeout=180s; fi

echo "✓ done — open http://localhost:30080  (admin / admin12345)"
echo "  quick check: curl -s -o /dev/null -w '%{http_code}\\n' http://localhost:30080/health"
