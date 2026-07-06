import {readdirSync, readFileSync} from 'node:fs'
import {join, relative} from 'node:path'

import {expect, test} from 'bun:test'

import type {ReviewServingProjectionComponent} from './reviewServingContracts.ts'
import type {ReviewServingDirtyWorkInput, ReviewServingDirtyWorkRecord} from './reviewServingDirtyWorkService.ts'
import {getReviewServingDirtyWorkScopeForChange} from './reviewServingProjectorDomain.ts'
import {
  intakeReviewServingProjectorDirtyWork,
  type ReviewServingProjectorServiceDependencies,
  wakeReviewServingProjectorService,
} from './reviewServingProjectorService.ts'
import {
  type PromoteReviewServingProjectorSnapshotInput,
  type ReviewServingProjectorWriterDatabase,
  writeReviewServingProjectorComponent,
} from './reviewServingProjectorWriter.ts'
import {getReviewServingOptionalComponentAvailability} from './reviewServingSnapshotPromotionService.ts'

const workspaceRoot = join(import.meta.dir, '../../..')

type RunningReviewServingDirtyWorkRecord = ReviewServingDirtyWorkRecord & {status: 'running'}

const getTypeScriptFiles = (directory: string): readonly string[] => {
  return readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
    const path = join(directory, entry.name)

    return entry.isDirectory() ? getTypeScriptFiles(path) : path.endsWith('.ts') ? [path] : []
  })
}

const createDatabase = () => {
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
      statements.push('BEGIN review-serving-writer')
      const result = await operation(database)
      statements.push('COMMIT review-serving-writer')

      return result
    },
  }

  return {database, statements}
}

const claimFromInput = (
  input: ReviewServingDirtyWorkInput,
  dirtyWorkId: string,
): RunningReviewServingDirtyWorkRecord => {
  return {
    articleId: input.scope.scopeKind === 'article' ? (input.scope.scopeId.split(':').at(-1) ?? null) : null,
    createdAt: null,
    dirtyKind: input.scope.dirtyKind,
    dirtyRangeEnd: input.scope.dirtyRangeEnd,
    dirtyRangeStart: input.scope.dirtyRangeStart,
    dirtyWorkId,
    firstSourceHighWaterMark: input.scope.sourceHighWaterMark,
    latestDeltaId: input.latestDeltaId ?? null,
    latestSourceHighWaterMark: input.scope.sourceHighWaterMark,
    projectId: input.scope.projectId,
    projectionComponent: input.projectionComponent,
    projectionIdentity: input.projectionIdentity,
    scopeId: input.scope.scopeId,
    scopeKind: input.scope.scopeKind,
    sourcePartition: input.scope.sourcePartition,
    status: 'running',
    updatedAt: null,
  }
}

const getScope = (input: {
  changeKind: string
  sourceHighWaterMark: number
  values: Record<string, string | number>
}) => {
  const scope = getReviewServingDirtyWorkScopeForChange({
    changeKind: input.changeKind,
    sourceHighWaterMark: input.sourceHighWaterMark,
    sourcePartition: 'phase-2-delta',
    values: {...input.values, sourceHighWaterMark: input.sourceHighWaterMark},
  })

  if (scope === null) {
    throw new Error(`expected scope for ${input.changeKind}`)
  }

  return scope
}

