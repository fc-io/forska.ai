import {readdirSync, readFileSync} from 'node:fs'
import {join, relative} from 'node:path'

import {expect, test} from 'bun:test'

import {type ReviewServingProjectorWriterDatabase} from './reviewServingProjectorWriter.ts'
import {
  getReviewServingProjectorReplayKey,
  writeReviewServingProjectorComponent,
  writeReviewServingQueueRebuildRows,
} from './reviewServingProjectorWriter.ts'

const workspaceRoot = join(import.meta.dir, '../../..')

const getTypeScriptFiles = (directory: string): readonly string[] => {
  return readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
    const path = join(directory, entry.name)

    return entry.isDirectory() ? getTypeScriptFiles(path) : path.endsWith('.ts') ? [path] : []
  })
}

const createWriterDatabase = () => {
  const statements: string[] = []
  const database: ReviewServingProjectorWriterDatabase = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      if (statement.includes('FROM app.review_selected_import_snapshot')) {
        return [{status: 'completed'}] as T[]
      }

      if (statement.includes('FROM app.review_projection_identity_manifest')) {
        return [
          {
            baseGeneration: 1,
            definitionVersion: 'display-v1',
            inputDigest: null,
            inputWatermark: 8,
            inputWatermarksJson: JSON.stringify({reviewChange: 8}),
            invalidationReason: null,
            manifestId: 'display-manifest-1',
            patchRangeEnd: null,
            patchRangeStart: null,
            patchWatermark: 2,
            projectId: 'project-1',
            projectionComponent: 'display',
            projectionIdentity: 'display:identity-1',
            promptConfigHash: null,
            reviewConfigHash: 'review-config-1',
            status: 'candidate',
          },
        ] as T[]
      }

      if (statement.includes('FROM app.review_serving_snapshot_manifest') && statement.includes('snapshot_id =')) {
        return [
          {
            componentStateJson: JSON.stringify({
              optional: [],
              required: [
                {
                  baseGeneration: '1',
                  component: 'display',
                  patchWatermark: '2',
                  projectionIdentity: 'display:identity-1',
                  requirement: 'required',
                },
              ],
            }),
            composedIdentityJson: JSON.stringify({route: 'review.llm.rows', version: 1}),
            lastError: null,
            lastKnownGoodSnapshotId: null,
            optionalComponentsJson: JSON.stringify([]),
            projectId: 'project-1',
            requiredComponentsJson: JSON.stringify(['display']),
            reviewConfigHash: 'review-config-1',
            selectedImportSnapshotId: 'selected-import-1',
            snapshotId: 'snapshot-1',
            snapshotStatus: 'candidate',
            sourceWatermarksJson: JSON.stringify({reviewChange: 8}),
            validationResultJson: null,
          },
        ] as T[]
      }

      return [] as T[]
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

test('projector replay keys include snapshot, generation, watermark, identity, and row scope', () => {
  const first = getReviewServingProjectorReplayKey({
    articleId: 'article-1',
    baseGeneration: 4,
    contributionKey: 'summary:review.list.total',
    filterKey: 'publicationYear:2026',
    patchWatermark: 9,
    projectionIdentity: 'summary:identity-1',
    promptId: 'prompt-1',
    snapshotId: 'snapshot-1',
  })
  const replay = getReviewServingProjectorReplayKey({
    articleId: 'article-1',
    baseGeneration: 4,
    contributionKey: 'summary:review.list.total',
    filterKey: 'publicationYear:2026',
    patchWatermark: 9,
    projectionIdentity: 'summary:identity-1',
    promptId: 'prompt-1',
    snapshotId: 'snapshot-1',
  })
  const nextPatch = getReviewServingProjectorReplayKey({
    articleId: 'article-1',
    baseGeneration: 4,
    contributionKey: 'summary:review.list.total',
    filterKey: 'publicationYear:2026',
    patchWatermark: 10,
    projectionIdentity: 'summary:identity-1',
    promptId: 'prompt-1',
    snapshotId: 'snapshot-1',
  })

  expect(first).toBe(replay)
  expect(first).not.toBe(nextPatch)
})

test('queue rebuild rows upsert overlapping split chunk boundary rows', async () => {
  const {database, statements} = createWriterDatabase()

  await writeReviewServingQueueRebuildRows(
    {
      projectId: 'project-1',
      queueIdentitySql: "'queue:article-1:prompt-1'",
      rangePredicateSql: "AND article_id >= 'article-1' AND article_id <= 'article-2'",
      rebuildSourceCtesSql: `queue_union AS (
        SELECT
          'review-config-1' AS review_config_hash,
          'unassessed' AS queue_kind,
          0 AS priority_bucket,
          current_timestamp AS activity_sort_at,
          'article-1' AS article_id,
          'prompt-1' AS prompt_id,
          false AS tombstone
      )`,
      reviewConfigHash: 'review-config-1',
      snapshotId: 'snapshot-1',
    },
    database,
  )

  const insertStatement = statements.find((statement) => {
    return statement.includes('INSERT INTO mart.review_unassessed_queue_serving_v4')
  })

  expect(insertStatement).toContain(
    'ON CONFLICT(project_id, review_config_hash, snapshot_id, queue_kind, priority_bucket, activity_sort_at, article_id, prompt_id, queue_identity) DO UPDATE SET',
  )
  expect(insertStatement).toContain('queue_updated_at = excluded.queue_updated_at')
})

test('projector writer updates rows, manifests, acknowledgements, watermarks, and promotion in one transaction', async () => {
  const {database, statements} = createWriterDatabase()

  await writeReviewServingProjectorComponent(
    {
      acknowledgements: [
        {
          articleId: 'article-1',
          dirtyKind: 'article.display.updated',
          dirtyRangeEnd: null,
          dirtyRangeStart: null,
          dirtyWorkId: 'dirty-work-1',
          firstSourceHighWaterMark: 7,
          latestDeltaId: 'delta-1',
          latestSourceHighWaterMark: 8,
          projectId: 'project-1',
          projectionComponent: 'display',
          projectionIdentity: 'display:identity-1',
          scopeId: 'project-1:article-1',
          scopeKind: 'article',
          sourcePartition: 'review-change',
          status: 'running',
        },
      ],
      component: 'display',
      projectionManifests: [
        {
          baseGeneration: 1,
          definitionVersion: 'display-v1',
          inputWatermark: 8,
          patchWatermark: 2,
          projectId: 'project-1',
          projectionComponent: 'display',
          projectionIdentity: 'display:identity-1',
          status: 'candidate',
        },
      ],
      records: [
        {
          keyColumns: ['project_id', 'review_config_hash', 'snapshot_id', 'list_mode_key', 'article_id'],
          table: 'mart.review_article_serving_v4',
          values: {
            article_id: 'article-1',
            article_title: 'Title',
            base_generation: 1,
            display_identity: 'display:identity-1',
            list_mode_key: 'llm',
            patch_watermark: 2,
            project_id: 'project-1',
            project_scope_identity: 'scope:identity-1',
            review_config_hash: 'review-config-1',
            snapshot_id: 'snapshot-1',
          },
        },
      ],
      repairDirtyWork: [
        {
          articleId: 'article-2',
          latestDeltaId: 'repair-delta-1',
          projectionComponent: 'display',
          projectionIdentity: 'display:identity-1',
          scope: {
            affectedComponents: ['display'],
            dirtyKind: 'article.display.updated',
            dirtyRangeEnd: 'article-2',
            dirtyRangeStart: 'article-2',
            firstAffectedComponent: 'display',
            projectId: 'project-1',
            projectionKey: null,
            scopeId: 'project-1:article-2',
            scopeKind: 'article',
            sourceHighWaterMark: 9,
            sourcePartition: 'review-change',
          },
        },
      ],
      candidateSnapshot: {
        componentRequirements: {optionalComponents: [], requiredComponents: ['display']},
        componentState: {
          optional: [],
          required: [
            {
              baseGeneration: '1',
              component: 'display',
              patchWatermark: '2',
              projectionIdentity: 'display:identity-1',
              requirement: 'required',
            },
          ],
        },
        composedIdentity: {route: 'review.llm.rows', version: 1},
        projectId: 'project-1',
        reviewConfigHash: 'review-config-1',
        selectedImportSnapshotId: 'selected-import-1',
        snapshotId: 'snapshot-1',
        sourceWatermarks: {reviewChange: 8},
      },
      snapshotPromotion: {projectId: 'project-1', reviewConfigHash: 'review-config-1', snapshotId: 'snapshot-1'},
      watermark: {
        projectId: 'project-1',
        projectionComponent: 'display',
        projectorName: 'display-projector',
        sourceHighWaterMark: 8,
        sourcePartition: 'review-change',
      },
    },
    database,
  )

  expect(
    statements.some((statement) => {
      return statement.includes('FROM app.review_source_change_outbox')
    }),
  ).toBe(true)
  expect(
    statements.some((statement) => {
      return (
        statement.includes('INSERT INTO app.review_projection_identity_manifest')
        || statement.includes('UPDATE app.review_projection_identity_manifest')
      )
    }),
  ).toBe(true)
  expect(
    statements.some((statement) => {
      return statement.includes('INSERT INTO mart.review_article_serving_v4')
    }),
  ).toBe(true)
  expect(
    statements.some((statement) => {
      return statement.includes('INSERT INTO app.review_serving_dirty_work_ack')
    }),
  ).toBe(true)
  expect(
    statements.some((statement) => {
      return statement.includes('INSERT INTO app.review_serving_projector_watermark')
    }),
  ).toBe(true)
  expect(
    statements.findIndex((statement) => {
      return statement.includes('INSERT INTO app.review_serving_dirty_work')
    }),
  ).toBeLessThan(
    statements.findIndex((statement) => {
      return statement.includes('INSERT INTO app.review_serving_dirty_work_ack')
    }),
  )
  expect(
    statements.some((statement) => {
      return statement.includes("snapshot_status = 'active'")
    }),
  ).toBe(true)
})

test('selected import snapshot cursor writes are idempotent upserts', async () => {
  const statements: string[] = []
  const database: ReviewServingProjectorWriterDatabase = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      return [] as T[]
    },
    run: async (statement: string) => {
      statements.push(statement)
    },
    transaction: async (operation) => {
      return operation(database)
    },
  }

  await writeReviewServingProjectorComponent(
    {
      component: 'selectedImport',
      selectedImportSnapshotCursor: {
        cursorJson: {cursor: 'new'},
        projectId: 'project-1',
        projectScopeIdentity: 'project-scope-1',
        selectedImportSnapshotId: 'selected-import-1',
        sourceDeltaHighWater: 2,
        status: 'completed',
      },
    },
    database,
  )

  const joined = statements.join('\n')
  expect(joined).toContain('INSERT INTO app.review_selected_import_snapshot')
  expect(joined).toContain('ON CONFLICT(selected_import_snapshot_id) DO UPDATE SET')
  expect(joined).not.toContain('FROM app.review_selected_import_snapshot')
})

