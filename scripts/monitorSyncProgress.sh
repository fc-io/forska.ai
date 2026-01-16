#!/bin/bash
# Real-time monitoring of ClickHouse MaterializedPostgreSQL sync progress

echo "=== ClickHouse MaterializedPostgreSQL Sync Monitor ==="
echo "Started at: $(date)"
echo ""

while true; do
  clear
  echo "=== Sync Progress Monitor | $(date) ==="
  echo ""

  # 1. PostgreSQL replication slot status
  echo "📊 PostgreSQL Replication Slot:"
  docker exec forska-stack-db-1 psql -U postgres -t -c "
    SELECT
      '  Status: ' || CASE WHEN active THEN 'ACTIVE ✓' ELSE 'Inactive' END || E'\n' ||
      '  WAL Lag: ' || pg_size_pretty(COALESCE(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn), 0)) || E'\n' ||
      '  PID: ' || COALESCE(active_pid::text, 'none')
    FROM pg_replication_slots WHERE slot_name = 'postgres'" 2>/dev/null || echo "  Error checking slot"
  echo ""

  # 2. ClickHouse tables synced
  echo "📁 ClickHouse Tables (target: 8):"
  TABLE_COUNT=$(docker exec forska-stack-clickhouse-1 clickhouse-client --password clickhouse -q \
    "SELECT COUNT(*) FROM system.tables WHERE database = 'pg'" 2>/dev/null || echo "0")
  echo "  Tables synced: $TABLE_COUNT/8"

  if [ "$TABLE_COUNT" -gt 0 ]; then
    echo ""
    echo "  Table details:"
    docker exec forska-stack-clickhouse-1 clickhouse-client --password clickhouse -q \
      "SELECT '  ✓ ' || table || ': ' || formatReadableQuantity(total_rows) || ' rows, ' || formatReadableSize(total_bytes) AS info
       FROM system.tables
       WHERE database = 'pg'
       ORDER BY table
       FORMAT TSVRaw" 2>/dev/null || echo "  Error fetching table details"
  fi
  echo ""

  # 3. Disk usage
  echo "💾 Disk Usage:"
  DISK_USAGE=$(docker exec forska-stack-clickhouse-1 du -sh /var/lib/clickhouse/store/8e8/ 2>/dev/null | cut -f1 || echo "0")
  echo "  pg database: $DISK_USAGE"
  echo ""

  # 4. Latest ClickHouse activity (last 5 seconds)
  echo "📝 Recent ClickHouse Activity:"
  RECENT_LOGS=$(docker exec forska-stack-clickhouse-1 cat /var/log/clickhouse-server/clickhouse-server.log 2>/dev/null | \
    grep "$(date -u -d '5 seconds ago' '+%Y.%m.%d %H:%M')" | \
    grep -i "materialized\|postgresql" | tail -3)

  if [ -n "$RECENT_LOGS" ]; then
    echo "$RECENT_LOGS" | sed 's/^/  /'
  else
    echo "  No recent MaterializedPostgreSQL activity"
  fi
  echo ""

  # 5. Progress estimate
  if [ "$TABLE_COUNT" -gt 0 ]; then
    PROGRESS=$((TABLE_COUNT * 100 / 8))
    echo "⏳ Overall Progress: ${PROGRESS}% ($TABLE_COUNT/8 tables)"

    # Progress bar
    FILLED=$((PROGRESS / 5))
    EMPTY=$((20 - FILLED))
    printf "   ["
    printf "%${FILLED}s" | tr ' ' '='
    printf "%${EMPTY}s" | tr ' ' '-'
    printf "]\n"
  else
    echo "⏳ Waiting for initial sync to start..."
  fi

  echo ""
  echo "Press Ctrl+C to stop monitoring"

  sleep 5
done
