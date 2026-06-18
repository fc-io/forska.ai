import {hostname} from 'node:os'

import {sleep} from '../../utils/sleep.ts'
import {getJsonValue, getSqlLiteral} from '../services/appQueryHelpers.ts'
import {
  buildPromptConfigHash,
  buildReviewConfigHash,
  type ReviewServingIdentityValue,
} from '../reviewServing/reviewProjectionIdentity.ts'
import {getReviewServingSourcePartitionWatermarks} from '../reviewServing/reviewServingProjectorDomain.ts'
import {reviewServingListModes, type ReviewServingProjectionComponent} from '../reviewServing/reviewServingContracts.ts'
import {projectReviewServingDisplayPatches, projectReviewServingPayloadRows} from '../reviewServing/reviewServingDisplayPayloadProjector.ts'
import {
  getReviewServingFilterOptionIdentity,
  projectReviewServingFilterOptions,
} from '../reviewServing/reviewServingFilterOptionProjector.ts'
import {
  claimReviewServingRebuildChunk,
  isReviewServingRebuildChunkComplete,
  markReviewServingRebuildChunkFailed,
  type ReviewServingChunkManifestRepositoryDatabase,
  type ReviewServingRebuildChunkIdentity,
  type ReviewServingRebuildChunkManifest,
} from '../reviewServing/reviewServingChunkManifestRepository.ts'
import {projectReviewServingHumanStatusPatches} from '../reviewServing/reviewServingHumanStatusProjector.ts'
import {projectReviewServingJudgmentPayloadRows} from '../reviewServing/reviewServingJudgmentPayloadProjector.ts'
import {projectReviewServingLlmStatusPatches} from '../reviewServing/reviewServingLlmStatusProjector.ts'
import {completeReviewServingDirtyWorkClaims} from '../reviewServing/reviewServingDirtyWorkService.ts'
import {getReviewServingProjectionIdentityManifest} from '../reviewServing/reviewServingManifestRepository.ts'
import {projectReviewServingFilterPostings} from '../reviewServing/reviewServingFilterPostingProjector.ts'
import {projectReviewServingQueuePatches} from '../reviewServing/reviewServingQueueProjector.ts'
import {projectReviewServingSelectedImportPatches} from '../reviewServing/reviewServingSelectedImportPatchProjector.ts'
import {projectReviewServingProjectScopePatches} from '../reviewServing/reviewServingProjectScopeProjector.ts'
import {
  type ReviewServingProjectorRunner,
  type ReviewServingProjectorServiceDependencies,
  wakeReviewServingProjectorService,
  type WakeReviewServingProjectorServiceInput,
  type WakeReviewServingProjectorServiceResult,
} from '../reviewServing/reviewServingProjectorService.ts'
import {writeReviewServingProjectorComponent} from '../reviewServing/reviewServingProjectorWriter.ts'
import {projectReviewServingSummaries} from '../reviewServing/reviewServingSummaryProjector.ts'
import {projectReviewServingTitleSearchRows} from '../reviewServing/reviewServingTitleSearchProjector.ts'
import {
  cleanupReviewServingRetentionState,
  type ReviewServingRetentionCleanupInput,
  type ReviewServingRetentionServiceDatabase,
} from '../reviewServing/reviewServingRetentionService.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import type {DuckdbWorkloadContext} from '../utils/duckdbService.ts'

type ReviewServingProjectorWorkerDatabase = NonNullable<ReviewServingProjectorServiceDependencies['database']>

type ReviewServingProjectorWorkerCleanupTarget = ReviewServingRetentionCleanupInput

type ReviewServingProjectorWorkerChunkInput = ReviewServingRebuildChunkIdentity & {checksum?: string | null}

type ReviewServingProjectorWorkerRebuildChunkService = {
  claimChunk: typeof claimReviewServingRebuildChunk
  failChunk: typeof markReviewServingRebuildChunkFailed
  getNextChunk: () => Promise<ReviewServingProjectorWorkerChunkInput | null>
  isChunkComplete: typeof isReviewServingRebuildChunkComplete
  runClaimedChunk: (input: {
    chunk: ReviewServingRebuildChunkManifest
    leaseOwner: string
    workloadContext: DuckdbWorkloadContext
  }) => Promise<{status: 'completed'}>
}

type ReviewServingProjectorWorkerDependencies = {
  cleanupRetentionState?: typeof cleanupReviewServingRetentionState
  getCleanupTargets?: () => Promise<readonly ReviewServingProjectorWorkerCleanupTarget[]>
  getDatabase?: () => ReviewServingProjectorWorkerDatabase
    & ReviewServingChunkManifestRepositoryDatabase
    & ReviewServingRetentionServiceDatabase
  nowMs?: () => number
  projectorServiceDependencies?: Omit<ReviewServingProjectorServiceDependencies, 'database' | 'nowMs'>
  rebuildChunkService?: ReviewServingProjectorWorkerRebuildChunkService
  sleep: typeof sleep
  wakeProjectors: typeof wakeReviewServingProjectorService
}

type ReviewServingProjectorWorkerCycleOptions = {
  batchSize?: number
  cleanupIntervalMs?: number
  lastCleanupAtMs?: number | null
  leaseMs?: number
  maxActiveImportCount?: number
  maxPendingDirtyWorkCount?: number
  maxRetries?: number
  maxRowsPerWake?: number
  maxWakeMs?: number
  now?: Date
  workerId?: string
}

type ReviewServingProjectorWorkerLoopOptions = ReviewServingProjectorWorkerCycleOptions & {
  errorBackoffMs?: number
  pollIntervalMs?: number
  signal?: AbortSignal
}

type ReviewServingProjectorWorkerChunkResult =
  | {chunkId: null; status: 'idle'}
  | {chunkId: string; status: 'completed'}
  | {chunkId: string; status: 'failed'}
  | {chunkId: string; status: 'skipped'}