test('Phase 3 intake, projector wake, writer transactions, promotion, and recovery stay integrated', async () => {
  const {database, statements} = createDatabase()
  const pending: Partial<Record<ReviewServingProjectionComponent, RunningReviewServingDirtyWorkRecord[]>> = {}
  const upserts: ReviewServingDirtyWorkInput[] = []
  const promotions: PromoteReviewServingProjectorSnapshotInput[] = []
  const deltas = [
    getScope({
      changeKind: 'judgment.llm.updated',
      sourceHighWaterMark: 11,
      values: {
        articleId: 'article-1',
        contentFlags: 'title',
        judgmentId: 'judgment-1',
        modelId: 'model-1',
        projectId: 'project-1',
        promptId: 'prompt-1',
      },
    }),
    getScope({
      changeKind: 'article.display.updated',
      sourceHighWaterMark: 12,
      values: {articleId: 'article-1', changedDisplayFieldNames: 'title', projectId: 'project-1'},
    }),
    getScope({
      changeKind: 'article.searchText.updated',
      sourceHighWaterMark: 13,
      values: {articleId: 'article-1', changedSearchableFieldNames: 'title', projectId: 'project-1'},
    }),
    getScope({
      changeKind: 'importRoute.article.rankFields.updated',
      sourceHighWaterMark: 14,
      values: {
        articleId: 'article-1',
        changedRankFilterFields: 'rank',
        importRouteId: 'import-route-1',
        projectId: 'project-1',
      },
    }),
  ]
  const dependencies = {
    claimDirtyWork: async (params) => {
      const claims = pending[params.projectionComponent] ?? []
      const claimed = claims.slice(0, params.limit)

      pending[params.projectionComponent] = claims.slice(params.limit)

      return claimed
    },
    database,
    promoteSnapshot: async (input) => {
      promotions.push(input)

      return input.snapshotId === 'snapshot-invalid'
        ? {
            error: 'required component summary is missing from snapshot state',
            promoted: false,
            snapshotId: input.snapshotId,
          }
        : {promoted: true, snapshotId: input.snapshotId}
    },
    releaseDirtyWork: async (dirtyWorkIds) => {
      return {releasedCount: dirtyWorkIds.length}
    },
    runners: {
      display: async ({claims, component}) => {
        await writeReviewServingProjectorComponent(
          {
            acknowledgements: claims,
            component,
            records: [
              {
                keyColumns: ['project_id', 'review_config_hash', 'snapshot_id', 'list_mode_key', 'article_id'],
                table: 'mart.review_article_serving_v4',
                values: {
                  article_id: 'article-1',
                  article_title: 'Display title',
                  list_mode_key: 'llm',
                  project_id: 'project-1',
                  review_config_hash: 'review-config-1',
                  snapshot_id: 'snapshot-1',
                },
              },
            ],
          },
          database,
        )

        return {processedCount: claims.length}
      },
      llmStatus: async ({claims, component}) => {
        await writeReviewServingProjectorComponent(
          {
            acknowledgements: claims,
            component,
            records: [
              {
                keyColumns: [
                  'project_id',
                  'review_config_hash',
                  'snapshot_id',
                  'list_mode_key',
                  'article_id',
                ],
                table: 'mart.review_article_serving_v4',
                values: {
                  article_id: 'article-1',
                  is_answered: true,
                  list_mode_key: 'llm',
                  project_id: 'project-1',
                  review_config_hash: 'review-config-1',
                  snapshot_id: 'snapshot-1',
                },
              },
            ],
          },
          database,
        )

        return {processedCount: claims.length}
      },
      search: async ({claims, component}) => {
        await writeReviewServingProjectorComponent(
          {
            acknowledgements: claims,
            component,
            records: [
              {
                keyColumns: ['project_id', 'search_identity', 'snapshot_id', 'token', 'article_id'],
                table: 'mart.review_title_search_serving_v4',
                values: {
                  article_id: 'article-1',
                  project_id: 'project-1',
                  search_identity: 'search:identity',
                  snapshot_id: 'snapshot-1',
                  token: 'display',
                },
              },
            ],
          },
          database,
        )

        return {processedCount: claims.length}
      },
      selectedImport: async ({claims, component}) => {
        await writeReviewServingProjectorComponent(
          {
            acknowledgements: claims,
            component,
            records: [
              {
                keyColumns: [
                  'project_id',
                  'project_scope_identity',
                  'selected_import_snapshot_id',
                  'article_id',
                ],
                table: 'app.review_selected_article_import_v4',
                values: {
                  article_id: 'article-1',
                  project_id: 'project-1',
                  project_scope_identity: 'projectScope:identity',
                  selected_import_snapshot_id: 'selected-import-1',
                },
              },
            ],
          },
          database,
        )

        return {
          candidateSnapshots: [{projectId: 'project-1', snapshotId: 'snapshot-invalid'}],
          processedCount: claims.length,
        }
      },
      summary: async ({claims, component}) => {
        await writeReviewServingProjectorComponent(
          {
            acknowledgements: claims,
            component,
            records: [
              {
                keyColumns: ['project_id', 'summary_identity', 'list_mode_key', 'named_summary_key'],
                table: 'mart.review_article_count_serving_v4',
                values: {
                  count_value: 1,
                  list_mode_key: 'llm',
                  named_summary_key: 'review.list.total:v1',
                  project_id: 'project-1',
                  summary_identity: 'summary:identity',
                },
              },
            ],
          },
          database,
        )

        return {
          candidateSnapshots: [{projectId: 'project-1', snapshotId: 'snapshot-ready'}],
          processedCount: claims.length,
        }
      },
    },
    upsertDirtyWork: async (input) => {
      const dirtyWorkId = `dirty-${upserts.length + 1}`
      const claim = claimFromInput(input, dirtyWorkId)

      upserts.push(input)
      pending[input.projectionComponent] = [...(pending[input.projectionComponent] ?? []), claim]

      return {dirtyWorkId, skipped: false}
    },
  } satisfies ReviewServingProjectorServiceDependencies

  await deltas.reduce<Promise<void>>(async (previous, scope, index) => {
    await previous
    await intakeReviewServingProjectorDirtyWork(
      {
        identityResolver: ({component}) => {
          return `${component}:identity`
        },
        latestDeltaId: `delta-${index + 1}`,
        scope,
      },
      dependencies,
    )
  }, Promise.resolve())

  const result = await wakeReviewServingProjectorService(
    {
      batchSize: 10,
      componentOrder: ['display', 'search', 'selectedImport', 'llmStatus', 'summary'],
      maxRowsPerWake: 20,
      maxWakeMs: 1_000,
      wakeId: 'wake-us-026',
    },
    dependencies,
  )
  const joined = statements.join('\n')

  expect(result.status).toBe('completed')
  expect(
    upserts.map((input) => {
      return input.projectionComponent
    }),
  ).toEqual([
    'llmStatus',
    'queue',
    'payload',
    'posting',
    'summary',
    'display',
    'payload',
    'posting',
    'summary',
    'search',
    'selectedImport',
    'posting',
    'search',
    'summary',
    'payload',
  ])
  expect(
    result.runs.map((run) => {
      return run.component
    }),
  ).toEqual(['display', 'search', 'selectedImport', 'llmStatus', 'summary'])
  expect(result.promotions).toEqual([
    {
      error: 'required component summary is missing from snapshot state',
      promoted: false,
      snapshotId: 'snapshot-invalid',
    },
    {promoted: true, snapshotId: 'snapshot-ready'},
  ])
  expect(promotions).toEqual([
    {projectId: 'project-1', snapshotId: 'snapshot-invalid'},
    {projectId: 'project-1', snapshotId: 'snapshot-ready'},
  ])
  expect(joined).toContain('BEGIN review-serving-writer')
  expect(joined).toContain('COMMIT review-serving-writer')
  expect(joined).toContain('INSERT INTO mart.review_article_serving_v4')
  expect(joined).toContain('INSERT INTO mart.review_title_search_serving_v4')
  expect(joined).toContain('INSERT INTO app.review_selected_article_import_v4')
  expect(joined).not.toContain('_patch_v4')
  expect(joined).toContain('INSERT INTO mart.review_article_count_serving_v4')
  expect(joined).toContain('INSERT INTO app.review_serving_dirty_work_ack')
})

