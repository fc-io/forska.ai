import {spawnSync} from 'node:child_process'
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {hostname} from 'node:os'
import {dirname, join} from 'node:path'

import {expect, test} from 'bun:test'

import {acquireJudgeWorkerJournalIdentity, resolveJudgeWorkerJournalIdentity} from './judgeWorkerJournalIdentity.ts'
import {getLocalMachineFingerprint} from './localMachineIdentity.ts'

type JudgeWorkerJournalLockMetadata = {
  acquiredAt: string
  hostname: string
  journalPath: string
  leaseId: string
  machineFingerprint?: string
  pid: number
  workerId: string | null
}

const createJournalLockPaths = () => {
  const tempParentDirectory = join(process.cwd(), 'data', 'runtime')
  mkdirSync(tempParentDirectory, {recursive: true})

  const tempDirectory = mkdtempSync(join(tempParentDirectory, 'test-judge-worker-journal-'))
  const envValues = {
    DUCKDB_PATH: join(tempDirectory, 'forska.duckdb'),
    JUDGE_WORKER_ID: 'test-judge-worker',
    JUDGE_WORKER_JOURNAL_PATH: '',
  }
  const identity = resolveJudgeWorkerJournalIdentity({envValues})

  mkdirSync(dirname(identity.lockPath), {recursive: true})

  return {envValues, identity, tempDirectory}
}

const readLockMetadata = (lockPath: string): JudgeWorkerJournalLockMetadata => {
  return JSON.parse(readFileSync(lockPath, 'utf8')) as JudgeWorkerJournalLockMetadata
}

const writeLockMetadata = (lockPath: string, metadata: JudgeWorkerJournalLockMetadata) => {
  writeFileSync(lockPath, `${JSON.stringify(metadata, null, 2)}\n`)
}

const getNormalizedCommandOutput = (command: string, args: string[]) => {
  const result = spawnSync(command, args, {encoding: 'utf8'})
  const output = typeof result.stdout === 'string' ? result.stdout.trim() : ''

  return result.status === 0 && output !== '' ? output : null
}

const getDarwinLocalHostname = () => {
  if (process.platform !== 'darwin') {
    return null
  }

  return getNormalizedCommandOutput('/usr/sbin/scutil', ['--get', 'LocalHostName'])
}

const isProcessDead = () => {
  return false
}

test('judge-worker reclaims stale local journal lock for macOS local hostname alias', () => {
  const darwinLocalHostname = getDarwinLocalHostname()

  if (darwinLocalHostname === null) {
    return
  }

  const {envValues, identity, tempDirectory} = createJournalLockPaths()
  let releaseLease: (() => void) | null = null

  try {
    writeLockMetadata(identity.lockPath, {
      acquiredAt: '2026-03-01T00:00:00.000Z',
      hostname: `${darwinLocalHostname}.local`,
      journalPath: identity.journalPath,
      leaseId: 'legacy-local-lock-id',
      pid: 999_999,
      workerId: identity.workerId,
    })

    const lease = acquireJudgeWorkerJournalIdentity({envValues, isProcessAliveValue: isProcessDead})
    releaseLease = lease.release

    expect(lease.metadata.hostname).toBe(hostname())
    expect(lease.metadata.leaseId).not.toBe('legacy-local-lock-id')
    expect(readLockMetadata(identity.lockPath).machineFingerprint).toBeDefined()
  } finally {
    releaseLease?.()
    rmSync(tempDirectory, {force: true, recursive: true})
  }
})

test('judge-worker reclaims stale local journal lock after hostname change when machine fingerprint matches', () => {
  const {envValues, identity, tempDirectory} = createJournalLockPaths()
  let releaseLease: (() => void) | null = null

  try {
    writeLockMetadata(identity.lockPath, {
      acquiredAt: '2026-03-01T00:00:00.000Z',
      hostname: 'renamed-macbook-pro.local',
      journalPath: identity.journalPath,
      leaseId: 'renamed-local-lock-id',
      machineFingerprint: getLocalMachineFingerprint(),
      pid: 999_999,
      workerId: identity.workerId,
    })

    const lease = acquireJudgeWorkerJournalIdentity({envValues, isProcessAliveValue: isProcessDead})
    releaseLease = lease.release

    expect(lease.metadata.hostname).toBe(hostname())
    expect(lease.metadata.leaseId).not.toBe('renamed-local-lock-id')
    expect(readLockMetadata(identity.lockPath).machineFingerprint).toBe(getLocalMachineFingerprint())
  } finally {
    releaseLease?.()
    rmSync(tempDirectory, {force: true, recursive: true})
  }
})

test('judge-worker does not reclaim stale foreign journal lock without matching machine fingerprint', () => {
  const {envValues, identity, tempDirectory} = createJournalLockPaths()

  try {
    writeLockMetadata(identity.lockPath, {
      acquiredAt: '2026-03-01T00:00:00.000Z',
      hostname: 'foreign-machine.local',
      journalPath: identity.journalPath,
      leaseId: 'foreign-lock-id',
      machineFingerprint: 'foreign-machine-fingerprint',
      pid: 999_999,
      workerId: identity.workerId,
    })

    const acquireError = (() => {
      try {
        acquireJudgeWorkerJournalIdentity({envValues, isProcessAliveValue: isProcessDead})
        return null
      } catch (error) {
        return error
      }
    })()

    expect(acquireError).toBeInstanceOf(Error)
    expect((acquireError as Error).message).toContain('Judge-worker journal target collides')
    expect(readLockMetadata(identity.lockPath).leaseId).toBe('foreign-lock-id')
  } finally {
    rmSync(tempDirectory, {force: true, recursive: true})
  }
})