type ReviewServingProjectorWorkerCleanupResult =
  | {retentionScopes: readonly string[]; status: 'completed'}
  | {retentionScopes: readonly string[]; status: 'skipped'}

type ReviewServingProjectorWorkerCycleResult = {
  chunk: ReviewServingProjectorWorkerChunkResult
  cleanup: ReviewServingProjectorWorkerCleanupResult
  nextCleanupAtMs: number | null
  projector: WakeReviewServingProjectorServiceResult
  status: 'completed' | 'failed' | 'idle' | 'partial'
  wakeId: string
  workerId: string
}

type ReviewServingSnapshotContextRow = {
  componentStateJson: unknown
  reviewConfigHash: string | null
  selectedImportSnapshotId: string | null
  snapshotId: string
}

type ReviewServingSnapshotComponentState = {
  baseGeneration: string
  component: ReviewServingProjectionComponent
  patchWatermark: string
  projectionIdentity: string
}

type ReviewServingSnapshotComponentStateJson = {
  optional?: readonly ReviewServingSnapshotComponentState[]
  required?: readonly ReviewServingSnapshotComponentState[]
}

type ReviewServingSnapshotContext = ReviewServingSnapshotContextRow & {
  componentState: ReviewServingSnapshotComponentStateJson
}

type ProjectReviewSettingsRow = {
  humanJudgmentMode: 'prompt' | 'summary'
  modelExecutionOptions: unknown
  modelId: string
  modelProviderBaseUrl: string | null
  modelProviderConnectionId: string | null
  modelProviderKind: string | null
  modelRemoteModelId: string | null
  modelVariant: string | null
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}

type ProjectPromptConfigRow = {
  answerSchemaHash: string | null
  promptId: string
  promptOrder: number | null
  promptTextHash: string | null
  settingsVersion: string | null
  thresholdVersion: string | null
}

type ProjectReviewSnapshotSettings = ProjectReviewSettingsRow & {reviewConfigHash: string}

const defaultReviewServingProjectorWorkerBatchSize = 64
const defaultReviewServingProjectorWorkerCleanupIntervalMs = 60_000
const defaultReviewServingProjectorWorkerLeaseMs = 30_000
const defaultReviewServingProjectorWorkerMaxRetries = 1
const defaultReviewServingProjectorWorkerMaxRowsPerWake = 512
const defaultReviewServingProjectorWorkerMaxWakeMs = 5_000
const defaultReviewServingProjectorWorkerPollIntervalMs = 2_000
const defaultReviewServingProjectorWorkerErrorBackoffMs = 10_000
const reviewServingProjectorWorkerRouteOrJobKey = 'reviewServing.projector.worker'
const defaultReviewServingLlmListModeKeys = ['llm', 'both'] as const
const defaultReviewServingHumanListModeKeys = ['human', 'both'] as const
const defaultReviewFilterOptionKeys = [
  'conflictFlag',
  'duplicateFlag',
  'humanStatus',
  'importRoute',
  'llmStatus',
  'promptAnswer',
  'publicationYear',
  'searchTokenPrefix',
] as const
const defaultHumanFilterOptionKeys = [
  'conflictFlag',
  'duplicateFlag',
  'humanStatus',
  'importRoute',
  'promptAnswer',
  'publicationYear',
  'searchTokenPrefix',
] as const

const getClaimProjectId = (claims: readonly {projectId: string | null}[]) => {
  return claims.find((claim) => {
    return claim.projectId !== null
  })?.projectId ?? null
}

const getDefaultClaimManifestInput = async (
  context: Parameters<ReviewServingProjectorRunner>[0],
  database: ReviewServingProjectorWorkerDatabase,
) => {
  const projectId = getClaimProjectId(context.claims)

  if (projectId === null) {
    throw new Error(`cannot run ${context.component} projector without a project id`)
  }

  const manifest = await getReviewServingProjectionIdentityManifest(
    {
      projectId,
      projectionComponent: context.component,
      projectionIdentity: context.claims[0]?.projectionIdentity ?? '',
    },
    database,
  )

  if (manifest === null) {
    throw new Error(`cannot run ${context.component} projector without an identity manifest`)
  }

  return {manifest, projectId}
}

const getSnapshotContext = async (
  input: {
    component: ReviewServingProjectionComponent
    projectId: string
    projectionIdentity: string
    reviewConfigHash: string | null
  },
  database: ReviewServingProjectorWorkerDatabase,
) => {
  const rows = await database.queryJson<ReviewServingSnapshotContextRow>(`
    SELECT
      snapshot_id AS snapshotId,
      review_config_hash AS reviewConfigHash,
      selected_import_snapshot_id AS selectedImportSnapshotId,
      component_state_json AS componentStateJson
    FROM app.review_serving_snapshot_manifest
    WHERE project_id = ${getSqlLiteral(input.projectId)}
      ${input.reviewConfigHash === null ? '' : `AND review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}`}
      AND snapshot_status IN ('candidate', 'active')
    ORDER BY CASE WHEN snapshot_status = 'candidate' THEN 0 ELSE 1 END, updated_at DESC
  `)
  const snapshots = rows.map((row) => {
    return {
      ...row,
      componentState: getJsonValue(row.componentStateJson) as ReviewServingSnapshotComponentStateJson,
    }
  })

  return snapshots.find((snapshot) => {
    return getSnapshotComponentState(snapshot, input.component)?.projectionIdentity === input.projectionIdentity
  }) ?? null
}

