import {expect, test} from 'bun:test'
import {Effect} from 'effect'

import type {DuckdbWorkloadContext} from '../utils/duckdbService.ts'
import {buildReviewDirtyProjectionIdentity} from './reviewProjectionIdentity.ts'
import type {ReviewServingChunkManifestRepositoryDatabase} from './reviewServingChunkManifestRepository.ts'
import type {ReviewServingProjectionComponent} from './reviewServingContracts.ts'
import {getReviewServingProjectionComponentIdentityKey} from './reviewServingProjectorDomain.ts'
import {getReviewServingSelectedImportSnapshotId} from './reviewServingSelectedImportProjector.ts'
import {requestReviewServingV4RebuildEffect} from './reviewServingV4RebuildRequestService.ts'

type FakeStats = {
  activeSnapshotCount: number
  enabledPromptCount: number
  humanJudgmentCount: number
  humanJudgmentUpdatedAt: string | null
  judgmentCount: number
  judgmentUpdatedAt: string | null
  modelExecutionIdentityDigest: string | null
  modelUpdatedAt: string | null
  patchPromptUpdatedAt: string | null
  promptCount: number
  promptIdentityDigest: string | null
  promptUpdatedAt: string | null
  providerConnectionUpdatedAt: string | null
  projectArticleUpdatedAt: string | null
  projectPromptUpdatedAt: string | null
  projectUpdatedAt: string
  scopedArticleCount: number
  snapshotCount: number
  snapshotUpdatedAt: string | null
  summaryHumanJudgmentCount: number
  summaryHumanJudgmentUpdatedAt: string | null
}

type FakeRequestRow = {
  admissionState: 'admitted' | 'blocked_over_budget' | 'pending'
  admittedAt: string | null
  completedAt: string | null
  createdAt: string
  diagnosticsJson: unknown
  failedAt: string | null
  identityJson: unknown
  lastError: string | null
  leaseExpiresAt: string | null
  leaseOwner: string | null
  oomCategory: string | null
  overBudgetReason: string | null
  priority: number
  projectId: string
  reason: string
  requestedComponentsJson: unknown
  requestId: string
  retryAfter: string | null
  retryCount: number
  retryPolicyJson: unknown
  sourceWatermarksJson: unknown
  status: 'admitted' | 'blocked_over_budget' | 'running'
  updatedAt: string
}

type FakeProjectionManifestRow = {
  baseGeneration: number
  definitionVersion: string
  inputDigest: string | null
  inputWatermark: number
  inputWatermarksJson: unknown
  invalidationReason: string | null
  manifestId: string
  patchRangeEnd: number | null
  patchRangeStart: number | null
  patchWatermark: number
  projectId: string
  projectionComponent: string
  projectionIdentity: string
  promptConfigHash: string | null
  reviewConfigHash: string | null
  status: 'active' | 'candidate'
}

type FakeDirtyWatermark = {latestSourceHighWaterMark: number; sourcePartition: string}

type FakeDirtyWorkRow = {
  articleId: string | null
  createdAt: string
  dirtyKind: string
  dirtyRangeEnd: string | null
  dirtyRangeStart: string | null
  dirtyWorkId: string
  firstSourceHighWaterMark: number
  latestDeltaId: string | null
  latestSourceHighWaterMark: number
  lifecycleReason: string | null
  projectId: string
  projectionComponent: ReviewServingProjectionComponent
  projectionIdentity: string
  projectionKey: string
  scopeId: string
  scopeKind: string
  sourcePartition: string
  status: 'pending' | 'running' | 'completed'
  storageRowId: number
  updatedAt: string
}

type FakeRequestDatabaseOptions = {
  completedBootstrapComponents?: readonly ReviewServingProjectionComponent[]
  coveredDirtyWorkRows?: readonly FakeDirtyWorkRow[]
  dirtyWatermarks?: readonly FakeDirtyWatermark[]
  legacyRequiredEnrichmentCandidate?: boolean
  reusableBootstrapSourceSnapshotId?: string
  staleBootstrapComponents?: readonly ReviewServingProjectionComponent[]
}

const getSqlStrings = (statement: string) => {
  return [...statement.matchAll(/'((?:''|[^'])*)'/g)].map((match) => {
    return match[1]?.replaceAll("''", "'") ?? ''
  })
}

const getJsonArraysFromSql = (statement: string) => {
  return getSqlStrings(statement).flatMap((value) => {
    if (!value.startsWith('[')) {
      return []
    }

    try {
      const parsed: unknown = JSON.parse(value)

      return Array.isArray(parsed) ? [parsed] : []
    } catch (_error) {
      return []
    }
  })
}

const baseStats = {
  activeSnapshotCount: 1,
  enabledPromptCount: 2,
  humanJudgmentCount: 8,
  humanJudgmentUpdatedAt: '2026-06-20T10:03:00.000Z',
  judgmentCount: 12,
  judgmentUpdatedAt: '2026-06-20T10:02:00.000Z',
  modelExecutionIdentityDigest: 'model-execution-digest-v1',
  modelUpdatedAt: '2026-06-20T10:01:45.000Z',
  patchPromptUpdatedAt: null,
  promptCount: 2,
  promptIdentityDigest: 'prompt-digest-v1',
  promptUpdatedAt: '2026-06-20T10:01:30.000Z',
  providerConnectionUpdatedAt: '2026-06-20T10:01:40.000Z',
  projectArticleUpdatedAt: '2026-06-20T10:00:00.000Z',
  projectPromptUpdatedAt: '2026-06-20T10:01:00.000Z',
  projectUpdatedAt: '2026-06-20T09:59:00.000Z',
  scopedArticleCount: 10,
  snapshotCount: 1,
  snapshotUpdatedAt: '2026-06-20T10:03:45.000Z',
  summaryHumanJudgmentCount: 3,
  summaryHumanJudgmentUpdatedAt: '2026-06-20T10:03:30.000Z',
} satisfies FakeStats

const fakeRebuildComponents = [
  'projectScope',
  'selectedImport',
  'display',
  'llmStatus',
  'humanStatus',
  'queue',
  'payload',
  'posting',
  'summary',
  'judgmentInputContent',
  'search',
] as const

const getFakeBootstrapProjectionIdentity = (component: ReviewServingProjectionComponent) => {
  return buildReviewDirtyProjectionIdentity({projectId: 'project-v4', projectionComponent: component})
}

const getFakeBootstrapProjectionManifestId = (component: ReviewServingProjectionComponent) => {
  return getReviewServingProjectionComponentIdentityKey({
    projectId: 'project-v4',
    projectionComponent: component,
    projectionIdentity: getFakeBootstrapProjectionIdentity(component),
  })
}

const getFakeSelectedImportSnapshotId = (sourceDeltaHighWater: number) => {
  return getReviewServingSelectedImportSnapshotId({
    projectId: 'project-v4',
    projectScopeIdentity: getFakeBootstrapProjectionIdentity('projectScope'),
    sourceDeltaHighWater,
  })
}

const getFakeBootstrapSourceWatermarks = (options: FakeRequestDatabaseOptions) => {
  return (options.dirtyWatermarks ?? []).reduce<Record<string, number>>((watermarks, watermark) => {
    const sourceKey = watermark.sourcePartition.split(':')[0] ?? watermark.sourcePartition

    return {...watermarks, [sourceKey]: Math.max(watermarks[sourceKey] ?? 0, watermark.latestSourceHighWaterMark)}
  }, {})
}

const getFakeReusableProjectionManifest = (
  component: ReviewServingProjectionComponent,
  sourceWatermarks: Record<string, number>,
  options: FakeRequestDatabaseOptions,
) => {
  const staleComponentSet = new Set(options.staleBootstrapComponents ?? [])
  const inputWatermarks = staleComponentSet.has(component)
    ? Object.fromEntries(
        Object.entries(sourceWatermarks).map(([sourceKey, sourceWatermark]) => {
          return [sourceKey, Math.max(0, sourceWatermark - 1)]
        }),
      )
    : sourceWatermarks

  return {
    baseGeneration: 0,
    definitionVersion: `${component}:dirty-claim-seed-v1`,
    inputDigest: `${component}-completed-bootstrap`,
    inputWatermark: Math.max(0, ...Object.values(inputWatermarks)),
    inputWatermarksJson: JSON.stringify(inputWatermarks),
    invalidationReason: `${component}.completed`,
    manifestId: getFakeBootstrapProjectionManifestId(component),
    patchRangeEnd: Math.max(0, ...Object.values(inputWatermarks)),
    patchRangeStart: 0,
    patchWatermark: Math.max(0, ...Object.values(inputWatermarks)),
    projectId: 'project-v4',
    projectionComponent: component,
    projectionIdentity: getFakeBootstrapProjectionIdentity(component),
    promptConfigHash: null,
    reviewConfigHash: null,
    status: 'candidate',
  } satisfies FakeProjectionManifestRow
}