test('required route components share one logical snapshot while optional components expose availability', () => {
  const requiredSnapshot = {
    componentStates: {
      optional: [
        {
          baseGeneration: '2',
          component: 'search' as const,
          patchWatermark: '13',
          projectionIdentity: 'search:identity',
          requirement: 'optional' as const,
        },
      ],
      required: [
        {
          baseGeneration: '2',
          component: 'display' as const,
          patchWatermark: '12',
          projectionIdentity: 'display:identity',
          requirement: 'required' as const,
        },
        {
          baseGeneration: '2',
          component: 'llmStatus' as const,
          patchWatermark: '11',
          projectionIdentity: 'llmStatus:identity',
          requirement: 'required' as const,
        },
        {
          baseGeneration: '2',
          component: 'summary' as const,
          patchWatermark: '14',
          projectionIdentity: 'summary:identity',
          requirement: 'required' as const,
        },
      ],
    },
    snapshotId: 'snapshot-ready',
  }
  const requiredBaseGenerations = new Set(
    requiredSnapshot.componentStates.required.map((state) => {
      return state.baseGeneration
    }),
  )
  const requiredPatchWatermarks = requiredSnapshot.componentStates.required.map((state) => {
    return state.patchWatermark
  })

  expect(requiredSnapshot.componentStates.required).toHaveLength(3)
  expect(requiredBaseGenerations).toEqual(new Set(['2']))
  expect(requiredPatchWatermarks).toEqual(['12', '11', '14'])
  expect(
    getReviewServingOptionalComponentAvailability({
      component: 'search',
      hasActiveSnapshot: true,
      optionalComponents: ['search'],
      optionalStatePresent: true,
    }),
  ).toBe('ready')
  expect(
    getReviewServingOptionalComponentAvailability({
      component: 'search',
      hasActiveSnapshot: true,
      optionalComponents: ['search'],
      optionalStatePresent: false,
    }),
  ).toBe('indexing')
  expect(
    getReviewServingOptionalComponentAvailability({
      component: 'summary',
      hasActiveSnapshot: true,
      optionalComponents: [],
      optionalStatePresent: false,
    }),
  ).toBe('async')
  expect(
    getReviewServingOptionalComponentAvailability({
      component: 'search',
      hasActiveSnapshot: false,
      optionalComponents: ['search'],
      optionalStatePresent: false,
    }),
  ).toBe('unavailable')
})