const getSnapshotContexts = async (
  input: {
    component: ReviewServingProjectionComponent
    projectId: string
    projectionIdentity: string
    reviewConfigHash: string | null
  },
  database: ReviewServingProjectorWorkerDatabase,
) => {
  const rows = await database.queryJson<ReviewServingSnapshotContextRow>(`
    SELECT
      snapshot_id AS snapshotId,
      review_config_hash AS reviewConfigHash,
      selected_import_snapshot_id AS selectedImportSnapshotId,
      component_state_json AS componentStateJson
    FROM app.review_serving_snapshot_manifest
    WHERE project_id = ${getSqlLiteral(input.projectId)}
      ${input.reviewConfigHash === null ? '' : `AND review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}`}
      AND snapshot_status IN ('candidate', 'active')
    ORDER BY CASE WHEN snapshot_status = 'candidate' THEN 0 ELSE 1 END, updated_at DESC
  `)
  const snapshots = rows.map((row) => {
    return {
      ...row,
      componentState: getJsonValue(row.componentStateJson) as ReviewServingSnapshotComponentStateJson,
    }
  })

  return snapshots.filter((snapshot) => {
    return getSnapshotComponentState(snapshot, input.component)?.projectionIdentity === input.projectionIdentity
  })
}

const requireSnapshotContexts = async (
  input: {
    component: ReviewServingProjectionComponent
    projectId: string
    projectionIdentity: string
    reviewConfigHash: string | null
  },
  database: ReviewServingProjectorWorkerDatabase,
) => {
  const contexts = await getSnapshotContexts(input, database)

  if (contexts.length === 0) {
    throw new Error(`cannot run projector without a candidate or active snapshot for project ${input.projectId}`)
  }

  return contexts
}

const requireSnapshotContext = async (
  input: {
    component: ReviewServingProjectionComponent
    projectId: string
    projectionIdentity: string
    reviewConfigHash: string | null
  },
  database: ReviewServingProjectorWorkerDatabase,
) => {
  const context = await getSnapshotContext(input, database)

  if (context === null) {
    throw new Error(`cannot run projector without a candidate or active snapshot for project ${input.projectId}`)
  }

  return context
}

const getSnapshotComponentState = (
  snapshot: ReviewServingSnapshotContext,
  component: ReviewServingProjectionComponent,
) => {
  return [...(snapshot.componentState.required ?? []), ...(snapshot.componentState.optional ?? [])].find((state) => {
    return state.component === component
  }) ?? null
}

const requireSnapshotComponentIdentity = (
  snapshot: ReviewServingSnapshotContext,
  component: ReviewServingProjectionComponent,
) => {
  const projectionIdentity = getSnapshotComponentState(snapshot, component)?.projectionIdentity ?? null

  if (projectionIdentity === null) {
    throw new Error(`cannot run projector without ${component} identity in snapshot ${snapshot.snapshotId}`)
  }

  return projectionIdentity
}

const requireReviewConfigHash = (snapshot: ReviewServingSnapshotContext) => {
  if (snapshot.reviewConfigHash === null) {
    throw new Error(`cannot run projector without review config hash in snapshot ${snapshot.snapshotId}`)
  }

  return snapshot.reviewConfigHash
}

const requireSelectedImportSnapshotId = (snapshot: ReviewServingSnapshotContext) => {
  if (snapshot.selectedImportSnapshotId === null) {
    throw new Error(`cannot run projector without selected import snapshot id in snapshot ${snapshot.snapshotId}`)
  }

  return snapshot.selectedImportSnapshotId
}

const getProjectReviewSettings = async (projectId: string, database: ReviewServingProjectorWorkerDatabase) => {
  const rows = await database.queryJson<ProjectReviewSettingsRow>(`
    SELECT
      COALESCE(project.human_judgment_mode, 'prompt') AS humanJudgmentMode,
      project.model_id AS modelId,
      model.provider_connection_id AS modelProviderConnectionId,
      provider_connection.provider_kind AS modelProviderKind,
      provider_connection.base_url AS modelProviderBaseUrl,
      model.remote_model_id AS modelRemoteModelId,
      model.variant AS modelVariant,
      TO_JSON(json_extract(model.metadata_json, '$.options')) AS modelExecutionOptions,
      project.use_title AS useTitle,
      project.use_abstract AS useAbstract,
      project.use_fulltext AS useFulltext,
      project.use_fulltext_no_images AS useFulltextNoImages
    FROM app.project project
    LEFT JOIN app.model model
      ON model.id = project.model_id
    LEFT JOIN app.provider_connection provider_connection
      ON provider_connection.id = model.provider_connection_id
    WHERE project.id = ${getSqlLiteral(projectId)}
    LIMIT 1
  `)
  const row = rows[0]

  if (row === undefined) {
    throw new Error(`cannot run projector without review settings for project ${projectId}`)
  }

  return row
}

const getProjectPromptConfigRows = async (projectId: string, database: ReviewServingProjectorWorkerDatabase) => {
  return database.queryJson<ProjectPromptConfigRow>(`
    SELECT
      prompt.id AS promptId,
      project_prompt.prompt_order AS promptOrder,
      COALESCE(prompt.content_hash, sha256(prompt.original_text)) AS promptTextHash,
      NULL AS answerSchemaHash,
      'prompt-v1' AS settingsVersion,
      NULL AS thresholdVersion
    FROM app.project_prompt project_prompt
    INNER JOIN app.prompt prompt
      ON prompt.id = project_prompt.prompt_id
    WHERE project_prompt.project_id = ${getSqlLiteral(projectId)}
      AND project_prompt.enabled
      AND NOT project_prompt.archived
      AND COALESCE(prompt.archived, FALSE) = FALSE
    ORDER BY COALESCE(project_prompt.prompt_order, 0) ASC, prompt.id ASC
  `)
}

const getPromptConfigHash = (row: ProjectPromptConfigRow) => {
  return buildPromptConfigHash({
    answerSchemaHash: row.answerSchemaHash,
    promptId: row.promptId,
    promptTextHash: row.promptTextHash ?? row.promptId,
    settingsVersion: row.settingsVersion ?? 'prompt-v1',
    thresholdVersion: row.thresholdVersion,
  })
}