test('selected import snapshot cursor writes unchanged rows through the same upsert path', async () => {
  const statements: string[] = []
  const database: ReviewServingProjectorWriterDatabase = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      return [] as T[]
    },
    run: async (statement: string) => {
      statements.push(statement)
    },
    transaction: async (operation) => {
      return operation(database)
    },
  }

  await writeReviewServingProjectorComponent(
    {
      component: 'selectedImport',
      selectedImportSnapshotCursor: {
        cursorJson: {cursor: 'same'},
        projectId: 'project-1',
        projectScopeIdentity: 'project-scope-1',
        selectedImportSnapshotId: 'selected-import-1',
        sourceDeltaHighWater: 2,
        status: 'completed',
      },
    },
    database,
  )

  const writeStatements = statements.filter((statement) => {
    return statement.includes('INSERT INTO app.review_selected_import_snapshot')
  })

  expect(writeStatements).toHaveLength(1)
  expect(writeStatements[0]).toContain('ON CONFLICT(selected_import_snapshot_id) DO UPDATE SET')
})

test('projector writer batches same-shape record upserts into one statement', async () => {
  const {database, statements} = createWriterDatabase()

  await writeReviewServingProjectorComponent(
    {
      component: 'posting',
      records: [
        {
          keyColumns: [
            'project_id',
            'review_config_hash',
            'snapshot_id',
            'article_id',
            'component_kind',
            'summary_definition_version',
            'contribution_key',
          ],
          table: 'mart.review_article_summary_contribution_v4',
          values: {
            article_id: 'article-1',
            component_kind: 'posting',
            contribution_key: '{"filterKind":"duplicateFlag","filterValue":"false","listModeKey":"unassessed"}',
            contribution_updated_at: new Date('2026-04-02T12:00:00.000Z'),
            contribution_value: 1,
            project_id: 'project-1',
            review_config_hash: 'review-config-1',
            snapshot_id: 'snapshot-1',
            summary_definition_version: 'posting:identity-1',
          },
        },
        {
          keyColumns: [
            'project_id',
            'review_config_hash',
            'snapshot_id',
            'article_id',
            'component_kind',
            'summary_definition_version',
            'contribution_key',
          ],
          table: 'mart.review_article_summary_contribution_v4',
          values: {
            article_id: 'article-2',
            component_kind: 'posting',
            contribution_key: '{"filterKind":"duplicateFlag","filterValue":"false","listModeKey":"unassessed"}',
            contribution_updated_at: new Date('2026-04-02T12:00:00.000Z'),
            contribution_value: 1,
            project_id: 'project-1',
            review_config_hash: 'review-config-1',
            snapshot_id: 'snapshot-1',
            summary_definition_version: 'posting:identity-1',
          },
        },
      ],
    },
    database,
  )

  const insertStatements = statements.filter((statement) => {
    return statement.includes('INSERT INTO mart.review_article_summary_contribution_v4')
  })

  expect(insertStatements).toHaveLength(1)
  expect(insertStatements[0]).toContain("'article-1'")
  expect(insertStatements[0]).toContain("'article-2'")
})

