/**
 * ClickHouse client configuration and singleton instance.
 *
 * Uses the official @clickhouse/client package to connect to ClickHouse.
 * Configuration is read from environment variables.
 */
import {type ClickHouseClient, createClient} from '@clickhouse/client'

let clickhouseClient: ClickHouseClient | null = null

/**
 * Gets the default ClickHouse URL based on environment
 */
const getDefaultClickhouseUrl = (): string => {
  // Development default
  return 'http://localhost:8123'
}

/**
 * Returns a singleton ClickHouse client instance.
 *
 * Configuration via environment variables:
 * - CLICKHOUSE_URL: Full URL to ClickHouse HTTP interface (default: http://localhost:8123)
 * - CLICKHOUSE_DATABASE: Database to use (default: forska)
 * - CLICKHOUSE_USER: Username (default: default)
 * - CLICKHOUSE_PASSWORD: Password (default: clickhouse)
 */
export const getClickhouseClient = (): ClickHouseClient => {
  if (!clickhouseClient) {
    const url = process.env['CLICKHOUSE_URL'] ?? getDefaultClickhouseUrl()
    const database = process.env['CLICKHOUSE_DATABASE'] ?? 'forska'
    const username = process.env['CLICKHOUSE_USER'] ?? 'default'
    const password = process.env['CLICKHOUSE_PASSWORD'] ?? 'clickhouse'

    console.log(`[ClickHouse] Connecting to ${url} (database: ${database})`)

    clickhouseClient = createClient({
      url,
      database,
      username,
      password,
      // Default timeout settings - 120s to accommodate external GROUP BY (disk-based)
      request_timeout: 120000,
      // Connection settings for better performance
      compression: {request: false, response: true},
      // Use JSON format for easy parsing
      clickhouse_settings: {
        output_format_json_quote_64bit_integers: 0,
        output_format_json_quote_denormals: 1,
        // Memory management: prevent OOM on large aggregations
        // When GROUP BY needs more than 8GB, spill to disk
        max_bytes_before_external_group_by: '8589934592', // 8 GB
        // Max memory per query: 16GB (allows headroom before external GROUP BY kicks in)
        max_memory_usage: '17179869184', // 16 GB
        // Use external sorting when ORDER BY exceeds memory
        max_bytes_before_external_sort: '8589934592', // 8 GB
      },
    })
  }

  return clickhouseClient
}

/**
 * Closes the ClickHouse client connection.
 * Should be called on application shutdown.
 */
export const closeClickhouseClient = async (): Promise<void> => {
  if (clickhouseClient) {
    await clickhouseClient.close()
    clickhouseClient = null
  }
}

/**
 * Health check - pings the ClickHouse server
 */
export const pingClickhouse = async (): Promise<boolean> => {
  try {
    const client = getClickhouseClient()
    await client.ping()
    return true
  } catch (error) {
    console.error('[ClickHouse] Ping failed:', error)
    return false
  }
}