const getReviewConfigHash = (input: ProjectReviewSettingsRow & {promptConfigRows: readonly ProjectPromptConfigRow[]}) => {
  return buildReviewConfigHash({
    humanJudgmentMode: input.humanJudgmentMode,
    modelExecutionIdentity: {
      modelExecutionOptions: getJsonValue(input.modelExecutionOptions) as ReviewServingIdentityValue,
      modelId: input.modelId,
      providerBaseUrl: input.modelProviderBaseUrl,
      providerConnectionId: input.modelProviderConnectionId,
      providerKind: input.modelProviderKind,
      remoteModelId: input.modelRemoteModelId,
      variant: input.modelVariant,
    },
    modelId: input.modelId,
    promptConfigs: input.promptConfigRows.map((row, index) => {
      return {promptConfigHash: getPromptConfigHash(row), promptId: row.promptId, promptOrder: row.promptOrder ?? index}
    }),
    useAbstract: input.useAbstract,
    useFulltext: input.useFulltext,
    useFulltextNoImages: input.useFulltextNoImages,
    useTitle: input.useTitle,
  })
}

const getCurrentProjectReviewSnapshotSettings = async (
  projectId: string,
  database: ReviewServingProjectorWorkerDatabase,
): Promise<ProjectReviewSnapshotSettings> => {
  const project = await getProjectReviewSettings(projectId, database)
  const promptConfigRows = await getProjectPromptConfigRows(projectId, database)
  const reviewConfigHash = getReviewConfigHash({...project, promptConfigRows})

  return {...project, reviewConfigHash}
}

const getSnapshotReviewSettings = (
  snapshot: ReviewServingSnapshotContext,
  currentSettings: ProjectReviewSnapshotSettings,
) => {
  return snapshot.reviewConfigHash === currentSettings.reviewConfigHash ? currentSettings : null
}

const getDefaultRunnerInput = async (
  context: Parameters<ReviewServingProjectorRunner>[0],
  database: ReviewServingProjectorWorkerDatabase,
) => {
  const {manifest, projectId} = await getDefaultClaimManifestInput(context, database)
  const snapshot = await requireSnapshotContext(
    {
      component: context.component,
      projectId,
      projectionIdentity: manifest.projectionIdentity,
      reviewConfigHash: manifest.reviewConfigHash,
    },
    database,
  )

  return {manifest, projectId, snapshot}
}

const getDefaultRunnerInputs = async (
  context: Parameters<ReviewServingProjectorRunner>[0],
  database: ReviewServingProjectorWorkerDatabase,
) => {
  const {manifest, projectId} = await getDefaultClaimManifestInput(context, database)
  const snapshots = await requireSnapshotContexts(
    {
      component: context.component,
      projectId,
      projectionIdentity: manifest.projectionIdentity,
      reviewConfigHash: manifest.reviewConfigHash,
    },
    database,
  )

  return {manifest, projectId, snapshots}
}

const runSnapshotProjectors = async <T>(
  snapshots: readonly ReviewServingSnapshotContext[],
  runSnapshot: (snapshot: ReviewServingSnapshotContext, acknowledgeClaims: boolean) => Promise<T>,
) => {
  const resultsWithoutAcknowledgement = await Promise.all(
    snapshots.slice(0, -1).map((snapshot) => {
      return runSnapshot(snapshot, false)
    }),
  )
  const finalSnapshot = snapshots.at(-1)

  return finalSnapshot === undefined
    ? resultsWithoutAcknowledgement
    : [...resultsWithoutAcknowledgement, await runSnapshot(finalSnapshot, true)]
}