test('Phase 3 direct serving and selected-import guard coverage stays inventoried', () => {
  const coverage = [
    {
      filePath: 'src/server/reviewServing/reviewServingDisplayPayloadProjector.test.ts',
      markers: [
        'display base rows flow through writer with display fields and selected import hot projection',
        'mart.review_article_serving_v4',
        "not.toContain('selected_scoped_article_import')",
      ],
    },
    {
      filePath: 'src/server/reviewServing/reviewServingTitleSearchProjector.test.ts',
      markers: [
        'title search projection writes token rows and search-only component state',
        'mart.review_title_search_serving_v4',
      ],
    },
    {
      filePath: 'src/server/reviewServing/reviewServingSelectedImportProjector.test.ts',
      markers: [
        'selected-import article range rebuild can refresh final serving rows from base rows',
        'app.review_selected_article_import_v4',
      ],
    },
    {
      filePath: 'src/server/reviewServing/reviewServingLlmStatusProjector.test.ts',
      markers: [
        'LLM judgment deltas update serving directly from persisted benchmark config',
        'mart.review_article_serving_v4',
      ],
    },
    {
      filePath: 'src/server/reviewServing/reviewServingHumanStatusProjector.test.ts',
      markers: ['human prompt answer deltas update serving directly', 'mart.review_article_serving_v4'],
    },
    {
      filePath: 'src/server/reviewServing/reviewServingSelectedImportProjector.test.ts',
      markers: [
        'selected-import V4 projector does not use the runtime selected scoped import CTE',
        'selected_scoped_article_import',
      ],
    },
    {
      filePath: 'src/server/reviewServing/reviewServingSummaryProjector.test.ts',
      markers: [
        'prompt badge counts flow through summary contribution rows used by review.prompt.badges',
        'review.both.conflictByPrompt',
        'INSERT INTO mart.review_article_summary_contribution_v4',
      ],
    },
  ]
  const missing = coverage.flatMap((entry) => {
    const source = readFileSync(join(workspaceRoot, entry.filePath), 'utf8')

    return entry.markers
      .filter((marker) => {
        return !source.includes(marker)
      })
      .map((marker) => {
        return `${entry.filePath}: ${marker}`
      })
  })

  expect(missing).toEqual([])
})

test('Phase 3 V4 serving readers are not migrated into product review routes', () => {
  const offenders = getTypeScriptFiles(join(workspaceRoot, 'src/server/routes')).flatMap((filePath) => {
    if (filePath.endsWith('.test.ts')) {
      return []
    }

    const source = readFileSync(filePath, 'utf8')
    const repoPath = relative(workspaceRoot, filePath)
    const v4RouteReadMarkers = [
      'mart.review_article_serving_v4',
      'mart.review_article_count_serving_v4',
      'mart.review_filter_facet_serving_v4',
      'mart.review_filter_option_serving_v4',
      'mart.review_title_search_serving_v4',
      'reviewServingReadContracts',
      'reviewServingSql',
    ]
    const directV4Reads = v4RouteReadMarkers
      .filter((marker) => {
        return source.includes(marker)
      })
      .map((marker) => {
        return `${repoPath}: ${marker}`
      })

    return directV4Reads
  })

  expect(offenders).toEqual([])
})

test('warning diagnostics coverage includes maintenance rebuild dirty-work quarantine and optional search states', () => {
  const source = readFileSync(
    join(workspaceRoot, 'src/server/reviewServing/reviewServingDiagnosticsRepository.ts'),
    'utf8',
  )
  const markers = [
    'review_serving_dirty_work',
    'review_rebuild_chunk_manifest',
    'review_source_change_outbox',
    'review_delta_reconciliation_cursor',
    'maintenance-worker',
    'getReviewServingOptionalComponentAvailability',
  ]
  const missing = markers.filter((marker) => {
    return !source.includes(marker)
  })

  expect(missing).toEqual([])
})
