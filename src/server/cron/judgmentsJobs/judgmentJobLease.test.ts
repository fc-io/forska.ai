import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {hostname} from 'node:os'
import {join} from 'node:path'

import {afterAll, expect, test} from 'bun:test'

const tempDirectory = mkdtempSync('/tmp/f1-judgment-job-lease-')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = join(tempDirectory, 'test.duckdb')
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

const writeLeaseMetadata = async (jobId: string, metadata: Record<string, unknown>) => {
  const {getJudgmentJobLeasePath} = await import('./judgmentJobPaths.ts')
  writeFileSync(
    getJudgmentJobLeasePath(jobId),
    `${JSON.stringify(metadata, null, 2)}
`,
  )
}

afterAll(() => {
  rmSync(tempDirectory, {force: true, recursive: true})
})

test('acquires and releases a same-host job lease', async () => {
  const {acquireJudgmentJobLease, readJudgmentJobLease, releaseJudgmentJobLease} = await import('./judgmentJobLease.ts')
  const jobId = `job-${Date.now()}`

  const lease = await acquireJudgmentJobLease({apiServerPort: 3001, jobId, serverJobId: 'server-job-a'})
  const storedLease = await readJudgmentJobLease(jobId)

  expect(storedLease?.jobId).toBe(jobId)
  expect(storedLease?.serverJobId).toBe('server-job-a')

  await releaseJudgmentJobLease(lease)

  expect(await readJudgmentJobLease(jobId)).toBeNull()
})

test('does not acquire an active foreign lease', async () => {
  const {JudgmentJobLeaseHeldError, acquireJudgmentJobLease, isJudgmentJobLeaseHeldError} =
    await import('./judgmentJobLease.ts')
  const jobId = `job-foreign-${Date.now()}`

  await writeLeaseMetadata(jobId, {
    acquiredAt: new Date().toISOString(),
    apiServerPort: 3999,
    heartbeatAt: new Date().toISOString(),
    hostname: 'foreign-machine.local',
    jobId,
    leaseId: 'foreign-lease-id',
    machineFingerprint: 'foreign-machine-fingerprint',
    pid: 999_999,
    serverJobId: 'server-job-foreign',
  })

  const acquireError = await acquireJudgmentJobLease({apiServerPort: 3001, jobId, serverJobId: 'server-job-b'})
    .then(() => {
      return null
    })
    .catch((error: unknown) => {
      return error
    })

  expect(acquireError).toBeInstanceOf(Error)
  expect(acquireError).toBeInstanceOf(JudgmentJobLeaseHeldError)
  expect(isJudgmentJobLeaseHeldError(acquireError)).toBe(true)
  expect((acquireError as Error).message).toContain('Judgment job lease for')
})

test('reclaims a stale same-host lease', async () => {
  const {acquireJudgmentJobLease} = await import('./judgmentJobLease.ts')
  const jobId = `job-stale-${Date.now()}`

  await writeLeaseMetadata(jobId, {
    acquiredAt: '2026-03-01T00:00:00.000Z',
    apiServerPort: 3999,
    heartbeatAt: '2026-03-01T00:00:00.000Z',
    hostname: hostname(),
    jobId,
    leaseId: 'stale-lease-id',
    pid: 999_999,
    serverJobId: 'server-job-old',
  })

  const lease = await acquireJudgmentJobLease({apiServerPort: 3001, jobId, serverJobId: 'server-job-new'})
  const storedLease = JSON.parse(readFileSync(lease.leasePath, 'utf8')) as {leaseId: string; serverJobId: string}

  expect(storedLease.leaseId).not.toBe('stale-lease-id')
  expect(storedLease.serverJobId).toBe('server-job-new')
})
