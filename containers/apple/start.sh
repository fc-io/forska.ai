#!/bin/sh
set -eu
mkdir -p /data/assets /data/local /data/share /data/logs
setsid "$@" &
app_pid=$!
stop_app() {
  trap '' INT TERM
  kill -TERM "-$app_pid" 2>/dev/null || true
  wait "$app_pid" 2>/dev/null || true
  while kill -0 "-$app_pid" 2>/dev/null; do
    sleep 0.1
  done
}
trap stop_app INT TERM
status=0
wait "$app_pid" || status=$?
stop_app
exit "$status"
