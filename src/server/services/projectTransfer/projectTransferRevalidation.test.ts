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

const queryJson = async <T>(statement: string): Promise<T[]> => {
  queries.push(statement)

  if (transactionActive) {
    throw new Error('Repository query is queued behind its own operation-table transaction')
  }

  return statement.includes('AS payloadJson') && statement.includes('_project\n')
    ? ([{payloadJson: payloads.project}] as T[])
    : []
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