const getFakeReusableBootstrapComponentStateJson = (
  sourceWatermarks: Record<string, number>,
  options: FakeRequestDatabaseOptions,
) => {
  const staleComponentSet = new Set(options.staleBootstrapComponents ?? [])
  const getPatchWatermark = (component: ReviewServingProjectionComponent) => {
    const sourceWatermark = Math.max(0, ...Object.values(sourceWatermarks))

    return staleComponentSet.has(component) ? Math.max(0, sourceWatermark - 1) : sourceWatermark
  }

  return {
    optional: [],
    required: fakeRebuildComponents.map((component) => {
      return {
        baseGeneration: 0,
        component,
        patchWatermark: getPatchWatermark(component),
        projectionIdentity: getFakeBootstrapProjectionIdentity(component),
      }
    }),
  }
}

const getFakeArticleRanges = (chunkCount: number, stats: FakeStats) => {
  return Array.from({length: chunkCount}, (_, index) => {
    return {
      chunkEndKey: `article-${String(index).padStart(3, '0')}-z`,
      chunkStartKey: `article-${String(index).padStart(3, '0')}-a`,
      humanJudgmentCount: index === 0 ? stats.humanJudgmentCount : 0,
      scopedArticleCount: 1,
      summaryHumanJudgmentCount: index === 0 ? stats.summaryHumanJudgmentCount : 0,
    }
  })
}

const createFakeRequestDatabase = (stats: FakeStats, options: FakeRequestDatabaseOptions = {}) => {
  const effectiveStats = {...stats, activeSnapshotCount: Math.min(stats.activeSnapshotCount, stats.snapshotCount)}
  const requests = new Map<string, FakeRequestRow>()
  const projectionManifests = new Map<string, FakeProjectionManifestRow>()
  const reusableBootstrapSourceWatermarks = getFakeBootstrapSourceWatermarks(options)
  const reusableBootstrapComponentSet = new Set(options.completedBootstrapComponents ?? [])
  const statements: string[] = []
  const transactionStatements: string[][] = []
  const transactionWorkloadContexts: Array<DuckdbWorkloadContext | undefined> = []
  const componentStateJson = {
    optional: [],
    required: fakeRebuildComponents.map((component) => {
      return {baseGeneration: 2, component, patchWatermark: 10, projectionIdentity: `${component}:identity-1`}
    }),
  }
  const getReusableBootstrapSnapshotRow = (snapshotId: string, status: 'active' | 'candidate' | 'retired' = 'candidate') => {
    return {
      componentStateJson: getFakeReusableBootstrapComponentStateJson(reusableBootstrapSourceWatermarks, options),
      composedIdentityJson: {},
      lastError: null,
      lastKnownGoodSnapshotId: null,
      optionalComponentsJson: [],
      projectId: 'project-v4',
      requiredComponentsJson: fakeRebuildComponents,
      reviewConfigHash: null,
      selectedImportSnapshotId: getFakeSelectedImportSnapshotId(reusableBootstrapSourceWatermarks.importRunArticle ?? 0),
      snapshotId,
      snapshotStatus: status,
      sourceWatermarksJson: reusableBootstrapSourceWatermarks,
      validationResultJson: null,
    }
  }

  reusableBootstrapComponentSet.forEach((component) => {
    const manifest = getFakeReusableProjectionManifest(component, reusableBootstrapSourceWatermarks, options)

    projectionManifests.set(manifest.manifestId, manifest)
  })

  const run = async (statement: string) => {
    statements.push(statement)

    if (statement.includes('INSERT INTO app.review_projection_identity_manifest')) {
      const strings = getSqlStrings(statement)
      const manifestId = strings[0] ?? ''
      const component = strings[2] ?? 'projectScope'

      projectionManifests.set(manifestId, {
        baseGeneration: 0,
        definitionVersion: strings[6] ?? `${component}:dirty-claim-seed-v1`,
        inputDigest: strings[5] ?? null,
        inputWatermark: 0,
        inputWatermarksJson: strings[4] ?? '{}',
        invalidationReason: strings[9] ?? null,
        manifestId,
        patchRangeEnd: 0,
        patchRangeStart: 0,
        patchWatermark: 0,
        projectId: strings[1] ?? 'project-v4',
        projectionComponent: component,
        projectionIdentity: strings[3] ?? `${component}:identity-1`,
        promptConfigHash: null,
        reviewConfigHash: null,
        status: 'candidate',
      })
    }

    if (statement.includes('UPDATE app.review_rebuild_request') && statement.includes('SET priority = CASE')) {
      const requestId = getSqlStrings(statement)[0] ?? ''
      const priority = Number(statement.match(/THEN\s+(\d+)\s+ELSE priority/u)?.[1] ?? 100)
      const request = requests.get(requestId)

      if (request !== undefined && request.priority <= priority) {
        requests.set(requestId, {
          ...request,
          priority: Math.max(request.priority, priority),
          updatedAt: '2026-06-20T10:05:00.000Z',
        })
      }

      return
    }

    if (statement.includes('UPDATE app.review_rebuild_request') && statement.includes('SET priority = ')) {
      const requestId = getSqlStrings(statement)[0] ?? ''
      const priority = Number(statement.match(/SET priority = (\d+)/u)?.[1] ?? 100)
      const request = requests.get(requestId)

      if (request !== undefined && request.priority < priority) {
        requests.set(requestId, {...request, priority})
      }

      return
    }

    if (!statement.includes('INSERT INTO app.review_rebuild_request')) {
      return
    }

    const strings = getSqlStrings(statement)
    const requestId = strings[0] ?? ''
    const status = (strings[6] ?? 'admitted') as FakeRequestRow['status']
    const admissionState = (strings[7] ?? 'admitted') as FakeRequestRow['admissionState']
    const overBudgetReason = status === 'blocked_over_budget' ? (strings[10] ?? 'over budget') : null
    const diagnosticsJson =
      strings.find((value) => {
        return value.startsWith('{"budget"')
      }) ?? '{}'
    const priority = Number(statement.match(/,\s*(\d+),\s*'(admitted|blocked_over_budget)'/u)?.[1] ?? 100)

    requests.set(requestId, {
      admissionState,
      admittedAt: status === 'admitted' ? '2026-06-20T10:04:00.000Z' : null,
      completedAt: null,
      createdAt: '2026-06-20T10:04:00.000Z',
      diagnosticsJson,
      failedAt: null,
      identityJson: strings[5] ?? '{}',
      lastError: null,
      leaseExpiresAt: null,
      leaseOwner: null,
      oomCategory: status === 'blocked_over_budget' ? 'request_over_budget' : null,
      overBudgetReason,
      priority,
      projectId: strings[1] ?? '',
      reason: strings[2] ?? '',
      requestedComponentsJson: strings[3] ?? '[]',
      requestId,
      retryAfter: null,
      retryCount: 0,
      retryPolicyJson: strings[8] ?? '{}',
      sourceWatermarksJson: strings[4] ?? '{}',
      status,
      updatedAt: '2026-06-20T10:04:00.000Z',
    })
  }

  const queryJson = async <T>(statement: string) => {
    statements.push(statement)

    if (statement.includes('NTILE(')) {
      const chunkCount = Number(statement.match(/NTILE\((\d+)\)/u)?.[1] ?? 1)

      return (effectiveStats.scopedArticleCount === 0 ? [] : getFakeArticleRanges(chunkCount, effectiveStats)) as T[]
    }

    if (statement.includes('WITH project_settings')) {
      return [effectiveStats] as T[]
    }

    if (statement.includes('FROM app.review_selected_import_snapshot')) {
      return [{status: 'completed'}] as T[]
    }

    if (statement.includes('FROM app.project_article')) {
      return [
        {chunkEndKey: 'article-z', chunkStartKey: 'article-a', scopedArticleCount: effectiveStats.scopedArticleCount},
      ] as T[]
    }

    if (
      statement.includes('FROM app.review_serving_dirty_work dirty_work')
      && statement.includes('INNER JOIN covered_claim_state')
    ) {
      return (options.coveredDirtyWorkRows ?? []) as T[]
    }

    if (statement.includes('FROM app.review_serving_dirty_work_claim_state')) {
      return [] as T[]
    }

    if (statement.includes('FROM app.review_serving_dirty_work_ack_id_lookup')) {
      return [] as T[]
    }

    if (statement.includes('FROM app.review_serving_dirty_work')) {
      return (options.dirtyWatermarks ?? []) as T[]
    }

    if (statement.includes('legacyRequiredEnrichmentCount')) {
      return [{legacyRequiredEnrichmentCount: options.legacyRequiredEnrichmentCandidate === true ? 1 : 0}] as T[]
    }

    if (statement.includes('FROM app.review_rebuild_chunk_manifest') && statement.includes('totalChunkCount')) {
      const component = getSqlStrings(statement).at(-2) as ReviewServingProjectionComponent | undefined
      const completed = component !== undefined && reusableBootstrapComponentSet.has(component) ? 2 : 0

      return [{completedChunkCount: completed, incompleteChunkCount: 0, totalChunkCount: completed}] as T[]
    }

    if (statement.includes('FROM app.review_serving_snapshot_manifest') && statement.includes('snapshot_id =')) {
      const strings = getSqlStrings(statement)
      const projectId = strings[0] ?? 'project-v4'
      const snapshotId = strings[1] ?? 'snapshot:reusable-bootstrap'
      const exactSnapshotEnabled = options.reusableBootstrapSourceSnapshotId === undefined
      const sourceSnapshotEnabled = options.reusableBootstrapSourceSnapshotId === snapshotId

      return reusableBootstrapComponentSet.size === 0 || (!exactSnapshotEnabled && !sourceSnapshotEnabled)
        ? ([] as T[])
        : ([{...getReusableBootstrapSnapshotRow(snapshotId), projectId}] as T[])
    }

    if (
      statement.includes('FROM app.review_serving_snapshot_manifest')
      && statement.includes("snapshot_status IN ('active', 'retired')")
    ) {
      return reusableBootstrapComponentSet.size === 0 || options.reusableBootstrapSourceSnapshotId === undefined
        ? ([] as T[])
        : ([getReusableBootstrapSnapshotRow(options.reusableBootstrapSourceSnapshotId, 'active')] as T[])
    }

    if (statement.includes('FROM app.review_serving_snapshot_manifest')) {
      return [{componentStateJson}] as T[]
    }

    if (statement.includes('FROM app.review_projection_identity_manifest')) {
      if (statement.includes('WHERE manifest_id =')) {
        const manifestId = getSqlStrings(statement)[0] ?? ''
        const manifest = projectionManifests.get(manifestId)

        return (manifest === undefined ? [] : [manifest]) as T[]
      }

      return fakeRebuildComponents.map((component) => {
        return {
          baseGeneration: 2,
          inputDigest: `${component}-digest-v1`,
          inputWatermark: 10,
          projectionComponent: component,
          projectionIdentity: `${component}:identity-1`,
        }
      }) as T[]
    }

    if (statement.includes('FROM app.review_rebuild_request')) {
      if (statement.includes("status = 'admitted'") || statement.includes("status IN ('admitted', 'running')")) {
        const strings = getSqlStrings(statement)
        const projectId = strings[0] ?? ''
        const reasonFilter = statement.includes('AND reason =') ? strings[1] : undefined
        const allowedStatuses = statement.includes("status IN ('admitted', 'running')")
          ? ['admitted', 'running']
          : ['admitted']
        const activeRequest = Array.from(requests.values()).find((request) => {
          return (
            request.projectId === projectId
            && allowedStatuses.includes(request.status)
            && request.admissionState === 'admitted'
            && (reasonFilter === undefined || request.reason === reasonFilter)
          )
        })

        return (activeRequest === undefined ? [] : [activeRequest]) as T[]
      }

      const requestId = getSqlStrings(statement)[0] ?? ''
      const request = requests.get(requestId)

      return (request === undefined ? [] : [request]) as T[]
    }

    return [] as T[]
  }
  const database = {
    queryJson,
    run,
    transaction: async <T>(
      operation: (tx: {queryJson: typeof queryJson; run: typeof run}) => Promise<T>,
      workloadContext?: DuckdbWorkloadContext,
    ) => {
      const statementStart = statements.length
      transactionWorkloadContexts.push(workloadContext)
      const result = await operation({queryJson, run})
      transactionStatements.push(statements.slice(statementStart))
      return result
    },
  } satisfies ReviewServingChunkManifestRepositoryDatabase

  const setRequestStatus = (requestId: string, status: FakeRequestRow['status']) => {
    const request = requests.get(requestId)

    if (!request) {
      throw new Error(`Expected fake rebuild request ${requestId} to exist`)
    }

    requests.set(requestId, {...request, status})
  }

  return {database, setRequestStatus, statements, transactionStatements, transactionWorkloadContexts}
}