const getDefaultReviewServingProjectorRunners = (
  database: ReviewServingProjectorWorkerDatabase,
): ReviewServingProjectorServiceDependencies['runners'] => {
  return {
    display: async (context) => {
      const {manifest, projectId} = await getDefaultClaimManifestInput(context, database)
      const snapshots = await requireSnapshotContexts(
        {
          component: context.component,
          projectId,
          projectionIdentity: manifest.projectionIdentity,
          reviewConfigHash: manifest.reviewConfigHash,
        },
        database,
      )
      const patchSnapshot = (snapshot: ReviewServingSnapshotContext, acknowledgeClaims: boolean) => {
        return projectReviewServingDisplayPatches(
          {
            acknowledgeClaims,
            baseGeneration: manifest.baseGeneration,
            claims: context.claims,
            definitionVersion: manifest.definitionVersion,
            displayIdentity: manifest.projectionIdentity,
            projectId,
            projectScopeIdentity: requireSnapshotComponentIdentity(snapshot, 'projectScope'),
            projectionIdentity: manifest.projectionIdentity,
            selectedImportSnapshotId: requireSelectedImportSnapshotId(snapshot),
            snapshotId: snapshot.snapshotId,
          },
          database,
        )
      }
      const patchSnapshotsWithoutAcknowledgement = await Promise.all(
        snapshots.slice(0, -1).map((snapshot) => {
          return patchSnapshot(snapshot, false)
        }),
      )
      const finalPatchSnapshot = snapshots.at(-1)
      const results = finalPatchSnapshot === undefined
        ? patchSnapshotsWithoutAcknowledgement
        : [
            ...patchSnapshotsWithoutAcknowledgement,
            await patchSnapshot(finalPatchSnapshot, true),
          ]

      return {
        processedCount: results.reduce((total, result) => {
          return total + result.patchRowCount
        }, 0),
      }
    },
    humanStatus: async (context) => {
      const {manifest, projectId} = await getDefaultClaimManifestInput(context, database)
      const result = await projectReviewServingHumanStatusPatches(
        {
          baseGeneration: manifest.baseGeneration,
          claims: context.claims,
          definitionVersion: manifest.definitionVersion,
          listModeKeys: defaultReviewServingHumanListModeKeys,
          projectId,
          projectionIdentity: manifest.projectionIdentity,
        },
        database,
      )

      return {processedCount: result.patchRowCount}
    },
    judgmentInputContent: async (context) => {
      const {manifest, projectId} = await getDefaultClaimManifestInput(context, database)
      const patchWatermark = Math.max(
        0,
        ...context.claims.map((claim) => {
          return claim.latestSourceHighWaterMark
        }),
      )
      const patchRangeStart = Math.min(
        ...context.claims.map((claim) => {
          return claim.firstSourceHighWaterMark
        }),
      )
      const inputDigest = [
        ...new Set(
          context.claims.map((claim) => {
            return claim.dirtyKind
          }),
        ),
      ].join(',')

      await writeReviewServingProjectorComponent(
        {
          acknowledgements: context.claims,
          component: 'judgmentInputContent',
          projectionManifests:
            context.claims.length === 0
              ? []
              : [
                  {
                    baseGeneration: manifest.baseGeneration,
                    definitionVersion: manifest.definitionVersion,
                    inputDigest,
                    inputWatermark: patchWatermark,
                    inputWatermarks: getReviewServingSourcePartitionWatermarks(context.claims),
                    invalidationReason: inputDigest,
                    patchRangeEnd: patchWatermark,
                    patchRangeStart,
                    patchWatermark,
                    projectId,
                    projectionComponent: 'judgmentInputContent',
                    projectionIdentity: manifest.projectionIdentity,
                    reviewConfigHash: manifest.reviewConfigHash,
                    status: 'candidate',
                  },
                ],
          watermark:
            context.claims.length === 0
              ? undefined
              : {
                  projectId,
                  projectionComponent: 'judgmentInputContent',
                  projectorName: 'judgment-input-content-projector',
                  sourceHighWaterMark: patchWatermark,
                  sourcePartition: context.claims[0]?.sourcePartition ?? 'review-change',
                },
        },
        database,
      )

      return {processedCount: context.claims.length}
    },
    llmStatus: async (context) => {
      const {manifest, projectId} = await getDefaultClaimManifestInput(context, database)
      const result = await projectReviewServingLlmStatusPatches(
        {
          baseGeneration: manifest.baseGeneration,
          claims: context.claims,
          definitionVersion: manifest.definitionVersion,
          listModeKeys: defaultReviewServingLlmListModeKeys,
          projectId,
          projectionIdentity: manifest.projectionIdentity,
        },
        database,
      )

      return {processedCount: result.patchRowCount}
    },
    payload: async (context) => {
      const {manifest, projectId, snapshots} = await getDefaultRunnerInputs(context, database)
      const currentSettings = await getCurrentProjectReviewSnapshotSettings(projectId, database)
      const payloadSnapshots = snapshots.filter((snapshot) => {
        return getSnapshotReviewSettings(snapshot, currentSettings) !== null
      })

      if (payloadSnapshots.length === 0) {
        await completeReviewServingDirtyWorkClaims(context.claims, database)

        return {processedCount: 0}
      }

      const results = await runSnapshotProjectors(payloadSnapshots, async (snapshot, acknowledgeClaims) => {
        const project = getSnapshotReviewSettings(snapshot, currentSettings)

        if (project === null) {
          return 0
        }

        const articlePayloadResult = await projectReviewServingPayloadRows(
          {
            acknowledgeClaims: false,
            baseGeneration: manifest.baseGeneration,
            claims: context.claims,
            definitionVersion: manifest.definitionVersion,
            displayIdentity: requireSnapshotComponentIdentity(snapshot, 'display'),
            payloadIdentity: manifest.projectionIdentity,
            projectId,
            projectionIdentity: manifest.projectionIdentity,
            snapshotId: snapshot.snapshotId,
          },
          database,
        )
        const judgmentPayloadResult = await projectReviewServingJudgmentPayloadRows(
          {
            acknowledgeClaims,
            baseGeneration: manifest.baseGeneration,
            claims: context.claims,
            definitionVersion: manifest.definitionVersion,
            listModeKeys: reviewServingListModes,
            modelId: project.modelId,
            projectId,
            projectionIdentity: manifest.projectionIdentity,
            reviewConfigHash: requireReviewConfigHash(snapshot),
            snapshotId: snapshot.snapshotId,
            useAbstract: project.useAbstract,
            useFulltext: project.useFulltext,
            useFulltextNoImages: project.useFulltextNoImages,
            useTitle: project.useTitle,
          },
          database,
        )

        return articlePayloadResult.payloadRowCount + judgmentPayloadResult.humanRowCount + judgmentPayloadResult.llmRowCount
      })

      return {processedCount: results.reduce((total, count) => total + count, 0)}
    },
    posting: async (context) => {
      const {manifest, projectId, snapshots} = await getDefaultRunnerInputs(context, database)
      const results = await runSnapshotProjectors(snapshots, (snapshot, acknowledgeClaims) => {
        return projectReviewServingFilterPostings(
          {
            acknowledgeClaims,
            baseGeneration: manifest.baseGeneration,
            claims: context.claims,
            definitionVersion: manifest.definitionVersion,
            listModeKeys: reviewServingListModes,
            projectId,
            projectScopeIdentity: requireSnapshotComponentIdentity(snapshot, 'projectScope'),
            projectionIdentity: manifest.projectionIdentity,
            reviewConfigHash: requireReviewConfigHash(snapshot),
            selectedImportSnapshotId: requireSelectedImportSnapshotId(snapshot),
            snapshotId: snapshot.snapshotId,
          },
          database,
        )
      })

      return {processedCount: results.reduce((total, result) => total + result.servingRowCount, 0)}
    },
    projectScope: async (context) => {
      const {manifest, projectId} = await getDefaultClaimManifestInput(context, database)
      await projectReviewServingProjectScopePatches(
        {
          baseGeneration: manifest.baseGeneration,
          claims: context.claims,
          definitionVersion: manifest.definitionVersion,
          projectId,
          projectionIdentity: manifest.projectionIdentity,
        },
        database,
      )

      return {processedCount: context.claims.length}
    },
    queue: async (context) => {
      const {manifest, projectId, snapshots} = await getDefaultRunnerInputs(context, database)
      const results = await runSnapshotProjectors(snapshots, (snapshot, acknowledgeClaims) => {
        return projectReviewServingQueuePatches(
          {
            acknowledgeClaims,
            baseGeneration: manifest.baseGeneration,
            claims: context.claims,
            definitionVersion: manifest.definitionVersion,
            projectId,
            projectScopeIdentity: requireSnapshotComponentIdentity(snapshot, 'projectScope'),
            projectionIdentity: manifest.projectionIdentity,
            selectedImportSnapshotId: requireSelectedImportSnapshotId(snapshot),
            snapshotId: snapshot.snapshotId,
          },
          database,
        )
      })

      return {processedCount: results.reduce((total, result) => total + result.servingRowCount, 0)}
    },
    search: async (context) => {
      const {manifest, projectId, snapshots} = await getDefaultRunnerInputs(context, database)
      const results = await runSnapshotProjectors(snapshots, (snapshot, acknowledgeClaims) => {
        return projectReviewServingTitleSearchRows(
          {
            acknowledgeClaims,
            baseGeneration: manifest.baseGeneration,
            claims: context.claims,
            definitionVersion: manifest.definitionVersion,
            projectId,
            projectScopeIdentity: requireSnapshotComponentIdentity(snapshot, 'projectScope'),
            projectionIdentity: manifest.projectionIdentity,
            searchIdentity: manifest.projectionIdentity,
            selectedImportSnapshotId: snapshot.selectedImportSnapshotId,
            snapshotId: snapshot.snapshotId,
          },
          database,
        )
      })

      return {processedCount: results.reduce((total, result) => total + result.searchRowCount, 0)}
    },
    selectedImport: async (context) => {
      const {manifest, projectId, snapshots} = await getDefaultRunnerInputs(context, database)
      const results = await runSnapshotProjectors(snapshots, (snapshot, acknowledgeClaims) => {
        return projectReviewServingSelectedImportPatches(
          {
            acknowledgeClaims,
            baseGeneration: manifest.baseGeneration,
            claims: context.claims,
            definitionVersion: manifest.definitionVersion,
            projectId,
            projectScopeIdentity: requireSnapshotComponentIdentity(snapshot, 'projectScope'),
            projectionIdentity: manifest.projectionIdentity,
            selectedImportSnapshotId: requireSelectedImportSnapshotId(snapshot),
          },
          database,
        )
      })

      return {processedCount: results.reduce((total, result) => total + result.patchRowCount, 0)}
    },
    summary: async (context) => {
      const {manifest, projectId, snapshots} = await getDefaultRunnerInputs(context, database)
      const results = await runSnapshotProjectors(snapshots, async (snapshot, acknowledgeClaims) => {
        const result = await projectReviewServingSummaries(
          {
            acknowledgeClaims: false,
            baseGeneration: manifest.baseGeneration,
            claims: context.claims,
            listModeKeys: reviewServingListModes,
            projectId,
            projectScopeIdentity: requireSnapshotComponentIdentity(snapshot, 'projectScope'),
            projectionIdentity: manifest.projectionIdentity,
            reviewConfigHash: requireReviewConfigHash(snapshot),
            selectedImportSnapshotId: requireSelectedImportSnapshotId(snapshot),
            snapshotId: snapshot.snapshotId,
          },
          database,
        )
        const searchIdentity = getSnapshotComponentState(snapshot, 'search')?.projectionIdentity ?? ''
        const reviewFilterOptionsResult = await projectReviewServingFilterOptions(
          {
            acknowledgeClaims: false,
            baseGeneration: manifest.baseGeneration,
            claims: context.claims,
            definitionVersion: manifest.definitionVersion,
            filterOptionIdentity: getReviewServingFilterOptionIdentity({
              filterKeys: defaultReviewFilterOptionKeys,
              listModeKeys: reviewServingListModes,
              optionMode: 'review',
              searchIdentity,
            }),
            listModeKeys: reviewServingListModes,
            optionMode: 'review',
            projectId,
            projectionIdentity: manifest.projectionIdentity,
            reviewConfigHash: requireReviewConfigHash(snapshot),
            searchIdentity,
            snapshotId: snapshot.snapshotId,
          },
          database,
        )
        const humanFilterOptionsResult = await projectReviewServingFilterOptions(
          {
            acknowledgeClaims,
            baseGeneration: manifest.baseGeneration,
            claims: context.claims,
            definitionVersion: manifest.definitionVersion,
            filterOptionIdentity: getReviewServingFilterOptionIdentity({
              filterKeys: defaultHumanFilterOptionKeys,
              listModeKeys: defaultReviewServingHumanListModeKeys,
              optionMode: 'human',
              searchIdentity,
            }),
            listModeKeys: defaultReviewServingHumanListModeKeys,
            optionMode: 'human',
            projectId,
            projectionIdentity: manifest.projectionIdentity,
            reviewConfigHash: requireReviewConfigHash(snapshot),
            searchIdentity,
            snapshotId: snapshot.snapshotId,
          },
          database,
        )

        return result.summaryRowCount + reviewFilterOptionsResult.optionRowCount + humanFilterOptionsResult.optionRowCount
      })

      return {processedCount: results.reduce((total, count) => total + count, 0)}
    },
  }
}

