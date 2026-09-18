import {expect, test} from 'bun:test'

import type {ReviewServingManifestRepositoryDatabase} from '../src/server/reviewServing/reviewServingManifestRepository.ts'
import {
  getFailStaleReviewServingCandidateSnapshotsCliOptions,
  getFailStaleReviewServingCandidateSnapshotsRefusalReasons,
  requiredApplyAcknowledgement,
  runFailStaleReviewServingCandidateSnapshots,
} from './failStaleReviewServingCandidateSnapshots.ts'

type FakeSupersessionRow = {
  createdAt: string
  hasInFlightRebuild: boolean
  isOlderThanReference: boolean
  lastError: string | null
  referenceSnapshotId: string
  reviewConfigHash: string | null
  snapshotId: string
}

const createFakeDatabase = (rows: FakeSupersessionRow[]) => {
  const statements: string[] = []
  const transactions: number[] = []
  const database: ReviewServingManifestRepositoryDatabase = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      if (statement.includes('AS hasInFlightRebuild')) {
        const scopedSnapshotId = statement.match(/candidate\.snapshot_id\s*=\s*'([^']*)'/u)?.[1] ?? null

        return rows.filter((row) => {
          return scopedSnapshotId === null || row.snapshotId === scopedSnapshotId
        }) as T[]
      }

      return [] as T[]
    },
    run: async (statement: string) => {
      statements.push(statement)
    },
    transaction: async (operation) => {
      transactions.push(statements.length)

      return operation(database)
    },
  }

  return {database, statements, transactions}
}

const staleRow: FakeSupersessionRow = {
  createdAt: '2026-08-20 10:00:00+00',
  hasInFlightRebuild: false,
  isOlderThanReference: true,
  lastError: null,
  referenceSnapshotId: '78c6d623',
  reviewConfigHash: 'review-config-1',
  snapshotId: 'b51927d6',
}
const inFlightRow: FakeSupersessionRow = {...staleRow, hasInFlightRebuild: true, snapshotId: 'snapshot-in-flight'}

test('stale candidate snapshot CLI parses project, snapshot, apply and acknowledgement options', () => {
  expect(getFailStaleReviewServingCandidateSnapshotsCliOptions(['--project-id=27593e73'])).toEqual({
    acknowledgement: null,
    apply: false,
    projectId: '27593e73',
    snapshotId: null,
  })
  expect(
    getFailStaleReviewServingCandidateSnapshotsCliOptions([
      '--project-id=27593e73',
      '--snapshot-id=b51927d6',
      '--apply',
      `--ack=${requiredApplyAcknowledgement}`,
    ]),
  ).toEqual({acknowledgement: requiredApplyAcknowledgement, apply: true, projectId: '27593e73', snapshotId: 'b51927d6'})
  expect(
    getFailStaleReviewServingCandidateSnapshotsCliOptions(['--project-id=27593e73', '--apply', '--dry-run']),
  ).toEqual({acknowledgement: null, apply: false, projectId: '27593e73', snapshotId: null})
})

test('stale candidate snapshot CLI refuses missing project id and apply without acknowledgement', async () => {
  expect(
    getFailStaleReviewServingCandidateSnapshotsRefusalReasons({
      acknowledgement: null,
      apply: true,
      projectId: null,
      snapshotId: null,
    }),
  ).toEqual(['missing_project_id', 'missing_apply_acknowledgement'])

  const {database, statements} = createFakeDatabase([staleRow])
  const refused = await runFailStaleReviewServingCandidateSnapshots(
    {acknowledgement: 'wrong', apply: true, projectId: '27593e73', snapshotId: null},
    database,
  )

  expect(refused).toMatchObject({
    acknowledgementRequiredForApply: requiredApplyAcknowledgement,
    applied: false,
    refusalReasons: ['missing_apply_acknowledgement'],
    result: null,
    status: 'refused',
  })
  expect(statements).toEqual([])
})

test('stale candidate snapshot CLI dry-run reports stale and skipped candidates without writes', async () => {
  const {database, statements, transactions} = createFakeDatabase([staleRow, inFlightRow])
  const result = await runFailStaleReviewServingCandidateSnapshots(
    {acknowledgement: null, apply: false, projectId: '27593e73', snapshotId: null},
    database,
  )

  expect(result.status).toBe('dry_run')
  expect(result.applied).toBe(false)
  expect(result.result?.failedSnapshotIds).toEqual([])
  expect(
    result.result?.staleCandidates.map((row) => {
      return row.snapshotId
    }),
  ).toEqual(['b51927d6'])
  expect(result.result?.skipped).toEqual([
    {reasons: ['referenced_by_in_flight_rebuild'], referenceSnapshotId: '78c6d623', snapshotId: 'snapshot-in-flight'},
  ])
  expect(transactions).toEqual([])
  expect(statements).toHaveLength(1)
  expect(statements[0]).toContain("candidate.project_id = '27593e73'")
  expect(statements[0]).toContain("snapshot_status = 'active'")
  expect(statements.join('\n')).not.toContain('UPDATE app.review_serving_snapshot_manifest')
})

test('stale candidate snapshot CLI apply marks only the scoped stale candidate failed inside a transaction', async () => {
  const {database, statements, transactions} = createFakeDatabase([staleRow, inFlightRow])
  const result = await runFailStaleReviewServingCandidateSnapshots(
    {acknowledgement: requiredApplyAcknowledgement, apply: true, projectId: '27593e73', snapshotId: 'b51927d6'},
    database,
  )
  const updates = statements.filter((statement) => {
    return statement.includes('UPDATE app.review_serving_snapshot_manifest')
  })

  expect(result.status).toBe('applied')
  expect(result.applied).toBe(true)
  expect(result.applyPreflight?.status).toBe('dry_run')
  expect(result.result?.failedSnapshotIds).toEqual(['b51927d6'])
  expect(transactions).toHaveLength(1)
  expect(updates).toHaveLength(1)
  expect(updates[0]).toContain("snapshot_status = 'failed'")
  expect(updates[0]).toContain("project_id = '27593e73'")
  expect(updates[0]).toContain("snapshot_id = 'b51927d6'")
  expect(updates[0]).toContain("AND snapshot_status = 'candidate'")
  expect(updates[0]).toContain(
    "last_error = 'superseded by snapshot 78c6d623 (operator failStaleReviewServingCandidateSnapshots)'",
  )
  expect(statements.join('\n')).not.toContain("snapshot_id = 'snapshot-in-flight'")
})

test('stale candidate snapshot CLI apply is a no-op when nothing is stale', async () => {
  const {database, statements} = createFakeDatabase([inFlightRow])
  const result = await runFailStaleReviewServingCandidateSnapshots(
    {acknowledgement: requiredApplyAcknowledgement, apply: true, projectId: '27593e73', snapshotId: null},
    database,
  )

  expect(result).toMatchObject({applied: false, applySkippedReason: 'no_stale_candidate_snapshots', status: 'dry_run'})
  expect(statements.join('\n')).not.toContain('UPDATE app.review_serving_snapshot_manifest')
})