test('V4 rebuild request service estimates admission budget from project data', async () => {
  const {database, statements} = createFakeRequestDatabase({
    ...baseStats,
    enabledPromptCount: 4,
    humanJudgmentCount: 2_000,
    judgmentCount: 5_000,
    promptCount: 4,
    scopedArticleCount: 100_000,
    summaryHumanJudgmentCount: 1_000,
  })

  const request = await Effect.runPromise(
    requestReviewServingV4RebuildEffect(
      {components: ['summary', 'payload'], projectId: 'project-v4', reason: 'requestReviewServingLargeRebuild'},
      database,
    ),
  )
  const joined = statements.join('\n')

  expect(request.status).toBe('blocked_over_budget')
  expect(request.overBudgetReason).toContain('input rows')
  expect(request.sourceWatermarksJson).toMatchObject({
    modelExecution: {
      identityDigest: 'model-execution-digest-v1',
      modelUpdatedAt: '2026-06-20T10:01:45.000Z',
      providerConnectionUpdatedAt: '2026-06-20T10:01:40.000Z',
    },
    projectArticles: {count: 100_000, updatedAt: '2026-06-20T10:00:00.000Z'},
    projectPrompts: {count: 4, enabledCount: 4, patchUpdatedAt: null, updatedAt: '2026-06-20T10:01:00.000Z'},
    prompts: {count: 4, identityDigest: 'prompt-digest-v1', updatedAt: '2026-06-20T10:01:30.000Z'},
    snapshots: {count: 1, updatedAt: '2026-06-20T10:03:45.000Z'},
    summaryHumanJudgments: {count: 1_000, updatedAt: '2026-06-20T10:03:30.000Z'},
  })
  expect(joined).toContain('FROM app.project_import_route')
  expect(joined).toContain('INNER JOIN app.article_import_route')
  expect(joined).toContain('scoped_article_id AS')
  expect(joined).toContain('CAST(COUNT(DISTINCT article_id) AS INTEGER) AS scopedArticleCount')
  expect(joined).toContain('LEFT JOIN app.model model ON model.id = project.model_id')
  expect(joined).toContain('LEFT JOIN app.provider_connection provider_connection')
  expect(joined).toContain('model_execution_identity_digest')
  expect(joined).toContain('enabled_prompt AS')
  expect(joined).toContain('rebuild_prompt AS')
  expect(joined).not.toContain('FROM mart.review_llm_status_patch_v4 llm')
  expect(joined).not.toContain('FROM mart.review_human_status_patch_v4 human')
  expect(joined).toContain('FROM rebuild_prompt')
  expect(joined).toContain('INNER JOIN scoped_article_id ON scoped_article_id.article_id = judgment.article_id')
  expect(joined).not.toContain('INNER JOIN scoped_article ON scoped_article.article_id = judgment.article_id')
  expect(joined).toContain('INNER JOIN rebuild_prompt ON rebuild_prompt.prompt_id = judgment.prompt_id')
  expect(joined).toContain('INNER JOIN rebuild_prompt ON rebuild_prompt.prompt_id = human.prompt_id')
  expect(joined).toContain('INNER JOIN scoped_article_id ON scoped_article_id.article_id = human.article_id')
  expect(joined).toContain('INNER JOIN app.prompt prompt ON prompt.id = project_prompt.prompt_id')
  expect(joined).toContain('AND COALESCE(prompt.archived, FALSE) = FALSE')
  expect(joined).toContain('COALESCE(prompt.content_hash, sha256(prompt.original_text))')
  expect(joined).toContain("snapshot.snapshot_status IN ('candidate', 'active')")
  expect(joined).toContain('snapshot.review_config_hash IS NOT DISTINCT FROM')
  expect(joined).toContain("WHERE snapshot.snapshot_status = 'active'")
  expect(joined).toContain('judgment.model_id = project.model_id')
  expect(joined).not.toContain('judgment.project_id = project.id')
  expect(joined).toContain('judgment.use_fulltext_no_images = project.use_fulltext_no_images')
  expect(joined).toContain('FROM app.judgment_human_summary')
})

test('V4 rebuild request service admits large search rebuilds as executable range chunks', async () => {
  const {database, statements} = createFakeRequestDatabase({...baseStats, scopedArticleCount: 120_000})

  const request = await Effect.runPromise(
    requestReviewServingV4RebuildEffect(
      {components: ['search'], projectId: 'project-v4', reason: 'requestReviewServingLargeRebuild'},
      database,
    ),
  )
  const joined = statements.join('\n')
  const searchChunkInserts = statements.filter((statement) => {
    return statement.includes('INSERT INTO app.review_rebuild_chunk_manifest') && statement.includes("'search'")
  })

  expect(request.status).toBe('admitted')
  expect(request.overBudgetReason).toBeNull()
  expect(joined).toContain('NTILE(3)')
  expect(searchChunkInserts).toHaveLength(3)
  expect(searchChunkInserts[0]).toContain('article-000-a')
  expect(searchChunkInserts[0]).toContain('article-000-z')
  expect(searchChunkInserts[0]).toContain('40000')
  expect(searchChunkInserts[0]).toContain('admissionPresplit')
  expect(searchChunkInserts[0]).not.toContain('input_row_budget_split')
})