const defaultReviewServingProjectorWorkerDependencies: ReviewServingProjectorWorkerDependencies = {
  cleanupRetentionState: cleanupReviewServingRetentionState,
  getDatabase: getAppDatabaseService as ReviewServingProjectorWorkerDependencies['getDatabase'],
  getCleanupTargets: async () => {
    return []
  },
  rebuildChunkService: {
    claimChunk: claimReviewServingRebuildChunk,
    failChunk: markReviewServingRebuildChunkFailed,
    getNextChunk: async () => {
      return null
    },
    isChunkComplete: isReviewServingRebuildChunkComplete,
    runClaimedChunk: async () => {
      return {status: 'completed'}
    },
  },
  sleep,
  wakeProjectors: wakeReviewServingProjectorService,
}

export const getReviewServingProjectorWorkerId = () => {
  return `review-serving-projector-worker:${hostname()}:${process.pid}`
}

export const getReviewServingProjectorWorkerWorkloadContext = (_workerId: string): DuckdbWorkloadContext => {
  return {
    allowsTempSpill: false,
    fallbackIntent: 'reject',
    routeOrJobKey: reviewServingProjectorWorkerRouteOrJobKey,
    searchMode: 'none',
    workloadClass: 'reviewProjector',
  }
}

const getWorkerNow = (options: ReviewServingProjectorWorkerCycleOptions) => {
  return options.now ?? new Date()
}

