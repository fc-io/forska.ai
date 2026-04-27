import {randomUUID} from 'node:crypto'
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import {homedir, hostname, tmpdir} from 'node:os'
import {dirname, isAbsolute, join, normalize, resolve, sep} from 'node:path'

import {getConfiguredDuckdbPath} from './getDuckdbPath.ts'
import {getLocalMachineFingerprint, isLockOwnedByCurrentMachine} from './localMachineIdentity.ts'
import {resolveRuntimeFilePath} from './runtimeWritablePath.ts'

export type JudgeWorkerJournalIdentity = {
  journalPath: string
  lockPath: string
  source: 'explicit-path' | 'worker-id'
  workerId: string | null
}

type JudgeWorkerJournalLockMetadata = {
  acquiredAt: string
  hostname: string
  journalPath: string
  leaseId: string
  machineFingerprint?: string
  pid: number
  workerId: string | null
}

type JudgeWorkerJournalLease = {
  identity: JudgeWorkerJournalIdentity
  metadata: JudgeWorkerJournalLockMetadata
  release: () => void
}

type JudgeWorkerJournalState = {lease: JudgeWorkerJournalLease | null}

type ResolveJudgeWorkerJournalIdentityOptions = {cwd?: string; envValues?: Record<string, string | undefined>}

type AcquireJudgeWorkerJournalIdentityOptions = ResolveJudgeWorkerJournalIdentityOptions & {
  isProcessAliveValue?: (pid: number) => boolean
}

declare global {
  var __forskaJudgeWorkerJournalState: JudgeWorkerJournalState | undefined
}

const stableWorkerIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/

const getJudgeWorkerJournalState = () => {
  globalThis.__forskaJudgeWorkerJournalState ??= {lease: null}

  return globalThis.__forskaJudgeWorkerJournalState
}

const getTrimmedValue = (value: string | null | undefined) => {
  const normalizedValue = String(value ?? '').trim()

  return normalizedValue === '' ? null : normalizedValue
}

const expandHomeDirectory = (pathValue: string) => {
  return pathValue === '~' || pathValue.startsWith('~/') || pathValue.startsWith('~\\')
    ? `${homedir()}${pathValue.slice(1)}`
    : pathValue
}

const getNormalizedAbsolutePath = (pathValue: string) => {
  return normalize(isAbsolute(pathValue) ? pathValue : resolve(pathValue))
}

const getPathInsideDirectory = (filePath: string, directoryPath: string) => {
  const normalizedFilePath = getNormalizedAbsolutePath(filePath)
  const normalizedDirectoryPath = getNormalizedAbsolutePath(directoryPath)

  return (
    normalizedFilePath === normalizedDirectoryPath || normalizedFilePath.startsWith(`${normalizedDirectoryPath}${sep}`)
  )
}

const getDurabilityRootCandidates = (envValues: Record<string, string | undefined>) => {
  return Array.from(
    new Set(
      [tmpdir(), envValues.TMPDIR, envValues.TMP, envValues.TEMP, '/tmp', '/private/tmp', '/var/tmp']
        .map((value) => {
          return getTrimmedValue(value)
        })
        .filter((value): value is string => {
          return value !== null
        }),
    ),
  )
}

const assertStableWorkerId = (workerId: string) => {
  if (workerId.match(stableWorkerIdPattern) === null) {
    throw new Error(
      'JUDGE_WORKER_ID must be a stable filesystem-safe id using letters, numbers, dot, underscore, or hyphen.',
    )
  }
}

const assertDurableJournalPath = (journalPath: string, envValues: Record<string, string | undefined>) => {
  if (journalPath === ':memory:') {
    throw new Error('JUDGE_WORKER_JOURNAL_PATH must be file-backed; :memory: is not durable.')
  }

  const matchedNonDurableRoot = getDurabilityRootCandidates(envValues).find((candidate) => {
    return getPathInsideDirectory(journalPath, candidate)
  })

  if (matchedNonDurableRoot !== undefined) {
    throw new Error(
      `JUDGE_WORKER_JOURNAL_PATH must be on durable app-data storage, not under non-durable ${matchedNonDurableRoot}.`,
    )
  }
}

