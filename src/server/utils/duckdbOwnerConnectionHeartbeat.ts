import {
  getDuckdbOwnerConnectionHeartbeatPayload,
  getDuckdbOwnerConnectionProxyHeaders,
} from './duckdbOwnerConnections.ts'
import {createRateLimitedLogger} from './rateLimitedLogger.ts'
import {getCurrentServerDuckdbOwnerUrl, shouldCurrentServerProxyApiToOwner} from './serverRuntimeRole.ts'

const duckdbOwnerConnectionHeartbeatLogger = createRateLimitedLogger({windowMs: 30_000})
const duckdbOwnerConnectionHeartbeatIntervalMs = 15_000

const sendDuckdbOwnerConnectionHeartbeat = async () => {
  const duckdbOwnerUrl = await getCurrentServerDuckdbOwnerUrl()

  if (!shouldCurrentServerProxyApiToOwner() || duckdbOwnerUrl === null) {
    return
  }

  const response = await fetch(`${duckdbOwnerUrl}/api/duckdb_owner_connections/heartbeat`, {
    method: 'POST',
    headers: {...getDuckdbOwnerConnectionProxyHeaders(), 'content-type': 'application/json'},
    body: JSON.stringify(getDuckdbOwnerConnectionHeartbeatPayload()),
  })

  if (!response.ok) {
    throw new Error(`DuckDB owner connection heartbeat failed with status ${response.status}`)
  }
}

const logDuckdbOwnerConnectionHeartbeatError = (error: unknown) => {
  return duckdbOwnerConnectionHeartbeatLogger.warn(
    'duckdb-owner-connection-heartbeat',
    '[duckdb-owner] heartbeat failed',
    error,
  )
}

export const startDuckdbOwnerConnectionHeartbeat = () => {
  const runHeartbeat = () => {
    return void sendDuckdbOwnerConnectionHeartbeat().catch(logDuckdbOwnerConnectionHeartbeatError)
  }
  const interval = setInterval(runHeartbeat, duckdbOwnerConnectionHeartbeatIntervalMs)

  interval.unref()
  runHeartbeat()
  process.once('exit', () => {
    clearInterval(interval)
  })
}