test('projector writer collapses duplicate primary-key records before a DuckDB commit', async () => {
  const {database, statements} = createWriterDatabase()
  const keyColumns = [
    'project_id',
    'review_config_hash',
    'snapshot_id',
    'article_id',
    'component_kind',
    'summary_definition_version',
    'contribution_key',
  ]

  await writeReviewServingProjectorComponent(
    {
      component: 'posting',
      records: [
        {
          keyColumns,
          table: 'mart.review_article_summary_contribution_v4',
          values: {
            article_id: 'article-1',
            component_kind: 'posting',
            contribution_key: '{"filterKind":"duplicateFlag","filterValue":"false","listModeKey":"unassessed"}',
            contribution_updated_at: new Date('2026-04-02T12:00:00.000Z'),
            contribution_value: 1,
            project_id: 'project-1',
            review_config_hash: 'review-config-1',
            snapshot_id: 'snapshot-1',
            summary_definition_version: 'posting:identity-1',
          },
        },
        {
          keyColumns,
          table: 'mart.review_article_summary_contribution_v4',
          values: {
            article_id: 'article-1',
            component_kind: 'posting',
            contribution_key: '{"filterKind":"duplicateFlag","filterValue":"false","listModeKey":"unassessed"}',
            contribution_updated_at: new Date('2026-04-02T12:01:00.000Z'),
            contribution_value: 2,
            project_id: 'project-1',
            review_config_hash: 'review-config-1',
            snapshot_id: 'snapshot-1',
            summary_definition_version: 'posting:identity-1',
          },
        },
      ],
    },
    database,
  )

  const insertStatement = statements.find((statement) => {
    return statement.includes('INSERT INTO mart.review_article_summary_contribution_v4')
  })

  expect(insertStatement).toBeDefined()
  expect(insertStatement?.match(/'article-1'/gu)).toHaveLength(1)
  expect(insertStatement).toContain('2')
  expect(insertStatement).toContain('2026-04-02T12:01:00.000Z')
})

