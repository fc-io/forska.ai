#!/bin/bash
# SSH tunnel to SGLang on MareNostrum 5
# Usage: ./scripts/mn5Tunnel.sh [compute-node]
#        ./scripts/mn5Tunnel.sh      # auto-detect from running job
#        ./scripts/mn5Tunnel.sh gp001  # specify node

set -euo pipefail

SGLANG_PORT=${SGLANG_PORT:-30000}
SSH_HOST="alog"

log() { echo "[mn5-tunnel] $*"; }

# Get compute node from argument or auto-detect
if [[ -n "${1:-}" ]]; then
  COMPUTE_NODE="$1"
else
  log "Auto-detecting compute node from running job..."
  COMPUTE_NODE=$(ssh "$SSH_HOST" "squeue -u \$USER -h -o '%N' -t RUNNING | head -1" 2>/dev/null || true)

  if [[ -z "$COMPUTE_NODE" ]]; then
    echo "No running job found. Usage: $0 <compute-node>"
    echo "Check job status with: ssh alog 'squeue -u \$USER'"
    exit 1
  fi
fi

log "Compute node: $COMPUTE_NODE"
log "Establishing tunnel: localhost:$SGLANG_PORT -> $COMPUTE_NODE:$SGLANG_PORT"
log "Press Ctrl+C to disconnect"
log ""
log "Test with: curl http://localhost:$SGLANG_PORT/v1/models"

# Use autossh if available for auto-reconnect, otherwise plain ssh
if command -v autossh &>/dev/null; then
  exec autossh -M 0 -N \
    -o "ServerAliveInterval=30" \
    -o "ServerAliveCountMax=3" \
    -L "$SGLANG_PORT:$COMPUTE_NODE:$SGLANG_PORT" \
    "$SSH_HOST"
else
  exec ssh -N \
    -o "ServerAliveInterval=30" \
    -o "ServerAliveCountMax=3" \
    -L "$SGLANG_PORT:$COMPUTE_NODE:$SGLANG_PORT" \
    "$SSH_HOST"
fi
