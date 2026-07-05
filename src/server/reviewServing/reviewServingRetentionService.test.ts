import {expect, test} from 'bun:test'

import {type ReviewServingSnapshotManifest} from './reviewServingManifestRepository.ts'
import {
  assessReviewServingCandidatePatchBudgets,
  cleanupReviewServingRetentionState,
  compactReviewServingCandidateSnapshotPatches,
  getReviewServingRetentionCleanupTargets,
  type ReviewServingRetentionServiceDatabase,
} from './reviewServingRetentionService.ts'

const createRetentionDatabase = (input?: {
  budgetRows?: Record<string, {patchRows: number; patchWatermarks: number}>
  cleanupTargetRows?: readonly {projectId: string; reviewConfigHash: string | null}[]
  retentionState?: {baseGeneration: number; cursorJson: unknown; patchWatermark: number; snapshotId: string | null}
}) => {
  const statements: string[] = []
  const database: ReviewServingRetentionServiceDatabase = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      if (statement.includes('FROM app.review_serving_retention_mark')) {
        return (input?.retentionState === undefined ? [] : [input.retentionState]) as T[]
      }

      if (statement.includes('FROM app.review_serving_snapshot_manifest') && statement.includes('GROUP BY')) {
        return (input?.cleanupTargetRows ?? []) as T[]
      }

      const budgetKey = Object.keys(input?.budgetRows ?? {}).find((key) => {
        return statement.includes(key)
      })

      return [input?.budgetRows?.[budgetKey ?? ''] ?? {patchRows: 0, patchWatermarks: 0}] as T[]
    },
    run: async (statement: string) => {
      statements.push(statement)
    },
    transaction: async (operation) => {
      return operation(database)
    },
  }

  return {database, statements}
}

const candidateManifest = (input?: Partial<ReviewServingSnapshotManifest>): ReviewServingSnapshotManifest => {
  return {
    componentState: {
      optional: [],
      required: [
        {
          baseGeneration: '4',
          component: 'selectedImport',
          patchWatermark: '8',
          projectionIdentity: 'selectedImport:identity-1',
          requirement: 'required',
        },
      ],
    },
    composedIdentity: {
      componentStates: {
        optional: [],
        required: [
          {
            baseGeneration: '4',
            component: 'selectedImport',
            patchWatermark: '8',
            projectionIdentity: 'selectedImport:identity-1',
          },
        ],
      },
      snapshot: 'candidate',
    },
    lastError: null,
    lastKnownGoodSnapshotId: 'snapshot-lkg',
    optionalComponents: [],
    projectId: 'project-1',
    requiredComponents: ['selectedImport'],
    reviewConfigHash: 'review-config-1',
    selectedImportSnapshotId: 'selected-import-snapshot-1',
    snapshotId: 'snapshot-candidate',
    sourceWatermarks: {review: 8},
    status: 'candidate',
    validationResult: null,
    ...input,
  }
}

test('candidate patch budget assessment skips legacy runtime patch tables', async () => {
  const candidate = candidateManifest({
    componentState: {
      optional: [],
      required: [
        {
          baseGeneration: '2',
          component: 'display',
          patchWatermark: '12',
          projectionIdentity: 'display:identity-1',
          requirement: 'required',
        },
      ],
    },
    requiredComponents: ['display'],
  })
  const {database, statements} = createRetentionDatabase({
    budgetRows: {'mart.review_article_display_patch_v4': {patchRows: 7, patchWatermarks: 3}},
  })

  const result = await assessReviewServingCandidatePatchBudgets(
    {budget: {maxPatchRows: 10, maxPatchWatermarks: 2}, candidate},
    database,
  )

  expect(result).toEqual([])
  expect(statements.join('\n')).not.toContain('mart.review_article_display_patch_v4')
})

test('status patch budget assessment skips legacy runtime patch tables', async () => {
  const candidate = candidateManifest({
    componentState: {
      optional: [],
      required: [
        {
          baseGeneration: '2',
          component: 'llmStatus',
          patchWatermark: '12',
          projectionIdentity: 'llmStatus:identity-1',
          requirement: 'required',
        },
      ],
    },
    requiredComponents: ['llmStatus'],
  })
  const {database, statements} = createRetentionDatabase({
    budgetRows: {'mart.review_llm_status_patch_v4': {patchRows: 7, patchWatermarks: 3}},
  })

  await assessReviewServingCandidatePatchBudgets(
    {budget: {maxPatchRows: 10, maxPatchWatermarks: 2}, candidate},
    database,
  )

  const joined = statements.join('\n')

  expect(joined).not.toContain('mart.review_llm_status_patch_v4')
  expect(joined).not.toContain('prompt_config_hash')
  expect(joined).not.toContain('llmStatus:identity-1')
})