test('V4 rebuild request service bootstraps explicit chunks when a project has no snapshot yet', async () => {
  const {database, statements} = createFakeRequestDatabase({...baseStats, snapshotCount: 0, snapshotUpdatedAt: null})

  const request = await Effect.runPromise(
    requestReviewServingV4RebuildEffect({projectId: 'project-v4', reason: 'missingReviewServingSnapshot'}, database),
  )
  const joined = statements.join('\n')

  expect(request.status).toBe('admitted')
  expect(request.requestedComponents).toEqual([...fakeRebuildComponents])
  expect(joined).toContain('INSERT INTO app.review_projection_identity_manifest')
  expect(joined).toContain('INSERT INTO app.review_serving_snapshot_manifest')
  expect(joined).toContain('INSERT INTO app.review_rebuild_chunk_manifest')
  expect(joined).toContain("'projectScope'")
  expect(joined).toContain("'selectedImport'")
  expect(joined).toContain("'search'")
  expect(joined).toContain('snapshot:')
  expect(joined).toContain('freshReviewServingSnapshot')
})

test('V4 bootstrap rebuild reuses unchanged same-snapshot component manifests', async () => {
  const {database, statements} = createFakeRequestDatabase(
    {
      ...baseStats,
      activeSnapshotCount: 0,
      snapshotCount: 1,
    },
    {
      completedBootstrapComponents: ['display', 'summary'],
      dirtyWatermarks: [
        {latestSourceHighWaterMark: 10, sourcePartition: 'reviewChange:project-v4'},
        {latestSourceHighWaterMark: 4, sourcePartition: 'importRunArticle:project-v4'},
        {latestSourceHighWaterMark: 7, sourcePartition: 'projectScope:project-v4'},
      ],
    },
  )

  const request = await Effect.runPromise(
    requestReviewServingV4RebuildEffect({projectId: 'project-v4', reason: 'missingReviewServingSnapshot'}, database),
  )
  const chunkInserts = statements.filter((statement) => {
    return statement.includes('INSERT INTO app.review_rebuild_chunk_manifest')
  })
  const displayChunkInserts = chunkInserts.filter((statement) => {
    return statement.includes("'display'")
  })
  const summaryChunkInserts = chunkInserts.filter((statement) => {
    return statement.includes("'summary'")
  })

  expect(request.status).toBe('admitted')
  expect(chunkInserts).toHaveLength(fakeRebuildComponents.length - 2)
  expect(displayChunkInserts).toHaveLength(0)
  expect(summaryChunkInserts).toHaveLength(0)
  expect(request.diagnosticsJson).toMatchObject({
    diagnostics: {
      componentReuse: {
        rebuiltChunkCount: fakeRebuildComponents.length - 2,
        clonedComponents: [],
        crossSnapshotComponents: [],
        reusedChunkCount: 4,
        reusedComponents: ['display', 'summary'],
        reuseMode: 'componentGeneration',
        sameSnapshotComponents: ['display', 'summary'],
      },
    },
  })
  expect(statements.join('\n')).toContain('FROM app.review_rebuild_chunk_manifest')
  expect(statements.join('\n')).toContain('INSERT INTO app.review_serving_snapshot_manifest')
})

test('V4 bootstrap rebuild creates fresh chunks for incompatible component manifests', async () => {
  const {database, statements} = createFakeRequestDatabase(
    {
      ...baseStats,
      activeSnapshotCount: 0,
      snapshotCount: 1,
    },
    {
      completedBootstrapComponents: ['display', 'summary'],
      dirtyWatermarks: [
        {latestSourceHighWaterMark: 10, sourcePartition: 'reviewChange:project-v4'},
        {latestSourceHighWaterMark: 4, sourcePartition: 'importRunArticle:project-v4'},
        {latestSourceHighWaterMark: 7, sourcePartition: 'projectScope:project-v4'},
      ],
      staleBootstrapComponents: ['display'],
    },
  )

  const request = await Effect.runPromise(
    requestReviewServingV4RebuildEffect({projectId: 'project-v4', reason: 'missingReviewServingSnapshot'}, database),
  )
  const chunkInserts = statements.filter((statement) => {
    return statement.includes('INSERT INTO app.review_rebuild_chunk_manifest')
  })
  const displayChunkInserts = chunkInserts.filter((statement) => {
    return statement.includes("'display'")
  })
  const summaryChunkInserts = chunkInserts.filter((statement) => {
    return statement.includes("'summary'")
  })

  expect(request.status).toBe('admitted')
  expect(chunkInserts).toHaveLength(fakeRebuildComponents.length - 1)
  expect(displayChunkInserts).toHaveLength(1)
  expect(summaryChunkInserts).toHaveLength(0)
  expect(request.diagnosticsJson).toMatchObject({
    diagnostics: {
      componentReuse: {
        rebuiltChunkCount: fakeRebuildComponents.length - 1,
        clonedComponents: [],
        crossSnapshotComponents: [],
        reusedChunkCount: 2,
        reusedComponents: ['summary'],
        reuseMode: 'componentGeneration',
        sameSnapshotComponents: ['summary'],
      },
    },
  })
})

test('V4 bootstrap rebuild clones isolated unchanged component rows from an active source snapshot', async () => {
  const {database, statements} = createFakeRequestDatabase(
    {
      ...baseStats,
      activeSnapshotCount: 0,
      snapshotCount: 1,
    },
    {
      completedBootstrapComponents: ['projectScope', 'selectedImport', 'payload', 'queue', 'summary', 'search'],
      reusableBootstrapSourceSnapshotId: 'snapshot:active-reusable',
    },
  )

  const request = await Effect.runPromise(
    requestReviewServingV4RebuildEffect({projectId: 'project-v4', reason: 'missingReviewServingSnapshot'}, database),
  )
  const joined = statements.join('\n')
  const chunkInserts = statements.filter((statement) => {
    return statement.includes('INSERT INTO app.review_rebuild_chunk_manifest')
  })

  expect(request.status).toBe('admitted')
  expect(chunkInserts).toHaveLength(fakeRebuildComponents.length - 6)
  expect(joined).toContain('INSERT INTO mart.review_article_judgment_detail_serving_v4 BY NAME')
  expect(joined).toContain('INSERT INTO mart.review_unassessed_queue_article_rank_serving_v4 BY NAME')
  expect(joined).toContain('INSERT INTO mart.review_title_search_serving_v4 BY NAME')
  expect(joined).toContain('INSERT INTO mart.review_article_count_serving_v4 BY NAME')
  expect(joined).toContain("SELECT * REPLACE (")
  expect(joined).toContain("snapshot_id = 'snapshot:active-reusable'")
  expect(joined).toContain('INSERT INTO app.review_serving_snapshot_manifest')
  expect(request.diagnosticsJson).toMatchObject({
    diagnostics: {
      componentReuse: {
        clonedComponents: ['queue', 'payload', 'summary', 'search'],
        crossSnapshotComponents: ['projectScope', 'selectedImport', 'queue', 'payload', 'summary', 'search'],
        rebuiltChunkCount: fakeRebuildComponents.length - 6,
        reusedComponents: ['projectScope', 'selectedImport', 'queue', 'payload', 'summary', 'search'],
        reuseMode: 'componentGeneration',
        sameSnapshotComponents: [],
      },
    },
  })
})

test('V4 bootstrap rebuild promotes all-reused candidates and completes covered dirty work', async () => {
  const {database, statements} = createFakeRequestDatabase(
    {
      ...baseStats,
      activeSnapshotCount: 0,
      snapshotCount: 1,
    },
    {
      completedBootstrapComponents: fakeRebuildComponents,
      coveredDirtyWorkRows: [
        {
          articleId: null,
          createdAt: '2026-06-20T10:00:00.000Z',
          dirtyKind: 'source-watermark',
          dirtyRangeEnd: null,
          dirtyRangeStart: null,
          dirtyWorkId: 'dirty-covered-summary-1',
          firstSourceHighWaterMark: 1,
          latestDeltaId: null,
          latestSourceHighWaterMark: 10,
          lifecycleReason: null,
          projectId: 'project-v4',
          projectionComponent: 'summary',
          projectionIdentity: getFakeBootstrapProjectionIdentity('summary'),
          projectionKey: JSON.stringify({
            projectionComponent: 'summary',
            projectionIdentity: getFakeBootstrapProjectionIdentity('summary'),
          }),
          scopeId: 'project-v4',
          scopeKind: 'project',
          sourcePartition: 'reviewChange',
          status: 'pending',
          storageRowId: 42,
          updatedAt: '2026-06-20T10:00:00.000Z',
        },
      ],
      dirtyWatermarks: [
        {latestSourceHighWaterMark: 10, sourcePartition: 'reviewChange:project-v4'},
        {latestSourceHighWaterMark: 4, sourcePartition: 'importRunArticle:project-v4'},
        {latestSourceHighWaterMark: 7, sourcePartition: 'projectScope:project-v4'},
      ],
    },
  )

  const request = await Effect.runPromise(
    requestReviewServingV4RebuildEffect({projectId: 'project-v4', reason: 'missingReviewServingSnapshot'}, database),
  )
  const joined = statements.join('\n')

  expect(request.status).toBe('completed')
  expect(joined).not.toContain('INSERT INTO app.review_rebuild_chunk_manifest')
  expect(joined).toContain("snapshot_status = 'active'")
  expect(joined).toContain('validation_result_json =')
  expect(joined).toContain('INSERT INTO app.review_serving_dirty_work_ack')
  expect(joined).toContain('FROM app.review_serving_dirty_work_claim_state')
  expect(joined).toContain("lifecycle_reason = 'covered_by_rebuild'")
  expect(joined).toContain('UPDATE app.review_serving_project_dirty_source_watermark')
  expect(request.diagnosticsJson).toMatchObject({
    componentReuse: {
      rebuiltChunkCount: 0,
      reusedComponents: [...fakeRebuildComponents],
      reuseMode: 'componentGeneration',
      sameSnapshotComponents: [...fakeRebuildComponents],
    },
    promotion: {
      dirtyWorkCompletion: {completedCount: 1},
      promoted: true,
    },
  })
})

