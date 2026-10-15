import {mkdir, mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'

import {afterEach, beforeEach, expect, mock, test} from 'bun:test'

import type {ProjectTransferImportPlanArtifact} from './projectTransferAnalyze.ts'
import type {ProjectTransferOperationTableRunner} from './projectTransferOperationTables.ts'
import {getProjectTransferPayloadFixtureMap, serializeProjectTransferPayload} from './projectTransferPayloadSchemas.ts'
import {projectTransferPayloadKeys, projectTransferPayloadPathByKey} from './projectTransferSchemas.ts'
import {getProjectTransferImportTempLayout} from './projectTransferSession.ts'

const payloads = {
  ...getProjectTransferPayloadFixtureMap(),
  articleImportRoutes: [],
  articles: [],
  humanJudgmentSummaries: [],
  humanJudgments: [],
  importRoutes: [],
  judgmentAssessments: [],
  judgments: [],
  models: [],
  projectArticles: [],
  projectImportRoutes: [],
  projectPrompts: [],
  prompts: [],
  providerConnections: [],
  reviews: [],
}
const queries: string[] = []
let transactionActive = false
let cwd = ''

const getTargetStateRows = (statement: string): unknown[] | null => {
  return statement.includes('FROM app.project_transfer_target_state_coverage')
    ? [
        {
          coverageCodeVersion: targetStateService.projectTransferTargetStateCoverageCodeVersion,
          coveredSurfacesJson: [...targetStateService.projectTransferTargetStateTrackedSurfaces],
          dependencyFingerprintAlgorithm: targetStateService.projectTransferDependencyFingerprintAlgorithm,
          dependencyFingerprintCodeVersion: targetStateService.projectTransferDependencyFingerprintCodeVersion,
          initializedAt: '2026-10-15T10:00:00.000Z',
          updatedAt: '2026-10-15T10:00:00.000Z',
        },
      ]
    : statement.includes('FROM app.project_transfer_target_state_unknown_token')
      ? [{dirtyToken: 0}]
      : statement.includes('FROM app.project_transfer_target_state_dirty_token')
        ? targetStateService.projectTransferTargetStateSafetySurfaces.map((surface) => {
            return {dirtyToken: 0, surface}
          })
        : null
}

const queryJson = async <T>(statement: string): Promise<T[]> => {
  queries.push(statement)

  if (transactionActive) {
    throw new Error('Repository query is queued behind its own operation-table transaction')
  }

  return (getTargetStateRows(statement)
    ?? (statement.includes('AS payloadJson') && statement.includes('_project\n')
      ? [{payloadJson: payloads.project}]
      : [])) as T[]
}
const run = async () => {}
const database = {
  queryJson,
  run,
  transaction: async <T>(work: (runner: ProjectTransferOperationTableRunner) => Promise<T>) => {
    transactionActive = true

    try {
      return await work({
        queryJson: async <TRow>() => {
          return [] as TRow[]
        },
        run,
      })
    } finally {
      transactionActive = false
    }
  },
}

void mock.module('../appDatabaseService.ts', () => {
  return {
    getAppDatabaseService: () => {
      return database
    },
  }
})

const {getProjectTransferAnalyzeTargetPlan} = await import('./projectTransferAnalyzeTarget.ts')
const {revalidateProjectTransferCommitPlan} = await import('./projectTransferCommit.ts')
const {resolveProjectTransferDependencies} = await import('./projectTransferDependencyResolution.ts')
const targetStateService = await import('./projectTransferTargetStateDirtyTokenService.ts')
const tableWriteTracker = await import('../../utils/duckdbTableWriteTracker.ts')

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'project-transfer-revalidation-'))
  queries.length = 0
})

afterEach(async () => {
  await rm(cwd, {force: true, recursive: true})
})

const getArtifacts = async () => {
  const layout = getProjectTransferImportTempLayout('revalidation-queue-test')
  const target = await getProjectTransferAnalyzeTargetPlan({packageFingerprint: 'fixture', payloads})
  const packageCounts = Object.fromEntries(
    projectTransferPayloadKeys.map((key) => {
      return [key, Array.isArray(payloads[key]) ? payloads[key].length : 1]
    }),
  ) as ProjectTransferImportPlanArtifact['packageCounts']
  const plan: ProjectTransferImportPlanArtifact = {
    blockers: [],
    canCommit: true,
    dependencyResolution: {
      acceptedSubstituteModelSourceIds: [],
      codexSetupState: null,
      modelMaterializationRequests: [],
      modelTargetBySourceId: {},
      providerTargetBySourceId: {},
      unresolvedModelSourceIds: [],
      unresolvedProviderSourceIds: [],
    },
    packageCounts,
    packageFingerprint: 'fixture',
    packageWarnings: [],
    planRevision: 1,
    resolutionKinds: {},
    summary: {
      blockerCount: 0,
      blockers: [],
      conflictCounts: {...target.conflictCounts, packageContractConflictCount: 0},
      dependencyStatuses: {},
      judgmentConflictStatus: 'clear',
      overlapCounts: target.overlapCounts,
      packageCounts,
      warningCount: 0,
    },
    targetPlan: target.targetPlan,
  }

  await Promise.all(
    projectTransferPayloadKeys.map(async (key) => {
      const path = join(cwd, layout.extractedPath, projectTransferPayloadPathByKey[key])
      await mkdir(dirname(path), {recursive: true})
      await globalThis.Bun.write(path, serializeProjectTransferPayload(key, payloads[key]))
    }),
  )

  return {layout, plan}
}

