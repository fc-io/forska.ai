import {
  getDuckdbOwnerConnectionHeartbeatPayload,
  getDuckdbOwnerConnectionProxyHeaders,
  upsertDuckdbOwnerConnectionHeartbeat,
} from './duckdbOwnerConnections.ts'
import {createRateLimitedLogger} from './rateLimitedLogger.ts'
import {canCurrentServerOwnDuckdb, getCurrentServerWorkerRegistryOwnerUrl} from './serverRuntimeRole.ts'

const duckdbOwnerConnectionHeartbeatLogger = createRateLimitedLogger({sink: 'both', windowMs: 30_000})
const duckdbOwnerConnectionHeartbeatIntervalMs = 15_000

const sendDuckdbOwnerConnectionHeartbeat = async () => {
  const duckdbOwnerUrl = await getCurrentServerWorkerRegistryOwnerUrl()
  const heartbeatPayload = await getDuckdbOwnerConnectionHeartbeatPayload()

  if (canCurrentServerOwnDuckdb()) {
    await upsertDuckdbOwnerConnectionHeartbeat(heartbeatPayload)
    return
  }

  if (duckdbOwnerUrl === null) {
    await upsertDuckdbOwnerConnectionHeartbeat(heartbeatPayload)
    return
  }

  const response = await fetch(`${duckdbOwnerUrl}/api/duckdb_owner_connections/heartbeat`, {
    method: 'POST',
    headers: {...getDuckdbOwnerConnectionProxyHeaders(), 'content-type': 'application/json'},
    body: JSON.stringify(heartbeatPayload),
  }).catch(async (error) => {
    await upsertDuckdbOwnerConnectionHeartbeat(heartbeatPayload)
    throw error
  })

  if (!response.ok) {
    await upsertDuckdbOwnerConnectionHeartbeat(heartbeatPayload)
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