test('V4 bootstrap candidate makes enrichment components optional for default readiness', async () => {
  const {database, statements} = createFakeRequestDatabase({...baseStats, snapshotCount: 0, snapshotUpdatedAt: null})

  await Effect.runPromise(
    requestReviewServingV4RebuildEffect({projectId: 'project-v4', reason: 'missingReviewServingSnapshot'}, database),
  )

  const snapshotInsert =
    statements.find((statement) => {
      return statement.includes('INSERT INTO app.review_serving_snapshot_manifest')
    }) ?? ''
  const jsonArrays = getJsonArraysFromSql(snapshotInsert)
  const requiredComponents = jsonArrays.find((entry) => {
    return entry.includes('projectScope') && entry.includes('selectedImport')
  })
  const optionalComponents = jsonArrays.find((entry) => {
    return entry.includes('payload')
  })

  expect(requiredComponents).not.toContain('posting')
  expect(requiredComponents).not.toContain('summary')
  expect(requiredComponents).not.toContain('judgmentInputContent')
  expect(requiredComponents).not.toContain('payload')
  expect(optionalComponents).toEqual(['payload', 'posting', 'summary', 'judgmentInputContent', 'search'])
})

test('V4 bootstrap request transaction carries workload context for all published manifests', async () => {
  const {database, transactionStatements, transactionWorkloadContexts} = createFakeRequestDatabase({
    ...baseStats,
    snapshotCount: 0,
    snapshotUpdatedAt: null,
  })

  await Effect.runPromise(
    requestReviewServingV4RebuildEffect({projectId: 'project-v4', reason: 'missingReviewServingSnapshot'}, database),
  )

  expect(transactionWorkloadContexts).toEqual([
    {
      allowsTempSpill: true,
      fallbackIntent: 'reject',
      projectId: 'project-v4',
      routeOrJobKey: 'reviewServing.v4RebuildRequest',
      searchMode: 'none',
      workloadClass: 'reviewProjector',
    },
  ])
  expect(transactionStatements).toHaveLength(1)
  expect(transactionStatements[0]?.join('\n')).toContain('INSERT INTO app.review_rebuild_request')
  expect(transactionStatements[0]?.join('\n')).toContain('INSERT INTO app.review_rebuild_chunk_manifest')
  expect(transactionStatements[0]?.join('\n')).not.toContain('INSERT INTO app.review_serving_snapshot_manifest')
})

test('V4 rebuild request service returns a no-op rebuild request when there are no scoped articles', async () => {
  const {database, statements} = createFakeRequestDatabase({
    ...baseStats,
    scopedArticleCount: 0,
    snapshotCount: 0,
    snapshotUpdatedAt: null,
  })

  const request = await Effect.runPromise(
    requestReviewServingV4RebuildEffect({projectId: 'project-v4', reason: 'missingReviewServingSnapshot'}, database),
  )

  expect(request.status).toBe('completed')
  expect(request.requestId).toStartWith('rebuild:')
  expect(request.diagnosticsJson).toMatchObject({noScopedArticles: true})
  expect(statements.join('\n')).not.toContain('INSERT INTO app.review_rebuild_request')
  expect(statements.join('\n')).not.toContain('INSERT INTO app.review_rebuild_chunk_manifest')
})

test('V4 rebuild request service keeps selected-import bootstrap chunks on import watermarks', async () => {
  const {database, statements} = createFakeRequestDatabase(
    {...baseStats, snapshotCount: 0, snapshotUpdatedAt: null},
    {
      dirtyWatermarks: [
        {latestSourceHighWaterMark: 4, sourcePartition: 'importRunArticle:project-v4'},
        {latestSourceHighWaterMark: 10, sourcePartition: 'reviewChange:project-v4'},
      ],
    },
  )

  const request = await Effect.runPromise(
    requestReviewServingV4RebuildEffect({projectId: 'project-v4', reason: 'missingReviewServingSnapshot'}, database),
  )
  const selectedImportChunk = statements.find((statement) => {
    return statement.includes('INSERT INTO app.review_rebuild_chunk_manifest') && statement.includes("'selectedImport'")
  })
  const projectScopeChunk = statements.find((statement) => {
    return statement.includes('INSERT INTO app.review_rebuild_chunk_manifest') && statement.includes("'projectScope'")
  })

  expect(request.status).toBe('admitted')
  expect(selectedImportChunk).toMatch(
    /'selectedImport',\s*'[^']+',\s*'freshReviewServingSnapshot',\s*4,\s*'article-000-a'/u,
  )
  expect(projectScopeChunk).toMatch(
    /'projectScope',\s*'[^']+',\s*'freshReviewServingSnapshot',\s*10,\s*'article-000-a'/u,
  )
  expect(statements.join('\n')).toContain('FROM app.review_serving_project_dirty_source_watermark')
  expect(statements.join('\n')).toContain("AND status <> 'completed'")
})

test('V4 rebuild request service preserves selected-import bootstrap watermarks from aggregate alone', async () => {
  const {database, statements} = createFakeRequestDatabase(
    {...baseStats, snapshotCount: 0, snapshotUpdatedAt: null},
    {
      dirtyWatermarks: [
        {latestSourceHighWaterMark: 7, sourcePartition: 'importRunArticle:project-v4'},
        {latestSourceHighWaterMark: 11, sourcePartition: 'reviewChange:project-v4'},
      ],
    },
  )

  await Effect.runPromise(
    requestReviewServingV4RebuildEffect({projectId: 'project-v4', reason: 'missingReviewServingSnapshot'}, database),
  )

  const selectedImportChunk = statements.find((statement) => {
    return statement.includes('INSERT INTO app.review_rebuild_chunk_manifest') && statement.includes("'selectedImport'")
  })

  expect(selectedImportChunk).toMatch(
    /'selectedImport',\s*'[^']+',\s*'freshReviewServingSnapshot',\s*7,\s*'article-000-a'/u,
  )
  expect(statements.join('\n')).toContain('FROM app.review_serving_project_dirty_source_watermark')
  expect(statements.join('\n')).toContain('GROUP BY source_partition')
  expect(statements.join('\n')).not.toContain('UNION ALL')
  expect(statements.join('\n')).toContain("AND status <> 'completed'")
})

test('V4 missing snapshot rebuild requests reuse active admitted work', async () => {
  const {database, statements} = createFakeRequestDatabase({...baseStats, snapshotCount: 0, snapshotUpdatedAt: null})

  const firstRequest = await Effect.runPromise(
    requestReviewServingV4RebuildEffect({projectId: 'project-v4', reason: 'missingReviewServingSnapshot'}, database),
  )
  const secondRequest = await Effect.runPromise(
    requestReviewServingV4RebuildEffect({projectId: 'project-v4', reason: 'missingReviewServingSnapshot'}, database),
  )
  const rebuildRequestInsertCount = statements.filter((statement) => {
    return statement.includes('INSERT INTO app.review_rebuild_request')
  }).length

  expect(secondRequest.requestId).toBe(firstRequest.requestId)
  expect(rebuildRequestInsertCount).toBe(1)
  expect(statements.join('\n')).toContain("chunk.status IN ('blocked_over_budget', 'quarantined')")
})

