import {expect, test} from 'bun:test'

import type {ReviewServingDirtyWorkDatabase} from '../src/server/reviewServing/reviewServingDirtyWorkService.ts'
import {
  deleteOrphanReviewServingDirtyWork,
  getDeleteOrphanReviewServingDirtyWorkCliOptions,
  getDeleteOrphanReviewServingDirtyWorkRefusalReasons,
  getNormalizedCreatedBefore,
  getOrphanReviewServingDirtyWorkSelectSql,
  orphanDirtyWorkTempTable,
  requiredApplyAcknowledgement,
  runDeleteOrphanReviewServingDirtyWork,
} from './deleteOrphanReviewServingDirtyWork.ts'

const projectId = '27593e73-8c8e-4db5-bf07-749da2670674'
const createdBeforeInput = '2026-08-22T12:18:41+02:00'
const createdBeforeUtc = '2026-08-22T10:18:41.000Z'

type FakeCounts = {claimStateRows: number; dirtyWorkRows: number; idLookupRows: number}

const createFakeDatabase = (counts: FakeCounts) => {
  const statements: string[] = []
  const transactions: number[] = []
  const database: ReviewServingDirtyWorkDatabase = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      if (statement.includes('AS dirtyWorkRows')) {
        return [counts] as T[]
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

const getDeleteStatements = (statements: string[]) => {
  return statements.filter((statement) => {
    return statement.trimStart().startsWith('DELETE FROM')
  })
}

test('orphan dirty work CLI parses project, created-before, limit, apply and acknowledgement options', () => {
  expect(getDeleteOrphanReviewServingDirtyWorkCliOptions([`--project-id=${projectId}`])).toEqual({
    acknowledgement: null,
    apply: false,
    createdBefore: null,
    limit: null,
    projectId,
  })
  expect(
    getDeleteOrphanReviewServingDirtyWorkCliOptions([
      `--project-id=${projectId}`,
      `--created-before=${createdBeforeInput}`,
      '--limit=500',
      '--apply',
      `--ack=${requiredApplyAcknowledgement}`,
    ]),
  ).toEqual({
    acknowledgement: requiredApplyAcknowledgement,
    apply: true,
    createdBefore: createdBeforeInput,
    limit: 500,
    projectId,
  })
  expect(
    getDeleteOrphanReviewServingDirtyWorkCliOptions([`--project-id=${projectId}`, '--apply', '--dry-run']),
  ).toEqual({acknowledgement: null, apply: false, createdBefore: null, limit: null, projectId})
  expect(getDeleteOrphanReviewServingDirtyWorkCliOptions(['--limit=abc']).limit).toBeNaN()
})

test('orphan dirty work CLI normalises created-before to a UTC instant', () => {
  expect(getNormalizedCreatedBefore(createdBeforeInput)).toBe(createdBeforeUtc)
  expect(getNormalizedCreatedBefore('2026-08-22 12:18:41+02')).toBe(createdBeforeUtc)
  expect(getNormalizedCreatedBefore(null)).toBeNull()
  expect(getNormalizedCreatedBefore('not-a-timestamp')).toBeNull()
})

test('orphan dirty work CLI refuses missing or invalid inputs before touching the database', async () => {
  expect(
    getDeleteOrphanReviewServingDirtyWorkRefusalReasons({
      acknowledgement: null,
      apply: true,
      createdBefore: null,
      limit: null,
      projectId: null,
    }),
  ).toEqual(['missing_project_id', 'missing_created_before', 'missing_apply_acknowledgement'])
  expect(
    getDeleteOrphanReviewServingDirtyWorkRefusalReasons({
      acknowledgement: requiredApplyAcknowledgement,
      apply: true,
      createdBefore: 'yesterday-ish',
      limit: 0,
      projectId,
    }),
  ).toEqual(['invalid_created_before', 'invalid_limit'])
  expect(
    getDeleteOrphanReviewServingDirtyWorkRefusalReasons({
      acknowledgement: null,
      apply: false,
      createdBefore: null,
      limit: null,
      projectId,
    }),
  ).toEqual([])

  const {database, statements} = createFakeDatabase({claimStateRows: 1, dirtyWorkRows: 1, idLookupRows: 1})
  const refused = await runDeleteOrphanReviewServingDirtyWork(
    {acknowledgement: 'wrong', apply: true, createdBefore: createdBeforeInput, limit: null, projectId},
    database,
  )

  expect(refused).toMatchObject({
    acknowledgementRequiredForApply: requiredApplyAcknowledgement,
    applied: false,
    createdBefore: createdBeforeUtc,
    refusalReasons: ['missing_apply_acknowledgement'],
    result: null,
    status: 'refused',
  })
  expect(statements).toEqual([])
})

test('orphan dirty work select scopes to pending null-lane rows of one project before the cutoff', () => {
  const sql = getOrphanReviewServingDirtyWorkSelectSql({createdBefore: createdBeforeUtc, limit: 25, projectId})

  expect(sql).toContain('FROM app.review_serving_dirty_work')
  expect(sql).toContain(`WHERE project_id = '${projectId}'`)
  expect(sql).toContain("AND status = 'pending'")
  expect(sql).toContain('AND projection_component IS NULL')
  expect(sql).toContain(`AND created_at < '${createdBeforeUtc}'::TIMESTAMPTZ`)
  expect(sql).toContain('ORDER BY created_at, dirty_work_id LIMIT 25')

  const unbounded = getOrphanReviewServingDirtyWorkSelectSql({createdBefore: null, limit: null, projectId})

  expect(unbounded).not.toContain('created_at <')
  expect(unbounded).not.toContain('LIMIT')
})

test('orphan dirty work CLI dry-run reports per-table counts without a transaction or writes', async () => {
  const counts = {claimStateRows: 300_271, dirtyWorkRows: 300_271, idLookupRows: 300_271}
  const {database, statements, transactions} = createFakeDatabase(counts)
  const result = await runDeleteOrphanReviewServingDirtyWork(
    {acknowledgement: null, apply: false, createdBefore: createdBeforeInput, limit: null, projectId},
    database,
  )

  expect(result).toMatchObject({
    applied: false,
    createdBefore: createdBeforeUtc,
    limit: null,
    mode: 'delete_orphan_dirty_work',
    projectId,
    refusalReasons: [],
    result: counts,
    status: 'dry_run',
  })
  expect(transactions).toEqual([])
  expect(statements).toHaveLength(1)
  expect(statements[0]).toContain('FROM app.review_serving_dirty_work_claim_state')
  expect(statements[0]).toContain('FROM app.review_serving_dirty_work_id_lookup')
  expect(statements[0]).toContain(`project_id = '${projectId}'`)
  expect(statements[0]).toContain("status = 'pending'")
  expect(statements[0]).toContain('projection_component IS NULL')
  expect(statements[0]).toContain(`created_at < '${createdBeforeUtc}'::TIMESTAMPTZ`)
  expect(getDeleteStatements(statements)).toEqual([])
  expect(statements.join('\n')).not.toContain('CREATE TEMP TABLE')
})

test('orphan dirty work CLI apply deletes companions then rows inside one transaction and leaves acks alone', async () => {
  const counts = {claimStateRows: 3, dirtyWorkRows: 5, idLookupRows: 5}
  const {database, statements, transactions} = createFakeDatabase(counts)
  const result = await runDeleteOrphanReviewServingDirtyWork(
    {
      acknowledgement: requiredApplyAcknowledgement,
      apply: true,
      createdBefore: createdBeforeInput,
      limit: 5,
      projectId,
    },
    database,
  )
  const deletes = getDeleteStatements(statements)
  const joined = statements.join('\n')

  expect(result).toMatchObject({applied: true, applyPreflight: counts, result: counts, status: 'applied'})
  expect(transactions).toHaveLength(1)
  // Everything after the dry-run preflight count runs inside the transaction.
  expect(transactions[0]).toBe(1)

  const createTemp = statements.find((statement) => {
    return statement.includes('CREATE TEMP TABLE')
  })

  expect(createTemp).toContain(`CREATE TEMP TABLE ${orphanDirtyWorkTempTable} AS`)
  expect(createTemp).toContain(`project_id = '${projectId}'`)
  expect(createTemp).toContain("status = 'pending'")
  expect(createTemp).toContain('projection_component IS NULL')
  expect(createTemp).toContain(`created_at < '${createdBeforeUtc}'::TIMESTAMPTZ`)
  expect(createTemp).toContain('ORDER BY created_at, dirty_work_id LIMIT 5')

  expect(deletes).toHaveLength(3)
  expect(deletes[0]).toContain('DELETE FROM app.review_serving_dirty_work_claim_state')
  expect(deletes[1]).toContain('DELETE FROM app.review_serving_dirty_work_id_lookup')
  expect(deletes[2]).toContain('DELETE FROM app.review_serving_dirty_work\n')
  deletes.forEach((statement) => {
    expect(statement).toContain(`WHERE dirty_work_id IN (SELECT dirty_work_id FROM ${orphanDirtyWorkTempTable})`)
  })
  expect(
    statements.findIndex((statement) => {
      return statement.includes('CREATE TEMP TABLE')
    }),
  ).toBeLessThan(statements.indexOf(deletes[0] ?? ''))
  expect(statements.at(-1)).toContain(`DROP TABLE IF EXISTS ${orphanDirtyWorkTempTable}`)

  expect(joined).not.toContain('review_serving_dirty_work_ack')
  expect(joined).not.toContain('watermark')
  expect(joined).not.toContain('UPDATE ')
})

test('orphan dirty work CLI apply is a no-op when nothing matches', async () => {
  const {database, statements, transactions} = createFakeDatabase({
    claimStateRows: 0,
    dirtyWorkRows: 0,
    idLookupRows: 0,
  })
  const result = await runDeleteOrphanReviewServingDirtyWork(
    {
      acknowledgement: requiredApplyAcknowledgement,
      apply: true,
      createdBefore: createdBeforeInput,
      limit: null,
      projectId,
    },
    database,
  )

  expect(result).toMatchObject({applied: false, applySkippedReason: 'no_orphan_dirty_work', status: 'dry_run'})
  expect(transactions).toEqual([])
  expect(getDeleteStatements(statements)).toEqual([])
})

test('orphan dirty work delete helper counts inside the transaction before deleting', async () => {
  const counts = {claimStateRows: 2, dirtyWorkRows: 2, idLookupRows: 2}
  const {database, statements} = createFakeDatabase(counts)
  const result = await deleteOrphanReviewServingDirtyWork(
    {createdBefore: createdBeforeUtc, limit: null, projectId},
    database,
  )
  const countIndex = statements.findIndex((statement) => {
    return statement.includes('AS dirtyWorkRows')
  })
  const firstDeleteIndex = statements.findIndex((statement) => {
    return statement.trimStart().startsWith('DELETE FROM')
  })

  expect(result).toEqual(counts)
  expect(countIndex).toBeGreaterThan(-1)
  expect(countIndex).toBeLessThan(firstDeleteIndex)
  expect(statements[countIndex]).toContain(`FROM ${orphanDirtyWorkTempTable}`)
})