const getJudgeWorkerJournalAppDataRoot = ({
  cwd,
  envValues,
}: {
  cwd: string
  envValues: Record<string, string | undefined>
}) => {
  const duckdbPath = getConfiguredDuckdbPath({cwd, envValues})

  return duckdbPath === ':memory:' ? null : dirname(duckdbPath)
}

const resolveExplicitJournalPath = ({
  cwd,
  envValues,
  journalPath,
}: {
  cwd: string
  envValues: Record<string, string | undefined>
  journalPath: string
}) => {
  const expandedPath = expandHomeDirectory(journalPath)

  return resolveRuntimeFilePath({cwd, envValues, pathValue: expandedPath})
}

const resolveJournalPathFromWorkerId = ({
  cwd,
  envValues,
  workerId,
}: {
  cwd: string
  envValues: Record<string, string | undefined>
  workerId: string
}) => {
  const appDataRoot = getJudgeWorkerJournalAppDataRoot({cwd, envValues})

  if (appDataRoot === null) {
    throw new Error('JUDGE_WORKER_ID cannot derive a durable journal path when DUCKDB_PATH=:memory:.')
  }

  return join(appDataRoot, 'judge-worker-journals', `${workerId}.sqlite`)
}

export const resolveJudgeWorkerJournalIdentity = ({
  cwd = process.cwd(),
  envValues = process.env,
}: ResolveJudgeWorkerJournalIdentityOptions = {}): JudgeWorkerJournalIdentity => {
  const configuredJournalPath = getTrimmedValue(envValues.JUDGE_WORKER_JOURNAL_PATH)
  const configuredWorkerId = getTrimmedValue(envValues.JUDGE_WORKER_ID)

  if (configuredWorkerId !== null) {
    assertStableWorkerId(configuredWorkerId)
  }

  if (configuredJournalPath !== null) {
    const journalPath = resolveExplicitJournalPath({cwd, envValues, journalPath: configuredJournalPath})

    assertDurableJournalPath(journalPath, envValues)

    return {journalPath, lockPath: `${journalPath}.lock`, source: 'explicit-path', workerId: configuredWorkerId}
  }

  if (configuredWorkerId === null) {
    throw new Error('JUDGE_WORKER_ID is required when JUDGE_WORKER_JOURNAL_PATH is omitted.')
  }

  const journalPath = resolveJournalPathFromWorkerId({cwd, envValues, workerId: configuredWorkerId})

  assertDurableJournalPath(journalPath, envValues)

  return {journalPath, lockPath: `${journalPath}.lock`, source: 'worker-id', workerId: configuredWorkerId}
}

const assertWritableJournalTarget = (identity: JudgeWorkerJournalIdentity) => {
  const journalDirectory = dirname(identity.journalPath)
  const shouldCreateDirectory = identity.source === 'worker-id'

  if (shouldCreateDirectory) {
    mkdirSync(journalDirectory, {recursive: true})
  }

  const directoryStats = existsSync(journalDirectory) ? statSync(journalDirectory) : null

  if (directoryStats === null || !directoryStats.isDirectory()) {
    throw new Error(`Judge-worker journal directory is missing or not a directory: ${journalDirectory}`)
  }

  accessSync(journalDirectory, constants.W_OK)

  if (existsSync(identity.journalPath) && statSync(identity.journalPath).isDirectory()) {
    throw new Error(`Judge-worker journal path must be a file, not a directory: ${identity.journalPath}`)
  }

  const journalFile = openSync(identity.journalPath, 'a')
  closeSync(journalFile)
  accessSync(identity.journalPath, constants.W_OK)
}