test('patch compaction is a no-op without legacy runtime patch tables', async () => {
  const {database, statements} = createRetentionDatabase({
    budgetRows: {'mart.review_selected_import_patch_v4': {patchRows: 101, patchWatermarks: 2}},
  })

  const result = await compactReviewServingCandidateSnapshotPatches(
    {budget: {maxPatchRows: 100, maxPatchWatermarks: 10}, candidate: candidateManifest()},
    database,
  )
  const joined = statements.join('\n')
  expect(result.compactedComponents).toEqual([])
  expect(joined).not.toContain('mart.review_selected_import_patch_v4')
  expect(joined).not.toContain('UPDATE mart.review_article_serving_v4 serving')
})

test('fresh direct candidate snapshots skip incremental patch compaction scans', async () => {
  const {database, statements} = createRetentionDatabase({
    budgetRows: {'mart.review_selected_import_patch_v4': {patchRows: 101, patchWatermarks: 2}},
  })

  const result = await compactReviewServingCandidateSnapshotPatches(
    {
      budget: {maxPatchRows: 100, maxPatchWatermarks: 10},
      candidate: candidateManifest({
        componentState: {
          optional: [],
          required: [
            {
              baseGeneration: '4',
              component: 'selectedImport',
              patchWatermark: '0',
              projectionIdentity: 'selectedImport:identity-1',
              requirement: 'required',
            },
          ],
        },
      }),
    },
    database,
  )

  expect(result.compactedComponents).toEqual([])
  expect(statements.join('\n')).not.toContain('mart.review_selected_import_patch_v4')
})

test('retention cleanup advances a bounded cursor and protects active, last-known-good, and pinned snapshots', async () => {
  const {database, statements} = createRetentionDatabase()

  const result = await cleanupReviewServingRetentionState(
    {batchSize: 25, now: '2026-06-16T00:00:00.000Z', projectId: 'project-1', reviewConfigHash: 'review-config-1'},
    database,
  )
  const joined = statements.join('\n')

  expect(result).toEqual({retentionScope: 'reviewServing:project-1:review-config-1'})
  expect(joined).toContain('DELETE FROM mart.review_article_serving_v4')
  expect(joined).toContain("snapshot_status = 'active'")
  expect(joined).toContain('last_known_good_snapshot_id')
  expect(joined).toContain('FROM app.review_serving_snapshot_pin pin')
  expect(joined).toContain('released_at IS NULL AND ref_count > 0 AND expires_at > TIMESTAMPTZ')
  expect(joined).toContain('LIMIT 25')
  expect(joined).toContain('INSERT INTO app.review_serving_retention_mark')
  expect(joined).toContain('updated_at = excluded.updated_at')
  expect(joined).toContain('"tableIndex":1')
})

test('retention cleanup purges legacy selected-import patch tables in bounded batches', async () => {
  const {database, statements} = createRetentionDatabase({
    retentionState: {baseGeneration: 0, cursorJson: {tableIndex: 13}, patchWatermark: 0, snapshotId: null},
  })

  await cleanupReviewServingRetentionState(
    {batchSize: 5, now: '2026-06-16T00:00:00.000Z', projectId: 'project-1'},
    database,
  )
  const joined = statements.join('\n')

  expect(joined).toContain('DELETE FROM mart.review_selected_import_patch_v4')
  expect(joined).toContain("WHERE candidate.project_id = 'project-1'")
  expect(joined).toContain('ORDER BY candidate.rowid')
  expect(joined).toContain('LIMIT 5')
})

test('status patch cleanup purges legacy status patch tables without protected snapshot predicates', async () => {
  const {database, statements} = createRetentionDatabase({
    retentionState: {baseGeneration: 0, cursorJson: {tableIndex: 14}, patchWatermark: 0, snapshotId: null},
  })

  await cleanupReviewServingRetentionState(
    {batchSize: 5, now: '2026-06-16T00:00:00.000Z', projectId: 'project-1'},
    database,
  )
  const joined = statements.join('\n')

  expect(joined).toContain('DELETE FROM mart.review_llm_status_patch_v4')
  expect(joined).toContain('ORDER BY candidate.rowid')
  expect(joined).not.toContain('candidate.null')
})

test('retention cleanup target discovery scopes normal cleanup by project and review config', async () => {
  const {database, statements} = createRetentionDatabase({
    cleanupTargetRows: [{projectId: 'project-1', reviewConfigHash: 'review-config-1'}],
  })

  const targets = await getReviewServingRetentionCleanupTargets(
    {cleanupBatchSize: 25, now: '2026-06-16T00:00:00.000Z', targetLimit: 3},
    database,
  )

  expect(targets).toEqual([
    {batchSize: 25, now: '2026-06-16T00:00:00.000Z', projectId: 'project-1', reviewConfigHash: 'review-config-1'},
  ])
  expect(statements.join('\n')).toContain("snapshot_status IN ('active', 'retired', 'failed')")
  expect(statements.join('\n')).toContain('GROUP BY project_id, review_config_hash')
  expect(statements.join('\n')).toContain('LIMIT 3')
})
