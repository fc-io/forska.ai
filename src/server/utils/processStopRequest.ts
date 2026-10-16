import {mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

export type ProcessStopRequest = {pid: number; reason: string; requestedAtMs: number; requesterPid: number}

export type ProcessStopRequestCheck =
  | {request: ProcessStopRequest; status: 'requested'}
  | {request: ProcessStopRequest; status: 'stale'}
  | {request: null; status: 'none'}

export type ProcessStopRequestWatcherInput = {
  directory?: string
  onStopRequest: (request: ProcessStopRequest) => void
  pid?: number
  pollIntervalMs?: number
  processStartedAtMs?: number
}

export const processStopRequestPollIntervalMs = 250
export const processStopRequestStartSlackMs = 5_000

const processStopRequestDirectoryName = 'forska-stop-requests'

export const shouldUseProcessStopRequests = (platform: string = process.platform) => {
  return platform === 'win32'
}

export const getProcessStopRequestDirectory = () => {
  return join(tmpdir(), processStopRequestDirectoryName)
}

export const getProcessStopRequestPath = (pid: number, directory = getProcessStopRequestDirectory()) => {
  return join(directory, `${pid}.json`)
}

const isProcessStopRequest = (value: unknown, pid: number): value is ProcessStopRequest => {
  const request = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null

  return (
    request !== null
    && request.pid === pid
    && typeof request.reason === 'string'
    && typeof request.requestedAtMs === 'number'
    && Number.isFinite(request.requestedAtMs)
    && typeof request.requesterPid === 'number'
  )
}

const parseProcessStopRequest = (text: string, pid: number) => {
  try {
    const value: unknown = JSON.parse(text)

    return isProcessStopRequest(value, pid) ? value : null
  } catch {
    return null
  }
}

const readProcessStopRequestText = (requestPath: string) => {
  try {
    return readFileSync(requestPath, 'utf8')
  } catch {
    return null
  }
}

export const readProcessStopRequest = (pid: number, directory = getProcessStopRequestDirectory()) => {
  const text = readProcessStopRequestText(getProcessStopRequestPath(pid, directory))

  return text === null ? null : parseProcessStopRequest(text, pid)
}

export const writeProcessStopRequest = ({
  directory = getProcessStopRequestDirectory(),
  now = Date.now,
  pid,
  reason,
}: {
  directory?: string
  now?: () => number
  pid: number
  reason: string
}) => {
  const requestPath = getProcessStopRequestPath(pid, directory)
  const temporaryPath = `${requestPath}.${process.pid}.tmp`
  const request: ProcessStopRequest = {pid, reason, requestedAtMs: now(), requesterPid: process.pid}

  mkdirSync(directory, {recursive: true})
  writeFileSync(temporaryPath, JSON.stringify(request))
  renameSync(temporaryPath, requestPath)

  return request
}

export const removeProcessStopRequest = (pid: number, directory = getProcessStopRequestDirectory()) => {
  rmSync(getProcessStopRequestPath(pid, directory), {force: true})
}

export const checkProcessStopRequest = ({
  directory = getProcessStopRequestDirectory(),
  pid = process.pid,
  processStartedAtMs = performance.timeOrigin,
}: {
  directory?: string
  pid?: number
  processStartedAtMs?: number
}): ProcessStopRequestCheck => {
  const request = readProcessStopRequest(pid, directory)

  if (request === null) {
    return {request: null, status: 'none'}
  }

  removeProcessStopRequest(pid, directory)

  return request.requestedAtMs >= processStartedAtMs - processStopRequestStartSlackMs
    ? {request, status: 'requested'}
    : {request, status: 'stale'}
}

export const startProcessStopRequestWatcher = ({
  directory = getProcessStopRequestDirectory(),
  onStopRequest,
  pid = process.pid,
  pollIntervalMs = processStopRequestPollIntervalMs,
  processStartedAtMs = performance.timeOrigin,
}: ProcessStopRequestWatcherInput) => {
  const stop = () => {
    clearInterval(timer)
  }
  const poll = () => {
    const check = checkProcessStopRequest({directory, pid, processStartedAtMs})

    if (check.status !== 'requested') {
      return
    }

    stop()
    onStopRequest(check.request)
  }
  const timer = setInterval(poll, pollIntervalMs)

  timer.unref()
  poll()

  return stop
}