test('projector writer keeps scoped-delete replacement writes idempotent', async () => {
  const {database, statements} = createWriterDatabase()

  await writeReviewServingProjectorComponent(
    {
      component: 'posting',
      records: [
        {
          keyColumns: [
            'project_id',
            'review_config_hash',
            'snapshot_id',
            'article_id',
            'component_kind',
            'summary_definition_version',
            'contribution_key',
          ],
          table: 'mart.review_article_summary_contribution_v4',
          values: {
            article_id: 'article-1',
            component_kind: 'posting',
            contribution_key: '{"filterKind":"duplicateFlag","filterValue":"false","listModeKey":"unassessed"}',
            contribution_updated_at: new Date('2026-04-02T12:00:00.000Z'),
            contribution_value: 1,
            project_id: 'project-1',
            review_config_hash: 'review-config-1',
            snapshot_id: 'snapshot-1',
            summary_definition_version: 'posting:identity-1',
          },
        },
      ],
      statements: [
        `
          DELETE FROM mart.review_article_summary_contribution_v4
          WHERE project_id = 'project-1'
            AND article_id IN ('article-1')
        `,
      ],
    },
    database,
  )

  const insertStatement = statements.find((statement) => {
    return statement.includes('INSERT INTO mart.review_article_summary_contribution_v4')
  })

  expect(insertStatement).toBeDefined()
  expect(insertStatement).toContain(
    'ON CONFLICT(project_id, review_config_hash, snapshot_id, article_id, component_kind, summary_definition_version, contribution_key) DO UPDATE SET',
  )
})

