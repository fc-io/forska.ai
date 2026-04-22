import {createRateLimitedLogger} from './rateLimitedLogger.ts'
import {getCurrentServerDuckdbOwnerUrl, shouldCurrentServerProxyApiToOwner} from './serverRuntimeRole.ts'
import {getWriterConnectionHeartbeatPayload, getWriterConnectionProxyHeaders} from './writerConnections.ts'

const writerConnectionHeartbeatLogger = createRateLimitedLogger({windowMs: 30_000})
const writerConnectionHeartbeatIntervalMs = 15_000

const sendWriterConnectionHeartbeat = async () => {
  const writerUrl = await getCurrentServerDuckdbOwnerUrl()

  if (!shouldCurrentServerProxyApiToOwner() || writerUrl === null) {
    return
  }

  const response = await fetch(`${writerUrl}/api/writer_connections/heartbeat`, {
    method: 'POST',
    headers: {...getWriterConnectionProxyHeaders(), 'content-type': 'application/json'},
    body: JSON.stringify(getWriterConnectionHeartbeatPayload()),
  })

  if (!response.ok) {
    throw new Error(`Writer connection heartbeat failed with status ${response.status}`)
  }
}

const logWriterConnectionHeartbeatError = (error: unknown) => {
  return writerConnectionHeartbeatLogger.warn('writer-connection-heartbeat', '[writer] heartbeat failed', error)
}

export const startWriterConnectionHeartbeat = () => {
  const runHeartbeat = () => {
    return void sendWriterConnectionHeartbeat().catch(logWriterConnectionHeartbeatError)
  }
  const interval = setInterval(runHeartbeat, writerConnectionHeartbeatIntervalMs)

  interval.unref()
  runHeartbeat()
  process.once('exit', () => {
    clearInterval(interval)
  })
}
