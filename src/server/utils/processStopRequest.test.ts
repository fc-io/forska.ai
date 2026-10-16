import {existsSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {afterEach, expect, test} from 'bun:test'

import {
  checkProcessStopRequest,
  getProcessStopRequestPath,
  processStopRequestStartSlackMs,
  readProcessStopRequest,
  removeProcessStopRequest,
  shouldUseProcessStopRequests,
  startProcessStopRequestWatcher,
  writeProcessStopRequest,
} from './processStopRequest.ts'

const directories: string[] = []

const createDirectory = () => {
  const directory = mkdtempSync(join(tmpdir(), 'forska-stop-request-test-'))
  directories.push(directory)
  return directory
}

afterEach(() => {
  directories.splice(0).map((directory) => {
    return rmSync(directory, {force: true, recursive: true})
  })
})

test('stop requests replace signals only on Windows', () => {
  expect(shouldUseProcessStopRequests('win32')).toBe(true)
  expect(shouldUseProcessStopRequests('darwin')).toBe(false)
  expect(shouldUseProcessStopRequests('linux')).toBe(false)
})

test('a stop request is addressed to one pid and consumed by the first check after the process started', () => {
  const directory = createDirectory()
  const request = writeProcessStopRequest({
    directory,
    now: () => {
      return 10_000
    },
    pid: 4242,
    reason: 'stop maintenance',
  })

  expect(request).toEqual({pid: 4242, reason: 'stop maintenance', requestedAtMs: 10_000, requesterPid: process.pid})
  expect(checkProcessStopRequest({directory, pid: 4343, processStartedAtMs: 9_000})).toEqual({
    request: null,
    status: 'none',
  })
  expect(checkProcessStopRequest({directory, pid: 4242, processStartedAtMs: 9_000})).toEqual({
    request,
    status: 'requested',
  })
  expect(existsSync(getProcessStopRequestPath(4242, directory))).toBe(false)
  expect(checkProcessStopRequest({directory, pid: 4242, processStartedAtMs: 9_000}).status).toBe('none')
})

test('a stop request left for an earlier process with the same pid is discarded instead of stopping the new one', () => {
  const directory = createDirectory()
  const processStartedAtMs = 100_000

  writeProcessStopRequest({
    directory,
    now: () => {
      return processStartedAtMs - processStopRequestStartSlackMs - 1
    },
    pid: 4242,
    reason: 'old',
  })

  expect(checkProcessStopRequest({directory, pid: 4242, processStartedAtMs}).status).toBe('stale')
  expect(existsSync(getProcessStopRequestPath(4242, directory))).toBe(false)

  writeProcessStopRequest({
    directory,
    now: () => {
      return processStartedAtMs - processStopRequestStartSlackMs
    },
    pid: 4242,
    reason: 'new',
  })

  expect(checkProcessStopRequest({directory, pid: 4242, processStartedAtMs}).status).toBe('requested')
})

test('malformed or mismatched stop request files are ignored', () => {
  const directory = createDirectory()

  writeFileSync(getProcessStopRequestPath(4242, directory), '{not json')
  expect(readProcessStopRequest(4242, directory)).toBeNull()

  writeFileSync(
    getProcessStopRequestPath(4242, directory),
    JSON.stringify({pid: 1, reason: 'x', requestedAtMs: 1, requesterPid: 1}),
  )
  expect(readProcessStopRequest(4242, directory)).toBeNull()

  removeProcessStopRequest(4242, directory)
  removeProcessStopRequest(4242, directory)
  expect(existsSync(getProcessStopRequestPath(4242, directory))).toBe(false)
})

test('the watcher calls back once for a fresh request and then stops polling', async () => {
  const directory = createDirectory()
  const requests: string[] = []
  const stop = startProcessStopRequestWatcher({
    directory,
    onStopRequest: (request) => {
      requests.push(request.reason)
    },
    pid: 4242,
    pollIntervalMs: 5,
    processStartedAtMs: Date.now(),
  })

  await globalThis.Bun.sleep(15)
  expect(requests).toEqual([])

  writeProcessStopRequest({directory, pid: 4242, reason: 'first'})
  await globalThis.Bun.sleep(30)
  writeProcessStopRequest({directory, pid: 4242, reason: 'second'})
  await globalThis.Bun.sleep(30)
  stop()

  expect(requests).toEqual(['first'])
  expect(readProcessStopRequest(4242, directory)?.reason).toBe('second')
})
