import {readFile, stat} from 'node:fs/promises'

export const processLockMalformedRetryIntervalMs = 25
export const processLockMalformedStaleAfterMs = 2_000

export type ProcessLockState<T> =
  | {kind: 'malformed'; modifiedAtMs: number}
  | {kind: 'missing'}
  | {kind: 'valid'; metadata: T}

type ReadProcessLockForAcquisitionOptions<T> = {
  lockPath: string
  now: () => number
  readState: () => Promise<ProcessLockState<T>>
  retryIntervalMs: number
  staleAfterMs: number
  wait: (ms: number) => Promise<void>
}

const isMissingFileError = (error: unknown) => {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

const readMalformedProcessLockState = async (lockPath: string): Promise<ProcessLockState<never>> => {
  try {
    const lockStat = await stat(lockPath)

    return {kind: 'malformed', modifiedAtMs: lockStat.mtimeMs}
  } catch (error) {
    if (isMissingFileError(error)) {
      return {kind: 'missing'}
    }

    throw error
  }
}

export const readJsonProcessLockState = async <T>(
  lockPath: string,
  isMetadata: (value: unknown) => value is T,
): Promise<ProcessLockState<T>> => {
  try {
    const metadata: unknown = JSON.parse(await readFile(lockPath, 'utf8'))

    if (!isMetadata(metadata)) {
      return readMalformedProcessLockState(lockPath)
    }

    return {kind: 'valid', metadata}
  } catch (error) {
    if (isMissingFileError(error)) {
      return {kind: 'missing'}
    }

    if (error instanceof SyntaxError || (error instanceof Error && error.name === 'SyntaxError')) {
      return readMalformedProcessLockState(lockPath)
    }

    throw error
  }
}

const resolveProcessLockState = async <T>(
  state: ProcessLockState<T>,
  options: ReadProcessLockForAcquisitionOptions<T>,
  malformedStateConfirmed: boolean,
): Promise<T | null> => {
  if (state.kind === 'missing') {
    return null
  }

  if (state.kind === 'valid') {
    return state.metadata
  }

  const malformedAgeMs = Math.max(0, options.now() - state.modifiedAtMs)

  if (malformedAgeMs < options.staleAfterMs) {
    const retryDelayMs = Math.max(1, Math.min(options.retryIntervalMs, options.staleAfterMs - malformedAgeMs))

    await options.wait(retryDelayMs)
    return resolveProcessLockState(await options.readState(), options, false)
  }

  if (!malformedStateConfirmed) {
    return resolveProcessLockState(await options.readState(), options, true)
  }

  throw new Error(
    `Process lock at ${options.lockPath} stayed malformed for ${options.staleAfterMs}ms. Inspect it and remove it only after confirming no server stack or dev watcher process is alive.`,
  )
}

export const readProcessLockForAcquisition = async <T>(
  options: ReadProcessLockForAcquisitionOptions<T>,
): Promise<T | null> => {
  return resolveProcessLockState(await options.readState(), options, false)
}