const isMissingFileError = (error: unknown) => {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

const isExistingFileError = (error: unknown) => {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

const readLockMetadata = (lockPath: string): JudgeWorkerJournalLockMetadata | null => {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<JudgeWorkerJournalLockMetadata>

    return typeof parsed.acquiredAt === 'string'
      && typeof parsed.hostname === 'string'
      && typeof parsed.journalPath === 'string'
      && typeof parsed.leaseId === 'string'
      && typeof parsed.pid === 'number'
      ? {
          acquiredAt: parsed.acquiredAt,
          hostname: parsed.hostname,
          journalPath: parsed.journalPath,
          leaseId: parsed.leaseId,
          machineFingerprint:
            typeof parsed.machineFingerprint === 'string' && parsed.machineFingerprint.length > 0
              ? parsed.machineFingerprint
              : undefined,
          pid: parsed.pid,
          workerId: typeof parsed.workerId === 'string' ? parsed.workerId : null,
        }
      : null
  } catch (error) {
    return isMissingFileError(error) ? null : null
  }
}

const isProcessAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM'
  }
}

const removeLockForLease = (lockPath: string, leaseId: string) => {
  const currentLock = readLockMetadata(lockPath)

  if (currentLock?.leaseId !== leaseId) {
    return
  }

  rmSync(lockPath, {force: true})
}

const getLockOwnerText = (metadata: JudgeWorkerJournalLockMetadata) => {
  return `${metadata.hostname} pid=${metadata.pid} workerId=${metadata.workerId ?? 'not set'}`
}

const acquireLock = (
  identity: JudgeWorkerJournalIdentity,
  isProcessAliveValue: (pid: number) => boolean,
): JudgeWorkerJournalLease => {
  const acquiredAt = new Date().toISOString()
  const metadata = {
    acquiredAt,
    hostname: hostname(),
    journalPath: identity.journalPath,
    leaseId: randomUUID(),
    machineFingerprint: getLocalMachineFingerprint(),
    pid: process.pid,
    workerId: identity.workerId,
  } satisfies JudgeWorkerJournalLockMetadata

  try {
    writeFileSync(identity.lockPath, `${JSON.stringify(metadata, null, 2)}\n`, {flag: 'wx'})

    return {
      identity,
      metadata,
      release: () => {
        removeLockForLease(identity.lockPath, metadata.leaseId)
      },
    }
  } catch (error) {
    if (!isExistingFileError(error)) {
      throw error
    }

    const currentLock = readLockMetadata(identity.lockPath)

    if (currentLock === null) {
      throw new Error(`Judge-worker journal lock is present but unreadable: ${identity.lockPath}`, {cause: error})
    }

    if (isLockOwnedByCurrentMachine(currentLock) && !isProcessAliveValue(currentLock.pid)) {
      rmSync(identity.lockPath, {force: true})
      return acquireLock(identity, isProcessAliveValue)
    }

    throw new Error(
      `Judge-worker journal target collides with another live worker at ${identity.journalPath}; held by ${getLockOwnerText(currentLock)} since ${currentLock.acquiredAt}.`,
      {cause: error},
    )
  }
}

export const acquireJudgeWorkerJournalIdentity = ({
  cwd = process.cwd(),
  envValues = process.env,
  isProcessAliveValue = isProcessAlive,
}: AcquireJudgeWorkerJournalIdentityOptions = {}) => {
  const identity = resolveJudgeWorkerJournalIdentity({cwd, envValues})

  assertWritableJournalTarget(identity)

  return acquireLock(identity, isProcessAliveValue)
}

export const initializeJudgeWorkerJournalIdentity = (
  options: AcquireJudgeWorkerJournalIdentityOptions = {},
): JudgeWorkerJournalIdentity => {
  const state = getJudgeWorkerJournalState()

  if (state.lease !== null) {
    return state.lease.identity
  }

  const lease = acquireJudgeWorkerJournalIdentity(options)
  state.lease = lease

  process.once('exit', () => {
    lease.release()
  })

  return lease.identity
}

export const getCurrentJudgeWorkerJournalIdentity = () => {
  return getJudgeWorkerJournalState().lease?.identity ?? null
}