test('projector writer keeps judgment detail replacement rows idempotent after scoped deletes', async () => {
  const {database, statements} = createWriterDatabase()
  const keyColumns = [
    'project_id',
    'review_config_hash',
    'snapshot_id',
    'list_mode_key',
    'payload_kind',
    'article_id',
    'prompt_id',
  ]

  await writeReviewServingProjectorComponent(
    {
      component: 'payload',
      records: [
        {
          keyColumns,
          table: 'mart.review_article_judgment_detail_serving_v4',
          values: {
            answered_original: 'old',
            answered_original_as_array: ['old'],
            article_id: 'article-1',
            detail_updated_at: new Date('2026-04-02T12:00:00.000Z'),
            judgment_id: 'judgment-old',
            judgment_payload_json: {answer: 'old'},
            list_mode_key: 'llm',
            model_id: 'model-1',
            payload_kind: 'llm',
            placeholder_kind: null,
            project_id: 'project-1',
            prompt_id: 'prompt-1',
            prompt_order: 1,
            review_config_hash: 'review-config-1',
            snapshot_id: 'snapshot-1',
          },
        },
        {
          keyColumns,
          table: 'mart.review_article_judgment_detail_serving_v4',
          values: {
            answered_original: 'new',
            answered_original_as_array: ['new'],
            article_id: 'article-1',
            detail_updated_at: new Date('2026-04-02T12:01:00.000Z'),
            judgment_id: 'judgment-new',
            judgment_payload_json: {answer: 'new'},
            list_mode_key: 'llm',
            model_id: 'model-1',
            payload_kind: 'llm',
            placeholder_kind: null,
            project_id: 'project-1',
            prompt_id: 'prompt-1',
            prompt_order: 1,
            review_config_hash: 'review-config-1',
            snapshot_id: 'snapshot-1',
          },
        },
      ],
      statements: [
        `
          DELETE FROM mart.review_article_judgment_detail_serving_v4
          WHERE project_id = 'project-1'
            AND review_config_hash = 'review-config-1'
            AND snapshot_id = 'snapshot-1'
            AND article_id >= 'article-1'
            AND article_id <= 'article-2'
        `,
      ],
    },
    database,
  )

  const insertStatement = statements.find((statement) => {
    return statement.includes('INSERT INTO mart.review_article_judgment_detail_serving_v4')
  })

  expect(insertStatement).toBeDefined()
  expect(insertStatement).toContain(
    'ON CONFLICT(project_id, review_config_hash, snapshot_id, list_mode_key, payload_kind, article_id, prompt_id) DO UPDATE SET',
  )
  expect(insertStatement?.match(/'article-1'/gu)).toHaveLength(1)
  expect(insertStatement).toContain('judgment-new')
  expect(insertStatement).not.toContain('judgment-old')
})

