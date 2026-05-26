import {mkdtempSync, rmSync} from 'node:fs'
import {mkdir, readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'

import {expect, test} from 'bun:test'

import type {
  ProviderConnectionForAdmin,
  ProviderConnectionRecord,
  ProviderModelRecord,
} from '../../providers/providerTypes.ts'
import type {ProjectTransferImportPlanArtifact} from './projectTransferAnalyze.ts'
import {
  getProjectTransferInitialConflictCounts,
  getProjectTransferInitialOverlapCounts,
} from './projectTransferAnalyzeTarget.ts'
import {resolveProjectTransferDependencies} from './projectTransferDependencyResolution.ts'
import {
  getProjectTransferPayloadFixtureMap,
  type ProjectTransferPayloadByKey,
  serializeProjectTransferPayload,
} from './projectTransferPayloadSchemas.ts'
import {projectTransferPayloadKeys, projectTransferPayloadPathByKey} from './projectTransferSchemas.ts'
import {getProjectTransferImportTempLayout} from './projectTransferSession.ts'

const sessionId = 'dependency-session-1'

const getRuntimeRoot = () => {
  return mkdtempSync(join(tmpdir(), `f2-project-transfer-dependencies-${process.pid}-`))
}

const getTargetModel = (overrides: Partial<ProviderModelRecord> = {}): ProviderModelRecord => {
  return {
    baseURL: null,
    createdAt: null,
    displayName: 'GPT 5.4',
    enabled: true,
    id: 'target-model-1',
    metadataJson: {options: {thinking: 'medium'}},
    modelName: 'gpt-5.4',
    name: 'GPT 5.4',
    provider: 'openai',
    providerConnectionId: 'target-provider-1',
    remoteModelId: 'gpt-5.4',
    source: 'manual',
    updatedAt: null,
    variant: null,
    version: null,
    ...overrides,
  }
}

const getTargetConnection = (
  overrides: Partial<ProviderConnectionForAdmin> = {},
  models: ProviderModelRecord[] = [getTargetModel()],
): ProviderConnectionForAdmin => {
  return {
    authMode: 'api-key',
    baseURL: null,
    config: {disabledModelIds: [], manualWorkerUrls: [], workerUrlMode: 'manual'},
    createdAt: null,
    enabled: true,
    hasSecret: true,
    id: 'target-provider-1',
    label: 'OpenAI target',
    lastCheckedAt: null,
    lastError: null,
    maxInflightRequests: 4,
    models,
    providerKind: 'openai',
    secretRef: 'secret:test',
    updatedAt: null,
    ...overrides,
  }
}

const getBasePlan = (): ProjectTransferImportPlanArtifact => {
  const summary = {
    blockerCount: 0,
    blockers: [],
    conflictCounts: getProjectTransferInitialConflictCounts(0),
    dependencyStatuses: {},
    overlapCounts: getProjectTransferInitialOverlapCounts(),
    packageCounts: projectTransferPayloadKeys.reduce<Record<string, number>>((counts, key) => {
      return {...counts, [key]: 0}
    }, {}),
    packageFingerprint: 'package-fingerprint-1',
    packageWarnings: [],
    warningCount: 0,
  }

  return {
    blockers: [],
    canCommit: true,
    packageCounts: summary.packageCounts as ProjectTransferImportPlanArtifact['packageCounts'],
    packageFingerprint: 'package-fingerprint-1',
    packageWarnings: [],
    planRevision: 1,
    resolutionKinds: {},
    summary,
    targetPlan: {
      articleMatches: [],
      articleRoutePlan: [],
      articleUpdatePlan: [],
      assetPromotionPlan: [],
      duplicateImportMatches: [],
      projectPromptPlan: [],
      projectRoutePlan: [],
      promptPlan: [],
    },
  }
}

const writeProjectTransferArtifacts = async ({
  cwd,
  payloads,
  plan,
}: {
  cwd: string
  payloads: ProjectTransferPayloadByKey
  plan: ProjectTransferImportPlanArtifact
}) => {
  const layout = getProjectTransferImportTempLayout(sessionId)

  await Promise.all(
    projectTransferPayloadKeys.map(async (key) => {
      const path = join(cwd, layout.extractedPath, projectTransferPayloadPathByKey[key])
      await mkdir(dirname(path), {recursive: true})
      await globalThis.Bun.write(path, serializeProjectTransferPayload(key, payloads[key]))
    }),
  )

  const planPath = join(cwd, layout.planPath)
  await mkdir(dirname(planPath), {recursive: true})
  await globalThis.Bun.write(planPath, JSON.stringify(plan))

  return layout
}

const getArchivedConnectionRecord = (): ProviderConnectionRecord => {
  const {models: _models, ...connection} = getTargetConnection({
    config: {archived: true, disabledModelIds: [], manualWorkerUrls: [], workerUrlMode: 'manual'},
  })

  return {...connection}
}

test('project transfer dependency resolution auto-matches one safe enabled provider and equivalent selectable model', async () => {
  const cwd = getRuntimeRoot()

  try {
    const payloads = getProjectTransferPayloadFixtureMap()
    const layout = await writeProjectTransferArtifacts({cwd, payloads, plan: getBasePlan()})

    const result = await resolveProjectTransferDependencies({
      cwd,
      layout,
      nextPlanRevision: 2,
      repositories: {
        listProviderConnections: async () => {
          return [getTargetConnection()]
        },
      },
      request: {planRevision: 1},
    })
    const persistedPlan = JSON.parse(await readFile(join(cwd, layout.planPath), 'utf8')) as {
      dependencyResolution: {
        modelTargetBySourceId: Record<string, string>
        providerTargetBySourceId: Record<string, string>
      }
      planRevision: number
      summary: {dependencyStatuses: Record<string, string>}
    }

    expect(result.status).toBe('ok')
    expect(result.status === 'ok' ? result.changed : false).toBe(true)
    expect(result.status === 'ok' ? result.planSummary.dependencyStatuses : {}).toEqual({
      'model:model-1': 'resolved',
      'provider:provider-connection-1': 'resolved',
    })
    expect(persistedPlan.planRevision).toBe(2)
    expect(persistedPlan.dependencyResolution.providerTargetBySourceId).toEqual({
      'provider-connection-1': 'target-provider-1',
    })
    expect(persistedPlan.dependencyResolution.modelTargetBySourceId).toEqual({'model-1': 'target-model-1'})
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('project transfer dependency resolution rejects an archived chosen provider connection', async () => {
  const cwd = getRuntimeRoot()

  try {
    const payloads = getProjectTransferPayloadFixtureMap()
    const layout = await writeProjectTransferArtifacts({cwd, payloads, plan: getBasePlan()})

    const result = await resolveProjectTransferDependencies({
      cwd,
      layout,
      nextPlanRevision: 2,
      repositories: {
        getProviderConnectionById: async () => {
          return getArchivedConnectionRecord()
        },
        listProviderConnections: async () => {
          return []
        },
      },
      request: {
        planRevision: 1,
        selectedProviderConnections: [
          {sourceProviderConnectionId: 'provider-connection-1', targetProviderConnectionId: 'target-provider-1'},
        ],
      },
    })

    expect(result).toMatchObject({
      error: 'Target provider connection target-provider-1 is archived',
      status: 'error',
      statusCode: 400,
    })
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('project transfer dependency resolution rejects materialized model handoffs that are not selectable', async () => {
  const cwd = getRuntimeRoot()

  try {
    const payloads = getProjectTransferPayloadFixtureMap()
    const layout = await writeProjectTransferArtifacts({cwd, payloads, plan: getBasePlan()})
    const disabledModel = getTargetModel({enabled: false})

    const result = await resolveProjectTransferDependencies({
      cwd,
      layout,
      nextPlanRevision: 2,
      repositories: {
        getProviderModelsByIds: async () => {
          return new Map([['target-model-1', disabledModel]])
        },
        listProviderConnections: async () => {
          return [getTargetConnection({}, [disabledModel])]
        },
      },
      request: {
        materializedModels: [{sourceModelId: 'model-1', targetModelId: 'target-model-1'}],
        planRevision: 1,
        selectedProviderConnections: [
          {sourceProviderConnectionId: 'provider-connection-1', targetProviderConnectionId: 'target-provider-1'},
        ],
      },
    })

    expect(result).toMatchObject({
      error: 'Target model target-model-1 is not selectable',
      status: 'error',
      statusCode: 400,
    })
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('project transfer dependency resolution leaves nullable remote model descriptors unresolved when fallback identity is ambiguous', async () => {
  const cwd = getRuntimeRoot()

  try {
    const payloads = getProjectTransferPayloadFixtureMap()
    const [sourceModel] = payloads.models

    if (!sourceModel) {
      throw new Error('Expected model fixture')
    }

    const nullableRemoteModel = {
      ...sourceModel,
      displayName: 'Local fallback model',
      modelName: 'Local fallback model',
      name: 'Local fallback model',
      remoteModelId: null,
      signature: {
        ...sourceModel.signature,
        displayName: 'Local fallback model',
        modelName: 'Local fallback model',
        name: 'Local fallback model',
        remoteModelId: null,
      },
    }
    const layout = await writeProjectTransferArtifacts({
      cwd,
      payloads: {...payloads, models: [nullableRemoteModel]},
      plan: getBasePlan(),
    })
    const ambiguousModelA = getTargetModel({
      displayName: 'Local fallback model',
      id: 'target-model-a',
      modelName: 'Local fallback model',
      name: 'Local fallback model',
      remoteModelId: null,
    })
    const ambiguousModelB = getTargetModel({
      displayName: 'Local fallback model',
      id: 'target-model-b',
      modelName: 'Local fallback model',
      name: 'Local fallback model',
      remoteModelId: null,
    })

    const result = await resolveProjectTransferDependencies({
      cwd,
      layout,
      nextPlanRevision: 2,
      repositories: {
        listProviderConnections: async () => {
          return [getTargetConnection({}, [ambiguousModelA, ambiguousModelB])]
        },
      },
      request: {planRevision: 1},
    })

    expect(result.status).toBe('ok')
    expect(result.status === 'ok' ? result.planSummary.dependencyStatuses : {}).toEqual({
      'model:model-1': 'missing',
      'provider:provider-connection-1': 'missing',
    })
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})