test('V4 missing snapshot rebuild reseeds legacy enrichment-required bootstrap candidates', async () => {
  const {database, statements} = createFakeRequestDatabase(
    {...baseStats, snapshotCount: 0, snapshotUpdatedAt: null},
    {legacyRequiredEnrichmentCandidate: true},
  )

  const firstRequest = await Effect.runPromise(
    requestReviewServingV4RebuildEffect({projectId: 'project-v4', reason: 'missingReviewServingSnapshot'}, database),
  )
  const reseededRequest = await Effect.runPromise(
    requestReviewServingV4RebuildEffect({projectId: 'project-v4', reason: 'missingReviewServingSnapshot'}, database),
  )
  const snapshotInserts = statements.filter((statement) => {
    return (
      statement.includes('INSERT INTO app.review_serving_snapshot_manifest')
      && statement.includes('optional_components_json')
    )
  })
  const reseededSnapshotInsert = snapshotInserts.at(-1) ?? ''
  const jsonArrays = getJsonArraysFromSql(reseededSnapshotInsert)
  const requiredComponents = jsonArrays.find((entry) => {
    return entry.includes('projectScope') && entry.includes('selectedImport')
  })
  const optionalComponents = jsonArrays.find((entry) => {
    return entry.includes('payload')
  })

  expect(reseededRequest.requestId).toBe(firstRequest.requestId)
  expect(snapshotInserts).toHaveLength(2)
  expect(requiredComponents).not.toContain('posting')
  expect(requiredComponents).not.toContain('summary')
  expect(requiredComponents).not.toContain('judgmentInputContent')
  expect(requiredComponents).not.toContain('payload')
  expect(optionalComponents).toEqual(['payload', 'posting', 'summary', 'judgmentInputContent', 'search'])
})

test('V4 missing snapshot rebuild requests boost active foreground work priority', async () => {
  const {database, statements} = createFakeRequestDatabase({...baseStats, snapshotCount: 0, snapshotUpdatedAt: null})

  const firstRequest = await Effect.runPromise(
    requestReviewServingV4RebuildEffect({projectId: 'project-v4', reason: 'missingReviewServingSnapshot'}, database),
  )
  const boostedRequest = await Effect.runPromise(
    requestReviewServingV4RebuildEffect(
      {priority: 1_000, projectId: 'project-v4', reason: 'missingReviewServingSnapshot'},
      database,
    ),
  )
  const rebuildRequestInsertCount = statements.filter((statement) => {
    return statement.includes('INSERT INTO app.review_rebuild_request')
  }).length

  expect(boostedRequest.requestId).toBe(firstRequest.requestId)
  expect(boostedRequest.priority).toBe(1_000)
  expect(rebuildRequestInsertCount).toBe(1)
  expect(statements.join('\n')).toContain('UPDATE app.review_rebuild_request')
  expect(statements.join('\n')).toContain('WHEN priority < 1000 THEN 1000')
})

test('V4 missing snapshot rebuild requests retouch equal foreground priority on repeated foreground access', async () => {
  const {database, statements} = createFakeRequestDatabase({...baseStats, snapshotCount: 0, snapshotUpdatedAt: null})

  const firstRequest = await Effect.runPromise(
    requestReviewServingV4RebuildEffect(
      {priority: 1_000, projectId: 'project-v4', reason: 'missingReviewServingSnapshot'},
      database,
    ),
  )
  const touchedRequest = await Effect.runPromise(
    requestReviewServingV4RebuildEffect(
      {priority: 1_000, projectId: 'project-v4', reason: 'missingReviewServingSnapshot'},
      database,
    ),
  )
  const updateCount = statements.filter((statement) => {
    return (
      statement.includes('UPDATE app.review_rebuild_request') && statement.includes('updated_at = current_timestamp')
    )
  }).length

  expect(touchedRequest.requestId).toBe(firstRequest.requestId)
  expect(touchedRequest.priority).toBe(1_000)
  expect(updateCount).toBe(1)
})

test('V4 missing snapshot rebuild requests preserve foreground priority on first create', async () => {
  const {database} = createFakeRequestDatabase({...baseStats, snapshotCount: 0, snapshotUpdatedAt: null})

  const request = await Effect.runPromise(
    requestReviewServingV4RebuildEffect(
      {priority: 1_000, projectId: 'project-v4', reason: 'missingReviewServingSnapshot'},
      database,
    ),
  )

  expect(request.priority).toBe(1_000)
})

test('V4 missing snapshot rebuild requests do not reuse running active work', async () => {
  const {database, setRequestStatus, statements} = createFakeRequestDatabase({
    ...baseStats,
    snapshotCount: 0,
    snapshotUpdatedAt: null,
  })

  const firstRequest = await Effect.runPromise(
    requestReviewServingV4RebuildEffect({projectId: 'project-v4', reason: 'missingReviewServingSnapshot'}, database),
  )
  setRequestStatus(firstRequest.requestId, 'running')
  const secondRequest = await Effect.runPromise(
    requestReviewServingV4RebuildEffect({projectId: 'project-v4', reason: 'missingReviewServingSnapshot'}, database),
  )
  const rebuildRequestInsertCount = statements.filter((statement) => {
    return statement.includes('INSERT INTO app.review_rebuild_request')
  }).length

  expect(secondRequest.status).toBe('admitted')
  expect(rebuildRequestInsertCount).toBe(2)
})

test('V4 missing snapshot rebuild requests do not reuse unrelated active work', async () => {
  const {database, statements} = createFakeRequestDatabase({...baseStats, snapshotCount: 0, snapshotUpdatedAt: null})

  const unrelatedRequest = await Effect.runPromise(
    requestReviewServingV4RebuildEffect(
      {projectId: 'project-v4', reason: 'requestReviewServingLargeRebuild'},
      database,
    ),
  )
  const missingSnapshotRequest = await Effect.runPromise(
    requestReviewServingV4RebuildEffect({projectId: 'project-v4', reason: 'missingReviewServingSnapshot'}, database),
  )
  const rebuildRequestInsertCount = statements.filter((statement) => {
    return statement.includes('INSERT INTO app.review_rebuild_request')
  }).length

  expect(missingSnapshotRequest.requestId).not.toBe(unrelatedRequest.requestId)
  expect(missingSnapshotRequest.reason).toBe('missingReviewServingSnapshot')
  expect(rebuildRequestInsertCount).toBe(2)
})

test('V4 rebuild request service splits missing snapshot bootstraps into bounded article chunks', async () => {
  const {database, statements} = createFakeRequestDatabase({
    ...baseStats,
    humanJudgmentCount: 0,
    judgmentCount: 0,
    promptCount: 0,
    scopedArticleCount: 20_000,
    snapshotCount: 0,
    snapshotUpdatedAt: null,
    summaryHumanJudgmentCount: 0,
  })

  const request = await Effect.runPromise(
    requestReviewServingV4RebuildEffect(
      {components: ['display', 'summary'], projectId: 'project-v4', reason: 'missingReviewServingSnapshot'},
      database,
    ),
  )
  const joined = statements.join('\n')
  const chunkInserts = statements.filter((statement) => {
    return statement.includes('INSERT INTO app.review_rebuild_chunk_manifest')
  })
  const displayChunkInserts = chunkInserts.filter((statement) => {
    return statement.includes('display')
  })
  const summaryChunkInserts = chunkInserts.filter((statement) => {
    return statement.includes('summary')
  })

  expect(request.status).toBe('admitted')
  expect(request.overBudgetReason).toBeNull()
  expect(joined).toContain('NTILE(')
  expect(joined).toContain('INSERT INTO app.review_rebuild_chunk_manifest')
  expect(joined).not.toContain('FROM mart.review_llm_status_patch_v4 llm')
  expect(joined).not.toContain('FROM mart.review_human_status_patch_v4 human')
  expect(joined).toContain('article-000-a')
  expect(joined).toContain('article-001-a')
  expect(displayChunkInserts.length).toBeGreaterThan(1)
  expect(summaryChunkInserts.length).toBeGreaterThan(1)
  expect(summaryChunkInserts[0]).toContain('article-000-a')
  expect(summaryChunkInserts[0]).toContain('article-000-z')
  expect(joined).toContain('INSERT INTO app.review_projection_identity_manifest')
  expect(joined).toContain('INSERT INTO app.review_serving_snapshot_manifest')
})

test('V4 missing snapshot rebuild bootstraps candidate-only projects with bounded chunks', async () => {
  const {database, statements} = createFakeRequestDatabase({
    ...baseStats,
    activeSnapshotCount: 0,
    humanJudgmentCount: 0,
    judgmentCount: 0,
    promptCount: 0,
    scopedArticleCount: 20_000,
    snapshotCount: 1,
    summaryHumanJudgmentCount: 0,
  })

  const request = await Effect.runPromise(
    requestReviewServingV4RebuildEffect({projectId: 'project-v4', reason: 'missingReviewServingSnapshot'}, database),
  )
  const joined = statements.join('\n')
  const displayChunkInserts = statements.filter((statement) => {
    return statement.includes('INSERT INTO app.review_rebuild_chunk_manifest') && statement.includes('display')
  })

  expect(request.status).toBe('admitted')
  expect(request.overBudgetReason).toBeNull()
  expect(joined).toContain('NTILE(')
  expect(joined).not.toContain('FROM mart.review_llm_status_patch_v4 llm')
  expect(joined).not.toContain('FROM mart.review_human_status_patch_v4 human')
  expect(displayChunkInserts.length).toBeGreaterThan(1)
  expect(joined).toContain('INSERT INTO app.review_projection_identity_manifest')
  expect(joined).toContain('INSERT INTO app.review_serving_snapshot_manifest')
})

