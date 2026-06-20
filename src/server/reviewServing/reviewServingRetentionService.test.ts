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

test('candidate patch budget assessment uses component table and bounded thresholds', async () => {
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

  expect(result).toEqual([
    {
      baseGeneration: 2,
      component: 'display',
      patchRows: 7,
      patchWatermark: 12,
      patchWatermarks: 3,
      projectionIdentity: 'display:identity-1',
      shouldCompact: true,
    },
  ])
  expect(statements.join('\n')).toContain('FROM mart.review_article_display_patch_v4')
  expect(statements.join('\n')).toContain("display_identity = 'display:identity-1'")
  expect(statements.join('\n')).toContain('base_generation = 2')
})

test('status patch budget assessment uses component scope instead of prompt config identity', async () => {
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

  expect(joined).toContain('FROM mart.review_llm_status_patch_v4')
  expect(joined).toContain('base_generation = 2')
  expect(joined).not.toContain('prompt_config_hash')
  expect(joined).not.toContain('llmStatus:identity-1')
})

test('patch compaction writes a new major base generation before activation', async () => {
  const {database, statements} = createRetentionDatabase({
    budgetRows: {'mart.review_selected_import_patch_v4': {patchRows: 101, patchWatermarks: 2}},
  })

  const result = await compactReviewServingCandidateSnapshotPatches(
    {budget: {maxPatchRows: 100, maxPatchWatermarks: 10}, candidate: candidateManifest()},
    database,
  )
  const joined = statements.join('\n')
  const servingUpdateStatement = statements.find((statement) => {
    return statement.includes('UPDATE mart.review_article_serving_v4 serving')
  })

  expect(result.compactedComponents).toHaveLength(1)
  expect(result.compactedComponents[0]?.component).toBe('selectedImport')
  expect(joined).toContain('INSERT INTO app.review_selected_article_import_v4')
  expect(joined).toContain('FROM mart.review_selected_import_patch_v4 patch')
  expect(joined).toContain('DELETE FROM mart.review_selected_import_patch_v4')
  expect(joined).toContain('UPDATE mart.review_article_serving_v4 serving')
  expect(joined).toContain('FROM app.review_serving_snapshot_manifest snapshot')
  expect(joined).toContain("snapshot.selected_import_snapshot_id = 'selected-import-snapshot-1'")
  expect(servingUpdateStatement).not.toContain("AND selected_import_snapshot_id = 'selected-import-snapshot-1'")
  expect(joined).toContain('base_generation = 5')
  expect(joined).toContain('patch_watermark = 0')
  expect(joined).toContain('UPDATE app.review_serving_snapshot_manifest')
  expect(joined).toContain('"baseGeneration":"5"')
  expect(joined).toContain('composed_identity_json')
  expect(joined).toContain('"componentStates"')
  expect(joined).toContain('reviewServingCompact:project-1:snapshot-candidate:selectedImport:selectedImport:identity-1')
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
  expect(joined).toContain('"tableIndex":1')
})

test('patch cleanup uses component-state protection for pinned snapshot base generations', async () => {
  const {database, statements} = createRetentionDatabase({
    retentionState: {baseGeneration: 0, cursorJson: {tableIndex: 13}, patchWatermark: 0, snapshotId: null},
  })

  await cleanupReviewServingRetentionState(
    {batchSize: 5, now: '2026-06-16T00:00:00.000Z', projectId: 'project-1'},
    database,
  )
  const joined = statements.join('\n')

  expect(joined).toContain('DELETE FROM mart.review_article_display_patch_v4')
  expect(joined).toContain('app.review_projection_identity_manifest manifest')
  expect(joined).toContain('UNION ALL')
  expect(joined).toContain('INNER JOIN app.review_serving_snapshot_manifest pinned_manifest')
  expect(joined).toContain('component_state_json')
  expect(joined).not.toContain('manifest.projection_identity = candidate.display_identity')
  expect(joined).toContain('CAST(candidate.base_generation AS VARCHAR)')
  expect(joined).toContain('LIMIT 5')
})

test('status patch cleanup orders without a nullable identity column', async () => {
  const {database, statements} = createRetentionDatabase({
    retentionState: {baseGeneration: 0, cursorJson: {tableIndex: 14}, patchWatermark: 0, snapshotId: null},
  })

  await cleanupReviewServingRetentionState(
    {batchSize: 5, now: '2026-06-16T00:00:00.000Z', projectId: 'project-1'},
    database,
  )
  const joined = statements.join('\n')

  expect(joined).toContain('DELETE FROM mart.review_llm_status_patch_v4')
  expect(joined).toContain('ORDER BY candidate.base_generation, candidate.patch_watermark')
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
