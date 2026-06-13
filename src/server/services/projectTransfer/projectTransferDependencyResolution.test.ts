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
import {
  getProjectTransferModelSnapshotFingerprint,
  getProjectTransferProviderSnapshotFingerprint,
} from './projectTransferSnapshotFingerprint.ts'

const sessionId = 'dependency-session-1'

const getRuntimeRoot = () => {
  return mkdtempSync(join(tmpdir(), `f2-project-transfer-dependencies-${process.pid}-`))
}

const getImportedSnapshotMarker = (value: Record<string, unknown>) => {
  return {projectTransferImportedSnapshot: value}
}

const withImportedSnapshotMarker = (record: Record<string, unknown>, marker: Record<string, unknown>) => {
  return {...record, ...getImportedSnapshotMarker(marker)}
}

const getTargetModel = (overrides: Partial<ProviderModelRecord> = {}): ProviderModelRecord => {
  const model = {
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
  const metadataJson = model.metadataJson
  const marker =
    overrides.metadataJson === undefined
    || (typeof metadataJson === 'object'
      && metadataJson !== null
      && !Array.isArray(metadataJson)
      && 'projectTransferImportedSnapshot' in metadataJson)
      ? {
          snapshotFingerprint: getProjectTransferModelSnapshotFingerprint({
            displayName: model.displayName,
            metadataJson,
            modelName: model.modelName,
            name: model.name,
            provider: {
              authMode: model.provider === 'codex' ? 'codex-cli' : 'api-key',
              baseURL: null,
              configJson: {workerUrlMode: 'manual'},
              providerKind: model.provider,
            },
            remoteModelId: model.remoteModelId,
            variant: model.variant,
            version: model.version,
          }),
          sourceModelId: 'model-1',
          sourceProviderConnectionId: 'provider-connection-1',
        }
      : null

  return marker === null || typeof metadataJson !== 'object' || metadataJson === null || Array.isArray(metadataJson)
    ? model
    : {...model, metadataJson: withImportedSnapshotMarker(metadataJson, marker)}
}

const getTargetConnection = (
  overrides: Partial<ProviderConnectionForAdmin> = {},
  models: ProviderModelRecord[] = [getTargetModel()],
): ProviderConnectionForAdmin => {
  const connection = {
    authMode: 'api-key',
    baseURL: null,
    config: {
      disabledModelIds: [],
      manualWorkerUrls: [],
      workerUrlMode: 'manual',
    } as ProviderConnectionForAdmin['config'],
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
  const marker =
    overrides.config === undefined || connection.config.projectTransferImportedSnapshot
      ? {
          snapshotFingerprint: getProjectTransferProviderSnapshotFingerprint({
            authMode: connection.authMode,
            baseURL: connection.baseURL,
            providerKind: connection.providerKind,
            targetConfig: connection.config,
          }),
          sourceProviderConnectionId: 'provider-connection-1',
        }
      : null

  return marker === null
    ? connection
    : {...connection, config: {...connection.config, ...getImportedSnapshotMarker(marker)}}
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
      articleMatches: [
        {
          action: 'create',
          candidates: [],
          conflicts: [],
          identifierKeys: ['arxiv:2401.12345', 'doi:10.1101/2024.01.01.123456', 'pmid:12345'],
          packageArticleId: null,
          selectedTargetArticleId: null,
          sourceArticleId: 'article-1',
        },
      ],
      articleRoutePlan: [],
      articleUpdatePlan: [],
      assetPromotionPlan: [],
      duplicateImportMatches: [],
      projectPromptPlan: [
        {
          enabled: true,
          metadata: {
            archived: false,
            criteriaDisposition: 'include',
            criteriaSectionKey: 'inclusion',
            criteriaSectionLabel: 'Inclusion',
          },
          order: 1,
          sourceProjectPromptId: 'project-prompt-1',
          sourcePromptId: 'prompt-1',
          targetPromptId: 'new:prompt:c4f659c8baf0066f65ecb7006731b24d',
        },
      ],
      projectRoutePlan: [],
      promptPlan: [
        {
          action: 'create',
          computedContentHash: 'c4f659c8baf0066f65ecb7006731b24d',
          packageContentHash: 'c4f659c8baf0066f65ecb7006731b24d',
          sourcePromptId: 'prompt-1',
          targetPromptId: null,
        },
      ],
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

const getCodexPayloads = (): ProjectTransferPayloadByKey => {
  const payloads = getProjectTransferPayloadFixtureMap()
  const [sourceProvider] = payloads.providerConnections
  const [sourceModel] = payloads.models
  const codexProviderSignature = {
    authMode: 'codex-cli',
    baseURL: null,
    configSignature: {workerUrlMode: 'manual'},
    providerKind: 'codex',
  }
  const codexModelSignature = {
    displayName: 'Codex Thinking',
    modelName: 'codex-thinking',
    name: 'Codex Thinking',
    providerConnectionSignature: codexProviderSignature,
    remoteModelId: 'codex-thinking',
    variant: 'medium',
    version: 'medium',
  }

  if (!sourceProvider || !sourceModel) {
    throw new Error('Expected provider and model fixtures')
  }

  return {
    ...payloads,
    judgments: payloads.judgments.map((judgment) => {
      const judgmentInputSignature = judgment.judgmentInputSignature as Record<string, unknown>

      return {
        ...judgment,
        judgmentInputSignature: {
          ...judgmentInputSignature,
          model: {
            ...(judgmentInputSignature.model as Record<string, unknown>),
            modelOptions: {thinking: 'medium'},
            modelSignature: codexModelSignature,
          },
          provider: {
            providerConnectionSignature: codexProviderSignature,
            providerKind: 'codex',
            transportFamily: 'codex-app',
          },
        },
      }
    }),
    models: [
      {
        ...sourceModel,
        displayName: 'Codex Thinking',
        metadataJson: {options: {thinking: 'medium'}},
        modelName: 'codex-thinking',
        name: 'Codex Thinking',
        remoteModelId: 'codex-thinking',
        signature: codexModelSignature,
        variant: 'medium',
        version: 'medium',
      },
    ],
    providerConnections: [
      {
        ...sourceProvider,
        authMode: 'codex-cli',
        configJson: {workerUrlMode: 'manual'},
        label: 'Codex source',
        providerKind: 'codex',
        signature: codexProviderSignature,
      },
    ],
  }
}

test('project transfer dependency resolution auto-resolves exact imported provider and model snapshots', async () => {
  const cwd = getRuntimeRoot()

  try {
    const payloads = getProjectTransferPayloadFixtureMap()
    const targetModel = getTargetModel({enabled: false})
    const targetConnection = getTargetConnection({enabled: false}, [targetModel])
    const layout = await writeProjectTransferArtifacts({cwd, payloads, plan: getBasePlan()})

    const result = await resolveProjectTransferDependencies({
      cwd,
      layout,
      nextPlanRevision: 2,
      repositories: {
        listProviderConnections: async () => {
          return [targetConnection]
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

test('project transfer dependency resolution fast auto-copies published provider and model dependencies', async () => {
  const cwd = getRuntimeRoot()

  try {
    const layout = getProjectTransferImportTempLayout(sessionId)
    const basePlan = getBasePlan()
    const plan: ProjectTransferImportPlanArtifact = {
      ...basePlan,
      canCommit: false,
      summary: {
        ...basePlan.summary,
        dependencyStatuses: {'model:model-1': 'missing', 'provider:provider-connection-1': 'missing'},
        judgmentConflictStatus: 'unknown',
      },
      targetPlan: {
        ...basePlan.targetPlan,
        humanReviewPlan: [],
        judgmentAssessmentPlan: [],
        judgmentPlan: [
          {
            action: 'unknown',
            conflictCodes: [],
            inputSignatureMatches: null,
            physicalKey: null,
            provenanceKind: null,
            reviewVisibleKey: null,
            sourceJudgmentId: 'judgment-1',
            targetArticleId: 'new:article:article-1',
            targetJudgmentId: 'new:judgment:judgment-1',
            targetModelId: 'model-1',
            targetPromptId: 'new:prompt:c4f659c8baf0066f65ecb7006731b24d',
          },
        ],
      },
    }
    const planPath = join(cwd, layout.planPath)
    await mkdir(dirname(planPath), {recursive: true})
    await globalThis.Bun.write(planPath, JSON.stringify(plan))

    const result = await resolveProjectTransferDependencies({
      cwd,
      layout,
      nextPlanRevision: 2,
      plan,
      repositories: {
        listProviderConnections: async () => {
          throw new Error('fast auto-copy should not inspect provider connections')
        },
      },
      request: {autoResolve: true, planRevision: 1},
    })
    const persistedPlan = JSON.parse(await readFile(planPath, 'utf8')) as {
      canCommit: boolean
      dependencyResolution: {
        modelTargetBySourceId: Record<string, string>
        providerTargetBySourceId: Record<string, string>
      }
      planRevision: number
      summary: {dependencyStatuses: Record<string, string>; judgmentConflictStatus: string}
      targetPlan: {judgmentPlan: {action: string; targetModelId: string | null}[]}
    }

    expect(result.status).toBe('ok')
    expect(result.status === 'ok' ? result.planSummary.dependencyStatuses : {}).toEqual({
      'model:model-1': 'resolved',
      'provider:provider-connection-1': 'resolved',
    })
    expect(persistedPlan.canCommit).toBe(true)
    expect(persistedPlan.planRevision).toBe(2)
    expect(persistedPlan.summary.judgmentConflictStatus).toBe('clear')
    expect(persistedPlan.dependencyResolution.providerTargetBySourceId).toEqual({
      'provider-connection-1': 'new:provider:provider-connection-1',
    })
    expect(persistedPlan.dependencyResolution.modelTargetBySourceId).toEqual({'model-1': 'new:model:model-1'})
    expect(persistedPlan.targetPlan.judgmentPlan).toMatchObject([
      {action: 'insert', targetModelId: 'new:model:model-1'},
    ])
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('project transfer dependency resolution auto-resolves imported snapshots with distinct variant and version', async () => {
  const cwd = getRuntimeRoot()

  try {
    const fixturePayloads = getProjectTransferPayloadFixtureMap()
    const payloads = {
      ...fixturePayloads,
      judgments: [],
      models: fixturePayloads.models.map((model) => {
        return {
          ...model,
          signature: {...model.signature, variant: 'reasoning', version: '2026-06-01'},
          variant: 'reasoning',
          version: '2026-06-01',
        }
      }),
    }
    const targetModel = getTargetModel({variant: 'reasoning', version: '2026-06-01'})
    const targetConnection = getTargetConnection({}, [targetModel])
    const layout = await writeProjectTransferArtifacts({cwd, payloads, plan: getBasePlan()})

    const result = await resolveProjectTransferDependencies({
      cwd,
      layout,
      nextPlanRevision: 2,
      repositories: {
        listProviderConnections: async () => {
          return [targetConnection]
        },
      },
      request: {planRevision: 1},
    })

    expect(result.status).toBe('ok')
    expect(result.status === 'ok' ? result.plan.dependencyResolution?.modelTargetBySourceId : {}).toEqual({
      'model-1': 'target-model-1',
    })
    expect(result.status === 'ok' ? result.planSummary.dependencyStatuses : {}).toEqual({
      'model:model-1': 'resolved',
      'provider:provider-connection-1': 'resolved',
    })
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('project transfer dependency resolution rejects stale reviewed plan revisions', async () => {
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
      request: {planRevision: 0},
    })

    expect(result).toEqual({
      error: 'Project transfer dependency request planRevision is stale',
      status: 'error',
      statusCode: 409,
    })
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('project transfer dependency resolution preserves imported placeholders when no exact snapshot matches', async () => {
  const cwd = getRuntimeRoot()

  try {
    const payloads = getProjectTransferPayloadFixtureMap()
    const targetModel = getTargetModel({metadataJson: {options: {thinking: 'high'}}})
    const targetConnection = getTargetConnection(
      {
        config: {
          disabledModelIds: [],
          manualWorkerUrls: [],
          workerUrlMode: 'auto',
        } as ProviderConnectionForAdmin['config'],
      },
      [targetModel],
    )
    const layout = await writeProjectTransferArtifacts({cwd, payloads, plan: getBasePlan()})

    const result = await resolveProjectTransferDependencies({
      cwd,
      layout,
      nextPlanRevision: 2,
      repositories: {
        listProviderConnections: async () => {
          return [targetConnection]
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
      'provider-connection-1': 'new:provider:provider-connection-1',
    })
    expect(persistedPlan.dependencyResolution.modelTargetBySourceId).toEqual({'model-1': 'new:model:model-1'})
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('project transfer dependency resolution inserts imported judgments when provider and model are imported as new dependencies', async () => {
  const cwd = getRuntimeRoot()

  try {
    const payloads = getProjectTransferPayloadFixtureMap()
    const [article] = payloads.articles

    if (!article) {
      throw new Error('Expected article fixture')
    }

    const plan = {
      ...getBasePlan(),
      targetPlan: {
        ...getBasePlan().targetPlan,
        articleMatches: [
          {
            action: 'reuse' as const,
            candidates: [
              {
                matchedIdentifiers: [],
                targetArticle: {...article, targetArticleId: 'target-article-1'},
                targetArticleId: 'target-article-1',
              },
            ],
            conflicts: [],
            identifierKeys: ['doi:10.1101/2024.01.01.123456'],
            packageArticleId: null,
            selectedTargetArticleId: 'target-article-1',
            sourceArticleId: 'article-1',
          },
        ],
        projectPromptPlan: getBasePlan().targetPlan.projectPromptPlan.map((projectPrompt) => {
          return {...projectPrompt, targetPromptId: 'target-prompt-1'}
        }),
        promptPlan: getBasePlan().targetPlan.promptPlan.map((prompt) => {
          return {...prompt, action: 'reuse' as const, targetPromptId: 'target-prompt-1'}
        }),
      },
    }
    const layout = await writeProjectTransferArtifacts({cwd, payloads, plan})

    const result = await resolveProjectTransferDependencies({
      cwd,
      layout,
      nextPlanRevision: 2,
      repositories: {
        analyzeTargetRunner: {
          queryJson: async <T>(statement: string): Promise<T[]> => {
            const rows = statement.includes('FROM app.judgment_assessment')
              ? []
              : statement.includes('FROM app.judgment')
                ? [
                    {
                      answeredOriginal: 'include',
                      answeredOriginalAsArray: ['include'],
                      confidenceOriginal: 90,
                      explanation: 'Fixture explanation',
                      isAnswered: true,
                      quotes: [{quote: 'Fixture quote'}],
                      targetArticleId: 'target-article-1',
                      targetJudgmentId: 'target-judgment-1',
                      targetModelId: 'target-model-1',
                      targetPromptId: 'target-prompt-1',
                      useAbstract: true,
                      useFulltext: false,
                      useFulltextNoImages: false,
                      useTitle: true,
                    },
                  ]
                : []

            return rows as T[]
          },
        },
        listProviderConnections: async () => {
          return []
        },
      },
      request: {planRevision: 1},
    })

    expect(result.status).toBe('ok')
    expect(result.status === 'ok' ? result.plan.canCommit : false).toBe(true)
    expect(result.status === 'ok' ? result.planSummary.overlapCounts.reusedJudgmentCount : 0).toBe(0)
    expect(result.status === 'ok' ? result.plan.targetPlan.judgmentPlan?.[0]?.action : null).toBe('insert')
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('project transfer dependency resolution ignores virtual selectable target model ids', async () => {
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
      request: {
        planRevision: 1,
        selectedModels: [{sourceModelId: 'model-1', targetModelId: 'anthropic:claude-sonnet-4-6:high'}],
        selectedProviderConnections: [
          {sourceProviderConnectionId: 'provider-connection-1', targetProviderConnectionId: 'target-provider-1'},
        ],
      },
    })

    expect(result.status).toBe('ok')
    expect(result.status === 'ok' ? result.plan.dependencyResolution?.modelTargetBySourceId : {}).toEqual({
      'model-1': 'target-model-1',
    })
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('project transfer dependency resolution ignores archived local provider selections', async () => {
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

    expect(result.status).toBe('ok')
    expect(result.status === 'ok' ? result.plan.dependencyResolution?.providerTargetBySourceId : {}).toEqual({
      'provider-connection-1': 'new:provider:provider-connection-1',
    })
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('project transfer dependency resolution accepts disabled imported snapshot handoffs', async () => {
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

    expect(result.status).toBe('ok')
    expect(result.status === 'ok' ? result.plan.dependencyResolution?.modelTargetBySourceId : {}).toEqual({
      'model-1': 'target-model-1',
    })
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('project transfer dependency resolution maps materialized models to provider connections', async () => {
  const cwd = getRuntimeRoot()

  try {
    const payloads = getProjectTransferPayloadFixtureMap()
    const targetModel = getTargetModel()
    const layout = await writeProjectTransferArtifacts({cwd, payloads, plan: getBasePlan()})

    const result = await resolveProjectTransferDependencies({
      cwd,
      layout,
      nextPlanRevision: 2,
      repositories: {
        getProviderModelsByIds: async () => {
          return new Map([['target-model-1', targetModel]])
        },
        listProviderConnections: async () => {
          return [getTargetConnection({}, [targetModel])]
        },
      },
      request: {
        materializedModels: [
          {sourceModelId: 'model-1', targetModelId: 'target-model-1', targetProviderConnectionId: 'target-provider-1'},
        ],
        planRevision: 1,
      },
    })
    const persistedPlan = JSON.parse(await readFile(join(cwd, layout.planPath), 'utf8')) as {
      dependencyResolution: {
        modelTargetBySourceId: Record<string, string>
        providerTargetBySourceId: Record<string, string>
      }
      summary: {dependencyStatuses: Record<string, string>}
    }

    expect(result.status).toBe('ok')
    expect(result.status === 'ok' ? result.planSummary.dependencyStatuses : {}).toEqual({
      'model:model-1': 'resolved',
      'provider:provider-connection-1': 'resolved',
    })
    expect(persistedPlan.dependencyResolution.providerTargetBySourceId).toEqual({
      'provider-connection-1': 'target-provider-1',
    })
    expect(persistedPlan.dependencyResolution.modelTargetBySourceId).toEqual({'model-1': 'target-model-1'})
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('project transfer dependency resolution ignores unmarked local provider and model rows for snapshot reuse', async () => {
  const cwd = getRuntimeRoot()

  try {
    const payloads = getProjectTransferPayloadFixtureMap()
    const targetModel = getTargetModel({metadataJson: {options: {thinking: 'medium'}}})
    const targetConnection = getTargetConnection(
      {
        config: {
          disabledModelIds: [],
          manualWorkerUrls: [],
          workerUrlMode: 'manual',
        } as ProviderConnectionForAdmin['config'],
      },
      [targetModel],
    )
    const layout = await writeProjectTransferArtifacts({cwd, payloads, plan: getBasePlan()})

    const result = await resolveProjectTransferDependencies({
      cwd,
      layout,
      nextPlanRevision: 2,
      repositories: {
        getProviderModelsByIds: async () => {
          return new Map([['target-model-1', targetModel]])
        },
        listProviderConnections: async () => {
          return [targetConnection]
        },
      },
      request: {
        planRevision: 1,
        selectedModels: [{sourceModelId: 'model-1', targetModelId: 'target-model-1'}],
        selectedProviderConnections: [
          {sourceProviderConnectionId: 'provider-connection-1', targetProviderConnectionId: 'target-provider-1'},
        ],
      },
    })

    expect(result.status).toBe('ok')
    expect(result.status === 'ok' ? result.planSummary.dependencyStatuses : {}).toEqual({
      'model:model-1': 'resolved',
      'provider:provider-connection-1': 'resolved',
    })
    expect(result.status === 'ok' ? result.plan.canCommit : false).toBe(true)
    expect(result.status === 'ok' ? result.plan.dependencyResolution?.providerTargetBySourceId : {}).toEqual({
      'provider-connection-1': 'new:provider:provider-connection-1',
    })
    expect(result.status === 'ok' ? result.plan.dependencyResolution?.modelTargetBySourceId : {}).toEqual({
      'model-1': 'new:model:model-1',
    })
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('project transfer dependency resolution blocks snapshot reuse when imported model metadata changes', async () => {
  const cases = [
    {metadataJson: {discovery: {contextWindow: {totalTokens: 100000}}, options: {thinking: 'medium'}}},
    {
      metadataJson: {
        discovery: {contextWindow: {inputTokens: 12000, totalTokens: 32768}},
        options: {thinking: 'medium'},
      },
    },
    {metadataJson: {options: {thinking: 'high'}}},
  ]

  await cases.reduce<Promise<void>>(async (previous, testCase) => {
    await previous
    const cwd = getRuntimeRoot()

    try {
      const payloads = {
        ...getProjectTransferPayloadFixtureMap(),
        judgments: [],
        models: getProjectTransferPayloadFixtureMap().models.map((model) => {
          return {...model, metadataJson: testCase.metadataJson}
        }),
      }
      const layout = await writeProjectTransferArtifacts({cwd, payloads, plan: getBasePlan()})
      const targetModel = getTargetModel()
      const result = await resolveProjectTransferDependencies({
        cwd,
        layout,
        nextPlanRevision: 2,
        repositories: {
          getProviderModelsByIds: async () => {
            return new Map([['target-model-1', targetModel]])
          },
          listProviderConnections: async () => {
            return [getTargetConnection({}, [targetModel])]
          },
        },
        request: {
          planRevision: 1,
          selectedModels: [{sourceModelId: 'model-1', targetModelId: 'target-model-1'}],
          selectedProviderConnections: [
            {sourceProviderConnectionId: 'provider-connection-1', targetProviderConnectionId: 'target-provider-1'},
          ],
        },
      })

      expect(result.status).toBe('ok')
      expect(result.status === 'ok' ? result.planSummary.dependencyStatuses : {}).toEqual({
        'model:model-1': 'resolved',
        'provider:provider-connection-1': 'resolved',
      })
      expect(result.status === 'ok' ? result.plan.dependencyResolution?.modelTargetBySourceId : {}).toEqual({
        'model-1': 'new:model:model-1',
      })
    } finally {
      rmSync(cwd, {force: true, recursive: true})
    }
  }, Promise.resolve())
})

test('project transfer dependency resolution plans Codex imports as snapshots without visible live models', async () => {
  const cwd = getRuntimeRoot()

  try {
    const payloads = getCodexPayloads()
    const codexModel = getTargetModel({
      displayName: 'Codex Thinking',
      id: 'target-codex-model-1',
      metadataJson: {
        ...getImportedSnapshotMarker({sourceModelId: 'model-1', sourceProviderConnectionId: 'provider-connection-1'}),
        options: {thinking: 'medium'},
      },
      modelName: 'codex-thinking',
      name: 'Codex Thinking',
      provider: 'codex',
      providerConnectionId: 'target-codex-provider-1',
      remoteModelId: 'codex-thinking',
      variant: 'medium',
      version: 'medium',
    })
    const codexConnection = getTargetConnection(
      {authMode: 'codex-cli', id: 'target-codex-provider-1', label: 'Codex target', providerKind: 'codex'},
      [],
    )
    const layout = await writeProjectTransferArtifacts({cwd, payloads, plan: getBasePlan()})

    const result = await resolveProjectTransferDependencies({
      cwd,
      layout,
      nextPlanRevision: 2,
      repositories: {
        ensureCodexProviderModel: async () => {
          return {modelId: 'target-codex-model-1', providerConnectionId: 'target-codex-provider-1'}
        },
        getProviderModelsByIds: async () => {
          return new Map([['target-codex-model-1', codexModel]])
        },
        listProviderConnections: async () => {
          return [codexConnection]
        },
      },
      request: {
        materializedModels: [{sourceModelId: 'model-1', targetModelId: 'target-codex-model-1'}],
        planRevision: 1,
        selectedProviderConnections: [
          {sourceProviderConnectionId: 'provider-connection-1', targetProviderConnectionId: 'target-codex-provider-1'},
        ],
      },
    })

    expect(result.status).toBe('ok')
    expect(result.status === 'ok' ? result.planSummary.dependencyStatuses : {}).toEqual({
      'model:model-1': 'resolved',
      'provider:provider-connection-1': 'resolved',
    })
    expect(result.status === 'ok' ? result.plan.canCommit : false).toBe(true)
    expect(result.status === 'ok' ? result.plan.dependencyResolution?.modelTargetBySourceId : {}).toEqual({
      'model-1': 'new:model:model-1',
    })
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('project transfer dependency resolution resolves Codex after materialized model and provider connection re-read match', async () => {
  const cwd = getRuntimeRoot()

  try {
    const payloads = getCodexPayloads()
    const codexModel = getTargetModel({
      displayName: 'Codex Thinking',
      id: 'target-codex-model-1',
      metadataJson: {
        ...getImportedSnapshotMarker({sourceModelId: 'model-1', sourceProviderConnectionId: 'provider-connection-1'}),
        options: {thinking: 'medium'},
      },
      modelName: 'codex-thinking',
      name: 'Codex Thinking',
      provider: 'codex',
      providerConnectionId: 'target-codex-provider-1',
      remoteModelId: 'codex-thinking',
      variant: 'medium',
      version: 'medium',
    })
    const codexConnection = getTargetConnection(
      {authMode: 'codex-cli', id: 'target-codex-provider-1', label: 'Codex target', providerKind: 'codex'},
      [codexModel],
    )
    const layout = await writeProjectTransferArtifacts({cwd, payloads, plan: getBasePlan()})

    const result = await resolveProjectTransferDependencies({
      cwd,
      layout,
      nextPlanRevision: 2,
      repositories: {
        ensureCodexProviderModel: async () => {
          return {modelId: 'target-codex-model-1', providerConnectionId: 'target-codex-provider-1'}
        },
        getProviderModelsByIds: async () => {
          return new Map([['target-codex-model-1', codexModel]])
        },
        listProviderConnections: async () => {
          return [codexConnection]
        },
      },
      request: {
        materializedModels: [
          {
            sourceModelId: 'model-1',
            targetModelId: 'target-codex-model-1',
            targetProviderConnectionId: 'target-codex-provider-1',
          },
        ],
        planRevision: 1,
        selectedProviderConnections: [
          {sourceProviderConnectionId: 'provider-connection-1', targetProviderConnectionId: 'target-codex-provider-1'},
        ],
      },
    })

    expect(result.status).toBe('ok')
    expect(result.status === 'ok' ? result.planSummary.dependencyStatuses : {}).toEqual({
      'model:model-1': 'resolved',
      'provider:provider-connection-1': 'resolved',
    })
    expect(result.status === 'ok' ? result.plan.canCommit : false).toBe(true)
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('project transfer dependency resolution auto-resolves Codex dependencies to imported placeholders on existing local connections', async () => {
  const cwd = getRuntimeRoot()

  try {
    const payloads = getCodexPayloads()
    const layout = await writeProjectTransferArtifacts({cwd, payloads, plan: getBasePlan()})
    let ensured = false

    const result = await resolveProjectTransferDependencies({
      cwd,
      layout,
      nextPlanRevision: 2,
      repositories: {
        ensureCodexProviderModel: async () => {
          ensured = true

          return {modelId: 'target-codex-model-1', providerConnectionId: 'target-codex-provider-1'}
        },
        listProviderConnections: async () => {
          return [
            getTargetConnection(
              {
                authMode: 'codex-cli',
                config: {
                  disabledModelIds: [],
                  manualWorkerUrls: [],
                  workerUrlMode: 'manual',
                } as ProviderConnectionForAdmin['config'],
                id: 'target-codex-provider-1',
                label: 'Codex target',
                providerKind: 'codex',
              },
              [],
            ),
          ]
        },
      },
      request: {planRevision: 1},
    })

    expect(result.status).toBe('ok')
    expect(result.status === 'ok' ? result.planSummary.dependencyStatuses : {}).toEqual({
      'model:model-1': 'resolved',
      'provider:provider-connection-1': 'resolved',
    })
    expect(result.status === 'ok' ? result.plan.canCommit : false).toBe(true)
    expect(result.status === 'ok' ? result.plan.dependencyResolution?.providerTargetBySourceId : {}).toEqual({
      'provider-connection-1': 'new:provider:provider-connection-1',
    })
    expect(result.status === 'ok' ? result.plan.dependencyResolution?.modelTargetBySourceId : {}).toEqual({
      'model-1': 'new:model:model-1',
    })
    expect(ensured).toBe(false)
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('project transfer dependency resolution auto-resolves Codex dependencies to imported placeholders when Codex is not present locally', async () => {
  const cwd = getRuntimeRoot()

  try {
    const payloads = getCodexPayloads()
    const layout = await writeProjectTransferArtifacts({cwd, payloads, plan: getBasePlan()})
    let ensured = false

    const result = await resolveProjectTransferDependencies({
      cwd,
      layout,
      nextPlanRevision: 2,
      repositories: {
        ensureCodexProviderModel: async () => {
          ensured = true

          return {modelId: 'target-codex-model-2', providerConnectionId: 'target-codex-provider-2'}
        },
        listProviderConnections: async () => {
          return []
        },
      },
      request: {planRevision: 1},
    })

    expect(result.status).toBe('ok')
    expect(result.status === 'ok' ? result.planSummary.dependencyStatuses : {}).toEqual({
      'model:model-1': 'resolved',
      'provider:provider-connection-1': 'resolved',
    })
    expect(result.status === 'ok' ? result.plan.canCommit : false).toBe(true)
    expect(result.status === 'ok' ? result.plan.dependencyResolution?.providerTargetBySourceId : {}).toEqual({
      'provider-connection-1': 'new:provider:provider-connection-1',
    })
    expect(result.status === 'ok' ? result.plan.dependencyResolution?.modelTargetBySourceId : {}).toEqual({
      'model-1': 'new:model:model-1',
    })
    expect(ensured).toBe(false)
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('project transfer dependency resolution reuses disabled stale mapped Codex snapshots without enabling them', async () => {
  const cwd = getRuntimeRoot()

  try {
    const payloads = getCodexPayloads()
    const disabledCodexModel = getTargetModel({
      displayName: 'Codex Thinking',
      enabled: false,
      id: 'target-codex-model-1',
      metadataJson: {
        ...getImportedSnapshotMarker({sourceModelId: 'model-1', sourceProviderConnectionId: 'provider-connection-1'}),
        options: {thinking: 'medium'},
      },
      modelName: 'codex-thinking',
      name: 'Codex Thinking',
      provider: 'codex',
      providerConnectionId: 'target-codex-provider-1',
      remoteModelId: 'codex-thinking',
      variant: 'medium',
      version: 'medium',
    })
    const enabledCodexModel = {...disabledCodexModel, enabled: true}
    const layout = await writeProjectTransferArtifacts({
      cwd,
      payloads,
      plan: {
        ...getBasePlan(),
        dependencyResolution: {
          acceptedSubstituteModelSourceIds: [],
          codexSetupState: null,
          modelMaterializationRequests: [],
          modelTargetBySourceId: {'model-1': 'target-codex-model-1'},
          providerTargetBySourceId: {'provider-connection-1': 'target-codex-provider-1'},
          unresolvedModelSourceIds: [],
          unresolvedProviderSourceIds: [],
        },
      },
    })
    const disabledCodexConnection = getTargetConnection(
      {
        authMode: 'codex-cli',
        enabled: false,
        id: 'target-codex-provider-1',
        label: 'Codex target',
        providerKind: 'codex',
      },
      [disabledCodexModel],
    )
    const enabledCodexConnection = getTargetConnection(
      {authMode: 'codex-cli', id: 'target-codex-provider-1', label: 'Codex target', providerKind: 'codex'},
      [enabledCodexModel],
    )
    let ensured = false
    let listCallCount = 0

    const result = await resolveProjectTransferDependencies({
      cwd,
      layout,
      nextPlanRevision: 2,
      repositories: {
        ensureCodexProviderModel: async () => {
          ensured = true

          return {modelId: 'target-codex-model-1', providerConnectionId: 'target-codex-provider-1'}
        },
        getProviderModelsByIds: async () => {
          return new Map([['target-codex-model-1', ensured ? enabledCodexModel : disabledCodexModel]])
        },
        listProviderConnections: async () => {
          listCallCount += 1

          return listCallCount === 1 ? [disabledCodexConnection] : [enabledCodexConnection]
        },
      },
      request: {autoResolve: true, planRevision: 1},
    })

    expect(result.status).toBe('ok')
    expect(result.status === 'ok' ? result.planSummary.dependencyStatuses : {}).toEqual({
      'model:model-1': 'resolved',
      'provider:provider-connection-1': 'resolved',
    })
    expect(result.status === 'ok' ? result.plan.canCommit : false).toBe(true)
    expect(ensured).toBe(false)
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('project transfer dependency resolution ignores non-equivalent substitutes without imported judgment references', async () => {
  const cwd = getRuntimeRoot()

  try {
    const payloads = {...getProjectTransferPayloadFixtureMap(), judgments: []}
    const substituteModel = getTargetModel({
      displayName: 'Future settings model',
      id: 'substitute-model-1',
      modelName: 'future-settings-model',
      name: 'Future settings model',
      remoteModelId: 'future-settings-model',
    })
    const layout = await writeProjectTransferArtifacts({cwd, payloads, plan: getBasePlan()})

    const result = await resolveProjectTransferDependencies({
      cwd,
      layout,
      nextPlanRevision: 2,
      repositories: {
        getProviderModelsByIds: async () => {
          return new Map([['substitute-model-1', substituteModel]])
        },
        listProviderConnections: async () => {
          return [getTargetConnection({}, [substituteModel])]
        },
      },
      request: {
        planRevision: 1,
        selectedModels: [{acceptSubstitute: true, sourceModelId: 'model-1', targetModelId: 'substitute-model-1'}],
        selectedProviderConnections: [
          {sourceProviderConnectionId: 'provider-connection-1', targetProviderConnectionId: 'target-provider-1'},
        ],
      },
    })

    expect(result.status).toBe('ok')
    expect(result.status === 'ok' ? result.planSummary.dependencyStatuses : {}).toEqual({
      'model:model-1': 'resolved',
      'provider:provider-connection-1': 'resolved',
    })
    expect(result.status === 'ok' ? result.plan.dependencyResolution?.modelTargetBySourceId : {}).toEqual({
      'model-1': 'new:model:model-1',
    })
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('project transfer dependency resolution revokes stale substitute approvals', async () => {
  const cwd = getRuntimeRoot()

  try {
    const payloads = {...getProjectTransferPayloadFixtureMap(), judgments: []}
    const substituteModel = getTargetModel({
      displayName: 'Future settings model',
      id: 'substitute-model-1',
      modelName: 'future-settings-model',
      name: 'Future settings model',
      remoteModelId: 'future-settings-model',
    })
    const layout = await writeProjectTransferArtifacts({
      cwd,
      payloads,
      plan: {
        ...getBasePlan(),
        dependencyResolution: {
          acceptedSubstituteModelSourceIds: ['model-1'],
          modelTargetBySourceId: {'model-1': 'substitute-model-1'},
          providerTargetBySourceId: {'provider-connection-1': 'target-provider-1'},
        },
      },
    })

    const result = await resolveProjectTransferDependencies({
      cwd,
      layout,
      nextPlanRevision: 2,
      repositories: {
        getProviderModelsByIds: async () => {
          return new Map([['substitute-model-1', substituteModel]])
        },
        listProviderConnections: async () => {
          return [getTargetConnection({}, [substituteModel])]
        },
      },
      request: {
        planRevision: 1,
        selectedModels: [{acceptSubstitute: false, sourceModelId: 'model-1', targetModelId: 'substitute-model-1'}],
      },
    })
    const persistedPlan = JSON.parse(await readFile(join(cwd, layout.planPath), 'utf8')) as {
      dependencyResolution: {acceptedSubstituteModelSourceIds: string[]}
    }

    expect(result.status).toBe('ok')
    expect(result.status === 'ok' ? result.planSummary.dependencyStatuses : {}).toEqual({
      'model:model-1': 'resolved',
      'provider:provider-connection-1': 'resolved',
    })
    expect(result.status === 'ok' ? result.plan.dependencyResolution?.modelTargetBySourceId : {}).toEqual({
      'model-1': 'new:model:model-1',
    })
    expect(persistedPlan.dependencyResolution.acceptedSubstituteModelSourceIds).toEqual([])
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
      'model:model-1': 'resolved',
      'provider:provider-connection-1': 'resolved',
    })
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})