test('only the projector writer boundary writes V4 mart rows and promotes active snapshots', () => {
  const projectorStatementBuilderFiles = new Set([
    'src/server/reviewServing/reviewServingDisplayPayloadProjector.ts',
    'src/server/reviewServing/reviewServingFilterPostingProjector.ts',
    'src/server/reviewServing/reviewServingHumanStatusProjector.ts',
    'src/server/reviewServing/reviewServingJudgmentPayloadProjector.ts',
    'src/server/reviewServing/reviewServingLlmStatusProjector.ts',
    'src/server/reviewServing/reviewServingQueueProjector.ts',
    'src/server/reviewServing/reviewServingRetentionService.ts',
    'src/server/reviewServing/reviewServingSelectedImportPatchProjector.ts',
    'src/server/reviewServing/reviewServingSelectedImportProjector.ts',
    'src/server/reviewServing/reviewServingSummaryProjector.ts',
  ])
  const testSupportFixtureFiles = new Set(['src/server/test/seedHumanAssessmentServingArticle.ts'])
  const operationalRecoveryFiles = new Set(['src/server/utils/duckdbService.ts'])
  const offenders = getTypeScriptFiles(join(workspaceRoot, 'src/server'))
    .filter((filePath) => {
      const repoPath = relative(workspaceRoot, filePath)

      return (
        repoPath !== 'src/server/reviewServing/reviewServingProjectorWriter.ts'
        && !projectorStatementBuilderFiles.has(repoPath)
        && !testSupportFixtureFiles.has(repoPath)
        && !operationalRecoveryFiles.has(repoPath)
        && !repoPath.endsWith('.test.ts')
      )
    })
    .flatMap((filePath) => {
      const source = readFileSync(filePath, 'utf8')
      const markers = [
        'INSERT INTO mart.review_.*_v4',
        'UPDATE mart.review_.*_v4',
        'DELETE FROM mart.review_.*_v4',
        "SET[\\s\\S]{0,200}snapshot_status = 'active'",
      ]

      return markers
        .filter((marker) => {
          return new RegExp(marker, 'u').test(source)
        })
        .map((marker) => {
          return `${relative(workspaceRoot, filePath)}: ${marker}`
        })
    })

  expect(offenders).toEqual([])
})

test('legacy mart maintenance paths do not write V4 review-serving snapshots', () => {
  const legacyMartMaintenanceFiles = getTypeScriptFiles(join(workspaceRoot, 'src/server'))
    .map((filePath) => {
      return relative(workspaceRoot, filePath)
    })
    .filter((repoPath) => {
      return (
        repoPath.startsWith('src/server/services/projectMartDirty')
        || repoPath.startsWith('src/server/services/projectMartLargeRebuild')
      )
    })
    .filter((repoPath) => {
      return !repoPath.endsWith('.test.ts')
    })
  const forbiddenMarkers = [
    'INSERT INTO app.review_projection_identity_manifest',
    'UPDATE app.review_projection_identity_manifest',
    'DELETE FROM app.review_projection_identity_manifest',
    'INSERT INTO app.review_selected_import_snapshot',
    'UPDATE app.review_selected_import_snapshot',
    'DELETE FROM app.review_selected_import_snapshot',
    'INSERT INTO app.review_serving_snapshot_manifest',
    'UPDATE app.review_serving_snapshot_manifest',
    'DELETE FROM app.review_serving_snapshot_manifest',
    'INSERT INTO mart.review_.*_v4',
    'UPDATE mart.review_.*_v4',
    'DELETE FROM mart.review_.*_v4',
    'promoteReviewServingProjectorSnapshot',
  ]
  const offenders = legacyMartMaintenanceFiles.flatMap((repoPath) => {
    const source = readFileSync(join(workspaceRoot, repoPath), 'utf8')

    return forbiddenMarkers
      .filter((marker) => {
        return new RegExp(marker, 'u').test(source)
      })
      .map((marker) => {
        return `${repoPath}: ${marker}`
      })
  })

  expect(legacyMartMaintenanceFiles.sort()).toEqual(['src/server/services/projectMartDirtyRefreshStateService.ts'])
  expect(offenders).toEqual([])
})