const getWorkerNowMs = (
  dependencies: ReviewServingProjectorWorkerDependencies,
  options: ReviewServingProjectorWorkerCycleOptions,
) => {
  return options.now?.getTime() ?? dependencies.nowMs?.() ?? Date.now()
}

const getPositiveInteger = (value: number | null | undefined, fallback: number) => {
  return value !== null && value !== undefined && Number.isInteger(value) && value > 0 ? Math.trunc(value) : fallback
}

const getLeaseExpiresAt = (options: ReviewServingProjectorWorkerCycleOptions) => {
  return new Date(
    getWorkerNow(options).getTime() + getPositiveInteger(options.leaseMs, defaultReviewServingProjectorWorkerLeaseMs),
  )
}

const getErrorText = (error: unknown) => {
  return error instanceof Error ? error.message : String(error)
}

const getReviewServingProjectorWorkerDatabase = (
  dependencies: ReviewServingProjectorWorkerDependencies,
  workloadContext: DuckdbWorkloadContext,
) => {
  const database = dependencies.getDatabase?.() ?? getAppDatabaseService()

  return {
    ...database,
    queryJson: <T>(statement: string) => {
      return database.queryJson<T>(statement, workloadContext)
    },
    run: (statement: string) => {
      return database.run(statement, workloadContext)
    },
    transaction: <T>(
      operation: (tx: {
        queryJson: <T>(statement: string) => Promise<T[]>
        run: (statement: string) => Promise<void>
      }) => Promise<T>,
    ) => {
      return database.transaction(operation, workloadContext)
    },
  }
}

const getWakeInput = (
  options: ReviewServingProjectorWorkerCycleOptions,
  wakeId: string,
): WakeReviewServingProjectorServiceInput => {
  return {
    batchSize: getPositiveInteger(options.batchSize, defaultReviewServingProjectorWorkerBatchSize),
    maxActiveImportCount: options.maxActiveImportCount,
    maxPendingDirtyWorkCount: options.maxPendingDirtyWorkCount,
    maxRetries: getPositiveInteger(options.maxRetries, defaultReviewServingProjectorWorkerMaxRetries),
    maxRowsPerWake: getPositiveInteger(options.maxRowsPerWake, defaultReviewServingProjectorWorkerMaxRowsPerWake),
    maxWakeMs: getPositiveInteger(options.maxWakeMs, defaultReviewServingProjectorWorkerMaxWakeMs),
    wakeId,
  }
}

const getCycleStatus = (input: {
  chunk: ReviewServingProjectorWorkerChunkResult
  cleanup: ReviewServingProjectorWorkerCleanupResult
  projector: WakeReviewServingProjectorServiceResult
}): ReviewServingProjectorWorkerCycleResult['status'] => {
  if (input.projector.status === 'failed' || input.chunk.status === 'failed') {
    return 'failed'
  }

  if (input.projector.status === 'partial') {
    return 'partial'
  }

  if (input.projector.status === 'blocked' && input.chunk.status === 'idle' && input.cleanup.status === 'skipped') {
    return 'idle'
  }

  return 'completed'
}

const shouldRunCleanup = (input: {cleanupIntervalMs: number; lastCleanupAtMs: number | null; nowMs: number}) => {
  return input.lastCleanupAtMs === null || input.nowMs - input.lastCleanupAtMs >= input.cleanupIntervalMs
}

const runReviewServingProjectorWorkerRebuildChunk = async ({
  database,
  dependencies,
  options,
  workloadContext,
  workerId,
}: {
  database: ReviewServingChunkManifestRepositoryDatabase
  dependencies: ReviewServingProjectorWorkerDependencies
  options: ReviewServingProjectorWorkerCycleOptions
  workloadContext: DuckdbWorkloadContext
  workerId: string
}): Promise<ReviewServingProjectorWorkerChunkResult> => {
  const service = dependencies.rebuildChunkService
  const chunkInput = await service?.getNextChunk()

  if (!service || chunkInput === null || chunkInput === undefined) {
    return {chunkId: null, status: 'idle'}
  }

  const completed = await service.isChunkComplete(chunkInput, database)
  const claimedChunk = completed
    ? null
    : await service.claimChunk(
        {...chunkInput, leaseExpiresAt: getLeaseExpiresAt(options), leaseOwner: workerId, now: getWorkerNow(options)},
        database,
      )

  if (completed) {
    return {chunkId: 'completed-manifest', status: 'skipped'}
  }

  if (claimedChunk === null) {
    return {chunkId: null, status: 'idle'}
  }

  try {
    await service.runClaimedChunk({chunk: claimedChunk, leaseOwner: workerId, workloadContext})

    return {chunkId: claimedChunk.chunkId, status: 'completed'}
  } catch (error) {
    await service.failChunk({chunkId: claimedChunk.chunkId, error: getErrorText(error), leaseOwner: workerId}, database)

    return {chunkId: claimedChunk.chunkId, status: 'failed'}
  }
}