test('V4 rebuild request service budgets split missing snapshot bootstraps by the largest article chunk', async () => {
  const {database, statements} = createFakeRequestDatabase({
    ...baseStats,
    enabledPromptCount: 0,
    humanJudgmentCount: 150_000,
    judgmentCount: 0,
    promptCount: 0,
    scopedArticleCount: 20_000,
    snapshotCount: 0,
    snapshotUpdatedAt: null,
    summaryHumanJudgmentCount: 0,
  })

  const request = await Effect.runPromise(
    requestReviewServingV4RebuildEffect(
      {components: ['judgmentInputContent'], projectId: 'project-v4', reason: 'missingReviewServingSnapshot'},
      database,
    ),
  )

  expect(request.status).toBe('blocked_over_budget')
  expect(request.overBudgetReason).toBe('input rows: estimated 300033 > max 250000')
  expect(statements.join('\n')).toContain('INSERT INTO app.review_rebuild_chunk_manifest')
  expect(statements.join('\n')).not.toContain('INSERT INTO app.review_serving_snapshot_manifest')
})

test('V4 rebuild request service blocks terminally over-budget missing snapshot repair with explicit chunks', async () => {
  const {database, statements} = createFakeRequestDatabase({
    ...baseStats,
    humanJudgmentCount: 0,
    promptCount: 10_001,
    scopedArticleCount: 1,
    snapshotCount: 0,
    snapshotUpdatedAt: null,
    summaryHumanJudgmentCount: 0,
  })

  const request = await Effect.runPromise(
    requestReviewServingV4RebuildEffect({projectId: 'project-v4', reason: 'missingReviewServingSnapshot'}, database),
  )
  const joined = statements.join('\n')

  expect(request.status).toBe('blocked_over_budget')
  expect(request.overBudgetReason).toBe('prompt count: estimated 10001 > max 10000')
  expect(joined).toContain('NTILE(')
  expect(joined).toContain('INSERT INTO app.review_rebuild_chunk_manifest')
  expect(joined).not.toContain('INSERT INTO app.review_projection_identity_manifest')
  expect(joined).not.toContain('INSERT INTO app.review_serving_snapshot_manifest')
})

test('V4 rebuild request service range-chunks project scope with other bootstrap components', async () => {
  const {database, statements} = createFakeRequestDatabase({
    ...baseStats,
    humanJudgmentCount: 0,
    judgmentCount: 0,
    promptCount: 0,
    scopedArticleCount: 20_000,
    snapshotCount: 0,
    snapshotUpdatedAt: null,
    summaryHumanJudgmentCount: 0,
  })

  const request = await Effect.runPromise(
    requestReviewServingV4RebuildEffect(
      {
        components: ['projectScope', 'selectedImport', 'summary', 'display'],
        projectId: 'project-v4',
        reason: 'missingReviewServingSnapshot',
      },
      database,
    ),
  )
  const chunkInserts = statements.filter((statement) => {
    return statement.includes('INSERT INTO app.review_rebuild_chunk_manifest')
  })
  const selectedImportChunkInserts = chunkInserts.filter((statement) => {
    return statement.includes('selectedImport')
  })
  const projectScopeChunkInserts = chunkInserts.filter((statement) => {
    return statement.includes('projectScope')
  })
  const displayChunkInserts = chunkInserts.filter((statement) => {
    return statement.includes('display')
  })
  const summaryChunkInserts = chunkInserts.filter((statement) => {
    return statement.includes('summary')
  })

  expect(request.status).toBe('admitted')
  expect(selectedImportChunkInserts.length).toBeGreaterThan(1)
  expect(projectScopeChunkInserts.length).toBeGreaterThan(1)
  expect(summaryChunkInserts.length).toBeGreaterThan(1)
  expect(displayChunkInserts.length).toBeGreaterThan(1)
  expect(selectedImportChunkInserts[0]).toContain('article-000-a')
  expect(selectedImportChunkInserts[0]).toContain('article-000-z')
  expect(summaryChunkInserts[0]).toContain('article-000-a')
  expect(summaryChunkInserts[0]).toContain('article-000-z')
  expect(projectScopeChunkInserts[0]).toContain('article-000-a')
  expect(projectScopeChunkInserts[0]).toContain('article-000-z')
})

test('V4 missing snapshot bootstrap admits selected import, project scope, and summary as bounded range chunks', async () => {
  const {database, statements} = createFakeRequestDatabase({
    ...baseStats,
    activeSnapshotCount: 0,
    enabledPromptCount: 0,
    humanJudgmentCount: 0,
    judgmentCount: 0,
    promptCount: 0,
    scopedArticleCount: 139_574,
    snapshotCount: 1,
    summaryHumanJudgmentCount: 0,
  })

  const request = await Effect.runPromise(
    requestReviewServingV4RebuildEffect({projectId: 'project-v4', reason: 'missingReviewServingSnapshot'}, database),
  )
  const chunkInserts = statements.filter((statement) => {
    return statement.includes('INSERT INTO app.review_rebuild_chunk_manifest')
  })
  const selectedImportChunkInserts = chunkInserts.filter((statement) => {
    return statement.includes('selectedImport')
  })
  const summaryChunkInserts = chunkInserts.filter((statement) => {
    return statement.includes('summary')
  })
  const projectScopeChunkInserts = chunkInserts.filter((statement) => {
    return statement.includes('projectScope')
  })
  expect(request.status).toBe('admitted')
  expect(request.overBudgetReason).toBeNull()
  expect(selectedImportChunkInserts.length).toBeGreaterThan(1)
  expect(summaryChunkInserts.length).toBeGreaterThan(1)
  expect(projectScopeChunkInserts.length).toBeGreaterThan(1)
  expect(selectedImportChunkInserts[0]).toContain('article-000-a')
  expect(selectedImportChunkInserts[0]).toContain('article-000-z')
  expect(summaryChunkInserts[0]).toContain('article-000-a')
  expect(summaryChunkInserts[0]).toContain('article-000-z')
})

test('V4 missing snapshot bootstrap bounds large project-scope request estimates', async () => {
  const {database, statements} = createFakeRequestDatabase({
    ...baseStats,
    activeSnapshotCount: 0,
    enabledPromptCount: 1,
    humanJudgmentCount: 0,
    judgmentCount: 86_264,
    promptCount: 1,
    scopedArticleCount: 544_684,
    snapshotCount: 1,
    summaryHumanJudgmentCount: 0,
  })

  const request = await Effect.runPromise(
    requestReviewServingV4RebuildEffect({projectId: 'project-v4', reason: 'missingReviewServingSnapshot'}, database),
  )
  const projectScopeChunkInserts = statements.filter((statement) => {
    return statement.includes('INSERT INTO app.review_rebuild_chunk_manifest') && statement.includes('projectScope')
  })

  expect(request.status).toBe('admitted')
  expect(request.overBudgetReason).toBeNull()
  const joined = statements.join('\n')

  expect(joined).toContain('"bootstrapChunkCount":85')
  expect(joined).toContain('"bootstrapExecutableChunkCount":935')
  expect(joined).toContain('"bootstrapSnapshot":true')
  expect(joined).toContain('"childAdmissionBudget"')
  expect(joined).toContain('"childAdmissionEstimate"')
  expect(joined).toContain('"coldBootstrap":true')
  expect(joined).toContain('"totalEstimate"')
  expect(projectScopeChunkInserts).toHaveLength(85)
})

test('V4 rebuild request service accounts for list-mode fan-out in admission budgets', async () => {
  const {database} = createFakeRequestDatabase({
    ...baseStats,
    humanJudgmentCount: 0,
    judgmentCount: 0,
    promptCount: 0,
    scopedArticleCount: 100_000,
    summaryHumanJudgmentCount: 0,
  })

  const request = await Effect.runPromise(
    requestReviewServingV4RebuildEffect(
      {components: ['display'], projectId: 'project-v4', reason: 'requestReviewServingLargeRebuild'},
      database,
    ),
  )

  expect(request.status).toBe('blocked_over_budget')
  expect(request.overBudgetReason).toBe('input rows: estimated 400000 > max 250000')
})

test('V4 rebuild request service estimates status rebuild rows from written list modes', async () => {
  const {database} = createFakeRequestDatabase({
    ...baseStats,
    enabledPromptCount: 2,
    humanJudgmentCount: 0,
    judgmentCount: 0,
    promptCount: 2,
    scopedArticleCount: 30_000,
    summaryHumanJudgmentCount: 0,
  })

  const request = await Effect.runPromise(
    requestReviewServingV4RebuildEffect(
      {components: ['llmStatus'], projectId: 'project-v4', reason: 'requestReviewServingLargeRebuild'},
      database,
    ),
  )

  expect(request.status).toBe('admitted')
  expect(request.overBudgetReason).toBeNull()
})

