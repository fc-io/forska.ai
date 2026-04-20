import {expect, test} from 'bun:test'

import {recordWriterConnectionProxy, upsertWriterConnectionHeartbeat} from './writerConnections.ts'

const getWriterHeaders = (startedAt: string) => {
  return new Headers({
    'x-forska-api-server-port': '4010',
    'x-forska-hostname': 'test-host',
    'x-forska-instance-id': `api-server:test-host:4010:12345:${startedAt}`,
    'x-forska-listen-port': '4010',
    'x-forska-pid': '12345',
    'x-forska-process-started-at': startedAt,
    'x-forska-runtime-profile': 'primary',
    'x-forska-server-role': 'api',
    'x-forska-service': 'api-server',
    'x-forska-started-at': startedAt,
    'x-forska-writer-url': 'http://127.0.0.1:4011/',
  })
}

test('tracks writer connection heartbeats and proxy metadata', () => {
  const startedAt = new Date().toISOString()
  const heartbeat = upsertWriterConnectionHeartbeat({
    apiServerPort: 4010,
    hostname: 'test-host',
    instanceId: `api-server:test-host:4010:12345:${startedAt}`,
    listenPort: 4010,
    pid: 12345,
    processStartedAt: startedAt,
    runtimeProfile: 'primary',
    serverRole: 'api',
    service: 'api-server',
    startedAt,
    writerUrl: 'http://127.0.0.1:4011',
  })
  const proxied = recordWriterConnectionProxy(getWriterHeaders(startedAt), '/api/projects')

  expect(heartbeat.connectionId).toBe(`api-server:test-host:4010:12345:${startedAt}`)
  expect(heartbeat.instanceId).toBe(heartbeat.connectionId)
  expect(heartbeat.processStartedAt).toBe(startedAt)
  expect(heartbeat.service).toBe('api-server')
  expect(proxied?.connectionId).toBe(heartbeat.connectionId)
  expect(proxied?.lastRequestPath).toBe('/api/projects')
  expect(proxied?.proxyCount).toBe(1)
  expect(proxied?.runtimeProfile).toBe('primary')
  expect(proxied?.writerUrl).toBe('http://127.0.0.1:4011')
})