const runReviewServingProjectorWorkerCleanup = async ({
  database,
  dependencies,
  options,
}: {
  database: ReviewServingRetentionServiceDatabase
  dependencies: ReviewServingProjectorWorkerDependencies
  options: ReviewServingProjectorWorkerCycleOptions
}): Promise<ReviewServingProjectorWorkerCleanupResult> => {
  const cleanupIntervalMs = getPositiveInteger(
    options.cleanupIntervalMs,
    defaultReviewServingProjectorWorkerCleanupIntervalMs,
  )
  const nowMs = getWorkerNowMs(dependencies, options)
  const lastCleanupAtMs = options.lastCleanupAtMs ?? null

  if (!shouldRunCleanup({cleanupIntervalMs, lastCleanupAtMs, nowMs})) {
    return {retentionScopes: [], status: 'skipped'}
  }

  const cleanupTargets = await dependencies.getCleanupTargets?.()
  const cleanupRetentionState = dependencies.cleanupRetentionState

  if (!cleanupRetentionState || cleanupTargets === undefined || cleanupTargets.length === 0) {
    return {retentionScopes: [], status: 'skipped'}
  }

  const retentionScopes = await cleanupTargets.reduce<Promise<string[]>>(async (previousScopes, target) => {
    const scopes = await previousScopes
    const cleanup = await cleanupRetentionState(target, database)

    return [...scopes, cleanup.retentionScope]
  }, Promise.resolve([]))

  return {retentionScopes, status: 'completed'}
}

export const runReviewServingProjectorWorkerCycle = async (
  options: ReviewServingProjectorWorkerCycleOptions = {},
  dependencies: ReviewServingProjectorWorkerDependencies = defaultReviewServingProjectorWorkerDependencies,
): Promise<ReviewServingProjectorWorkerCycleResult> => {
  const workerId = options.workerId ?? getReviewServingProjectorWorkerId()
  const wakeId = `${workerId}:${getWorkerNowMs(dependencies, options)}`
  const workloadContext = getReviewServingProjectorWorkerWorkloadContext(workerId)
  const database = getReviewServingProjectorWorkerDatabase(dependencies, workloadContext)
  const chunk = await runReviewServingProjectorWorkerRebuildChunk({
    database,
    dependencies,
    options,
    workloadContext,
    workerId,
  })
  const projector = await dependencies.wakeProjectors(getWakeInput(options, wakeId), {
    ...(dependencies.projectorServiceDependencies ?? {runners: getDefaultReviewServingProjectorRunners(database)}),
    database,
    nowMs: () => {
      return getWorkerNowMs(dependencies, options)
    },
  })
  const cleanup = await runReviewServingProjectorWorkerCleanup({database, dependencies, options})
  const nextCleanupAtMs =
    cleanup.status === 'completed' ? getWorkerNowMs(dependencies, options) : (options.lastCleanupAtMs ?? null)

  return {
    chunk,
    cleanup,
    nextCleanupAtMs,
    projector,
    status: getCycleStatus({chunk, cleanup, projector}),
    wakeId,
    workerId,
  }
}

export const runReviewServingProjectorWorkerOnce = async (
  options: ReviewServingProjectorWorkerCycleOptions = {},
  dependencies: ReviewServingProjectorWorkerDependencies = defaultReviewServingProjectorWorkerDependencies,
) => {
  return runReviewServingProjectorWorkerCycle(options, dependencies)
}

export const runReviewServingProjectorWorker = async (
  options: ReviewServingProjectorWorkerLoopOptions = {},
  dependencies: ReviewServingProjectorWorkerDependencies = defaultReviewServingProjectorWorkerDependencies,
): Promise<void> => {
  const cycleResult = await runReviewServingProjectorWorkerOnce(options, dependencies)

  if (options.signal?.aborted) {
    return
  }

  const delayMs =
    cycleResult.status === 'failed'
      ? (options.errorBackoffMs ?? defaultReviewServingProjectorWorkerErrorBackoffMs)
      : cycleResult.status === 'idle'
        ? (options.pollIntervalMs ?? defaultReviewServingProjectorWorkerPollIntervalMs)
        : 0
  const nextOptions = {...options, lastCleanupAtMs: cycleResult.nextCleanupAtMs}

  return delayMs > 0
    ? dependencies.sleep(delayMs).then(() => {
        return runReviewServingProjectorWorker(nextOptions, dependencies)
      })
    : runReviewServingProjectorWorker(nextOptions, dependencies)
}

export {
  defaultReviewServingProjectorWorkerBatchSize,
  defaultReviewServingProjectorWorkerCleanupIntervalMs,
  defaultReviewServingProjectorWorkerErrorBackoffMs,
  defaultReviewServingProjectorWorkerLeaseMs,
  defaultReviewServingProjectorWorkerMaxRetries,
  defaultReviewServingProjectorWorkerMaxRowsPerWake,
  defaultReviewServingProjectorWorkerMaxWakeMs,
  defaultReviewServingProjectorWorkerPollIntervalMs,
}

export type {
  ReviewServingProjectorWorkerChunkResult,
  ReviewServingProjectorWorkerCleanupResult,
  ReviewServingProjectorWorkerCycleOptions,
  ReviewServingProjectorWorkerCycleResult,
  ReviewServingProjectorWorkerDependencies,
  ReviewServingProjectorWorkerLoopOptions,
  ReviewServingProjectorWorkerRebuildChunkService,
}