test('commit revalidation can call provider repositories without holding their database queue', async () => {
  const {layout, plan} = await getArtifacts()
  const result = await revalidateProjectTransferCommitPlan({
    analysis: {packageFingerprint: 'fixture'} as Parameters<typeof revalidateProjectTransferCommitPlan>[0]['analysis'],
    cwd,
    layout,
    nextPlanRevision: 2,
    plan,
  })

  expect(result).toMatchObject({changed: false, ready: true})
  expect(
    queries.some((statement) => {
      return statement.includes('FROM app.provider_connection')
    }),
  ).toBe(true)
  expect(await database.queryJson('SELECT 1')).toEqual([])
})

const getAnalyzedPlanWithTrackedTargetState = async () => {
  const {layout, plan} = await getArtifacts()

  tableWriteTracker.recordDuckdbTableWriteTrackerOpen('project-transfer-revalidation-test-database')

  const targetState = await targetStateService
    .getProjectTransferTargetStateDirtyTokenService()
    .getTargetStateDirtyTokenSnapshot()

  queries.length = 0

  return {layout, plan: {...plan, targetState}}
}

const getRevalidationInput = (layout: ReturnType<typeof getProjectTransferImportTempLayout>) => {
  return {
    analysis: {packageFingerprint: 'fixture'} as Parameters<typeof revalidateProjectTransferCommitPlan>[0]['analysis'],
    cwd,
    layout,
    nextPlanRevision: 2,
  }
}

const isTargetStateQuery = (statement: string) => {
  return statement.includes('project_transfer_target_state_')
}

test('commit revalidation keeps the analyzed plan without reading payloads when tracked target tables are unchanged', async () => {
  try {
    const {layout, plan} = await getAnalyzedPlanWithTrackedTargetState()

    await rm(join(cwd, layout.extractedPath), {force: true, recursive: true})

    const result = await revalidateProjectTransferCommitPlan({...getRevalidationInput(layout), plan})

    expect(result).toEqual({changed: false, plan, ready: true})
    expect(result.plan).toBe(plan)
    expect(queries.length).toBeGreaterThan(0)
    expect(queries.every(isTargetStateQuery)).toBe(true)
  } finally {
    tableWriteTracker.recordDuckdbTableWriteTrackerClose()
  }
})

test('commit revalidation re-runs target analysis when a tracked target table was written after analysis', async () => {
  try {
    const {layout, plan} = await getAnalyzedPlanWithTrackedTargetState()

    tableWriteTracker.finishDuckdbTableWriteTracking(
      tableWriteTracker.beginDuckdbTableWriteTracking(
        {},
        "UPDATE app.article SET article_title = 'Edited' WHERE id = 'a'",
      ),
    )

    const result = await revalidateProjectTransferCommitPlan({...getRevalidationInput(layout), plan})

    expect(result).toMatchObject({changed: false, ready: true})
    expect(result.plan).not.toBe(plan)
    expect(result.plan.stalePlanReasons).toMatchObject({
      targetArticle: [{reason: 'target_state_table_write_changed', targetStateSurfaces: ['article']}],
    })
    expect(queries.some(isTargetStateQuery)).toBe(true)
    expect(
      queries.some((statement) => {
        return statement.includes('FROM app.provider_connection')
      }),
    ).toBe(true)
  } finally {
    tableWriteTracker.recordDuckdbTableWriteTrackerClose()
  }
})

test('dependency resolution can call provider repositories without holding their database queue', async () => {
  const {layout, plan} = await getArtifacts()
  const result = await resolveProjectTransferDependencies({
    cwd,
    deferPlanWrite: true,
    layout,
    nextPlanRevision: 2,
    plan,
    request: {autoResolve: false, planRevision: 1},
  })

  expect(result.status).toBe('ok')
  expect(
    queries.some((statement) => {
      return statement.includes('FROM app.provider_connection')
    }),
  ).toBe(true)
  expect(await database.queryJson('SELECT 1')).toEqual([])
})