test('V4 rebuild request service presplits synthetic summary prompt rows in human status estimates', async () => {
  const {database, statements} = createFakeRequestDatabase({
    ...baseStats,
    enabledPromptCount: 1,
    humanJudgmentCount: 0,
    judgmentCount: 0,
    promptCount: 1,
    scopedArticleCount: 100_000,
    summaryHumanJudgmentCount: 0,
  })

  const request = await Effect.runPromise(
    requestReviewServingV4RebuildEffect(
      {components: ['humanStatus'], projectId: 'project-v4', reason: 'requestReviewServingLargeRebuild'},
      database,
    ),
  )

  const joined = statements.join('\n')
  const humanStatusChunkInserts = statements.filter((statement) => {
    return statement.includes('INSERT INTO app.review_rebuild_chunk_manifest') && statement.includes('humanStatus')
  })

  expect(request.status).toBe('admitted')
  expect(request.overBudgetReason).toBeNull()
  expect(joined).toContain('NTILE(64)')
  expect(joined).toContain('"estimatedInputRows":400000')
  expect(humanStatusChunkInserts).toHaveLength(64)
  expect(humanStatusChunkInserts[0]).toContain('"admissionPresplit":true')
  expect(humanStatusChunkInserts[0]).toContain('"inputRowLimit":64')
  expect(humanStatusChunkInserts[0]).toContain('6250')
})

test('V4 rebuild request service presplits selected-import posting facets in admission budgets', async () => {
  const {database, statements} = createFakeRequestDatabase({
    ...baseStats,
    enabledPromptCount: 0,
    humanJudgmentCount: 0,
    judgmentCount: 0,
    promptCount: 0,
    scopedArticleCount: 40_000,
    summaryHumanJudgmentCount: 0,
  })

  const request = await Effect.runPromise(
    requestReviewServingV4RebuildEffect(
      {components: ['posting'], projectId: 'project-v4', reason: 'requestReviewServingLargeRebuild'},
      database,
    ),
  )

  const joined = statements.join('\n')
  const postingChunkInserts = statements.filter((statement) => {
    return statement.includes('INSERT INTO app.review_rebuild_chunk_manifest') && statement.includes('posting')
  })

  expect(request.status).toBe('admitted')
  expect(request.overBudgetReason).toBeNull()
  expect(joined).toContain('NTILE(64)')
  expect(joined).toContain('"estimatedInputRows":640000')
  expect(postingChunkInserts).toHaveLength(64)
  expect(postingChunkInserts[0]).toContain('"admissionPresplit":true')
  expect(postingChunkInserts[0]).toContain('"inputRowLimit":512')
  expect(postingChunkInserts[0]).toContain('10000')
})

test('V4 rebuild request service excludes lazy prompt-answer posting fan-out from admission budgets', async () => {
  const {database} = createFakeRequestDatabase({
    ...baseStats,
    enabledPromptCount: 10,
    humanJudgmentCount: 0,
    judgmentCount: 0,
    promptCount: 10,
    scopedArticleCount: 10_000,
    summaryHumanJudgmentCount: 0,
  })

  const request = await Effect.runPromise(
    requestReviewServingV4RebuildEffect(
      {components: ['posting'], projectId: 'project-v4', reason: 'requestReviewServingLargeRebuild'},
      database,
    ),
  )

  expect(request.status).toBe('admitted')
  expect(request.overBudgetReason).toBeNull()
})

test('V4 rebuild request service excludes lazy prompt-derived summary fan-out from admission budgets', async () => {
  const {database} = createFakeRequestDatabase({
    ...baseStats,
    enabledPromptCount: 10,
    humanJudgmentCount: 0,
    judgmentCount: 0,
    promptCount: 10,
    scopedArticleCount: 40_000,
    summaryHumanJudgmentCount: 0,
  })

  const request = await Effect.runPromise(
    requestReviewServingV4RebuildEffect(
      {components: ['summary'], projectId: 'project-v4', reason: 'requestReviewServingLargeRebuild'},
      database,
    ),
  )

  expect(request.status).toBe('admitted')
  expect(request.overBudgetReason).toBeNull()
})

test('V4 rebuild request service charges queue readiness as article-level output only', async () => {
  const {database, statements} = createFakeRequestDatabase({
    ...baseStats,
    enabledPromptCount: 10,
    humanJudgmentCount: 0,
    judgmentCount: 0,
    promptCount: 10,
    scopedArticleCount: 100_000,
    summaryHumanJudgmentCount: 0,
  })

  const request = await Effect.runPromise(
    requestReviewServingV4RebuildEffect(
      {components: ['queue'], projectId: 'project-v4', reason: 'requestReviewServingLargeRebuild'},
      database,
    ),
  )

  expect(request.status).toBe('admitted')
  expect(statements.join('\n')).toContain('"estimatedInputRows":100000')
  expect(statements.join('\n')).toContain('"estimatedOutputRows":100000')
  expect(request.overBudgetReason).toBeNull()
})

test('V4 rebuild request service includes placeholder detail rows in payload bytes', async () => {
  const {database} = createFakeRequestDatabase({
    ...baseStats,
    enabledPromptCount: 7,
    humanJudgmentCount: 0,
    judgmentCount: 0,
    promptCount: 7,
    scopedArticleCount: 10_000,
    summaryHumanJudgmentCount: 0,
  })

  const request = await Effect.runPromise(
    requestReviewServingV4RebuildEffect(
      {
        components: ['judgmentInputContent', 'payload'],
        projectId: 'project-v4',
        reason: 'requestReviewServingLargeRebuild',
      },
      database,
    ),
  )

  expect(request.status).toBe('blocked_over_budget')
  expect(request.overBudgetReason).toBe('payload bytes: estimated 71680000 > max 67108864')
})

test('V4 rebuild request service scales admission estimates by queued snapshots', async () => {
  const {database} = createFakeRequestDatabase({
    ...baseStats,
    enabledPromptCount: 1,
    humanJudgmentCount: 2,
    judgmentCount: 4,
    scopedArticleCount: 10,
    snapshotCount: 2,
    summaryHumanJudgmentCount: 1,
  })

  const request = await Effect.runPromise(
    requestReviewServingV4RebuildEffect(
      {components: ['summary', 'payload'], projectId: 'project-v4', reason: 'requestReviewServingLargeRebuild'},
      database,
    ),
  )

  expect(request.status).toBe('blocked_over_budget')
  expect(request.overBudgetReason).toBe('snapshot count: estimated 2 > max 1')
})

test('V4 rebuild request service watermarks make changed data produce a new request id', async () => {
  const first = createFakeRequestDatabase(baseStats)
  const second = createFakeRequestDatabase({...baseStats, summaryHumanJudgmentUpdatedAt: '2026-06-20T11:00:00.000Z'})

  const firstRequest = await Effect.runPromise(
    requestReviewServingV4RebuildEffect(
      {components: ['summary'], projectId: 'project-v4', reason: 'requestReviewServingLargeRebuild'},
      first.database,
    ),
  )
  const secondRequest = await Effect.runPromise(
    requestReviewServingV4RebuildEffect(
      {components: ['summary'], projectId: 'project-v4', reason: 'requestReviewServingLargeRebuild'},
      second.database,
    ),
  )

  expect(firstRequest.requestId).not.toBe(secondRequest.requestId)
})

test('V4 rebuild request service prompt watermarks make changed prompt identity produce a new request id', async () => {
  const first = createFakeRequestDatabase(baseStats)
  const second = createFakeRequestDatabase({...baseStats, promptIdentityDigest: 'prompt-digest-v2'})

  const firstRequest = await Effect.runPromise(
    requestReviewServingV4RebuildEffect(
      {components: ['summary'], projectId: 'project-v4', reason: 'requestReviewServingLargeRebuild'},
      first.database,
    ),
  )
  const secondRequest = await Effect.runPromise(
    requestReviewServingV4RebuildEffect(
      {components: ['summary'], projectId: 'project-v4', reason: 'requestReviewServingLargeRebuild'},
      second.database,
    ),
  )

  expect(firstRequest.requestId).not.toBe(secondRequest.requestId)
})

test('V4 rebuild request service model watermarks make changed execution identity produce a new request id', async () => {
  const first = createFakeRequestDatabase(baseStats)
  const second = createFakeRequestDatabase({...baseStats, modelExecutionIdentityDigest: 'model-execution-digest-v2'})

  const firstRequest = await Effect.runPromise(
    requestReviewServingV4RebuildEffect(
      {components: ['summary'], projectId: 'project-v4', reason: 'requestReviewServingLargeRebuild'},
      first.database,
    ),
  )
  const secondRequest = await Effect.runPromise(
    requestReviewServingV4RebuildEffect(
      {components: ['summary'], projectId: 'project-v4', reason: 'requestReviewServingLargeRebuild'},
      second.database,
    ),
  )

  expect(firstRequest.requestId).not.toBe(secondRequest.requestId)
})
