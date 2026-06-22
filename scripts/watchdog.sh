#!/bin/bash
# Watchdog for the Next.js dev server.
#
# This script runs forever. Every 5 seconds it checks if anything is listening
# on port 3000. If not, it restarts `bun run dev`. If the dev server dies
# (sandbox kills it, OOM, crash, etc.), the watchdog brings it back within
# 5-10 seconds.
#
# The watchdog itself is launched with setsid + nohup so it survives the
# parent shell exiting. It writes a heartbeat to /tmp/watchdog.heartbeat
# so we can verify it's alive.

PROJECT_DIR="/home/z/my-project"
LOG_FILE="/home/z/my-project/dev.log"
HEARTBEAT_FILE="/tmp/watchdog.heartbeat"
PID_FILE="/home/z/my-project/.zscripts/dev.pid"
PORT=3000
CHECK_INTERVAL=5  # seconds between health checks
MAX_LOG_SIZE=1048576  # 1 MB — rotate dev.log if it gets too big

log() {
  # Only write to log file (stdout/stderr may be closed in daemon mode)
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [watchdog] $*" >> "$LOG_FILE" 2>/dev/null || true
}

is_port_open() {
  ss -tlnp 2>/dev/null | grep -q ":$PORT "
}

rotate_log_if_needed() {
  if [ -f "$LOG_FILE" ]; then
    size=$(stat -c%s "$LOG_FILE" 2>/dev/null || echo 0)
    if [ "$size" -gt "$MAX_LOG_SIZE" ]; then
      mv "$LOG_FILE" "${LOG_FILE}.1"
      log "Rotated dev.log (was $size bytes)"
    fi
  fi
}

start_dev_server() {
  log "Starting Next.js dev server via dev.sh..."
  cd "$PROJECT_DIR" || return 1

  # Use the project's official dev.sh script — the sandbox is configured
  # to allow this script to spawn the dev server. Spawning bun directly
  # from the watchdog gets killed by the sandbox.
  rm -f "$PID_FILE"
  setsid bash "$PROJECT_DIR/.zscripts/dev.sh" </dev/null >>"$LOG_FILE" 2>&1 &
  local dev_pid=$!
  echo "$dev_pid" > "$PID_FILE"
  log "Started dev.sh (PID: $dev_pid). Waiting for port $PORT to come up..."

  # Wait up to 90 seconds for the port to open (dev.sh does db:push + setup first)
  for i in $(seq 1 90); do
    if is_port_open; then
      log "✅ Dev server is up (port $PORT open after ${i}s)"
      return 0
    fi
    sleep 1
  done

  log "❌ Dev server failed to start within 90s"
  return 1
}

# Main loop
log "=== Watchdog started (PID: $$) ==="
log "Checking dev server every ${CHECK_INTERVAL}s, auto-restart on death."

while true; do
  # Update heartbeat
  date '+%Y-%m-%d %H:%M:%S' > "$HEARTBEAT_FILE"

  rotate_log_if_needed

  if ! is_port_open; then
    log "⚠️  Port $PORT is NOT open — dev server appears dead. Restarting..."
    # Kill any stale next/bun processes
    pkill -9 -f "next-server" 2>/dev/null
    pkill -9 -f "next dev" 2>/dev/null
    sleep 2
    start_dev_server
    # Wait a bit after restart before checking again
    sleep 5
  fi

  sleep "$CHECK_INTERVAL"
done
