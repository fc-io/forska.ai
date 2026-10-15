import {existsSync, mkdtempSync, rmSync} from 'node:fs'
import {mkdir, readdir, readFile, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'

import {expect, setDefaultTimeout, spyOn, test} from 'bun:test'

import type {ProjectTransferSessionRecord} from '../../../db/schemaTypes.ts'
import type {RequestReviewServingV4RebuildInput} from '../../reviewServing/reviewServingV4RebuildRequestService.ts'
import {runMeasuredDuckdbJsonWorkload} from '../../utils/duckdbService.ts'
import {
  beginDuckdbTableWriteTracking,
  finishDuckdbTableWriteTracking,
  recordDuckdbTableWriteTrackerClose,
  recordDuckdbTableWriteTrackerOpen,
} from '../../utils/duckdbTableWriteTracker.ts'
import {installRuntimeJsonlSink, resetRuntimeJsonlSinkForTests} from '../../utils/runtimeLogger.ts'
import type {
  ProjectTransferImportAnalysisArtifact,
  ProjectTransferImportPlanArtifact,
} from './projectTransferAnalyze.ts'
import {
  commitProjectTransferImportSession,
  type ProjectTransferCommitInput,
  type ProjectTransferCommitResult,
  revalidateProjectTransferCommitPlan,
} from './projectTransferCommit.ts'
import {getProjectTransferPlanWithCommitIdMaps} from './projectTransferCommitIdMaps.ts'
import {assertProjectTransferCommitTargetStateUnchanged} from './projectTransferCommitWriteGuard.ts'
import {
  getActiveDuckdbExclusiveWorkSnapshot,
  hasActiveDuckdbExclusiveWork,
} from './projectTransferDuckdbExclusiveWork.ts'
import {getProjectTransferCanonicalJson} from './projectTransferFingerprint.ts'
import {
  getProjectTransferImportTempLayout,
  parseProjectTransferProgressPayload,
  type ProjectTransferPlanSummary,
} from './projectTransferSession.ts'
import {
  getProjectTransferImportStagingLayout,
  getProjectTransferProgressStagingRevision,
} from './projectTransferStaging.ts'
import {
  getCurrentProjectTransferTargetStateTableWrites,
  getProjectTransferTargetStateDirtyTokenService,
  projectTransferDependencyFingerprintAlgorithm,
  projectTransferDependencyFingerprintCodeVersion,
  projectTransferTargetStateCoverageCodeVersion,
  type ProjectTransferTargetStateDirtyTokenSnapshot,
  type ProjectTransferTargetStateSafetySurface,
  projectTransferTargetStateSafetySurfaces,
} from './projectTransferTargetStateDirtyTokenService.ts'

setDefaultTimeout(120_000)

type MutableSessionRepository = NonNullable<ProjectTransferCommitInput['repositories']>['sessionRepository']
type RevalidateInput = Parameters<NonNullable<NonNullable<ProjectTransferCommitInput['repositories']>['revalidate']>>[0]

const getCompleteTargetStateTokens = (overrides?: Partial<Record<ProjectTransferTargetStateSafetySurface, number>>) => {
  return projectTransferTargetStateSafetySurfaces.reduce<
    Partial<Record<ProjectTransferTargetStateSafetySurface, number>>
  >((tokens, surface) => {
    return {...tokens, [surface]: overrides?.[surface] ?? 0}
  }, {})
}

const getTargetStateSnapshot = (
  overrides?: Partial<ProjectTransferTargetStateDirtyTokenSnapshot>,
): ProjectTransferTargetStateDirtyTokenSnapshot => {
  return {
    capturedAt: '2026-05-28T10:00:00.000Z',
    coverage: {
      coverageCodeVersion: projectTransferTargetStateCoverageCodeVersion,
      coveredSurfaces: [...projectTransferTargetStateSafetySurfaces],
      dependencyFingerprintAlgorithm: projectTransferDependencyFingerprintAlgorithm,
      dependencyFingerprintCodeVersion: projectTransferDependencyFingerprintCodeVersion,
      initializedAt: '2026-05-28T09:00:00.000Z',
      updatedAt: '2026-05-28T09:00:00.000Z',
    },
    globalUnknownToken: 0,
    tokens: getCompleteTargetStateTokens(),
    ...overrides,
  }
}

const getTargetStateSnapshotRunner = (snapshot: ProjectTransferTargetStateDirtyTokenSnapshot) => {
  return {
    queryJson: async <T>(statement: string): Promise<T[]> => {
      return statement.includes('project_transfer_target_state_coverage')
        ? ([
            {
              coverageCodeVersion: snapshot.coverage?.coverageCodeVersion ?? null,
              coveredSurfacesJson: snapshot.coverage?.coveredSurfaces ?? [],
              dependencyFingerprintAlgorithm: snapshot.coverage?.dependencyFingerprintAlgorithm ?? null,
              dependencyFingerprintCodeVersion: snapshot.coverage?.dependencyFingerprintCodeVersion ?? null,
              initializedAt: snapshot.coverage?.initializedAt ?? '2026-05-28T09:00:00.000Z',
              updatedAt: snapshot.coverage?.updatedAt ?? '2026-05-28T09:00:00.000Z',
            },
          ] as T[])
        : statement.includes('project_transfer_target_state_unknown_token')
          ? ([{dirtyToken: snapshot.globalUnknownToken}] as T[])
          : statement.includes('project_transfer_target_state_dirty_token')
            ? (Object.entries(snapshot.tokens).map(([surface, dirtyToken]) => {
                return {dirtyToken, surface}
              }) as T[])
            : []
    },
    run: async () => {
      return undefined
    },
  }
}

const getRuntimeRoot = () => {
  return mkdtempSync(join(tmpdir(), `f2-project-transfer-commit-${process.pid}-`))
}

const getCommitRevalidationDecisionEvents = async (logDir: string) => {
  const files = (await readdir(logDir)).filter((file) => {
    return file.endsWith('.jsonl')
  })
  const contents = await Promise.all(
    files.map((file) => {
      return readFile(join(logDir, file), 'utf8')
    }),
  )

  return contents.flatMap((content) => {
    return content
      .trim()
      .split('\n')
      .map((line) => {
        return JSON.parse(line) as {attrs: Record<string, unknown>; event: string; severity: string}
      })
      .filter((event) => {
        return event.event === 'project_transfer.commit_revalidation_decision'
      })
  })
}

const removePathIfExists = (pathValue: string) => {
  rmSync(pathValue, {force: true, recursive: true})
}

const getLastJsonLine = (stdout: string) => {
  return (
    stdout
      .split('\n')
      .map((line) => {
        return line.trim()
      })
      .filter((line) => {
        return line !== ''
      })
      .at(-1) ?? ''
  )
}

const runCommitWriterScript = <TResult>(body: string) => {
  const duckdbPath = `/tmp/f2-project-transfer-commit-writer-${Date.now()}-${Math.random().toString(16).slice(2)}.duckdb`
  const runtimeRoot = getRuntimeRoot()
  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const [{migrateDuckdb}, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}, {computePromptContentHash}, {writeProjectTransferCommitAppTables: writeProjectTransferCommitAppTablesInRuntimeRoot}, {getProjectTransferPlanWithCommitIdMaps}, {getProjectTransferOperationTableNames}, {intakeReviewImportDeltasToDirtyWork}] = await Promise.all([
          import('./src/db/migrateDuckdb.ts'),
          import('./src/server/services/appDatabaseService.ts'),
          import('./src/server/utils/duckdbService.ts'),
          import('./src/server/utils/serverRuntimeRole.ts'),
          import('./src/server/utils/computePromptContentHash.ts'),
          import('./src/server/services/projectTransfer/projectTransferCommitWriter.ts'),
          import('./src/server/services/projectTransfer/projectTransferCommitIdMaps.ts'),
          import('./src/server/services/projectTransfer/projectTransferOperationTables.ts'),
          import('./src/server/reviewServing/reviewImportDeltaDirtyIntakeService.ts'),
        ])

        resetDuckdbServiceForTests()
        resetServerRuntimeRoleForTests()
        await migrateDuckdb()

        const writeProjectTransferCommitAppTables = (input) => {
          return writeProjectTransferCommitAppTablesInRuntimeRoot({cwd: process.env.PROJECT_TRANSFER_TEST_RUNTIME_ROOT, ...input})
        }
        const database = getAppDatabaseService()
        const now = new Date('2026-05-28T13:00:00.000Z')
        const catchMessage = async (operation) => {
          try {
            await operation()
            return null
          } catch (error) {
            return error instanceof Error ? error.message : String(error)
          }
        }
        const getPlanSummary = () => ({
          blockerCount: 0,
          conflictCounts: {
            articleConflictCount: 0,
            humanReviewFidelityConflictCount: 0,
            judgmentConflictCount: 0,
            packageContractConflictCount: 0,
            projectPromptConflictCount: 0,
          },
          dependencyStatuses: {},
          judgmentConflictStatus: 'clear',
          overlapCounts: {
            currentReviewRowsSignatureHumanReviewCount: 0,
            currentReviewRowsSignatureJudgmentCount: 0,
            dirtiedExistingProjectCount: 0,
            duplicateImportMatchCount: 0,
            newArticleCount: 0,
            omittedArticleRouteLinkCount: 0,
            omittedRouteLinkCount: 0,
            reusedArticleAssetPromotionCount: 0,
            reusedArticleCount: 0,
            reusedArticleFieldFillCount: 0,
            reusedArticleUpdateCount: 0,
            reusedJudgmentCount: 0,
            routeArticleSnapshotLinkCount: 0,
            snapshotVerifiedJudgmentCount: 0,
            storedSignatureHumanReviewCount: 0,
            storedSignatureJudgmentCount: 0,
          },
          warningCount: 0,
        })
        const getPackageCounts = () => ({
          articleImportRoutes: 0,
          assetManifest: 0,
          articles: 0,
          humanJudgmentSummaries: 0,
          humanJudgments: 0,
          importRoutes: 0,
          judgmentAssessments: 0,
          judgments: 0,
          models: 0,
          project: 1,
          projectArticles: 0,
          projectImportRoutes: 0,
          projectPrompts: 0,
          prompts: 0,
          providerConnections: 0,
          reviews: 0,
        })
        const getBasePlan = (targetPlan, dependencyResolution) => ({
          blockers: [],
          canCommit: true,
          dependencyResolution,
          packageCounts: getPackageCounts(),
          packageFingerprint: 'fingerprint-writer',
          packageWarnings: [],
          planRevision: 1,
          resolutionKinds: {},
          summary: getPlanSummary(),
          targetPlan: {
            articleMatches: [],
            articleRoutePlan: [],
            articleUpdatePlan: [],
            assetPromotionPlan: [],
            duplicateImportMatches: [],
            projectPromptPlan: [],
            projectRoutePlan: [],
            promptPlan: [],
            ...targetPlan,
          },
        })
        const getProjectPayload = (settings) => ({
          dateFrom: '2025-01-01T00:00:00.000Z',
          dateTo: '2025-12-31T00:00:00.000Z',
          description: 'Imported package description',
          modelSignature: {name: 'Model Signature'},
          name: 'Imported Writer Project',
          provenance: {sourceProjectId: 'source-project'},
          settings,
          signature: {modelSignature: {name: 'Model Signature'}, name: 'Imported Writer Project', settings},
          sourceProjectId: 'source-project',
        })
        const getModelPayload = () => ({
          modelName: 'target-model-name',
          name: 'target-model-name',
          provenance: {sourceModelId: 'source-model', sourceProviderConnectionId: 'source-provider'},
          remoteModelId: 'target-remote',
          signature: {name: 'Model Signature'},
          sourceModelId: 'source-model',
          sourceProviderConnectionId: 'source-provider',
          variant: null,
          version: null,
        })
        const dependencyResolution = {
          modelTargetBySourceId: {'source-model': 'target-model'},
          providerTargetBySourceId: {'source-provider': 'target-provider'},
        }

        ${body}

        await database.close()
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '39991',
        DUCKDB_PATH: duckdbPath,
        PROJECT_TRANSFER_TEST_RUNTIME_ROOT: runtimeRoot,
        SERVER_ROLE: 'dev-single',
        VITE_PORT: '39992',
      },
    },
  )

  try {
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString() || result.stdout.toString() || 'Project transfer commit writer failed')
    }

    return JSON.parse(getLastJsonLine(result.stdout.toString())) as TResult
  } finally {
    removePathIfExists(runtimeRoot)
    removePathIfExists(duckdbPath)
    removePathIfExists(`${duckdbPath}.wal`)
    removePathIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removePathIfExists(`${duckdbPath}.duckdb-owner.history.json`)
    removePathIfExists(`${duckdbPath}.tmp`)
    removePathIfExists('/tmp/duckdb-temp')
  }
}

const getFinalConflictCounts = () => {
  return {
    articleConflictCount: 0,
    humanReviewFidelityConflictCount: 0,
    judgmentConflictCount: 0,
    packageContractConflictCount: 0,
    projectPromptConflictCount: 0,
  }
}

const getFinalOverlapCounts = () => {
  return {
    currentReviewRowsSignatureHumanReviewCount: 0,
    currentReviewRowsSignatureJudgmentCount: 0,
    dirtiedExistingProjectCount: 0,
    duplicateImportMatchCount: 0,
    newArticleCount: 0,
    omittedArticleRouteLinkCount: 0,
    omittedRouteLinkCount: 0,
    reusedArticleAssetPromotionCount: 0,
    reusedArticleCount: 0,
    reusedArticleFieldFillCount: 0,
    reusedArticleUpdateCount: 0,
    reusedJudgmentCount: 0,
    routeArticleSnapshotLinkCount: 0,
    snapshotVerifiedJudgmentCount: 0,
    storedSignatureHumanReviewCount: 0,
    storedSignatureJudgmentCount: 0,
  }
}

const getEmptyPackageCounts = () => {
  return {
    articleImportRoutes: 0,
    assetManifest: 0,
    articles: 0,
    humanJudgmentSummaries: 0,
    humanJudgments: 0,
    importRoutes: 0,
    judgmentAssessments: 0,
    judgments: 0,
    models: 0,
    project: 1,
    projectArticles: 0,
    projectImportRoutes: 0,
    projectPrompts: 0,
    prompts: 0,
    providerConnections: 0,
    reviews: 0,
  }
}

const getReadySummary = (overrides?: Partial<ProjectTransferPlanSummary>): ProjectTransferPlanSummary => {
  return {
    blockerCount: 0,
    blockers: [],
    conflictCounts: getFinalConflictCounts(),
    dependencyStatuses: {},
    judgmentConflictStatus: 'clear',
    overlapCounts: getFinalOverlapCounts(),
    packageCounts: getEmptyPackageCounts(),
    warningCount: 0,
    ...overrides,
  }
}

const getPlan = ({
  planRevision,
  summary = getReadySummary(),
}: {
  planRevision: number
  summary?: ProjectTransferPlanSummary
}): ProjectTransferImportPlanArtifact => {
  return {
    blockers: summary.blockers ?? [],
    canCommit: summary.blockerCount === 0,
    packageCounts: getEmptyPackageCounts(),
    packageFingerprint: 'fingerprint-commit',
    packageWarnings: [],
    planRevision,
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

const getAnalysis = (
  planRevision: number,
  overrides: Partial<ProjectTransferImportAnalysisArtifact> = {},
): ProjectTransferImportAnalysisArtifact => {
  return {
    analyzedAt: '2026-05-28T10:00:00.000Z',
    archive: {expandedBytes: 0, memberCount: 0, packageChecksumSha256: 'a'.repeat(64), packageSizeBytes: 0},
    assetSummary: {actualByteLength: 0, actualEntryCount: 0, manifestByteLength: null, manifestEntryCount: null},
    computedPackageFingerprint: 'fingerprint-commit',
    manifest: {
      createdAt: '2026-05-28T10:00:00.000Z',
      packageFingerprint: 'fingerprint-commit',
      payloads: getPlan({planRevision}).packageCounts,
      schemaVersion: 1,
      source: {app: 'forska', exportedAt: '2026-05-28T10:00:00.000Z'},
    } as unknown as ProjectTransferImportAnalysisArtifact['manifest'],
    packageCounts: getPlan({planRevision}).packageCounts,
    packageFingerprint: 'fingerprint-commit',
    packageWarnings: [],
    payloads: {} as ProjectTransferImportAnalysisArtifact['payloads'],
    planRevision,
    ...overrides,
  }
}

const writeJson = async ({cwd, pathValue, value}: {cwd: string; pathValue: string; value: unknown}) => {
  const resolvedPath = join(cwd, pathValue)
  await mkdir(dirname(resolvedPath), {recursive: true})
  await globalThis.Bun.write(resolvedPath, getProjectTransferCanonicalJson(value))
}

const writeArtifacts = async ({
  cwd,
  sessionId,
  analysis,
  plan,
}: {
  analysis: ProjectTransferImportAnalysisArtifact
  cwd: string
  plan: ProjectTransferImportPlanArtifact
  sessionId: string
}) => {
  const baseLayout = getProjectTransferImportTempLayout(sessionId)
  const layout =
    typeof plan.stagingRevision === 'number'
      ? getProjectTransferImportStagingLayout({layout: baseLayout, stagingRevision: plan.stagingRevision})
      : baseLayout
  await writeJson({cwd, pathValue: layout.analysisPath, value: analysis})
  await writeJson({cwd, pathValue: layout.planPath, value: plan})

  return layout
}

const getSession = (overrides?: Partial<ProjectTransferSessionRecord>): ProjectTransferSessionRecord => {
  const now = new Date('2026-05-28T10:00:00.000Z')
  const summary = getReadySummary()

  return {
    commitId: null,
    completionPayloadJson: null,
    createdAt: now,
    direction: 'import',
    errorJson: null,
    expiresAt: new Date('2026-05-28T11:00:00.000Z'),
    heartbeatAt: null,
    id: 'commit-session',
    ownerToken: null,
    packageFingerprint: 'fingerprint-commit',
    planRevision: 1,
    planSummaryJson: summary,
    progressJson: null,
    state: 'ready_to_commit',
    terminalCleanupAt: null,
    updatedAt: now,
    ...overrides,
  }
}

const getFakeSessionRepository = (initialSession: ProjectTransferSessionRecord) => {
  const calls: {
    cleanup: unknown[]
    persist: unknown[]
    reopen: unknown[]
    transition: unknown[]
    updatePlan: unknown[]
  } = {cleanup: [], persist: [], reopen: [], transition: [], updatePlan: []}
  let session = initialSession
  const repository: MutableSessionRepository = {
    getProjectTransferSession: async () => {
      return session
    },
    markProjectTransferSessionTerminalCleanupComplete: async (params) => {
      calls.cleanup = [...calls.cleanup, params]
      session = session.state === 'completed' ? {...session, terminalCleanupAt: params.now ?? new Date()} : session

      return session.state === 'completed' ? session : null
    },
    reopenProjectTransferCommitSession: async (params) => {
      calls.reopen = [...calls.reopen, params]
      session =
        session.state === 'committing'
        && session.ownerToken === params.ownerToken
        && session.commitId === params.commitId
        && session.planRevision === params.expectedPlanRevision
          ? {
              ...session,
              commitId: null,
              ownerToken: null,
              planRevision: session.planRevision + 1,
              planSummaryJson: params.planSummary,
              progressJson: params.progress ?? session.progressJson,
              state: 'awaiting_resolution',
            }
          : session

      return session.state === 'awaiting_resolution' ? session : null
    },
    persistProjectTransferSessionCompletion: async (params) => {
      calls.persist = [...calls.persist, params]
      session =
        session.state === 'committing'
        && session.ownerToken === params.ownerToken
        && (params.expectedPlanRevision === undefined || session.planRevision === params.expectedPlanRevision)
          ? {
              ...session,
              completionPayloadJson: params.completionPayload,
              errorJson: null,
              ownerToken: null,
              packageFingerprint: params.completionPayload.packageFingerprint ?? null,
              progressJson: null,
              state: 'completed',
            }
          : session

      return session.state === 'completed' ? session : null
    },
    transitionProjectTransferSessionState: async (params) => {
      calls.transition = [...calls.transition, params]
      const stateMatches = Array.isArray(params.expectedState)
        ? params.expectedState.includes(session.state)
        : session.state === params.expectedState
      const ownerMatches =
        params.expectedOwnerToken === undefined ? true : session.ownerToken === params.expectedOwnerToken
      const planRevisionMatches =
        params.expectedPlanRevision === undefined ? true : session.planRevision === params.expectedPlanRevision
      const stagingRevisionMatches =
        params.expectedStagingRevision === undefined
        || getProjectTransferProgressStagingRevision(parseProjectTransferProgressPayload(session.progressJson))
          === params.expectedStagingRevision
      session =
        stateMatches && ownerMatches && planRevisionMatches && stagingRevisionMatches
          ? {
              ...session,
              commitId: Object.hasOwn(params, 'commitId') ? (params.commitId ?? null) : session.commitId,
              completionPayloadJson: Object.hasOwn(params, 'completionPayload')
                ? (params.completionPayload ?? null)
                : session.completionPayloadJson,
              errorJson: Object.hasOwn(params, 'error') ? (params.error ?? null) : session.errorJson,
              heartbeatAt: params.now ?? null,
              ownerToken: Object.hasOwn(params, 'nextOwnerToken')
                ? (params.nextOwnerToken ?? null)
                : session.ownerToken,
              planRevision: params.expectedPlanRevision ?? session.planRevision,
              progressJson: params.progress ?? null,
              state: params.nextState,
            }
          : session

      return session.state === params.nextState ? session : null
    },
    updateProjectTransferSessionPlanRevision: async (params) => {
      calls.updatePlan = [...calls.updatePlan, params]
      session =
        session.planRevision === params.expectedPlanRevision && session.ownerToken === null
          ? {
              ...session,
              planRevision: session.planRevision + 1,
              planSummaryJson: params.planSummary,
              state: params.nextState ?? session.state,
            }
          : session

      return session.planRevision === params.expectedPlanRevision + 1 ? session : null
    },
  }

  return {
    calls,
    getSession: () => {
      return session
    },
    repository,
  }
}

const getNoopHistoryRepository = () => {
  return {
    getCompletedImportHistoryBySessionId: async () => {
      return null
    },
  }
}

const runCommit = async ({
  cwd,
  onAppTableWrites,
  reclaimRevalidationMemory,
  repository,
  requestReviewServingBuild = async () => {
    return undefined
  },
  request = {planRevision: 1},
  revalidate,
  sessionId = 'commit-session',
  startBackgroundCommit,
}: {
  cwd: string
  onAppTableWrites?: () => Promise<void> | void
  reclaimRevalidationMemory?: NonNullable<ProjectTransferCommitInput['repositories']>['reclaimRevalidationMemory']
  repository: MutableSessionRepository
  requestReviewServingBuild?: NonNullable<ProjectTransferCommitInput['repositories']>['requestReviewServingBuild']
  request?: ProjectTransferCommitInput['request']
  revalidate: NonNullable<ProjectTransferCommitInput['repositories']>['revalidate']
  sessionId?: string
  startBackgroundCommit?: NonNullable<ProjectTransferCommitInput['repositories']>['startBackgroundCommit']
}): Promise<ProjectTransferCommitResult> => {
  return commitProjectTransferImportSession({
    cwd,
    now: new Date('2026-05-28T10:30:00.000Z'),
    repositories: {
      getCommitId: () => {
        return 'commit-generated'
      },
      getOwnerToken: () => {
        return 'owner-generated'
      },
      historyRepository: getNoopHistoryRepository(),
      reclaimRevalidationMemory,
      revalidate,
      requestReviewServingBuild,
      runAppTableWrites: async () => {
        await onAppTableWrites?.()
        expect(getActiveDuckdbExclusiveWorkSnapshot()).toMatchObject({
          admissionState: 'running',
          kind: 'project_transfer_import',
          ownerToken: 'owner-generated',
          phase: 'commit',
          sessionId,
        })

        const completion = {
          finalCounts: {articles: 0, judgments: 0, prompts: 0, reviews: 0, routes: 0, warnings: 0},
          importWarnings: [],
          packageFingerprint: 'fingerprint-commit',
          payloadCounts: getPlan({planRevision: 1}).packageCounts,
          projectId: 'target-project',
          projectName: 'Target Project',
          status: 'completed' as const,
          targetProjectId: 'target-project',
          targetProjectName: 'Target Project',
          transferHistoryId: 'history-generated',
        }

        return {
          articleIdBySourceId: {},
          completion,
          history: {
            commitId: 'commit-generated',
            completionPayloadJson: completion,
            createdAt: new Date('2026-05-28T10:30:00.000Z'),
            direction: 'import' as const,
            id: 'history-generated',
            packageFingerprint: 'fingerprint-commit',
            payloadCountsJson: getPlan({planRevision: 1}).packageCounts,
            schemaVersion: 1,
            sessionId: 'commit-session',
            sourceProjectId: 'source-project',
            sourceProjectName: 'Source Project',
            targetProjectId: 'target-project',
            targetProjectName: 'Target Project',
          },
          importWarnings: [],
          projectId: 'target-project',
          projectName: 'Target Project',
          promptIdBySourceId: {},
          routeIdBySourceId: {},
        }
      },
      sessionRepository: repository,
      startBackgroundCommit,
    },
    request,
    sessionId,
  })
}

test('project transfer commit loads frozen artifacts and claims with server generated fencing ids', async () => {
  const cwd = getRuntimeRoot()

  try {
    const summary = getReadySummary()
    const plan = getPlan({planRevision: 1, summary})
    const layout = await writeArtifacts({analysis: getAnalysis(1), cwd, plan, sessionId: 'commit-session'})
    const fake = getFakeSessionRepository(getSession({planSummaryJson: summary}))
    const revalidationInputs: RevalidateInput[] = []
    const result = await runCommit({
      cwd,
      repository: fake.repository,
      revalidate: async (input) => {
        revalidationInputs.push(input)
        return {changed: false, plan, ready: true}
      },
    })
    const analysisArtifactExists = await globalThis.Bun.file(join(cwd, layout.analysisPath)).exists()
    const completionArtifactExists = await globalThis.Bun.file(join(cwd, layout.completionPath)).exists()
    const planArtifactExists = await globalThis.Bun.file(join(cwd, layout.planPath)).exists()
    const progressArtifactExists = await globalThis.Bun.file(join(cwd, layout.progressPath)).exists()

    expect(result.status).toBe('completed')
    expect(result.statusCode).toBe(200)
    expect(fake.getSession()).toMatchObject({
      commitId: 'commit-generated',
      completionPayloadJson: {projectId: 'target-project', transferHistoryId: 'history-generated'},
      ownerToken: null,
      state: 'completed',
    })
    expect(fake.calls.transition).toHaveLength(4)
    expect(fake.calls.transition[0]).toMatchObject({
      commitId: 'commit-generated',
      nextOwnerToken: 'owner-generated',
      nextState: 'committing',
      progress: {phase: 'revalidation', planRevision: 1, status: 'running'},
    })
    expect(fake.calls.transition[1]).toMatchObject({
      expectedOwnerToken: 'owner-generated',
      nextState: 'committing',
      progress: {message: 'Waiting for DuckDB maintenance work to pause', phase: 'revalidation', status: 'running'},
    })
    expect(fake.calls.transition[2]).toMatchObject({
      expectedOwnerToken: 'owner-generated',
      nextState: 'committing',
      progress: {message: 'Commit revalidation running', phase: 'revalidation', status: 'running'},
    })
    expect(fake.calls.transition[3]).toMatchObject({
      expectedOwnerToken: 'owner-generated',
      nextState: 'committing',
      progress: {percent: 100, phase: 'commit', status: 'completed'},
    })
    expect(fake.calls.persist).toHaveLength(1)
    expect((fake.calls.persist[0] as {now: Date}).now.toISOString()).toBe(
      (fake.calls.transition[3] as {progress: {updatedAt: string}}).progress.updatedAt,
    )
    expect(fake.calls.cleanup).toHaveLength(1)
    expect(fake.getSession().terminalCleanupAt).not.toBeNull()
    expect(fake.calls.updatePlan).toHaveLength(0)
    expect(revalidationInputs).toHaveLength(2)
    expect(analysisArtifactExists).toBe(false)
    expect(planArtifactExists).toBe(false)
    expect(completionArtifactExists).toBe(true)
    expect(progressArtifactExists).toBe(true)
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('project transfer commit retries a rolled-back failed commit with fresh fencing ids', async () => {
  const cwd = getRuntimeRoot()

  try {
    const summary = getReadySummary()
    const plan = {...getPlan({planRevision: 1, summary}), stagingRevision: 1}
    await writeArtifacts({analysis: getAnalysis(1, {stagingRevision: 1}), cwd, plan, sessionId: 'commit-session'})
    const fake = getFakeSessionRepository(
      getSession({
        commitId: 'commit-previous',
        completionPayloadJson: {status: 'completed'},
        errorJson: {message: 'Out of Memory Error'},
        planSummaryJson: summary,
        progressJson: {
          message: 'Commit failed; rollback cleanup completed or was not required',
          phase: 'commit',
          planRevision: 1,
          stagingRevision: 1,
          status: 'failed',
          updatedAt: '2026-05-28T10:20:00.000Z',
        },
        state: 'failed',
      }),
    )
    const revalidationInputs: RevalidateInput[] = []
    const result = await runCommit({
      cwd,
      repository: fake.repository,
      revalidate: async (input) => {
        revalidationInputs.push(input)
        return {changed: false, plan, ready: true}
      },
    })

    expect(result).toMatchObject({status: 'completed', statusCode: 200})
    expect(fake.calls.transition[0]).toMatchObject({
      commitId: 'commit-generated',
      completionPayload: null,
      error: null,
      expectedOwnerToken: null,
      expectedPlanRevision: 1,
      expectedStagingRevision: 1,
      expectedState: 'failed',
      nextOwnerToken: 'owner-generated',
      nextState: 'committing',
    })
    expect(fake.getSession()).toMatchObject({
      commitId: 'commit-generated',
      errorJson: null,
      ownerToken: null,
      state: 'completed',
    })
    expect(revalidationInputs).toHaveLength(1)
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('project transfer commit rejects a failed retry when reviewed staging artifacts are unavailable', async () => {
  const cwd = getRuntimeRoot()

  try {
    const fake = getFakeSessionRepository(
      getSession({
        commitId: 'commit-previous',
        errorJson: {message: 'Out of Memory Error'},
        planSummaryJson: getReadySummary(),
        progressJson: {
          message: 'Commit failed; rollback cleanup completed or was not required',
          phase: 'commit',
          planRevision: 1,
          stagingRevision: 1,
          status: 'failed',
          updatedAt: '2026-05-28T10:20:00.000Z',
        },
        state: 'failed',
      }),
    )
    const result = await runCommit({
      cwd,
      repository: fake.repository,
      revalidate: async () => {
        throw new Error('unexpected revalidation')
      },
    })

    expect(result).toMatchObject({status: 'error', statusCode: 409})
    expect(result.status === 'error' ? result.error : '').toContain('Project transfer import artifacts are unavailable')
    expect(fake.calls.transition).toHaveLength(0)
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('project transfer commit does not retry failed sessions that may have promoted assets', async () => {
  const cwd = getRuntimeRoot()

  try {
    const fake = getFakeSessionRepository(
      getSession({
        commitId: 'commit-previous',
        errorJson: {message: 'Asset promotion failed'},
        planSummaryJson: getReadySummary({packageCounts: {...getEmptyPackageCounts(), assetManifest: 1}}),
        progressJson: {
          message: 'Commit failed; rollback cleanup completed or was not required',
          phase: 'commit',
          planRevision: 1,
          stagingRevision: 1,
          status: 'failed',
          updatedAt: '2026-05-28T10:20:00.000Z',
        },
        state: 'failed',
      }),
    )
    const result = await runCommit({
      cwd,
      repository: fake.repository,
      revalidate: async () => {
        throw new Error('unexpected revalidation')
      },
    })

    expect(result).toMatchObject({error: 'Project transfer import session failed', status: 'error', statusCode: 409})
    expect(fake.calls.transition).toHaveLength(0)
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('project transfer commit rejects analysis-failed sessions before loading artifacts', async () => {
  const cwd = getRuntimeRoot()

  try {
    const fake = getFakeSessionRepository(
      getSession({
        commitId: 'analyze-attempt',
        errorJson: {message: 'Analysis failed'},
        progressJson: {
          phase: 'analyze',
          planRevision: 1,
          stagingRevision: 1,
          status: 'failed',
          updatedAt: '2026-05-28T10:20:00.000Z',
        },
        state: 'failed',
      }),
    )
    const result = await runCommit({
      cwd,
      repository: fake.repository,
      revalidate: async () => {
        throw new Error('unexpected revalidation')
      },
    })

    expect(result).toMatchObject({error: 'Project transfer import session failed', status: 'error', statusCode: 409})
    expect(fake.calls.transition).toHaveLength(0)
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('project transfer commit requests review-serving build after successful app-table commit', async () => {
  const cwd = getRuntimeRoot()

  try {
    const summary = getReadySummary()
    const plan = getPlan({planRevision: 1, summary})
    await writeArtifacts({analysis: getAnalysis(1), cwd, plan, sessionId: 'commit-session'})
    const fake = getFakeSessionRepository(getSession({planSummaryJson: summary}))
    const rebuildRequests: RequestReviewServingV4RebuildInput[] = []
    const commitTempTablesPath = join(cwd, getProjectTransferImportTempLayout('commit-session').commitTempTablesPath)
    const leftoverCommitTempTableFile = join(
      commitTempTablesPath,
      'temp_project_transfer_crashed_commit_id_map/idMap.ndjson',
    )
    await mkdir(dirname(leftoverCommitTempTableFile), {recursive: true})
    await writeFile(leftoverCommitTempTableFile, '{}\n')
    const result = await runCommit({
      cwd,
      repository: fake.repository,
      requestReviewServingBuild: async (input) => {
        rebuildRequests.push(input)
      },
      revalidate: async () => {
        return {changed: false, plan, ready: true}
      },
    })

    expect(result.status).toBe('completed')
    expect(rebuildRequests).toEqual([
      {priority: 1_000, projectId: 'target-project', reason: 'missingReviewServingSnapshot'},
    ])
    expect(fake.calls.persist).toHaveLength(1)
    expect(fake.calls.cleanup).toHaveLength(1)
    expect(existsSync(commitTempTablesPath)).toBe(false)
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('project transfer commit keeps completion successful when post-import review-serving request fails', async () => {
  const cwd = getRuntimeRoot()

  try {
    const summary = getReadySummary()
    const plan = getPlan({planRevision: 1, summary})
    await writeArtifacts({analysis: getAnalysis(1), cwd, plan, sessionId: 'commit-session'})
    const fake = getFakeSessionRepository(getSession({planSummaryJson: summary}))
    const result = await runCommit({
      cwd,
      repository: fake.repository,
      requestReviewServingBuild: async () => {
        throw new Error('review-serving request unavailable')
      },
      revalidate: async () => {
        return {changed: false, plan, ready: true}
      },
    })

    expect(result.status).toBe('completed')
    expect(result.statusCode).toBe(200)
    expect(fake.getSession()).toMatchObject({state: 'completed'})
    expect(fake.calls.cleanup).toHaveLength(1)
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('project transfer commit rejects stale artifact summaries before claiming', async () => {
  const cwd = getRuntimeRoot()

  try {
    const sessionSummary = getReadySummary()
    const artifactSummary = getReadySummary({warningCount: 1})
    const plan = getPlan({planRevision: 1, summary: artifactSummary})
    await writeArtifacts({analysis: getAnalysis(1), cwd, plan, sessionId: 'commit-session'})
    const fake = getFakeSessionRepository(getSession({planSummaryJson: sessionSummary}))
    const result = await runCommit({
      cwd,
      repository: fake.repository,
      revalidate: async () => {
        return {changed: false, plan, ready: true}
      },
    })

    expect(result).toMatchObject({
      error: 'Project transfer commit plan artifact summary is stale',
      status: 'error',
      statusCode: 409,
    })
    expect(fake.calls.transition).toHaveLength(0)
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('project transfer commit allows older analysis snapshots for resolved plan revisions', async () => {
  const cwd = getRuntimeRoot()

  try {
    const summary = getReadySummary()
    const plan = getPlan({planRevision: 2, summary})
    await writeArtifacts({analysis: getAnalysis(1), cwd, plan, sessionId: 'commit-session'})
    const fake = getFakeSessionRepository(getSession({planRevision: 2, planSummaryJson: summary}))
    const result = await runCommit({
      cwd,
      repository: fake.repository,
      request: {planRevision: 2},
      revalidate: async () => {
        return {changed: false, plan, ready: true}
      },
    })

    expect(result.status).toBe('completed')
    expect(fake.calls.transition[0]).toMatchObject({expectedPlanRevision: 2, nextState: 'committing'})
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('project transfer commit revalidation reads payloads when a runner target state has no table-write tracking', async () => {
  const cwd = getRuntimeRoot()
  const logDir = join(cwd, 'logs')

  installRuntimeJsonlSink({envValues: {LOG_DIR: logDir, LOG_LEVEL: 'ERROR'}})

  try {
    const targetState = getTargetStateSnapshot()
    const plan = {...getPlan({planRevision: 1}), targetState}
    const revalidationError = await revalidateProjectTransferCommitPlan({
      analysis: getAnalysis(1),
      cwd,
      layout: getProjectTransferImportTempLayout('commit-session'),
      nextPlanRevision: 2,
      plan,
      repositories: {analyzeTargetRunner: getTargetStateSnapshotRunner(targetState)},
      sessionId: 'commit-session',
    }).then(
      () => {
        return null
      },
      (error: unknown) => {
        return error instanceof Error ? error.message : String(error)
      },
    )

    expect(revalidationError).toMatch(/ENOENT|missing|no such file/i)
    const events = await getCommitRevalidationDecisionEvents(logDir)

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      attrs: {
        analyzedEpochReason: null,
        changedSurfaces: [],
        reason: 'analyzed_target_state_coverage_incomplete',
        sessionId: 'commit-session',
        status: 'full_revalidation_required',
      },
      severity: 'INFO',
    })
  } finally {
    resetRuntimeJsonlSinkForTests()
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('project transfer commit logs one operator decision for each pre-claim and post-claim skip', async () => {
  const cwd = getRuntimeRoot()
  const logDir = join(cwd, 'logs')
  recordDuckdbTableWriteTrackerOpen('project-transfer-decision-log-test')
  const targetState = getTargetStateSnapshot({tableWrites: getCurrentProjectTransferTargetStateTableWrites()})
  const snapshot = spyOn(
    getProjectTransferTargetStateDirtyTokenService(),
    'getTargetStateDirtyTokenSnapshot',
  ).mockResolvedValue(targetState)

  installRuntimeJsonlSink({envValues: {LOG_DIR: logDir, LOG_LEVEL: 'ERROR'}})

  try {
    const summary = getReadySummary()
    const plan = {...getPlan({planRevision: 1, summary}), targetState}
    await writeArtifacts({analysis: getAnalysis(1), cwd, plan, sessionId: 'commit-session'})
    const fake = getFakeSessionRepository(getSession({planSummaryJson: summary}))
    const phases: string[] = []
    const result = await runCommit({
      beforeAppTableWrites: async (input) => {
        expect(input.artifacts.plan.targetState).toEqual(targetState)
        assertProjectTransferCommitTargetStateUnchanged({plan: input.artifacts.plan, sessionId: input.sessionId})
      },
      cwd,
      repository: fake.repository,
      revalidate: async (input) => {
        phases.push(fake.getSession().state)
        expect(await getCommitRevalidationDecisionEvents(logDir)).toHaveLength(phases.length - 1)
        return revalidateProjectTransferCommitPlan(input)
      },
    })
    const events = await getCommitRevalidationDecisionEvents(logDir)

    expect(result.status).toBe('completed')
    expect(phases).toEqual(['ready_to_commit', 'committing'])
    expect(events).toHaveLength(2)
    events.map((event) => {
      expect(event.severity).toBe('INFO')
      expect(event.attrs).toEqual({
        analyzedEpochReason: targetState.tableWrites?.epochReason,
        analyzedTableWritesAvailable: true,
        changedSurfaces: [],
        currentEpochReason: targetState.tableWrites?.epochReason,
        currentTableWritesAvailable: true,
        epochsMatched: true,
        reason: 'target_state_unchanged',
        sessionId: 'commit-session',
        status: 'incremental_revalidation_allowed',
      })
    })
  } finally {
    snapshot.mockRestore()
    resetRuntimeJsonlSinkForTests()
    recordDuckdbTableWriteTrackerClose()
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('project transfer commit returns the current committing session without loading artifacts', async () => {
  const cwd = getRuntimeRoot()
  const fake = getFakeSessionRepository(
    getSession({commitId: 'commit-existing', ownerToken: 'owner-existing', state: 'committing'}),
  )
  const result = await runCommit({
    cwd,
    repository: fake.repository,
    revalidate: async () => {
      throw new Error('unexpected revalidation')
    },
  })

  expect(result.status).toBe('in_flight')
  expect(result.statusCode).toBe(202)
  expect(fake.calls.transition).toHaveLength(0)
})

test('project transfer commit claims large imports before running background revalidation', async () => {
  const cwd = getRuntimeRoot()

  try {
    const summary = getReadySummary()
    const plan = {
      ...getPlan({planRevision: 1, summary}),
      packageCounts: {...getPlan({planRevision: 1, summary}).packageCounts, articles: 10_000, judgments: 40_000},
    }
    await writeArtifacts({analysis: getAnalysis(1), cwd, plan, sessionId: 'commit-session'})
    const fake = getFakeSessionRepository(getSession({planSummaryJson: summary}))
    let backgroundOperation: null | (() => Promise<void>) = null
    let revalidateCount = 0

    const result = await commitProjectTransferImportSession({
      cwd,
      now: new Date('2026-05-28T10:30:00.000Z'),
      repositories: {
        getCommitId: () => {
          return 'commit-generated'
        },
        getOwnerToken: () => {
          return 'owner-generated'
        },
        historyRepository: getNoopHistoryRepository(),
        revalidate: async () => {
          revalidateCount += 1
          return {changed: false, plan, ready: true}
        },
        runAppTableWrites: async () => {
          const completion = {
            finalCounts: {articles: 0, judgments: 0, prompts: 0, reviews: 0, routes: 0, warnings: 0},
            importWarnings: [],
            packageFingerprint: 'fingerprint-commit',
            payloadCounts: plan.packageCounts,
            projectId: 'target-project',
            projectName: 'Target Project',
            status: 'completed' as const,
            targetProjectId: 'target-project',
            targetProjectName: 'Target Project',
            transferHistoryId: 'history-generated',
          }

          return {
            articleIdBySourceId: {},
            completion,
            history: {
              commitId: 'commit-generated',
              completionPayloadJson: completion,
              createdAt: new Date('2026-05-28T10:30:00.000Z'),
              direction: 'import' as const,
              id: 'history-generated',
              packageFingerprint: 'fingerprint-commit',
              payloadCountsJson: plan.packageCounts,
              schemaVersion: 1,
              sessionId: 'commit-session',
              sourceProjectId: 'source-project',
              sourceProjectName: 'Source Project',
              targetProjectId: 'target-project',
              targetProjectName: 'Target Project',
            },
            importWarnings: [],
            projectId: 'target-project',
            projectName: 'Target Project',
            promptIdBySourceId: {},
            routeIdBySourceId: {},
          }
        },
        sessionRepository: fake.repository,
        startBackgroundCommit: (operation) => {
          backgroundOperation = operation
        },
      },
      request: {planRevision: 1},
      sessionId: 'commit-session',
    })

    expect(result).toMatchObject({executionMode: 'background', status: 'claimed', statusCode: 202})
    expect(revalidateCount).toBe(0)
    expect(backgroundOperation).not.toBeNull()
    const claimProgress = JSON.parse(
      await readFile(join(cwd, getProjectTransferImportTempLayout('commit-session').progressPath), 'utf8'),
    ) as {message: string; phase: string; planRevision: number; status: string}

    expect(claimProgress).toMatchObject({
      message: 'Commit revalidation running',
      phase: 'revalidation',
      planRevision: 1,
      status: 'running',
    })

    await backgroundOperation?.()

    expect(revalidateCount).toBe(1)
    expect(fake.getSession()).toMatchObject({ownerToken: null, state: 'completed'})
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('project transfer commit uses background mode for large packages before row thresholds', async () => {
  const cwd = getRuntimeRoot()

  try {
    const summary = getReadySummary()
    const plan = getPlan({planRevision: 1, summary})
    await writeArtifacts({
      analysis: getAnalysis(1, {
        archive: {
          expandedBytes: 1024 * 1024,
          memberCount: 1,
          packageChecksumSha256: 'a'.repeat(64),
          packageSizeBytes: 129 * 1024 * 1024,
        },
      }),
      cwd,
      plan,
      sessionId: 'commit-session',
    })
    const fake = getFakeSessionRepository(getSession({planSummaryJson: summary}))
    let backgroundOperation: null | (() => Promise<void>) = null
    let revalidateCount = 0
    const result = await commitProjectTransferImportSession({
      cwd,
      now: new Date('2026-05-28T10:30:00.000Z'),
      repositories: {
        getCommitId: () => {
          return 'commit-generated'
        },
        getOwnerToken: () => {
          return 'owner-generated'
        },
        historyRepository: getNoopHistoryRepository(),
        revalidate: async () => {
          revalidateCount += 1
          return {changed: false, plan, ready: true}
        },
        runAppTableWrites: async () => {
          throw new Error('unexpected inline writes')
        },
        sessionRepository: fake.repository,
        startBackgroundCommit: (operation) => {
          backgroundOperation = operation
        },
      },
      request: {planRevision: 1},
      sessionId: 'commit-session',
    })

    expect(result).toMatchObject({executionMode: 'background', status: 'claimed', statusCode: 202})
    expect(revalidateCount).toBe(0)
    expect(backgroundOperation).not.toBeNull()
    expect(fake.getSession()).toMatchObject({ownerToken: 'owner-generated', state: 'committing'})
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('project transfer commit id maps keep large insert plans complete', () => {
  const rowCount = 12_000
  const sourceIds = Array.from({length: rowCount}, (_value, index) => {
    return `source-large-${index}`
  })
  const basePlan = getPlan({planRevision: 1})
  const judgmentPlan: NonNullable<ProjectTransferImportPlanArtifact['targetPlan']['judgmentPlan']> = sourceIds.map(
    (sourceId) => {
      return {
        action: 'insert',
        conflictCodes: [],
        inputSignatureMatches: true,
        physicalKey: `physical-${sourceId}`,
        provenanceKind: 'currentReviewRows',
        reviewVisibleKey: `visible-${sourceId}`,
        sourceJudgmentId: `source-judgment-${sourceId}`,
        targetArticleId: `new:article:${sourceId}`,
        targetJudgmentId: `new:judgment:${sourceId}`,
        targetModelId: 'target-model',
        targetPromptId: 'target-prompt',
      }
    },
  )
  const humanReviewPlan: NonNullable<ProjectTransferImportPlanArtifact['targetPlan']['humanReviewPlan']> =
    sourceIds.map((sourceId) => {
      return {
        action: 'insert',
        conflictCodes: [],
        inputSignatureMatches: true,
        kind: 'humanJudgmentSummary',
        provenanceKind: 'currentReviewRows',
        sourceId: `source-human-summary-${sourceId}`,
        targetArticleId: `new:article:${sourceId}`,
        targetPromptId: null,
        uniqueKey: `human-summary-${sourceId}`,
      }
    })
  const plan = {
    ...basePlan,
    packageCounts: {...basePlan.packageCounts, humanJudgmentSummaries: rowCount, judgments: rowCount},
    targetPlan: {...basePlan.targetPlan, humanReviewPlan, judgmentPlan},
  }
  const result = getProjectTransferPlanWithCommitIdMaps({
    commitId: 'commit-large-map',
    now: new Date('2026-05-28T10:30:00.000Z'),
    payloads: {},
    plan,
    promotion: {
      articleCreates: [],
      articleFieldFills: [],
      manifest: {
        createdAt: '2026-05-28T10:30:00.000Z',
        promotions: [],
        sessionId: 'commit-session',
        updatedAt: '2026-05-28T10:30:00.000Z',
      },
      promotionPathByPackagePath: {},
    },
  })
  const judgmentIds = Object.values(result.commitIdMaps.judgmentIdBySourceId)
  const humanSummaryIds = Object.values(result.commitIdMaps.humanJudgmentSummaryIdBySourceId)

  expect(judgmentIds).toHaveLength(rowCount)
  expect(humanSummaryIds).toHaveLength(rowCount)
  expect(result.commitIdMaps.generatedTargetIds.judgment).toHaveLength(rowCount)
  expect(result.commitIdMaps.generatedTargetIds.humanJudgmentSummary).toHaveLength(rowCount)
  expect(new Set(judgmentIds).size).toBe(rowCount)
  expect(new Set(humanSummaryIds).size).toBe(rowCount)
})

test('project transfer commit reopens stale plans before claiming', async () => {
  const cwd = getRuntimeRoot()

  try {
    const summary = getReadySummary()
    const staleSummary = getReadySummary({
      blockerCount: 1,
      blockers: [
        {
          code: 'commit_target_plan_stale',
          message: 'Target changed',
          resolutionKind: 'requires_new_package_or_target_changes',
          scope: 'commit.revalidation',
        },
      ],
    })
    const plan = getPlan({planRevision: 1, summary})
    const stalePlan = getPlan({planRevision: 2, summary: staleSummary})
    const layout = await writeArtifacts({analysis: getAnalysis(1), cwd, plan, sessionId: 'commit-session'})
    const fake = getFakeSessionRepository(getSession({planSummaryJson: summary}))
    const result = await runCommit({
      cwd,
      repository: fake.repository,
      revalidate: async () => {
        return {changed: true, plan: stalePlan, ready: false}
      },
    })
    const writtenPlan = JSON.parse(await readFile(join(cwd, layout.planPath), 'utf8')) as {planRevision: number}

    expect(result.status).toBe('stale')
    expect(fake.getSession()).toMatchObject({
      commitId: null,
      ownerToken: null,
      planRevision: 2,
      state: 'awaiting_resolution',
    })
    expect(fake.calls.transition).toHaveLength(0)
    expect(fake.calls.updatePlan).toHaveLength(1)
    expect(writtenPlan.planRevision).toBe(2)
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('project transfer commit stops running progress when revalidation reopens the plan', async () => {
  const cwd = getRuntimeRoot()

  try {
    const plan = getPlan({planRevision: 1})
    const stalePlan = getPlan({planRevision: 2, summary: getReadySummary({blockerCount: 1})})
    const layout = await writeArtifacts({analysis: getAnalysis(1), cwd, plan, sessionId: 'commit-session'})
    const fake = getFakeSessionRepository(getSession({planSummaryJson: plan.summary}))
    let revalidationCount = 0
    const result = await runCommit({
      cwd,
      repository: fake.repository,
      revalidate: async () => {
        revalidationCount += 1

        return revalidationCount === 1
          ? {changed: false, plan, ready: true}
          : {changed: true, plan: stalePlan, ready: false}
      },
    })
    const progress: unknown = JSON.parse(await readFile(join(cwd, layout.progressPath), 'utf8'))

    expect(result.status).toBe('stale')
    expect(progress).toMatchObject({phase: 'revalidation', planRevision: 2, status: 'completed'})
    expect(fake.getSession()).toMatchObject({ownerToken: null, progressJson: progress, state: 'awaiting_resolution'})
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('project transfer commit does not publish pre-claim stale plans after a lost revision CAS', async () => {
  const cwd = getRuntimeRoot()

  try {
    const summary = getReadySummary()
    const staleSummary = getReadySummary({blockerCount: 1})
    const plan = getPlan({planRevision: 1, summary})
    const stalePlan = getPlan({planRevision: 2, summary: staleSummary})
    const layout = await writeArtifacts({analysis: getAnalysis(1), cwd, plan, sessionId: 'commit-session'})
    const fake = getFakeSessionRepository(getSession({planSummaryJson: summary}))
    const repository: MutableSessionRepository = {
      ...fake.repository,
      updateProjectTransferSessionPlanRevision: async (params) => {
        fake.calls.updatePlan = [...fake.calls.updatePlan, params]

        return null
      },
    }
    const result = await runCommit({
      cwd,
      repository,
      revalidate: async () => {
        return {changed: true, plan: stalePlan, ready: false}
      },
    })
    const writtenPlan = JSON.parse(await readFile(join(cwd, layout.planPath), 'utf8')) as {planRevision: number}

    expect(result).toMatchObject({
      error: 'Project transfer commit could not reopen stale plan',
      status: 'error',
      statusCode: 409,
    })
    expect(fake.calls.updatePlan).toHaveLength(1)
    expect(writtenPlan.planRevision).toBe(1)
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('project transfer commit does not publish post-claim stale plans after a lost reopen CAS', async () => {
  const cwd = getRuntimeRoot()

  try {
    const summary = getReadySummary()
    const staleSummary = getReadySummary({blockerCount: 1})
    const plan = getPlan({planRevision: 1, summary})
    const stalePlan = getPlan({planRevision: 2, summary: staleSummary})
    const layout = await writeArtifacts({analysis: getAnalysis(1), cwd, plan, sessionId: 'commit-session'})
    const fake = getFakeSessionRepository(getSession({planSummaryJson: summary}))
    const repository: MutableSessionRepository = {
      ...fake.repository,
      reopenProjectTransferCommitSession: async (params) => {
        fake.calls.reopen = [...fake.calls.reopen, params]

        return null
      },
    }
    let revalidationCount = 0
    const result = await runCommit({
      cwd,
      repository,
      revalidate: async () => {
        revalidationCount += 1

        return revalidationCount === 1
          ? {changed: false, plan, ready: true}
          : {changed: true, plan: stalePlan, ready: false}
      },
    })
    const writtenPlan = JSON.parse(await readFile(join(cwd, layout.planPath), 'utf8')) as {planRevision: number}

    expect(result).toMatchObject({
      error: 'Project transfer commit could not reopen claimed stale plan',
      status: 'error',
      statusCode: 409,
    })
    expect(hasActiveDuckdbExclusiveWork()).toBe(false)
    expect(fake.calls.reopen).toHaveLength(1)
    expect(writtenPlan.planRevision).toBe(1)
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('project transfer commit marks claimed sessions failed when post-claim revalidation throws', async () => {
  const cwd = getRuntimeRoot()

  try {
    const summary = getReadySummary()
    const plan = getPlan({planRevision: 1, summary})
    await writeArtifacts({analysis: getAnalysis(1), cwd, plan, sessionId: 'commit-session'})
    const fake = getFakeSessionRepository(getSession({planSummaryJson: summary}))
    let revalidationCount = 0
    const result = await runCommit({
      cwd,
      repository: fake.repository,
      revalidate: async () => {
        revalidationCount += 1

        if (revalidationCount === 2) {
          throw new Error('post-claim revalidation failed')
        }

        return {changed: false, plan, ready: true}
      },
    })

    expect(result).toMatchObject({error: 'post-claim revalidation failed', status: 'error', statusCode: 500})
    expect(fake.getSession()).toMatchObject({
      commitId: 'commit-generated',
      errorJson: {message: 'post-claim revalidation failed', name: 'Error'},
      ownerToken: null,
      state: 'failed',
    })
    expect(hasActiveDuckdbExclusiveWork()).toBe(false)
    expect(fake.calls.transition).toHaveLength(4)
    expect(fake.calls.transition[3]).toMatchObject({
      expectedOwnerToken: 'owner-generated',
      nextOwnerToken: null,
      nextState: 'failed',
      progress: {phase: 'commit', status: 'failed'},
    })
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('project transfer background commit marks claimed sessions failed when revalidation throws', async () => {
  const cwd = getRuntimeRoot()

  try {
    const summary = getReadySummary()
    const plan = {
      ...getPlan({planRevision: 1, summary}),
      packageCounts: {...getPlan({planRevision: 1, summary}).packageCounts, articles: 10_000, judgments: 40_000},
    }
    await writeArtifacts({analysis: getAnalysis(1), cwd, plan, sessionId: 'commit-session'})
    const fake = getFakeSessionRepository(getSession({planSummaryJson: summary}))
    let backgroundOperation: null | (() => Promise<void>) = null
    const result = await commitProjectTransferImportSession({
      cwd,
      now: new Date('2026-05-28T10:30:00.000Z'),
      repositories: {
        getCommitId: () => {
          return 'commit-generated'
        },
        getOwnerToken: () => {
          return 'owner-generated'
        },
        historyRepository: getNoopHistoryRepository(),
        revalidate: async () => {
          throw new Error('background revalidation failed')
        },
        runAppTableWrites: async () => {
          throw new Error('unexpected writes')
        },
        sessionRepository: fake.repository,
        startBackgroundCommit: (operation) => {
          backgroundOperation = operation
        },
      },
      request: {planRevision: 1},
      sessionId: 'commit-session',
    })

    expect(result).toMatchObject({executionMode: 'background', status: 'claimed', statusCode: 202})
    expect(backgroundOperation).not.toBeNull()

    await backgroundOperation?.()

    expect(fake.getSession()).toMatchObject({
      commitId: 'commit-generated',
      errorJson: {message: 'background revalidation failed', name: 'Error'},
      ownerToken: null,
      state: 'failed',
    })
    expect(hasActiveDuckdbExclusiveWork()).toBe(false)
    expect(fake.calls.transition).toHaveLength(4)
    expect(fake.calls.transition[3]).toMatchObject({
      expectedOwnerToken: 'owner-generated',
      nextOwnerToken: null,
      nextState: 'failed',
      progress: {phase: 'commit', status: 'failed'},
    })
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

const getBackgroundSizedPlan = (summary: ProjectTransferPlanSummary) => {
  const plan = getPlan({planRevision: 1, summary})

  return {...plan, packageCounts: {...plan.packageCounts, articles: 10_000, judgments: 40_000}}
}

const getExclusiveLeaseState = () => {
  return getActiveDuckdbExclusiveWorkSnapshot()?.admissionState ?? 'no-lease'
}

const getProgressRecordingSessionRepository = (
  repository: NonNullable<MutableSessionRepository>,
  events: string[],
): NonNullable<MutableSessionRepository> => {
  return {
    ...repository,
    transitionProjectTransferSessionState: async (params) => {
      events.push(`progress:${params.progress?.message ?? 'none'}:${getExclusiveLeaseState()}`)

      return repository.transitionProjectTransferSessionState(params)
    },
  }
}

const waitForCondition = async (predicate: () => boolean, remainingAttempts = 2000): Promise<boolean> => {
  if (predicate()) {
    return true
  }

  if (remainingAttempts <= 0) {
    return false
  }

  await new Promise((resolve) => {
    setTimeout(resolve, 5)
  })
  return waitForCondition(predicate, remainingAttempts - 1)
}

const runLeaseOrderCommit = async (executionMode: 'background' | 'inline') => {
  const cwd = getRuntimeRoot()

  try {
    const summary = getReadySummary()
    const plan = executionMode === 'background' ? getBackgroundSizedPlan(summary) : getPlan({planRevision: 1, summary})
    await writeArtifacts({analysis: getAnalysis(1), cwd, plan, sessionId: 'commit-session'})
    const fake = getFakeSessionRepository(getSession({planSummaryJson: summary}))
    const events: string[] = []
    const reclaimedLeaseTokens: string[] = []
    const activeLeaseTokens: string[] = []
    let backgroundOperation = null as null | (() => Promise<void>)
    const result = await runCommit({
      cwd,
      onAppTableWrites: () => {
        events.push(`writes:${getExclusiveLeaseState()}`)
      },
      reclaimRevalidationMemory: async (lease) => {
        events.push(`reclaim:${getExclusiveLeaseState()}`)
        reclaimedLeaseTokens.push(lease.token)
        activeLeaseTokens.push(getActiveDuckdbExclusiveWorkSnapshot()?.token ?? 'missing')
      },
      repository: getProgressRecordingSessionRepository(fake.repository, events),
      revalidate: async () => {
        events.push(`revalidate:${getExclusiveLeaseState()}`)
        return {changed: false, plan, ready: true}
      },
      startBackgroundCommit: (operation) => {
        backgroundOperation = operation
      },
    })

    await backgroundOperation?.()

    return {activeLeaseTokens, events, fake, reclaimedLeaseTokens, result}
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
}

test('project transfer commit holds the exclusive lease from before revalidation through the writes', async () => {
  const leasedSequence = [
    'progress:Commit revalidation running:no-lease',
    'progress:Waiting for DuckDB maintenance work to pause:no-lease',
    'progress:Commit revalidation running:running',
    'revalidate:running',
    'reclaim:running',
    'writes:running',
    'progress:Commit transaction completed:no-lease',
  ]
  const inline = await runLeaseOrderCommit('inline')
  const background = await runLeaseOrderCommit('background')

  expect(inline.result.status).toBe('completed')
  expect(inline.events).toEqual(['revalidate:no-lease', ...leasedSequence])
  expect(inline.reclaimedLeaseTokens).toEqual(inline.activeLeaseTokens)
  expect(background.result).toMatchObject({executionMode: 'background', status: 'claimed'})
  expect(background.events).toEqual(leasedSequence)
  expect(background.fake.getSession()).toMatchObject({ownerToken: null, state: 'completed'})
  expect(background.reclaimedLeaseTokens).toEqual(background.activeLeaseTokens)
  expect(hasActiveDuckdbExclusiveWork()).toBe(false)
})

test('project transfer commit waits for in-flight DuckDB maintenance before revalidating', async () => {
  const cwd = getRuntimeRoot()
  let releaseMaintenance = () => {}
  const maintenanceGate = new Promise<void>((resolve) => {
    releaseMaintenance = resolve
  })
  const maintenance = runMeasuredDuckdbJsonWorkload({
    operation: 'backgroundQuery',
    queue: 'background',
    queueDepthAtStart: 0,
    workloadContext: {
      fallbackIntent: 'async',
      routeOrJobKey: 'reviewServing.projector.worker',
      workloadClass: 'reviewProjector',
    },
    work: async () => {
      await maintenanceGate
      return []
    },
  })

  try {
    const summary = getReadySummary()
    const plan = getPlan({planRevision: 1, summary})
    await writeArtifacts({analysis: getAnalysis(1), cwd, plan, sessionId: 'commit-session'})
    const fake = getFakeSessionRepository(getSession({planSummaryJson: summary}))
    const revalidationLeaseStates: string[] = []
    const commit = runCommit({
      cwd,
      repository: fake.repository,
      revalidate: async () => {
        revalidationLeaseStates.push(getExclusiveLeaseState())
        return {changed: false, plan, ready: true}
      },
    })
    const blocked = await waitForCondition(() => {
      return (getActiveDuckdbExclusiveWorkSnapshot()?.blockedBy.activeMaintenance?.length ?? 0) > 0
    })
    const blockedSnapshot = getActiveDuckdbExclusiveWorkSnapshot()
    const blockedProgress = fake.getSession().progressJson
    const revalidationsWhileBlocked = [...revalidationLeaseStates]

    releaseMaintenance()
    await maintenance

    const result = await commit

    expect(blocked).toBe(true)
    expect(blockedSnapshot).toMatchObject({admissionState: 'draining', phase: 'commit'})
    expect(blockedSnapshot?.blockedBy.activeMaintenance?.[0]).toContain('reviewServing.projector.worker')
    expect(blockedProgress).toMatchObject({message: 'Waiting for DuckDB maintenance work to pause'})
    expect(revalidationsWhileBlocked).toEqual(['no-lease'])
    expect(result.status).toBe('completed')
    expect(revalidationLeaseStates).toEqual(['no-lease', 'running'])
    expect(hasActiveDuckdbExclusiveWork()).toBe(false)
  } finally {
    releaseMaintenance()
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('project transfer commit releases the exclusive lease before reopening a stale plan', async () => {
  const cwd = getRuntimeRoot()

  try {
    const summary = getReadySummary()
    const plan = getBackgroundSizedPlan(summary)
    const stalePlan = getPlan({planRevision: 2, summary: getReadySummary({blockerCount: 1})})
    await writeArtifacts({analysis: getAnalysis(1), cwd, plan, sessionId: 'commit-session'})
    const fake = getFakeSessionRepository(getSession({planSummaryJson: summary}))
    const leaseStatesAtReopen: string[] = []
    const lateSteps: string[] = []
    let backgroundOperation = null as null | (() => Promise<void>)
    const result = await runCommit({
      cwd,
      onAppTableWrites: () => {
        lateSteps.push('writes')
      },
      reclaimRevalidationMemory: async () => {
        lateSteps.push('reclaim')
      },
      repository: {
        ...fake.repository,
        reopenProjectTransferCommitSession: async (params) => {
          leaseStatesAtReopen.push(getExclusiveLeaseState())
          return fake.repository.reopenProjectTransferCommitSession(params)
        },
      },
      revalidate: async () => {
        return {changed: true, plan: stalePlan, ready: false}
      },
      startBackgroundCommit: (operation) => {
        backgroundOperation = operation
      },
    })

    await backgroundOperation?.()

    expect(result).toMatchObject({status: 'claimed'})
    expect(leaseStatesAtReopen).toEqual(['no-lease'])
    expect(lateSteps).toEqual([])
    expect(fake.getSession()).toMatchObject({ownerToken: null, planRevision: 2, state: 'awaiting_resolution'})
    expect(hasActiveDuckdbExclusiveWork()).toBe(false)
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('project transfer commit releases the exclusive lease when writes throw', async () => {
  const cwd = getRuntimeRoot()

  try {
    const summary = getReadySummary()
    const plan = getPlan({planRevision: 1, summary})
    await writeArtifacts({analysis: getAnalysis(1), cwd, plan, sessionId: 'commit-session'})
    const fake = getFakeSessionRepository(getSession({planSummaryJson: summary}))
    const result = await runCommit({
      cwd,
      onAppTableWrites: () => {
        throw new Error('app-table writes failed')
      },
      repository: fake.repository,
      revalidate: async () => {
        return {changed: false, plan, ready: true}
      },
    })

    expect(result).toMatchObject({error: 'app-table writes failed', status: 'error', statusCode: 500})
    expect(fake.getSession()).toMatchObject({errorJson: {message: 'app-table writes failed'}, state: 'failed'})
    expect(hasActiveDuckdbExclusiveWork()).toBe(false)
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

const runTargetStateGuardedCommit = async ({
  cwd,
  refreshSnapshot = false,
  writeBeforeGuard,
}: {
  cwd: string
  refreshSnapshot?: boolean
  writeBeforeGuard: boolean
}) => {
  recordDuckdbTableWriteTrackerOpen('project-transfer-commit-guard-test')

  const summary = getReadySummary()
  const plan = getProjectTransferPlanWithCommitIdMaps({
    commitId: 'previous-attempt',
    now: new Date('2026-10-16T09:00:00.000Z'),
    payloads: {},
    plan: {
      ...getPlan({planRevision: 1, summary}),
      targetState: getTargetStateSnapshot({tableWrites: getCurrentProjectTransferTargetStateTableWrites()}),
    },
    promotion: {
      articleCreates: [],
      articleFieldFills: [],
      manifest: {createdAt: '', promotions: [], sessionId: 'commit-session', updatedAt: ''},
      promotionPathByPackagePath: {},
    },
  })
  const layout = await writeArtifacts({analysis: getAnalysis(1), cwd, plan, sessionId: 'commit-session'})
  const fake = getFakeSessionRepository(getSession({planSummaryJson: summary}))
  const appWrites: string[] = []

  if (refreshSnapshot) {
    finishDuckdbTableWriteTracking(beginDuckdbTableWriteTracking({}, 'UPDATE app.judgment SET id = id'))
  }

  const revalidatedPlan = refreshSnapshot
    ? {...plan, targetState: getTargetStateSnapshot({tableWrites: getCurrentProjectTransferTargetStateTableWrites()})}
    : plan
  const result = await runCommit({
    beforeAppTableWrites: async (input) => {
      if (writeBeforeGuard) {
        finishDuckdbTableWriteTracking(
          beginDuckdbTableWriteTracking({}, "INSERT INTO app.judgment (id) VALUES ('judgment-in-commit-window')"),
        )
      }

      assertProjectTransferCommitTargetStateUnchanged({plan: input.artifacts.plan, sessionId: input.sessionId})
      appWrites.push('written')
    },
    cwd,
    repository: fake.repository,
    revalidate: async () => {
      return {changed: false, plan: revalidatedPlan, ready: true}
    },
  })
  const storedPlanPath = join(cwd, layout.planPath)
  const storedPlan = existsSync(storedPlanPath)
    ? (JSON.parse(await readFile(storedPlanPath, 'utf8')) as ProjectTransferImportPlanArtifact)
    : null

  return {appWrites, fake, plan, result, storedPlan}
}

test('project transfer commit reopens the plan as stale when a tracked table changes before the write transaction', async () => {
  const cwd = getRuntimeRoot()

  try {
    const {appWrites, fake, plan, result, storedPlan} = await runTargetStateGuardedCommit({cwd, writeBeforeGuard: true})

    expect(result).toMatchObject({status: 'stale', statusCode: 200})
    expect(appWrites).toEqual([])
    expect(fake.calls.reopen).toHaveLength(1)
    expect(fake.getSession()).toMatchObject({ownerToken: null, planRevision: 2, state: 'awaiting_resolution'})
    expect(storedPlan?.planRevision).toBe(2)
    expect(storedPlan?.commitIdMaps).toBeUndefined()
    expect(storedPlan?.targetState).toEqual(plan.targetState)
    expect(storedPlan?.stalePlanReasons).toEqual({
      judgment: [{reason: 'target_state_table_write_changed', targetStateSurfaces: ['judgment']}],
    })
    expect(hasActiveDuckdbExclusiveWork()).toBe(false)
  } finally {
    recordDuckdbTableWriteTrackerClose()
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('project transfer commit guards the fresh revalidation snapshot after earlier target writes', async () => {
  const cwd = getRuntimeRoot()

  try {
    const {appWrites, result} = await runTargetStateGuardedCommit({cwd, refreshSnapshot: true, writeBeforeGuard: false})

    expect(result).toMatchObject({status: 'completed', statusCode: 200})
    expect(appWrites).toEqual(['written'])
  } finally {
    recordDuckdbTableWriteTrackerClose()
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('project transfer commit writes when no tracked table changes before the write transaction', async () => {
  const cwd = getRuntimeRoot()

  try {
    const {appWrites, result} = await runTargetStateGuardedCommit({cwd, writeBeforeGuard: false})

    expect(result).toMatchObject({status: 'completed', statusCode: 200})
    expect(appWrites).toEqual(['written'])
  } finally {
    recordDuckdbTableWriteTrackerClose()
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('project transfer commit releases the exclusive lease when ownership is lost inside it', async () => {
  const cwd = getRuntimeRoot()

  try {
    const summary = getReadySummary()
    const plan = getPlan({planRevision: 1, summary})
    await writeArtifacts({analysis: getAnalysis(1), cwd, plan, sessionId: 'commit-session'})
    const fake = getFakeSessionRepository(getSession({planSummaryJson: summary}))
    let revalidationCount = 0
    const result = await runCommit({
      cwd,
      repository: {
        ...fake.repository,
        transitionProjectTransferSessionState: async (params) => {
          return getExclusiveLeaseState() === 'running' && params.nextState === 'committing'
            ? null
            : fake.repository.transitionProjectTransferSessionState(params)
        },
      },
      revalidate: async () => {
        revalidationCount += 1
        return {changed: false, plan, ready: true}
      },
    })

    expect(result).toMatchObject({
      error: 'Project transfer import commit ownership was lost while updating progress',
      status: 'error',
      statusCode: 500,
    })
    expect(revalidationCount).toBe(1)
    expect(hasActiveDuckdbExclusiveWork()).toBe(false)
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('project transfer commit requires one reviewed plan revision alias without conflicts', async () => {
  const cwd = getRuntimeRoot()
  const fake = getFakeSessionRepository(getSession())
  const missingRevision = await commitProjectTransferImportSession({
    cwd,
    repositories: {historyRepository: getNoopHistoryRepository(), sessionRepository: fake.repository},
    request: {},
    sessionId: 'commit-session',
  })
  const conflictingRevision = await commitProjectTransferImportSession({
    cwd,
    repositories: {historyRepository: getNoopHistoryRepository(), sessionRepository: fake.repository},
    request: {expectedPlanRevision: 1, planRevision: 2},
    sessionId: 'commit-session',
  })

  expect(missingRevision).toMatchObject({
    error: 'Project transfer commit requires planRevision',
    status: 'error',
    statusCode: 400,
  })
  expect(conflictingRevision).toMatchObject({
    error: 'Project transfer commit planRevision and expectedPlanRevision conflict',
    status: 'error',
    statusCode: 400,
  })
  expect(fake.calls.transition).toHaveLength(0)
})

test('project transfer commit returns completed session history without replaying writes', async () => {
  const cwd = getRuntimeRoot()
  const fake = getFakeSessionRepository(getSession({completionPayloadJson: null, state: 'completed'}))
  const result = await commitProjectTransferImportSession({
    cwd,
    repositories: {
      historyRepository: {
        getCompletedImportHistoryBySessionId: async () => {
          return {
            commitId: 'commit-completed',
            completionPayloadJson: {
              packageFingerprint: 'fingerprint-commit',
              projectId: 'target-project-1',
              projectName: 'Target Project',
              status: 'completed',
            },
            createdAt: new Date('2026-05-28T10:00:00.000Z'),
            direction: 'import',
            id: 'history-1',
            packageFingerprint: 'fingerprint-commit',
            payloadCountsJson: {project: 1},
            schemaVersion: 1,
            sessionId: 'commit-session',
            sourceProjectId: 'source-project-1',
            sourceProjectName: 'Source Project',
            targetProjectId: 'target-project-1',
            targetProjectName: 'Target Project',
          }
        },
      },
      revalidate: async () => {
        throw new Error('unexpected revalidation')
      },
      sessionRepository: fake.repository,
    },
    request: {planRevision: 1},
    sessionId: 'commit-session',
  })

  expect(result).toMatchObject({
    completion: {projectId: 'target-project-1', status: 'completed'},
    status: 'completed',
    statusCode: 200,
  })
  expect(fake.calls.transition).toHaveLength(0)
})

test('project transfer commit returns history before retrying a failed commit', async () => {
  const cwd = getRuntimeRoot()
  const fake = getFakeSessionRepository(
    getSession({
      commitId: 'commit-previous',
      errorJson: {message: 'Commit failed'},
      progressJson: {
        phase: 'commit',
        planRevision: 1,
        stagingRevision: 1,
        status: 'failed',
        updatedAt: '2026-05-28T10:20:00.000Z',
      },
      state: 'failed',
    }),
  )
  const result = await commitProjectTransferImportSession({
    cwd,
    repositories: {
      historyRepository: {
        getCompletedImportHistoryBySessionId: async () => {
          return {
            commitId: 'commit-previous',
            completionPayloadJson: {
              packageFingerprint: 'fingerprint-commit',
              projectId: 'target-project-history',
              projectName: 'Target Project History',
              status: 'completed',
              transferHistoryId: 'history-failed-retry',
            },
            createdAt: new Date('2026-05-28T10:20:00.000Z'),
            direction: 'import',
            id: 'history-failed-retry',
            packageFingerprint: 'fingerprint-commit',
            payloadCountsJson: {project: 1},
            schemaVersion: 1,
            sessionId: 'commit-session',
            sourceProjectId: 'source-project-1',
            sourceProjectName: 'Source Project',
            targetProjectId: 'target-project-history',
            targetProjectName: 'Target Project History',
          }
        },
      },
      revalidate: async () => {
        throw new Error('unexpected revalidation')
      },
      runAppTableWrites: async () => {
        throw new Error('unexpected writes')
      },
      sessionRepository: fake.repository,
    },
    request: {planRevision: 1},
    sessionId: 'commit-session',
  })

  expect(result).toMatchObject({
    completion: {projectId: 'target-project-history', transferHistoryId: 'history-failed-retry'},
    status: 'completed',
    statusCode: 200,
  })
  expect(fake.calls.transition).toHaveLength(0)
})

test('project transfer commit returns completed import history before expiry handling', async () => {
  const cwd = getRuntimeRoot()
  const fake = getFakeSessionRepository(
    getSession({expiresAt: new Date('2026-05-28T10:00:00.000Z'), state: 'ready_to_commit'}),
  )
  const result = await commitProjectTransferImportSession({
    cwd,
    repositories: {
      historyRepository: {
        getCompletedImportHistoryBySessionId: async () => {
          return {
            commitId: 'commit-history-expired',
            completionPayloadJson: {
              packageFingerprint: 'fingerprint-commit',
              projectId: 'target-project-history',
              projectName: 'Target Project History',
              status: 'completed',
              transferHistoryId: 'history-expired',
            },
            createdAt: new Date('2026-05-28T10:00:00.000Z'),
            direction: 'import',
            id: 'history-expired',
            packageFingerprint: 'fingerprint-commit',
            payloadCountsJson: {project: 1},
            schemaVersion: 1,
            sessionId: 'commit-session',
            sourceProjectId: 'source-project-1',
            sourceProjectName: 'Source Project',
            targetProjectId: 'target-project-history',
            targetProjectName: 'Target Project History',
          }
        },
      },
      revalidate: async () => {
        throw new Error('unexpected revalidation')
      },
      sessionRepository: fake.repository,
    },
    now: new Date('2026-05-28T10:30:00.000Z'),
    request: {planRevision: 1},
    sessionId: 'commit-session',
  })

  expect(result).toMatchObject({
    completion: {projectId: 'target-project-history', transferHistoryId: 'history-expired'},
    status: 'completed',
    statusCode: 200,
  })
  expect(fake.calls.transition).toHaveLength(0)
})

test('project transfer commit writer creates project rows and preserves safe package semantics', () => {
  const result = runCommitWriterScript<{
    articleImportRouteCount: number
    articleRows: Array<{
      articleId: string | null
      articleSummary: string | null
      articleTitle: string
      fullTextPdf: string | null
      id: string
      sourceMetadata: unknown
    }>
    dirtyArticleRows: Array<{articleId: string; firstDirtyToken: number; lastDirtyToken: number; projectId: string}>
    importRunDeltaRows: Array<{articleId: string | null; changeKind: string; importRouteId: string | null}>
    identifierCount: number
    importRouteCount: number
    martCounts: {projectScopeArticleCount: number; reviewServingCount: number}
    materializationRows: Array<{projectId: string; targetDirtyToken: number}>
    projectArticleCount: number
    projectImportRouteCount: number
    projectRow: {
      archived: boolean
      dateFrom: string | null
      dateTo: string | null
      humanJudgmentMode: string | null
      modelId: string
      name: string
      systemPromptVariant: string | null
    }
    promptRow: {
      archived: boolean
      criteriaDisposition: string | null
      criteriaSectionKey: string | null
      enabled: boolean
      originProjectId: string | null
      promptArchived: boolean
      promptId: string
      promptOrder: number | null
    }
    refreshRows: Array<{dirtyToken: number; projectId: string; reason: string | null}>
    reviewChangeDeltaRows: Array<{
      articleId: string | null
      changeKind: string
      projectId: string | null
      sourceTable: string
    }>
    targetProjectId: string
    warningCodes: string[]
  }>(`
    await database.run("INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode) VALUES ('target-provider', 'openai', 'Target Provider', TRUE, 'none')")
    await database.run("INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled) VALUES ('target-model', 'target-provider', 'target-model-name', 'target-remote', 'Target Model', 'manual', TRUE)")
    await database.run("INSERT INTO app.import_route (id, route, name, active) VALUES ('target-route', 'covidence:safe', 'Safe Route', TRUE)")
    const promptHash = computePromptContentHash('Include the study?', null, 'Eligibility', 'system')
    await database.run("INSERT INTO app.prompt (id, original_text, transformed_text, prompt_heading, type, content_hash, archived) VALUES ('archived-prompt', 'Include the study?', NULL, 'Eligibility', 'system', '" + promptHash + "', TRUE)")
    await database.run("INSERT INTO app.article (id, article_title, article_summary, full_text_pdf, source_metadata, article_created_at) VALUES ('reuse-article', 'Existing Reuse Title', NULL, NULL, NULL, TIMESTAMPTZ '2025-06-01T00:00:00.000Z')")
    await database.run("INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images, archived) VALUES ('reuse-active-project', 'Reuse Active Project', 'target-model', TRUE, TRUE, FALSE, FALSE, FALSE)")
    await database.run("INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images, archived) VALUES ('reuse-archived-project', 'Reuse Archived Project', 'target-model', TRUE, TRUE, FALSE, FALSE, TRUE)")
    await database.run("INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images, archived, date_from) VALUES ('reuse-outside-date-project', 'Reuse Outside Date Project', 'target-model', TRUE, TRUE, FALSE, FALSE, FALSE, TIMESTAMPTZ '2026-01-01T00:00:00.000Z')")
    await database.run("INSERT INTO app.project_article (id, project_id, article_id) VALUES ('reuse-active-project-article', 'reuse-active-project', 'reuse-article'), ('reuse-archived-project-article', 'reuse-archived-project', 'reuse-article'), ('reuse-outside-date-project-article', 'reuse-outside-date-project', 'reuse-article')")

    const settings = {
      humanJudgmentMode: 'prompt',
      useAbstract: true,
      useFulltext: false,
      useFulltextNoImages: true,
      useTitle: true,
    }
    const newArticle = {
      articleCreatedAt: '2025-02-03T00:00:00.000Z',
      articleId: 'legacy-new-article',
      articleTitle: 'New Package Article',
      doi: '10.1000/new-package-article',
      fullTextAssets: {figures: ['assets/project-transfer/session-writer/new-figure.png']},
      fullTextFetchedAt: '2025-02-03T00:00:00.000Z',
      fullTextPdf: 'assets/project-transfer/session-writer/new.pdf',
      identifierInputs: [],
      originalData: {package: 'new'},
      provenance: {sourceArticleId: 'source-new'},
      signature: {identifierKeys: ['doi:10.1000/new-package-article'], title: 'New Package Article'},
      sourceArticleId: 'source-new',
      sourceMetadata: {journalTitle: 'Package Journal'},
    }
    const reusedArticle = {
      articleTitle: 'Existing Reuse Title',
      identifierInputs: [],
      provenance: {sourceArticleId: 'source-reuse'},
      signature: {identifierKeys: [], title: 'Existing Reuse Title'},
      sourceArticleId: 'source-reuse',
    }
    const promptPayload = {
      archived: false,
      contentHash: 'package-old-hash',
      originalText: 'Include the study?',
      promptHeading: 'Eligibility',
      provenance: {sourcePromptId: 'source-prompt'},
      signature: {contentHash: promptHash, originalText: 'Include the study?'},
      sourcePromptId: 'source-prompt',
      transformedText: null,
      type: 'system',
    }
    const projectPromptPayload = {
      archived: false,
      criteriaDisposition: 'combined',
      criteriaSectionKey: 'screen',
      criteriaSectionLabel: 'Screening',
      enabled: true,
      order: null,
      provenance: {sourceProjectId: 'source-project', sourcePromptId: 'source-prompt'},
      signature: {criteria: {disposition: 'combined'}, enabled: true, order: null, promptSignature: promptPayload.signature},
      sourceProjectId: 'source-project',
      sourceProjectPromptId: 'source-project-prompt',
      sourcePromptId: 'source-prompt',
    }
    const targetPlan = {
      articleMatches: [
        {
          action: 'create',
          candidates: [],
          conflicts: [],
          identifierKeys: ['doi:10.1000/new-package-article'],
          packageArticleId: 'legacy-new-article',
          selectedTargetArticleId: null,
          sourceArticleId: 'source-new',
        },
        {
          action: 'reuse',
          candidates: [],
          conflicts: [],
          identifierKeys: [],
          packageArticleId: null,
          selectedTargetArticleId: 'reuse-article',
          sourceArticleId: 'source-reuse',
        },
      ],
      articleRoutePlan: [
        {
          action: 'write',
          sourceArticleId: 'source-new',
          sourceArticleImportRouteId: 'source-air-new',
          sourceImportRouteId: 'source-route',
          snapshotProjectArticleLink: false,
          targetArticleId: null,
          targetImportRouteId: 'target-route',
          unsafeProjectIds: [],
        },
        {
          action: 'omit',
          sourceArticleId: 'source-reuse',
          sourceArticleImportRouteId: 'source-air-reuse',
          sourceImportRouteId: 'source-route',
          snapshotProjectArticleLink: true,
          targetArticleId: 'reuse-article',
          targetImportRouteId: 'target-route',
          unsafeProjectIds: ['other-project'],
        },
      ],
      articleUpdatePlan: [
        {
          activeDirtiedProjectIds: [],
          archivedReferencingProjectCount: 0,
          dateExpansionBlockers: [],
          fieldFills: [
            {assetDriven: false, assetPaths: [], field: 'articleSummary', value: 'Filled reuse summary'},
            {assetDriven: true, assetPaths: ['assets/source/reuse.pdf'], field: 'fullTextPdf', value: 'assets/source/reuse.pdf'},
            {assetDriven: false, assetPaths: [], field: 'sourceMetadata', value: {package: 'reuse'}},
          ],
          sourceArticleId: 'source-reuse',
          targetArticleId: 'reuse-article',
        },
      ],
      projectPromptPlan: [
        {
          enabled: true,
          metadata: {
            archived: false,
            criteriaDisposition: 'combined',
            criteriaSectionKey: 'screen',
            criteriaSectionLabel: 'Screening',
          },
          order: null,
          sourceProjectPromptId: 'source-project-prompt',
          sourcePromptId: 'source-prompt',
          targetPromptId: 'archived-prompt',
        },
      ],
      projectRoutePlan: [
        {
          action: 'omit',
          dateBoundedOutsideExportedArticleCount: 1,
          dateBoundedRouteArticleCount: 1,
          outsideExportedArticleCount: 1,
          sourceImportRouteId: 'source-route',
          sourceProjectImportRouteId: 'source-project-route',
          targetImportRouteId: 'target-route',
        },
      ],
      promptPlan: [
        {
          action: 'reuse',
          computedContentHash: promptHash,
          packageContentHash: 'package-old-hash',
          sourcePromptId: 'source-prompt',
          targetPromptId: 'archived-prompt',
        },
      ],
    }
    const writeResult = await writeProjectTransferCommitAppTables({
      commitId: 'commit-writer',
      now,
      payloads: {
        articleImportRoutes: [
          {
            externalArticleId: 'EXT-new',
            importMetadata: {route: true},
            matchMetadata: null,
            provenance: {sourceArticleId: 'source-new', sourceImportRouteId: 'source-route'},
            rawPayload: {raw: true},
            signature: {},
            sourceArticleId: 'source-new',
            sourceArticleImportRouteId: 'source-air-new',
            sourceImportRouteId: 'source-route',
            sourceRecordHash: 'source-record-hash-new',
            sourceRecordKey: 'source-record-key-new',
          },
        ],
        articles: [newArticle, reusedArticle],
        models: [getModelPayload()],
        project: getProjectPayload(settings),
        projectArticles: [
          {
            provenance: {sourceArticleId: 'source-new', sourceProjectId: 'source-project'},
            signature: {},
            sourceArticleId: 'source-new',
            sourceProjectArticleId: 'source-project-article-new',
            sourceProjectId: 'source-project',
          },
        ],
        projectPrompts: [projectPromptPayload],
        prompts: [promptPayload],
      },
      plan: getBasePlan(targetPlan, dependencyResolution),
      promotion: {
        articleCreates: [{article: newArticle, sourceArticleId: 'source-new'}],
        articleFieldFills: [
          {
            field: 'articleSummary',
            sourceArticleId: 'source-reuse',
            targetArticleId: 'reuse-article',
            value: 'Filled reuse summary',
          },
          {
            field: 'fullTextPdf',
            sourceArticleId: 'source-reuse',
            targetArticleId: 'reuse-article',
            value: 'assets/project-transfer/session-writer/reuse.pdf',
          },
          {
            field: 'sourceMetadata',
            sourceArticleId: 'source-reuse',
            targetArticleId: 'reuse-article',
            value: {package: 'reuse'},
          },
        ],
        manifest: {createdAt: now.toISOString(), promotions: [], sessionId: 'session-writer', updatedAt: now.toISOString()},
        promotionPathByPackagePath: {},
      },
      schemaVersion: 1,
      sessionId: 'session-writer',
    })

    const [projectRow] = await database.queryJson("SELECT name, model_id AS modelId, human_judgment_mode AS humanJudgmentMode, system_prompt_variant AS systemPromptVariant, use_fulltext_no_images AS useFulltextNoImages, archived, date_from AS dateFrom, date_to AS dateTo FROM app.project WHERE id = '" + writeResult.projectId + "'")
    const [promptRow] = await database.queryJson("SELECT pp.prompt_id AS promptId, pp.prompt_order AS promptOrder, pp.enabled, pp.archived, pp.origin_project_id AS originProjectId, pp.criteria_disposition AS criteriaDisposition, pp.criteria_section_key AS criteriaSectionKey, p.archived AS promptArchived FROM app.project_prompt pp INNER JOIN app.prompt p ON p.id = pp.prompt_id WHERE pp.project_id = '" + writeResult.projectId + "'")
    const articleRows = await database.queryJson("SELECT id, article_id AS articleId, article_title AS articleTitle, article_summary AS articleSummary, full_text_pdf AS fullTextPdf, TO_JSON(source_metadata) AS sourceMetadata FROM app.article WHERE id IN ('" + writeResult.articleIdBySourceId['source-new'] + "', 'reuse-article') ORDER BY id ASC")
    const [projectArticleCount] = await database.queryJson("SELECT COUNT(*)::INTEGER AS count FROM app.project_article WHERE project_id = '" + writeResult.projectId + "' AND imported_from_project_id IS NULL")
    const [projectImportRouteCount] = await database.queryJson("SELECT COUNT(*)::INTEGER AS count FROM app.project_import_route WHERE project_id = '" + writeResult.projectId + "'")
    const [articleImportRouteCount] = await database.queryJson("SELECT COUNT(*)::INTEGER AS count FROM app.article_import_route WHERE import_route_id = 'target-route'")
    const [importRouteCount] = await database.queryJson("SELECT COUNT(*)::INTEGER AS count FROM app.import_route")
    const [identifierCount] = await database.queryJson("SELECT COUNT(*)::INTEGER AS count FROM app.article_identifier")
    const refreshRows = await database.queryJson("SELECT project_id AS projectId, CAST(dirty_token AS INTEGER) AS dirtyToken, last_request_reason AS reason FROM app.project_mart_refresh_state ORDER BY project_id ASC")
    const dirtyArticleRows = await database.queryJson("SELECT project_id AS projectId, article_id AS articleId, CAST(first_dirty_token AS INTEGER) AS firstDirtyToken, CAST(last_dirty_token AS INTEGER) AS lastDirtyToken FROM app.project_mart_refresh_article_state ORDER BY project_id ASC, article_id ASC")
    const materializationRows = await database.queryJson("SELECT project_id AS projectId, CAST(target_dirty_token AS INTEGER) AS targetDirtyToken FROM app.project_mart_dirty_materialization_state ORDER BY project_id ASC, target_dirty_token ASC")
    const reviewChangeDeltaRows = await database.queryJson("SELECT change_kind AS changeKind, source_table AS sourceTable, project_id AS projectId, article_id AS articleId FROM app.review_change_delta ORDER BY change_kind ASC, source_table ASC, project_id ASC NULLS LAST, article_id ASC NULLS LAST")
    const importRunDeltaRows = await database.queryJson("SELECT change_kind AS changeKind, import_route_id AS importRouteId, article_id AS articleId FROM app.import_run_article_delta ORDER BY change_kind ASC, import_route_id ASC NULLS LAST, article_id ASC NULLS LAST")
    const [martCounts] = await database.queryJson("SELECT (SELECT COUNT(*)::INTEGER FROM mart.project_scope_article) AS projectScopeArticleCount")

    console.log(JSON.stringify({
      articleImportRouteCount: articleImportRouteCount.count,
      articleRows: articleRows.map((row) => ({...row, sourceMetadata: row.sourceMetadata === null ? null : JSON.parse(row.sourceMetadata)})),
      dirtyArticleRows,
      importRunDeltaRows,
      identifierCount: identifierCount.count,
      importRouteCount: importRouteCount.count,
      martCounts,
      materializationRows,
      projectArticleCount: projectArticleCount.count,
      projectImportRouteCount: projectImportRouteCount.count,
      projectRow,
      promptRow,
      refreshRows,
      reviewChangeDeltaRows,
      targetProjectId: writeResult.projectId,
      warningCodes: writeResult.importWarnings.map((warning) => warning.code),
    }))
  `)

  expect(result.projectRow).toMatchObject({
    archived: false,
    humanJudgmentMode: 'prompt',
    modelId: 'target-model',
    name: 'Imported Writer Project',
    systemPromptVariant: null,
  })
  expect(result.promptRow).toMatchObject({
    archived: false,
    criteriaDisposition: 'combined',
    criteriaSectionKey: 'screen',
    enabled: true,
    originProjectId: null,
    promptArchived: false,
    promptId: 'archived-prompt',
    promptOrder: null,
  })
  const newArticleRow = result.articleRows.find((row) => {
    return row.articleId === 'legacy-new-article'
  })
  const reusedArticleRow = result.articleRows.find((row) => {
    return row.id === 'reuse-article'
  })

  expect(newArticleRow).toMatchObject({
    articleId: 'legacy-new-article',
    articleTitle: 'New Package Article',
    fullTextPdf: 'assets/project-transfer/session-writer/new.pdf',
    sourceMetadata: {journalTitle: 'Package Journal'},
  })
  expect(reusedArticleRow).toMatchObject({
    articleSummary: 'Filled reuse summary',
    articleTitle: 'Existing Reuse Title',
    fullTextPdf: 'assets/project-transfer/session-writer/reuse.pdf',
    id: 'reuse-article',
    sourceMetadata: {package: 'reuse'},
  })
  expect(result.projectArticleCount).toBe(2)
  expect(result.projectImportRouteCount).toBe(0)
  expect(result.articleImportRouteCount).toBe(1)
  expect(result.importRouteCount).toBe(1)
  expect(result.identifierCount).toBe(1)
  expect(result.refreshRows).toEqual([])
  expect(result.dirtyArticleRows).toEqual([])
  expect(result.materializationRows).toEqual([])
  expect(
    result.reviewChangeDeltaRows.some((row) => {
      return (
        row.changeKind === 'project.reviewConfig.updated'
        && row.projectId === result.targetProjectId
        && row.sourceTable === 'app.project'
      )
    }),
  ).toBe(true)
  expect(
    result.reviewChangeDeltaRows.some((row) => {
      return (
        row.articleId === (newArticleRow?.id ?? '')
        && row.changeKind === 'projectScope.article.added'
        && row.projectId === result.targetProjectId
        && row.sourceTable === 'app.project_article'
      )
    }),
  ).toBe(true)
  expect(
    result.reviewChangeDeltaRows.some((row) => {
      return (
        row.articleId === 'reuse-article'
        && row.changeKind === 'article.display.updated'
        && row.sourceTable === 'app.article'
      )
    }),
  ).toBe(true)
  expect(
    result.importRunDeltaRows.some((row) => {
      return (
        row.articleId === (newArticleRow?.id ?? '')
        && row.changeKind === 'importRoute.article.added'
        && row.importRouteId === 'target-route'
      )
    }),
  ).toBe(true)
  expect(result.martCounts).toEqual({projectScopeArticleCount: 0})
  expect(result.warningCodes).toContain('targetArticleImportRouteOmitted')
})

test('project transfer import commit V4 route deltas intake into bounded dirty work without legacy fanout', () => {
  const result = runCommitWriterScript<{
    dirtyRows: Array<{
      dirtyKind: string
      latestDeltaId: string | null
      latestSourceHighWaterMark: number
      projectId: string
      projectionComponent: string | null
      sourcePartition: string
      status: string
    }>
    emittedDeltaRows: Array<{
      articleId: string | null
      changeKind: string
      importRouteId: string | null
      reconciled: boolean
      sourceHighWaterMark: number
      sourcePartition: string
    }>
    reconciledDeltaRows: Array<{reconciled: boolean; sourceHighWaterMark: number}>
    intakeResult: {dirtyWorkCount: number; maxSourceHighWaterMark: number | null; status: string}
    legacyCounts: {
      dirtyArticleRows: number
      materializations: number
      refreshRows: number
      rebuildChunks: number
      rebuildRequests: number
    }
    targetProjectId: string
  }>(`
    await database.run("INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode) VALUES ('target-provider', 'openai', 'Target Provider', TRUE, 'none')")
    await database.run("INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled) VALUES ('target-model', 'target-provider', 'target-model-name', 'target-remote', 'Target Model', 'manual', TRUE)")
    await database.run("INSERT INTO app.import_route (id, route, name, active) VALUES ('target-route', 'covidence:v4-delta', 'V4 Delta Route', TRUE)")

    const settings = {humanJudgmentMode: 'prompt', useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true}
    const article = {
      articleId: 'legacy-v4-delta-article',
      articleTitle: 'V4 Delta Article',
      doi: '10.1000/v4-delta',
      identifierInputs: [],
      originalData: {source: 'transfer'},
      provenance: {sourceArticleId: 'source-v4-delta-article'},
      signature: {identifierKeys: ['doi:10.1000/v4-delta'], title: 'V4 Delta Article'},
      sourceArticleId: 'source-v4-delta-article',
      sourceMetadata: {journalTitle: 'Delta Journal'},
    }
    const secondArticle = {
      articleId: 'legacy-v4-delta-article-2',
      articleTitle: 'V4 Delta Article 2',
      doi: '10.1000/v4-delta-2',
      identifierInputs: [],
      originalData: {source: 'transfer-2'},
      provenance: {sourceArticleId: 'source-v4-delta-article-2'},
      signature: {identifierKeys: ['doi:10.1000/v4-delta-2'], title: 'V4 Delta Article 2'},
      sourceArticleId: 'source-v4-delta-article-2',
      sourceMetadata: {journalTitle: 'Delta Journal 2'},
    }
    const articleImportRoute = {
      externalArticleId: 'EXT-v4-delta',
      importMetadata: {route: true},
      matchMetadata: null,
      provenance: {sourceArticleId: 'source-v4-delta-article', sourceImportRouteId: 'source-route'},
      rawPayload: {raw: true},
      signature: {},
      sourceArticleId: 'source-v4-delta-article',
      sourceArticleImportRouteId: 'source-air-v4-delta',
      sourceImportRouteId: 'source-route',
      sourceRecordHash: 'source-record-hash-v4-delta',
      sourceRecordKey: 'source-record-key-v4-delta',
    }
    const secondArticleImportRoute = {
      externalArticleId: 'EXT-v4-delta-2',
      importMetadata: {route: true},
      matchMetadata: null,
      provenance: {sourceArticleId: 'source-v4-delta-article-2', sourceImportRouteId: 'source-route'},
      rawPayload: {raw: true},
      signature: {},
      sourceArticleId: 'source-v4-delta-article-2',
      sourceArticleImportRouteId: 'source-air-v4-delta-2',
      sourceImportRouteId: 'source-route',
      sourceRecordHash: 'source-record-hash-v4-delta-2',
      sourceRecordKey: 'source-record-key-v4-delta-2',
    }
    const projectArticle = {
      provenance: {sourceArticleId: 'source-v4-delta-article', sourceProjectId: 'source-project'},
      signature: {},
      sourceArticleId: 'source-v4-delta-article',
      sourceProjectArticleId: 'source-project-article-v4-delta',
      sourceProjectId: 'source-project',
    }
    const secondProjectArticle = {
      provenance: {sourceArticleId: 'source-v4-delta-article-2', sourceProjectId: 'source-project'},
      signature: {},
      sourceArticleId: 'source-v4-delta-article-2',
      sourceProjectArticleId: 'source-project-article-v4-delta-2',
      sourceProjectId: 'source-project',
    }
    const targetPlan = {
      articleMatches: [
        {
          action: 'create',
          candidates: [],
          conflicts: [],
          identifierKeys: ['doi:10.1000/v4-delta'],
          packageArticleId: 'legacy-v4-delta-article',
          selectedTargetArticleId: null,
          sourceArticleId: 'source-v4-delta-article',
        },
        {
          action: 'create',
          candidates: [],
          conflicts: [],
          identifierKeys: ['doi:10.1000/v4-delta-2'],
          packageArticleId: 'legacy-v4-delta-article-2',
          selectedTargetArticleId: null,
          sourceArticleId: 'source-v4-delta-article-2',
        },
      ],
      articleRoutePlan: [
        {
          action: 'write',
          sourceArticleId: 'source-v4-delta-article',
          sourceArticleImportRouteId: 'source-air-v4-delta',
          sourceImportRouteId: 'source-route',
          snapshotProjectArticleLink: false,
          targetArticleId: null,
          targetImportRouteId: 'target-route',
          unsafeProjectIds: [],
        },
        {
          action: 'write',
          sourceArticleId: 'source-v4-delta-article-2',
          sourceArticleImportRouteId: 'source-air-v4-delta-2',
          sourceImportRouteId: 'source-route',
          snapshotProjectArticleLink: false,
          targetArticleId: null,
          targetImportRouteId: 'target-route',
          unsafeProjectIds: [],
        },
      ],
      projectRoutePlan: [
        {
          action: 'link',
          dateBoundedOutsideExportedArticleCount: 0,
          dateBoundedRouteArticleCount: 1,
          outsideExportedArticleCount: 0,
          sourceImportRouteId: 'source-route',
          sourceProjectImportRouteId: 'source-project-route-v4-delta',
          targetImportRouteId: 'target-route',
        },
      ],
    }
    const writeResult = await writeProjectTransferCommitAppTables({
      commitId: 'commit-v4-delta-intake',
      now,
      payloads: {
        articleImportRoutes: [articleImportRoute, secondArticleImportRoute],
        articles: [article, secondArticle],
        models: [getModelPayload()],
        project: getProjectPayload(settings),
        projectArticles: [projectArticle, secondProjectArticle],
      },
      plan: getBasePlan(targetPlan, dependencyResolution),
      promotion: {
        articleCreates: [
          {article, sourceArticleId: 'source-v4-delta-article'},
          {article: secondArticle, sourceArticleId: 'source-v4-delta-article-2'},
        ],
        articleFieldFills: [],
        manifest: {createdAt: now.toISOString(), promotions: [], sessionId: 'session-v4-delta-intake', updatedAt: now.toISOString()},
        promotionPathByPackagePath: {},
      },
      schemaVersion: 1,
      sessionId: 'session-v4-delta-intake',
    })
    const emittedDeltaRows = await database.queryJson("SELECT change_kind AS changeKind, import_route_id AS importRouteId, article_id AS articleId, source_partition AS sourcePartition, CAST(source_high_water_mark AS INTEGER) AS sourceHighWaterMark, reconciled_at IS NOT NULL AS reconciled FROM app.import_run_article_delta ORDER BY source_high_water_mark ASC")
    const intakeResult = await intakeReviewImportDeltasToDirtyWork({
      endSourceHighWaterMark: 2,
      limit: 1,
      sourcePartition: 'import-route:target-route',
      startSourceHighWaterMark: 1,
    }, database)
    const dirtyRows = await database.queryJson("SELECT project_id AS projectId, dirty_kind AS dirtyKind, source_partition AS sourcePartition, CAST(latest_source_high_water_mark AS INTEGER) AS latestSourceHighWaterMark, latest_delta_id AS latestDeltaId, json_extract_string(projection_key, '$.projectionComponent') AS projectionComponent, status FROM app.review_serving_dirty_work ORDER BY projectionComponent ASC")
    const reconciledDeltaRows = await database.queryJson("SELECT CAST(source_high_water_mark AS INTEGER) AS sourceHighWaterMark, reconciled_at IS NOT NULL AS reconciled FROM app.import_run_article_delta ORDER BY source_high_water_mark ASC")
    const [legacyCounts] = await database.queryJson("SELECT (SELECT COUNT(*)::INTEGER FROM app.project_mart_refresh_state) AS refreshRows, (SELECT COUNT(*)::INTEGER FROM app.project_mart_refresh_article_state) AS dirtyArticleRows, (SELECT COUNT(*)::INTEGER FROM app.project_mart_dirty_materialization_state) AS materializations, (SELECT COUNT(*)::INTEGER FROM app.review_rebuild_request) AS rebuildRequests, (SELECT COUNT(*)::INTEGER FROM app.review_rebuild_chunk_manifest) AS rebuildChunks")

    console.log(JSON.stringify({
      dirtyRows,
      emittedDeltaRows: emittedDeltaRows.map((row) => ({...row, reconciled: Boolean(row.reconciled)})),
      intakeResult,
      legacyCounts,
      reconciledDeltaRows: reconciledDeltaRows.map((row) => ({...row, reconciled: Boolean(row.reconciled)})),
      targetProjectId: writeResult.projectId,
    }))
  `)

  expect(result.emittedDeltaRows).toHaveLength(2)
  expect(result.emittedDeltaRows).toMatchObject([
    {
      changeKind: 'importRoute.article.added',
      importRouteId: 'target-route',
      reconciled: false,
      sourceHighWaterMark: 1,
      sourcePartition: 'import-route:target-route',
    },
    {
      changeKind: 'importRoute.article.added',
      importRouteId: 'target-route',
      reconciled: false,
      sourceHighWaterMark: 2,
      sourcePartition: 'import-route:target-route',
    },
  ])
  expect(result.emittedDeltaRows[0]?.articleId).toBeTruthy()
  expect(result.emittedDeltaRows[1]?.articleId).toBeTruthy()
  expect(result.reconciledDeltaRows).toEqual([
    {reconciled: true, sourceHighWaterMark: 1},
    {reconciled: false, sourceHighWaterMark: 2},
  ])
  expect(result.intakeResult).toEqual({dirtyWorkCount: 9, maxSourceHighWaterMark: 1, status: 'converted'})
  expect(result.dirtyRows).toHaveLength(9)
  expect(
    result.dirtyRows.every((row) => {
      return (
        row.dirtyKind === 'importRoute.article.added'
        && row.latestSourceHighWaterMark === 1
        && row.projectId === result.targetProjectId
        && row.sourcePartition === 'import-route:target-route'
        && row.status === 'pending'
      )
    }),
  ).toBe(true)
  expect(
    result.dirtyRows.map((row) => {
      return row.projectionComponent
    }),
  ).toEqual([
    'humanStatus',
    'llmStatus',
    'payload',
    'posting',
    'projectScope',
    'queue',
    'search',
    'selectedImport',
    'summary',
  ])
  expect(result.legacyCounts).toEqual({
    dirtyArticleRows: 0,
    materializations: 0,
    refreshRows: 0,
    rebuildChunks: 0,
    rebuildRequests: 0,
  })
})

test('project transfer commit writer consumes same-connection operation tables for set-based article writes', () => {
  const result = runCommitWriterScript<{
    articleImportRouteRow: {articleId: string; sourceRecordKey: string}
    createdArticle: {articleId: string | null; articleSummary: string | null; articleTitle: string}
    hotFieldRow: {conflictFlag: boolean | null; duplicateFlag: boolean | null}
    identifierRows: Array<{articleId: string; normalizedValue: string}>
    projectArticleCount: number
    projectImportRouteCount: number
    reusedArticle: {articleSummary: string | null}
    targetArticleId: string
  }>(`
    await database.run("INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode) VALUES ('target-provider', 'openai', 'Target Provider', TRUE, 'none')")
    await database.run("INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled) VALUES ('target-model', 'target-provider', 'target-model-name', 'target-remote', 'Target Model', 'manual', TRUE)")
    await database.run("INSERT INTO app.import_route (id, route, name, active) VALUES ('target-route', 'covidence:set-based', 'Set Based Route', TRUE)")
    await database.run("INSERT INTO app.article (id, article_title, article_summary) VALUES ('reuse-set-based-article', 'Reuse Set Based Article', NULL)")

    const escapeSql = (value) => String(value).replaceAll("'", "''")
    const jsonLiteral = (value) => "CAST('" + escapeSql(JSON.stringify(value)) + "' AS JSON)"
    const operationDatabase = (tx) => ({
      queryJson: tx.queryJson,
      run: tx.run,
      transaction: (work) => Promise.resolve(work(tx)),
    })
    const createOperationPayloadTable = (tx, tableName, rows) => {
      return tx.run(\`
        CREATE TEMP TABLE \${tableName} AS
        SELECT
          row_number() OVER () - 1 AS row_index,
          row_json AS payload_json
        FROM UNNEST(json_extract(\${jsonLiteral(rows)}, '$[*]')) AS rows(row_json)
      \`)
    }
    const settings = {humanJudgmentMode: 'prompt', useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true}
    const newArticle = {
      articleId: 'legacy-set-based-new',
      articleTitle: 'Set Based New Article',
      doi: '10.1000/set-based-new',
      identifierInputs: [],
      provenance: {sourceArticleId: 'source-set-based-new'},
      signature: {identifierKeys: ['doi:10.1000/set-based-new'], title: 'Set Based New Article'},
      sourceArticleId: 'source-set-based-new',
    }
    const reusedArticle = {
      articleTitle: 'Reuse Set Based Article',
      identifierInputs: [],
      provenance: {sourceArticleId: 'source-set-based-reuse'},
      signature: {identifierKeys: [], title: 'Reuse Set Based Article'},
      sourceArticleId: 'source-set-based-reuse',
    }
    const payloadArticleRoute = {
      externalArticleId: 'EXT-memory',
      importMetadata: {route: 'memory'},
      matchMetadata: null,
      provenance: {sourceArticleId: 'source-set-based-new', sourceImportRouteId: 'source-route'},
      rawPayload: {raw: 'memory'},
      signature: {},
      sourceArticleId: 'source-set-based-new',
      sourceArticleImportRouteId: 'source-air-set-based',
      sourceImportRouteId: 'source-route',
      sourceRecordHash: 'memory-hash',
      sourceRecordKey: 'memory-key',
    }
    const stagedArticleRoute = {
      ...payloadArticleRoute,
      externalArticleId: 'EXT-staged',
      importMetadata: {route: 'staged', covidence: {hasDuplicateStudyRecords: true, hasStudyDecisionConflict: true}},
      rawPayload: {raw: 'staged'},
      sourceRecordHash: 'staged-hash',
      sourceRecordKey: 'staged-key',
    }
    const projectArticle = {
      provenance: {sourceArticleId: 'source-set-based-new', sourceProjectId: 'source-project'},
      signature: {},
      sourceArticleId: 'source-set-based-new',
      sourceProjectArticleId: 'source-project-article-set-based',
      sourceProjectId: 'source-project',
    }
    const targetPlan = {
      articleMatches: [
        {
          action: 'create',
          candidates: [],
          conflicts: [],
          identifierKeys: ['doi:10.1000/set-based-new'],
          packageArticleId: 'legacy-set-based-new',
          selectedTargetArticleId: null,
          sourceArticleId: 'source-set-based-new',
        },
        {
          action: 'reuse',
          candidates: [],
          conflicts: [],
          identifierKeys: [],
          packageArticleId: null,
          selectedTargetArticleId: 'reuse-set-based-article',
          sourceArticleId: 'source-set-based-reuse',
        },
      ],
      articleRoutePlan: [
        {
          action: 'write',
          sourceArticleId: 'source-set-based-new',
          sourceArticleImportRouteId: 'source-air-set-based',
          sourceImportRouteId: 'source-route',
          snapshotProjectArticleLink: false,
          targetArticleId: null,
          targetImportRouteId: 'target-route',
          unsafeProjectIds: [],
        },
      ],
      articleUpdatePlan: [
        {
          activeDirtiedProjectIds: [],
          archivedReferencingProjectCount: 0,
          dateExpansionBlockers: [],
          fieldFills: [{assetDriven: false, assetPaths: [], field: 'articleSummary', value: 'Set based filled summary'}],
          sourceArticleId: 'source-set-based-reuse',
          targetArticleId: 'reuse-set-based-article',
        },
      ],
      projectRoutePlan: [
        {
          action: 'link',
          dateBoundedOutsideExportedArticleCount: 0,
          dateBoundedRouteArticleCount: 1,
          outsideExportedArticleCount: 0,
          sourceImportRouteId: 'source-route',
          sourceProjectImportRouteId: 'source-project-route-set-based',
          targetImportRouteId: 'target-route',
        },
      ],
    }
    const payloads = {
      articleImportRoutes: [payloadArticleRoute],
      articles: [newArticle, reusedArticle],
      models: [getModelPayload()],
      project: getProjectPayload(settings),
      projectArticles: [projectArticle],
    }
    const promotion = {
      articleCreates: [{article: newArticle, sourceArticleId: 'source-set-based-new'}],
      articleFieldFills: [
        {
          field: 'articleSummary',
          sourceArticleId: 'source-set-based-reuse',
          targetArticleId: 'reuse-set-based-article',
          value: 'Set based filled summary',
        },
      ],
      manifest: {createdAt: now.toISOString(), promotions: [], sessionId: 'session-set-based-writer', updatedAt: now.toISOString()},
      promotionPathByPackagePath: {},
    }
    const operationTables = getProjectTransferOperationTableNames('commit_set_based_writer')
    const writeResult = await database.transaction(async (tx) => {
      await createOperationPayloadTable(tx, operationTables.tableNames.articles, [newArticle, reusedArticle])
      await createOperationPayloadTable(tx, operationTables.tableNames.articleImportRoutes, [stagedArticleRoute])
      await createOperationPayloadTable(tx, operationTables.tableNames.judgments, [])
      await createOperationPayloadTable(tx, operationTables.tableNames.projectArticles, [projectArticle])

      return writeProjectTransferCommitAppTables({
        commitId: 'commit-set-based-writer',
        database: operationDatabase(tx),
        now,
        operationTables,
        payloads,
        plan: getBasePlan(targetPlan, dependencyResolution),
        promotion,
        schemaVersion: 1,
        sessionId: 'session-set-based-writer',
      })
    })
    const targetArticleId = writeResult.articleIdBySourceId['source-set-based-new']
    const [createdArticle] = await database.queryJson("SELECT article_id AS articleId, article_title AS articleTitle, article_summary AS articleSummary FROM app.article WHERE id = '" + targetArticleId + "'")
    const [reusedArticleRow] = await database.queryJson("SELECT article_summary AS articleSummary FROM app.article WHERE id = 'reuse-set-based-article'")
    const [articleImportRouteRow] = await database.queryJson("SELECT article_id AS articleId, source_record_key AS sourceRecordKey FROM app.article_import_route WHERE import_route_id = 'target-route'")
    const [hotFieldRow] = await database.queryJson("SELECT conflict_flag AS conflictFlag, duplicate_flag AS duplicateFlag FROM app.review_import_article_hot_field WHERE import_route_id = 'target-route'")
    const [projectArticleCount] = await database.queryJson("SELECT COUNT(*)::INTEGER AS count FROM app.project_article WHERE project_id = '" + writeResult.projectId + "'")
    const [projectImportRouteCount] = await database.queryJson("SELECT COUNT(*)::INTEGER AS count FROM app.project_import_route WHERE project_id = '" + writeResult.projectId + "'")
    const identifierRows = await database.queryJson("SELECT article_id AS articleId, normalized_value AS normalizedValue FROM app.article_identifier ORDER BY normalized_value ASC")

    console.log(JSON.stringify({
      articleImportRouteRow,
      createdArticle,
      hotFieldRow,
      identifierRows,
      projectArticleCount: projectArticleCount.count,
      projectImportRouteCount: projectImportRouteCount.count,
      reusedArticle: reusedArticleRow,
      targetArticleId,
    }))
  `)

  expect(result.createdArticle).toEqual({
    articleId: 'legacy-set-based-new',
    articleSummary: null,
    articleTitle: 'Set Based New Article',
  })
  expect(result.reusedArticle.articleSummary).toBe('Set based filled summary')
  expect(result.articleImportRouteRow).toEqual({articleId: result.targetArticleId, sourceRecordKey: 'staged-key'})
  expect(result.hotFieldRow).toEqual({conflictFlag: true, duplicateFlag: true})
  expect(result.projectArticleCount).toBe(1)
  expect(result.projectImportRouteCount).toBe(1)
  expect(result.identifierRows).toEqual([{articleId: result.targetArticleId, normalizedValue: '10.1000/set-based-new'}])
})

test('project transfer commit writer materializes imported provider and model dependencies', () => {
  const result = runCommitWriterScript<{
    commitMaps: {modelId: string | null; projectId: string | null; providerConnectionId: string | null}
    modelRow: {
      displayName: string | null
      enabled: boolean
      importedSourceModelId: string | null
      importedSourceProviderConnectionId: string | null
      snapshotContextLimit: number | null
      snapshotModelOptionThinking: string | null
      snapshotPromptTokenLimit: number | null
      providerConnectionId: string
      remoteModelId: string | null
      variant: string | null
    }
    projectRow: {modelId: string}
    providerRow: {
      authMode: string | null
      enabled: boolean
      id: string
      importedSourceProviderConnectionId: string | null
      label: string
      providerKind: string
      secretRef: string | null
      snapshotProviderKind: string | null
      snapshotWorkerUrlMode: string | null
    }
  }>(`
    const settings = {humanJudgmentMode: 'prompt', useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true}
    const importedDependencyResolution = {
      modelTargetBySourceId: {'source-model': 'new:model:source-model'},
      providerTargetBySourceId: {'source-provider': 'new:provider:source-provider'},
    }
    const writeResult = await writeProjectTransferCommitAppTables({
      commitId: 'commit-materialized-provider-model',
      now,
      payloads: {
        models: [getModelPayload()],
        project: getProjectPayload(settings),
        providerConnections: [
          {
            authMode: 'apiKey',
            baseURL: null,
            configJson: {archived: false, disabledModelIds: [], manualWorkerUrls: [], workerUrlMode: 'manual'},
            enabled: false,
            label: 'Imported Provider',
            maxInflightRequests: 4,
            providerKind: 'openai',
            secretRef: 'secret:should-not-import',
            sourceProviderConnectionId: 'source-provider',
          },
        ],
      },
      plan: getBasePlan({}, importedDependencyResolution),
      promotion: {
        articleCreates: [],
        articleFieldFills: [],
        manifest: {createdAt: now.toISOString(), promotions: [], sessionId: 'session-materialized-provider-model', updatedAt: now.toISOString()},
        promotionPathByPackagePath: {},
      },
      schemaVersion: 1,
      sessionId: 'session-materialized-provider-model',
    })
    const [projectRow] = await database.queryJson("SELECT model_id AS modelId FROM app.project WHERE id = '" + writeResult.projectId + "'")
    const [modelRow] = await database.queryJson("SELECT provider_connection_id AS providerConnectionId, display_name AS displayName, remote_model_id AS remoteModelId, variant, COALESCE(enabled, TRUE) AS enabled, json_extract_string(metadata_json, '$.projectTransferImportedSnapshot.sourceModelId') AS importedSourceModelId, json_extract_string(metadata_json, '$.projectTransferImportedSnapshot.sourceProviderConnectionId') AS importedSourceProviderConnectionId, json_extract(metadata_json, '$.projectTransferImportedSnapshot.snapshotFingerprint.model.contextLimit')::INTEGER AS snapshotContextLimit, json_extract(metadata_json, '$.projectTransferImportedSnapshot.snapshotFingerprint.model.promptTokenLimit')::INTEGER AS snapshotPromptTokenLimit, json_extract_string(metadata_json, '$.projectTransferImportedSnapshot.snapshotFingerprint.model.modelOptions.thinking') AS snapshotModelOptionThinking FROM app.model WHERE id = '" + projectRow.modelId + "'")
    const [providerRow] = await database.queryJson("SELECT id, provider_kind AS providerKind, label, enabled, auth_mode AS authMode, secret_ref AS secretRef, json_extract_string(config_json, '$.projectTransferImportedSnapshot.sourceProviderConnectionId') AS importedSourceProviderConnectionId, json_extract_string(config_json, '$.projectTransferImportedSnapshot.snapshotFingerprint.providerKind') AS snapshotProviderKind, json_extract_string(config_json, '$.projectTransferImportedSnapshot.snapshotFingerprint.runtimeMode.workerUrlMode') AS snapshotWorkerUrlMode FROM app.provider_connection WHERE id = '" + modelRow.providerConnectionId + "'")

    console.log(JSON.stringify({
      commitMaps: {
        modelId: writeResult.commitIdMaps.modelIdBySourceId['source-model'],
        projectId: writeResult.commitIdMaps.projectIdBySourceId['source-project'],
        providerConnectionId: writeResult.commitIdMaps.providerConnectionIdBySourceId['source-provider'],
      },
      modelRow,
      projectRow,
      providerRow,
    }))
  `)

  expect(result.projectRow.modelId).toBeTruthy()
  expect(result.providerRow).toMatchObject({
    authMode: 'apiKey',
    enabled: false,
    label: 'Imported Provider',
    providerKind: 'openai',
    secretRef: null,
  })
  expect(result.providerRow.importedSourceProviderConnectionId).toBe('source-provider')
  expect(result.providerRow.snapshotProviderKind).toBe('openai')
  expect(result.providerRow.snapshotWorkerUrlMode).toBe('manual')
  expect(result.modelRow).toMatchObject({
    displayName: null,
    enabled: false,
    importedSourceModelId: 'source-model',
    importedSourceProviderConnectionId: 'source-provider',
    remoteModelId: 'target-remote',
    variant: null,
  })
  expect(result.modelRow.snapshotContextLimit).toBe(32768)
  expect(result.modelRow.snapshotModelOptionThinking).toBe(null)
  expect(result.modelRow.snapshotPromptTokenLimit).toBe(28768)
  expect(result.modelRow.providerConnectionId).toBe(result.providerRow.id)
  expect(result.commitMaps.modelId).toBe(result.projectRow.modelId)
  expect(result.commitMaps.providerConnectionId).toBe(result.providerRow.id)
  expect(result.commitMaps.projectId).toBeTruthy()
})

test('project transfer commit writer reuses imported provider and model snapshots by marker and fingerprint', () => {
  const result = runCommitWriterScript<{
    secondCommitMaps: {modelId: string | null; providerConnectionId: string | null}
    modelCount: number
    modelEnabledValues: boolean[]
    modelIds: string[]
    projectModelIds: string[]
    providerCount: number
    providerEnabledValues: boolean[]
    providerIds: string[]
  }>(`
    const settings = {humanJudgmentMode: 'prompt', useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true}
    const importedDependencyResolution = {
      modelTargetBySourceId: {'source-model': 'new:model:source-model'},
      providerTargetBySourceId: {'source-provider': 'new:provider:source-provider'},
    }
    const payloads = {
      models: [getModelPayload()],
      project: getProjectPayload(settings),
      providerConnections: [
        {
          authMode: 'apiKey',
          baseURL: null,
          configJson: {archived: false, disabledModelIds: [], manualWorkerUrls: [], workerUrlMode: 'manual'},
          enabled: true,
          label: 'Imported Provider',
          maxInflightRequests: 4,
          providerKind: 'openai',
          secretRef: 'secret:should-not-import',
          sourceProviderConnectionId: 'source-provider',
        },
      ],
    }
    const promotion = {
      articleCreates: [],
      articleFieldFills: [],
      manifest: {createdAt: now.toISOString(), promotions: [], sessionId: 'session-reused-provider-model', updatedAt: now.toISOString()},
      promotionPathByPackagePath: {},
    }
    const firstWrite = await writeProjectTransferCommitAppTables({
      commitId: 'commit-reused-provider-model-1',
      now,
      payloads,
      plan: getBasePlan({}, importedDependencyResolution),
      promotion,
      schemaVersion: 1,
      sessionId: 'session-reused-provider-model-1',
    })
    await database.run("UPDATE app.provider_connection SET enabled = TRUE WHERE json_extract_string(config_json, '$.projectTransferImportedSnapshot.sourceProviderConnectionId') = 'source-provider'")
    await database.run("UPDATE app.model SET enabled = TRUE WHERE json_extract_string(metadata_json, '$.projectTransferImportedSnapshot.sourceModelId') = 'source-model'")
    const secondWrite = await writeProjectTransferCommitAppTables({
      commitId: 'commit-reused-provider-model-2',
      now,
      payloads,
      plan: getBasePlan({}, importedDependencyResolution),
      promotion,
      schemaVersion: 1,
      sessionId: 'session-reused-provider-model-2',
    })
    const providerRows = await database.queryJson("SELECT id, enabled FROM app.provider_connection WHERE json_extract_string(config_json, '$.projectTransferImportedSnapshot.sourceProviderConnectionId') = 'source-provider' ORDER BY id ASC")
    const modelRows = await database.queryJson("SELECT id, COALESCE(enabled, TRUE) AS enabled FROM app.model WHERE json_extract_string(metadata_json, '$.projectTransferImportedSnapshot.sourceModelId') = 'source-model' ORDER BY id ASC")
    const projectRows = await database.queryJson("SELECT id, model_id AS modelId FROM app.project WHERE id IN ('" + firstWrite.projectId + "', '" + secondWrite.projectId + "') ORDER BY id ASC")

    console.log(JSON.stringify({
      modelCount: modelRows.length,
      modelEnabledValues: modelRows.map((row) => row.enabled),
      modelIds: modelRows.map((row) => row.id),
      projectModelIds: projectRows.map((row) => row.modelId),
      providerCount: providerRows.length,
      providerEnabledValues: providerRows.map((row) => row.enabled),
      providerIds: providerRows.map((row) => row.id),
      secondCommitMaps: {
        modelId: secondWrite.commitIdMaps.modelIdBySourceId['source-model'],
        providerConnectionId: secondWrite.commitIdMaps.providerConnectionIdBySourceId['source-provider'],
      },
    }))
  `)

  expect(result.providerCount).toBe(1)
  expect(result.modelCount).toBe(1)
  expect(result.providerEnabledValues).toEqual([false])
  expect(result.modelEnabledValues).toEqual([false])
  expect(result.projectModelIds).toEqual([result.modelIds[0], result.modelIds[0]])
  expect(result.secondCommitMaps.modelId).toBe(result.modelIds[0])
  expect(result.secondCommitMaps.providerConnectionId).toBe(result.providerIds[0])
})

test('project transfer commit writer preserves imported model variant and version separately in snapshot marker', () => {
  const result = runCommitWriterScript<{
    modelRow: {markerVersion: string | null; markerVariant: string | null; variant: string | null}
  }>(`
    const settings = {humanJudgmentMode: 'prompt', useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true}
    const importedDependencyResolution = {
      modelTargetBySourceId: {'source-model': 'new:model:source-model'},
      providerTargetBySourceId: {'source-provider': 'new:provider:source-provider'},
    }
    const writeResult = await writeProjectTransferCommitAppTables({
      commitId: 'commit-versioned-provider-model',
      now,
      payloads: {
        models: [{...getModelPayload(), variant: 'reasoning', version: '2026-06-01'}],
        project: getProjectPayload(settings),
        providerConnections: [
          {
            authMode: 'apiKey',
            baseURL: null,
            configJson: {archived: false, disabledModelIds: [], manualWorkerUrls: [], workerUrlMode: 'manual'},
            enabled: false,
            label: 'Imported Provider',
            maxInflightRequests: 4,
            providerKind: 'openai',
            secretRef: 'secret:should-not-import',
            sourceProviderConnectionId: 'source-provider',
          },
        ],
      },
      plan: getBasePlan({}, importedDependencyResolution),
      promotion: {
        articleCreates: [],
        articleFieldFills: [],
        manifest: {createdAt: now.toISOString(), promotions: [], sessionId: 'session-versioned-provider-model', updatedAt: now.toISOString()},
        promotionPathByPackagePath: {},
      },
      schemaVersion: 1,
      sessionId: 'session-versioned-provider-model',
    })
    const [projectRow] = await database.queryJson("SELECT model_id AS modelId FROM app.project WHERE id = '" + writeResult.projectId + "'")
    const [modelRow] = await database.queryJson("SELECT variant, json_extract_string(metadata_json, '$.projectTransferImportedSnapshot.snapshotFingerprint.model.variant') AS markerVariant, json_extract_string(metadata_json, '$.projectTransferImportedSnapshot.snapshotFingerprint.model.version') AS markerVersion FROM app.model WHERE id = '" + projectRow.modelId + "'")

    console.log(JSON.stringify({modelRow}))
  `)

  expect(result.modelRow.variant).toBe('reasoning')
  expect(result.modelRow.markerVariant).toBe('reasoning')
  expect(result.modelRow.markerVersion).toBe('2026-06-01')
})

test('project transfer commit writer keeps the system prompt variant from the package settings', () => {
  const result = runCommitWriterScript<{projectRow: {systemPromptVariant: string | null; useMetadata: boolean}}>(`
    const settings = {
      humanJudgmentMode: 'summary',
      systemPromptVariant: 'screening_v1',
      useAbstract: true,
      useFulltext: false,
      useFulltextNoImages: false,
      useTitle: true,
    }
    const importedDependencyResolution = {
      modelTargetBySourceId: {'source-model': 'new:model:source-model'},
      providerTargetBySourceId: {'source-provider': 'new:provider:source-provider'},
    }
    const writeResult = await writeProjectTransferCommitAppTables({
      commitId: 'commit-system-prompt-variant',
      now,
      payloads: {
        models: [getModelPayload()],
        project: getProjectPayload(settings),
        providerConnections: [
          {
            authMode: 'apiKey',
            baseURL: null,
            configJson: {archived: false, disabledModelIds: [], manualWorkerUrls: [], workerUrlMode: 'manual'},
            enabled: false,
            label: 'Imported Provider',
            maxInflightRequests: 4,
            providerKind: 'openai',
            secretRef: null,
            sourceProviderConnectionId: 'source-provider',
          },
        ],
      },
      plan: getBasePlan({}, importedDependencyResolution),
      promotion: {
        articleCreates: [],
        articleFieldFills: [],
        manifest: {createdAt: now.toISOString(), promotions: [], sessionId: 'session-system-prompt-variant', updatedAt: now.toISOString()},
        promotionPathByPackagePath: {},
      },
      schemaVersion: 1,
      sessionId: 'session-system-prompt-variant',
    })
    const [projectRow] = await database.queryJson("SELECT system_prompt_variant AS systemPromptVariant, use_metadata AS useMetadata FROM app.project WHERE id = '" + writeResult.projectId + "'")

    console.log(JSON.stringify({projectRow}))
  `)

  expect(result.projectRow).toEqual({systemPromptVariant: 'screening_v1', useMetadata: false})
})

test('project transfer commit writer blocks commit when a reused imported model fingerprint drifts', () => {
  const result = runCommitWriterScript<{
    errorMessage: string | null
    modelCount: number
    projectCount: number
    providerCount: number
  }>(`
    const settings = {humanJudgmentMode: 'prompt', useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true}
    const importedDependencyResolution = {
      modelTargetBySourceId: {'source-model': 'new:model:source-model'},
      providerTargetBySourceId: {'source-provider': 'new:provider:source-provider'},
    }
    const payloads = {
      models: [getModelPayload()],
      project: getProjectPayload(settings),
      providerConnections: [
        {
          authMode: 'apiKey',
          baseURL: null,
          configJson: {archived: false, disabledModelIds: [], manualWorkerUrls: [], workerUrlMode: 'manual'},
          enabled: true,
          label: 'Imported Provider',
          maxInflightRequests: 4,
          providerKind: 'openai',
          secretRef: 'secret:should-not-import',
          sourceProviderConnectionId: 'source-provider',
        },
      ],
    }
    const promotion = {
      articleCreates: [],
      articleFieldFills: [],
      manifest: {createdAt: now.toISOString(), promotions: [], sessionId: 'session-drifted-provider-model', updatedAt: now.toISOString()},
      promotionPathByPackagePath: {},
    }
    const firstWrite = await writeProjectTransferCommitAppTables({
      commitId: 'commit-drifted-provider-model-1',
      now,
      payloads,
      plan: getBasePlan({}, importedDependencyResolution),
      promotion,
      schemaVersion: 1,
      sessionId: 'session-drifted-provider-model-1',
    })
    const [driftedModel] = await database.queryJson("SELECT id FROM app.model WHERE json_extract_string(metadata_json, '$.projectTransferImportedSnapshot.sourceModelId') = 'source-model' ORDER BY id ASC LIMIT 1")
    await database.run(\`UPDATE app.model SET metadata_json = json_merge_patch(COALESCE(metadata_json, CAST('{}' AS JSON)), CAST('{"options":{"thinking":"high"}}' AS JSON)) WHERE id = '\${driftedModel.id}'\`)
    const errorMessage = await catchMessage(() => {
      return writeProjectTransferCommitAppTables({
        commitId: 'commit-drifted-provider-model-2',
        now,
        payloads,
        plan: getBasePlan({}, importedDependencyResolution),
        promotion,
        schemaVersion: 1,
        sessionId: 'session-drifted-provider-model-2',
      })
    })
    const [providerCount] = await database.queryJson("SELECT COUNT(*)::INTEGER AS count FROM app.provider_connection WHERE json_extract_string(config_json, '$.projectTransferImportedSnapshot.sourceProviderConnectionId') = 'source-provider'")
    const [modelCount] = await database.queryJson("SELECT COUNT(*)::INTEGER AS count FROM app.model WHERE json_extract_string(metadata_json, '$.projectTransferImportedSnapshot.sourceModelId') = 'source-model'")
    const [projectCount] = await database.queryJson("SELECT COUNT(*)::INTEGER AS count FROM app.project WHERE name = 'Imported Writer Project'")

    console.log(JSON.stringify({
      errorMessage,
      modelCount: modelCount.count,
      projectCount: projectCount.count,
      providerCount: providerCount.count,
    }))
  `)

  expect(result.errorMessage).toContain(
    'imported model snapshot source-model no longer matches its materialized target; rerun import analysis before commit',
  )
  expect(result.providerCount).toBe(1)
  expect(result.modelCount).toBe(1)
  expect(result.projectCount).toBe(1)
})

test('project transfer dependency resolution and commit writer make the same snapshot reuse decisions', () => {
  const result = runCommitWriterScript<{
    outcomes: {
      key: string
      resolverModelTarget: string | null
      resolverProviderTarget: string | null
      snapshotModelId: string
      snapshotProviderId: string
      writerModelTarget: string | null
      writerProviderTarget: string | null
    }[]
  }>(`
    const {revalidateProjectTransferResolvedDependencies} = await import('./src/server/services/projectTransfer/projectTransferDependencyResolution.ts')
    const settings = {humanJudgmentMode: 'prompt', useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true}
    const fixtures = [
      {key: 'normalized-config', model: {metadataJson: {options: {thinking: 'medium'}}}, provider: {configJson: {workerUrlMode: 'manual'}, providerKind: 'openai'}},
      {key: 'raw-config', model: {}, provider: {configJson: {}, providerKind: 'openai'}},
      {key: 'runtime-default', model: {metadataJson: {discovery: {identity: {modelName: 'other-discovered-name'}}}}, provider: {authMode: null, baseURL: 'http://127.0.0.1:30000/v1', configJson: null, providerKind: 'sglang'}},
      {key: 'manual-name', model: {displayName: 'Local Llama 8B', modelName: 'llama-3.1-8b-instruct', name: 'Local Llama 8B', remoteModelId: 'llama-3.1-8b-instruct', source: 'manual'}, provider: {configJson: {}, providerKind: 'vllm'}},
      {key: 'null-remote', model: {modelName: 'Local Llama', name: 'Local Llama', remoteModelId: null}, provider: {configJson: {}, providerKind: 'openai'}},
      {key: 'blank-variant', model: {variant: '', version: ' '}, provider: {configJson: {}, providerKind: 'openai'}},
      {key: 'variant-version', model: {variant: 'reasoning', version: '2026-06-01'}, provider: {configJson: {}, providerKind: 'openai'}},
      {driftWorkerUrlMode: 'manual', key: 'drifted-provider', model: {}, provider: {configJson: {}, providerKind: 'sglang'}},
    ]
    const getFixtureIds = (fixture) => ({
      sourceModelId: 'source-model-' + fixture.key,
      sourceProviderConnectionId: 'source-provider-' + fixture.key,
    })
    const getFixturePayloads = (fixture) => {
      const {sourceModelId, sourceProviderConnectionId} = getFixtureIds(fixture)

      return {
        models: [{...getModelPayload(), provenance: {sourceModelId, sourceProviderConnectionId}, sourceModelId, sourceProviderConnectionId, ...fixture.model}],
        project: getProjectPayload(settings),
        providerConnections: [{authMode: 'apiKey', baseURL: null, enabled: true, label: 'Parity Provider', maxInflightRequests: 4, secretRef: null, sourceProviderConnectionId, ...fixture.provider}],
      }
    }
    const getPlaceholderResolution = (fixture) => {
      const {sourceModelId, sourceProviderConnectionId} = getFixtureIds(fixture)

      return {
        modelTargetBySourceId: {[sourceModelId]: 'new:model:' + sourceModelId},
        providerTargetBySourceId: {[sourceProviderConnectionId]: 'new:provider:' + sourceProviderConnectionId},
      }
    }
    const write = (commitId, fixture) => {
      return writeProjectTransferCommitAppTables({
        commitId,
        now,
        payloads: getFixturePayloads(fixture),
        plan: getBasePlan({}, getPlaceholderResolution(fixture)),
        promotion: {
          articleCreates: [],
          articleFieldFills: [],
          manifest: {createdAt: now.toISOString(), promotions: [], sessionId: commitId, updatedAt: now.toISOString()},
          promotionPathByPackagePath: {},
        },
        schemaVersion: 1,
        sessionId: commitId,
      })
    }
    const outcomes = []

    for (const fixture of fixtures) {
      const {sourceModelId, sourceProviderConnectionId} = getFixtureIds(fixture)
      const firstWrite = await write('commit-parity-first-' + fixture.key, fixture)
      const snapshotProviderId = firstWrite.commitIdMaps.providerConnectionIdBySourceId[sourceProviderConnectionId]
      const snapshotModelId = firstWrite.commitIdMaps.modelIdBySourceId[sourceModelId]

      if (fixture.driftWorkerUrlMode) {
        await database.run("UPDATE app.provider_connection SET config_json = json_merge_patch(config_json, CAST('" + JSON.stringify({workerUrlMode: fixture.driftWorkerUrlMode}) + "' AS JSON)) WHERE id = '" + snapshotProviderId + "'")
      }

      const resolverResult = await revalidateProjectTransferResolvedDependencies({
        nextPlanRevision: 2,
        payloads: {...getFixturePayloads(fixture), judgments: []},
        plan: getBasePlan({}, {}),
        repositories: {analyzeTargetRunner: database, listProviderConnections: async () => []},
        request: {autoResolve: true, planRevision: 1},
      })

      if (resolverResult.status !== 'ok') {
        throw new Error(resolverResult.error)
      }

      const secondWrite = await write('commit-parity-second-' + fixture.key, fixture)

      outcomes.push({
        key: fixture.key,
        resolverModelTarget: resolverResult.plan.dependencyResolution.modelTargetBySourceId[sourceModelId] ?? null,
        resolverProviderTarget: resolverResult.plan.dependencyResolution.providerTargetBySourceId[sourceProviderConnectionId] ?? null,
        snapshotModelId,
        snapshotProviderId,
        writerModelTarget: secondWrite.commitIdMaps.modelIdBySourceId[sourceModelId] ?? null,
        writerProviderTarget: secondWrite.commitIdMaps.providerConnectionIdBySourceId[sourceProviderConnectionId] ?? null,
      })
    }

    console.log(JSON.stringify({outcomes}))
  `)
  const decisions = result.outcomes.map((outcome) => {
    return {
      key: outcome.key,
      resolver: {
        model: outcome.resolverModelTarget === outcome.snapshotModelId,
        provider: outcome.resolverProviderTarget === outcome.snapshotProviderId,
      },
      writer: {
        model: outcome.writerModelTarget === outcome.snapshotModelId,
        provider: outcome.writerProviderTarget === outcome.snapshotProviderId,
      },
    }
  })
  const reused = {model: true, provider: true}
  const notReused = {model: false, provider: false}

  expect(decisions).toEqual([
    {key: 'normalized-config', resolver: reused, writer: reused},
    {key: 'raw-config', resolver: reused, writer: reused},
    {key: 'runtime-default', resolver: reused, writer: reused},
    {key: 'manual-name', resolver: reused, writer: reused},
    {key: 'null-remote', resolver: reused, writer: reused},
    {key: 'blank-variant', resolver: reused, writer: reused},
    {key: 'variant-version', resolver: reused, writer: reused},
    {key: 'drifted-provider', resolver: notReused, writer: notReused},
  ])
  expect(
    result.outcomes
      .filter((outcome) => {
        return outcome.key === 'drifted-provider'
      })
      .map((outcome) => {
        return [outcome.resolverProviderTarget, outcome.resolverModelTarget]
      }),
  ).toEqual([['new:provider:source-provider-drifted-provider', 'new:model:source-model-drifted-provider']])
})

test('project transfer commit writer rejects placeholder plans that would reuse an earlier import snapshot', () => {
  const result = runCommitWriterScript<{
    firstJudgmentId: string
    judgmentCount: number
    modelGuardError: string | null
    modelSnapshotCount: number
    physicalKeyError: string | null
    projectCount: number
    providerGuardError: string | null
    providerSnapshotCount: number
    snapshotModelId: string
    snapshotProviderId: string
  }>(`
    const promptHash = computePromptContentHash('Snapshot prompt?', null, 'Snapshot', 'system')
    await database.run("INSERT INTO app.prompt (id, original_text, transformed_text, prompt_heading, type, content_hash, archived) VALUES ('target-snapshot-prompt', 'Snapshot prompt?', NULL, 'Snapshot', 'system', '" + promptHash + "', FALSE)")
    await database.run("INSERT INTO app.article (id, article_title) VALUES ('target-snapshot-article', 'Snapshot Article')")
    const settings = {humanJudgmentMode: 'prompt', useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true}
    const getTargetPlan = (targetModelId) => ({
      articleMatches: [
        {
          action: 'reuse',
          candidates: [],
          conflicts: [],
          identifierKeys: [],
          packageArticleId: null,
          selectedTargetArticleId: 'target-snapshot-article',
          sourceArticleId: 'source-snapshot-article',
        },
      ],
      judgmentPlan: [
        {
          action: 'insert',
          conflictCodes: [],
          inputSignatureMatches: true,
          physicalKey: 'snapshot-physical',
          provenanceKind: 'currentReviewRows',
          reviewVisibleKey: 'snapshot-visible',
          sourceJudgmentId: 'source-snapshot-judgment',
          targetArticleId: 'target-snapshot-article',
          targetJudgmentId: 'new:judgment:source-snapshot-judgment',
          targetModelId,
          targetPromptId: 'target-snapshot-prompt',
        },
      ],
      projectPromptPlan: [
        {
          enabled: true,
          metadata: {archived: false},
          order: 0,
          sourceProjectPromptId: 'source-snapshot-project-prompt',
          sourcePromptId: 'source-snapshot-prompt',
          targetPromptId: 'target-snapshot-prompt',
        },
      ],
      promptPlan: [
        {
          action: 'reuse',
          computedContentHash: promptHash,
          packageContentHash: promptHash,
          sourcePromptId: 'source-snapshot-prompt',
          targetPromptId: 'target-snapshot-prompt',
        },
      ],
    })
    const payloads = {
      articles: [
        {
          articleTitle: 'Snapshot Article',
          identifierInputs: [],
          provenance: {sourceArticleId: 'source-snapshot-article'},
          signature: {identifierKeys: [], title: 'Snapshot Article'},
          sourceArticleId: 'source-snapshot-article',
        },
      ],
      judgments: [
        {
          answeredOriginal: 'include',
          answeredOriginalAsArray: ['include'],
          confidenceOriginal: 80,
          contentSettings: settings,
          deleteGeneration: 0,
          explanation: 'Imported explanation',
          isAnswered: true,
          judgmentInputSignature: {},
          judgmentInputSignatureProvenance: {kind: 'currentReviewRows', version: 1},
          provenance: {sourceArticleId: 'source-snapshot-article', sourceModelId: 'source-model', sourcePromptId: 'source-snapshot-prompt'},
          quotes: [],
          signature: {},
          sourceArticleId: 'source-snapshot-article',
          sourceJudgmentId: 'source-snapshot-judgment',
          sourceModelId: 'source-model',
          sourcePromptId: 'source-snapshot-prompt',
        },
      ],
      models: [getModelPayload()],
      project: getProjectPayload(settings),
      projectPrompts: [
        {
          archived: false,
          enabled: true,
          order: 0,
          provenance: {sourceProjectId: 'source-project', sourcePromptId: 'source-snapshot-prompt'},
          signature: {},
          sourceProjectId: 'source-project',
          sourceProjectPromptId: 'source-snapshot-project-prompt',
          sourcePromptId: 'source-snapshot-prompt',
        },
      ],
      prompts: [
        {
          archived: false,
          contentHash: promptHash,
          originalText: 'Snapshot prompt?',
          promptHeading: 'Snapshot',
          provenance: {sourcePromptId: 'source-snapshot-prompt'},
          signature: {},
          sourcePromptId: 'source-snapshot-prompt',
          transformedText: null,
          type: 'system',
        },
      ],
      providerConnections: [
        {
          authMode: 'apiKey',
          baseURL: null,
          configJson: {},
          enabled: true,
          label: 'Imported Provider',
          maxInflightRequests: 4,
          providerKind: 'openai',
          secretRef: null,
          sourceProviderConnectionId: 'source-provider',
        },
      ],
    }
    const placeholderResolution = {
      modelTargetBySourceId: {'source-model': 'new:model:source-model'},
      providerTargetBySourceId: {'source-provider': 'new:provider:source-provider'},
    }
    const write = (commitId, plan) => {
      return writeProjectTransferCommitAppTables({
        commitId,
        now,
        payloads,
        plan,
        promotion: {
          articleCreates: [],
          articleFieldFills: [],
          manifest: {createdAt: now.toISOString(), promotions: [], sessionId: commitId, updatedAt: now.toISOString()},
          promotionPathByPackagePath: {},
        },
        schemaVersion: 1,
        sessionId: commitId,
      })
    }
    const firstWrite = await write('commit-snapshot-guard-1', getBasePlan(getTargetPlan('new:model:source-model'), placeholderResolution))
    const snapshotProviderId = firstWrite.commitIdMaps.providerConnectionIdBySourceId['source-provider']
    const snapshotModelId = firstWrite.commitIdMaps.modelIdBySourceId['source-model']
    const providerGuardError = await catchMessage(() => {
      return write('commit-snapshot-guard-2', getBasePlan(getTargetPlan('new:model:source-model'), placeholderResolution))
    })
    const modelGuardError = await catchMessage(() => {
      return write(
        'commit-snapshot-guard-3',
        getBasePlan(getTargetPlan('new:model:source-model'), {
          modelTargetBySourceId: {'source-model': 'new:model:source-model'},
          providerTargetBySourceId: {'source-provider': snapshotProviderId},
        }),
      )
    })
    const physicalKeyError = await catchMessage(() => {
      return write(
        'commit-snapshot-guard-4',
        getBasePlan(getTargetPlan(snapshotModelId), {
          modelTargetBySourceId: {'source-model': snapshotModelId},
          providerTargetBySourceId: {'source-provider': snapshotProviderId},
        }),
      )
    })
    const [judgmentCount] = await database.queryJson("SELECT COUNT(*)::INTEGER AS count FROM app.judgment WHERE article_id = 'target-snapshot-article'")
    const [projectCount] = await database.queryJson("SELECT COUNT(*)::INTEGER AS count FROM app.project WHERE name = 'Imported Writer Project'")
    const [providerSnapshotCount] = await database.queryJson("SELECT COUNT(*)::INTEGER AS count FROM app.provider_connection WHERE json_extract_string(config_json, '$.projectTransferImportedSnapshot.sourceProviderConnectionId') = 'source-provider'")
    const [modelSnapshotCount] = await database.queryJson("SELECT COUNT(*)::INTEGER AS count FROM app.model WHERE json_extract_string(metadata_json, '$.projectTransferImportedSnapshot.sourceModelId') = 'source-model'")

    console.log(JSON.stringify({
      firstJudgmentId: firstWrite.commitIdMaps.judgmentIdBySourceId['source-snapshot-judgment'],
      judgmentCount: judgmentCount.count,
      modelGuardError,
      modelSnapshotCount: modelSnapshotCount.count,
      physicalKeyError,
      projectCount: projectCount.count,
      providerGuardError,
      providerSnapshotCount: providerSnapshotCount.count,
      snapshotModelId,
      snapshotProviderId,
    }))
  `)

  expect(result.providerGuardError).toBe(
    `Project transfer commit writer: import plan would create a new provider connection for package provider "Imported Provider" (source-provider), but existing provider snapshot ${result.snapshotProviderId} already matches it, most likely created by an earlier import of this package; 1 planned judgment was checked against new models instead of that snapshot's models and could duplicate judgments already stored there. Rerun the import analysis before committing.`,
  )
  expect(result.modelGuardError).toBe(
    `Project transfer commit writer: import plan would create a new model for package model "target-model-name" (source-model), but existing model snapshot ${result.snapshotModelId} on provider connection ${result.snapshotProviderId} already matches it, most likely created by an earlier import of this package; 1 planned judgment was checked against a new model instead of it and could duplicate judgments already stored for it. Rerun the import analysis before committing.`,
  )
  expect(result.physicalKeyError).toBe(
    `Project transfer commit writer: target judgment physical key already exists for source-snapshot-judgment: existing judgment ${result.firstJudgmentId} has the same article target-snapshot-article (existing row reused by this import), prompt target-snapshot-prompt (existing row reused by this import), model ${result.snapshotModelId} (existing row reused by this import for package model source-model), content flags, system prompt variant and delete generation, but the import analysis planned to insert a new judgment (the target changed after the analysis, or the analysis mapped a different article, prompt or model). Rerun the import analysis; if it repeats, map the package's provider and model to existing ones in the dependencies step.`,
  )
  expect(result.judgmentCount).toBe(1)
  expect(result.projectCount).toBe(1)
  expect(result.providerSnapshotCount).toBe(1)
  expect(result.modelSnapshotCount).toBe(1)
})

test('project transfer commit writer blocks target article_id conflicts before insert', () => {
  const result = runCommitWriterScript<{articleCount: number; errorMessage: string | null; projectCount: number}>(`
    await database.run("INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode) VALUES ('target-provider', 'openai', 'Target Provider', TRUE, 'none')")
    await database.run("INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled) VALUES ('target-model', 'target-provider', 'target-model-name', 'target-remote', 'Target Model', 'manual', TRUE)")
    await database.run("INSERT INTO app.article (id, article_id, article_title) VALUES ('existing-conflict', 'legacy-conflict', 'Existing Conflict')")
    const settings = {humanJudgmentMode: null, useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true}
    const article = {
      articleId: 'legacy-conflict',
      articleTitle: 'Package Conflict',
      identifierInputs: [],
      provenance: {sourceArticleId: 'source-conflict'},
      signature: {identifierKeys: [], title: 'Package Conflict'},
      sourceArticleId: 'source-conflict',
    }
    const targetPlan = {
      articleMatches: [
        {
          action: 'create',
          candidates: [],
          conflicts: [],
          identifierKeys: [],
          packageArticleId: 'legacy-conflict',
          selectedTargetArticleId: null,
          sourceArticleId: 'source-conflict',
        },
      ],
    }
    const errorMessage = await catchMessage(() => {
      return writeProjectTransferCommitAppTables({
        commitId: 'commit-article-id-conflict',
        now,
        payloads: {
          articles: [article],
          models: [getModelPayload()],
          project: getProjectPayload(settings),
        },
        plan: getBasePlan(targetPlan, dependencyResolution),
        promotion: {
          articleCreates: [{article, sourceArticleId: 'source-conflict'}],
          articleFieldFills: [],
          manifest: {createdAt: now.toISOString(), promotions: [], sessionId: 'session-article-id-conflict', updatedAt: now.toISOString()},
          promotionPathByPackagePath: {},
        },
        schemaVersion: 1,
        sessionId: 'session-article-id-conflict',
      })
    })
    const [projectCount] = await database.queryJson("SELECT COUNT(*)::INTEGER AS count FROM app.project WHERE name = 'Imported Writer Project'")
    const [articleCount] = await database.queryJson("SELECT COUNT(*)::INTEGER AS count FROM app.article WHERE article_id = 'legacy-conflict'")

    console.log(JSON.stringify({articleCount: articleCount.count, errorMessage, projectCount: projectCount.count}))
  `)

  expect(result.errorMessage).toContain('target article_id already exists: legacy-conflict')
  expect(result.projectCount).toBe(0)
  expect(result.articleCount).toBe(1)
})

test('project transfer commit writer blocks generated target id collisions before project writes', () => {
  const result = runCommitWriterScript<{errorMessage: string | null; projectCount: number}>(`
    await database.run("INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode) VALUES ('target-provider', 'openai', 'Target Provider', TRUE, 'none')")
    await database.run("INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled) VALUES ('target-model', 'target-provider', 'target-model-name', 'target-remote', 'Target Model', 'manual', TRUE)")
    await database.run("INSERT INTO app.project (id, name, model_id, archived) VALUES ('existing-project-id', 'Existing Project', 'target-model', FALSE)")
    const settings = {humanJudgmentMode: 'prompt', useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true}
    const payloads = {models: [getModelPayload()], project: getProjectPayload(settings)}
    const promotion = {
      articleCreates: [],
      articleFieldFills: [],
      manifest: {createdAt: now.toISOString(), promotions: [], sessionId: 'session-id-collision', updatedAt: now.toISOString()},
      promotionPathByPackagePath: {},
    }
    const planWithMaps = getProjectTransferPlanWithCommitIdMaps({
      commitId: 'commit-id-collision',
      now,
      payloads,
      plan: getBasePlan({}, dependencyResolution),
      promotion,
    })
    const collisionPlan = {
      ...planWithMaps,
      commitIdMaps: {
        ...planWithMaps.commitIdMaps,
        generatedTargetIds: {...planWithMaps.commitIdMaps.generatedTargetIds, project: ['existing-project-id']},
        projectIdBySourceId: {'source-project': 'existing-project-id'},
      },
    }
    const errorMessage = await catchMessage(() => {
      return writeProjectTransferCommitAppTables({
        commitId: 'commit-id-collision',
        now,
        payloads,
        plan: collisionPlan,
        promotion,
        schemaVersion: 1,
        sessionId: 'session-id-collision',
      })
    })
    const [projectCount] = await database.queryJson("SELECT COUNT(*)::INTEGER AS count FROM app.project WHERE name = 'Imported Writer Project'")

    console.log(JSON.stringify({errorMessage, projectCount: projectCount.count}))
  `)

  expect(result.errorMessage).toContain('generated project target id already exists: existing-project-id')
  expect(result.projectCount).toBe(0)
})

test('project transfer commit writer aborts article identifier races after insert conflicts', () => {
  const result = runCommitWriterScript<{errorMessage: string | null; newArticleCount: number; projectCount: number}>(`
    await database.run("INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode) VALUES ('target-provider', 'openai', 'Target Provider', TRUE, 'none')")
    await database.run("INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled) VALUES ('target-model', 'target-provider', 'target-model-name', 'target-remote', 'Target Model', 'manual', TRUE)")
    await database.run("INSERT INTO app.article (id, article_id, article_title) VALUES ('existing-identifier-article', 'legacy-existing-identifier', 'Existing Identifier')")
    await database.run("INSERT INTO app.article_identifier (id, article_id, kind, normalized_value, source, is_primary, created_at, updated_at) VALUES ('existing-identifier', 'existing-identifier-article', 'doi', '10.1000/identifier-race', 'article_identifier', TRUE, TIMESTAMPTZ '2026-01-01T00:00:00Z', TIMESTAMPTZ '2026-01-02T00:00:00Z')")
    const settings = {humanJudgmentMode: null, useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true}
    const article = {
      articleId: 'legacy-new-identifier-race',
      articleTitle: 'Package Identifier Race',
      doi: '10.1000/identifier-race',
      identifierInputs: [],
      provenance: {sourceArticleId: 'source-identifier-race'},
      signature: {identifierKeys: ['doi:10.1000/identifier-race'], title: 'Package Identifier Race'},
      sourceArticleId: 'source-identifier-race',
    }
    const targetPlan = {
      articleMatches: [
        {
          action: 'create',
          candidates: [],
          conflicts: [],
          identifierKeys: ['doi:10.1000/identifier-race'],
          packageArticleId: 'legacy-new-identifier-race',
          selectedTargetArticleId: null,
          sourceArticleId: 'source-identifier-race',
        },
      ],
    }
    const errorMessage = await catchMessage(() => {
      return writeProjectTransferCommitAppTables({
        commitId: 'commit-identifier-race',
        now,
        payloads: {
          articles: [article],
          models: [getModelPayload()],
          project: getProjectPayload(settings),
        },
        plan: getBasePlan(targetPlan, dependencyResolution),
        promotion: {
          articleCreates: [{article, sourceArticleId: 'source-identifier-race'}],
          articleFieldFills: [],
          manifest: {createdAt: now.toISOString(), promotions: [], sessionId: 'session-identifier-race', updatedAt: now.toISOString()},
          promotionPathByPackagePath: {},
        },
        schemaVersion: 1,
        sessionId: 'session-identifier-race',
      })
    })
    const [projectCount] = await database.queryJson("SELECT COUNT(*)::INTEGER AS count FROM app.project WHERE name = 'Imported Writer Project'")
    const [newArticleCount] = await database.queryJson("SELECT COUNT(*)::INTEGER AS count FROM app.article WHERE article_id = 'legacy-new-identifier-race'")

    console.log(JSON.stringify({errorMessage, newArticleCount: newArticleCount.count, projectCount: projectCount.count}))
  `)

  expect(result.errorMessage).toContain(
    'article identifier doi:10.1000/identifier-race for source-identifier-race is no longer available',
  )
  expect(result.projectCount).toBe(0)
  expect(result.newArticleCount).toBe(0)
})

test('project transfer commit writer validates set-based article identifier conflicts against target articles', () => {
  const result = runCommitWriterScript<{errorMessage: string | null; newArticleCount: number; projectCount: number}>(`
    await database.run("INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode) VALUES ('target-provider', 'openai', 'Target Provider', TRUE, 'none')")
    await database.run("INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled) VALUES ('target-model', 'target-provider', 'target-model-name', 'target-remote', 'Target Model', 'manual', TRUE)")
    await database.run("INSERT INTO app.article (id, article_id, article_title) VALUES ('existing-set-based-identifier-article', 'legacy-existing-set-based-identifier', 'Existing Set Based Identifier')")
    await database.run("INSERT INTO app.article_identifier (id, article_id, kind, normalized_value, source, is_primary, created_at, updated_at) VALUES ('existing-set-based-identifier', 'existing-set-based-identifier-article', 'doi', '10.1000/set-based-identifier-race', 'article_identifier', TRUE, TIMESTAMPTZ '2026-01-01T00:00:00Z', TIMESTAMPTZ '2026-01-02T00:00:00Z')")
    const escapeSql = (value) => String(value).replaceAll("'", "''")
    const jsonLiteral = (value) => "CAST('" + escapeSql(JSON.stringify(value)) + "' AS JSON)"
    const operationDatabase = (tx) => ({
      queryJson: tx.queryJson,
      run: tx.run,
      transaction: (work) => Promise.resolve(work(tx)),
    })
    const createOperationPayloadTable = (tx, tableName, rows) => {
      return tx.run(\`
        CREATE TEMP TABLE \${tableName} AS
        SELECT
          row_number() OVER () - 1 AS row_index,
          row_json AS payload_json
        FROM UNNEST(json_extract(\${jsonLiteral(rows)}, '$[*]')) AS rows(row_json)
      \`)
    }
    const settings = {humanJudgmentMode: null, useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true}
    const article = {
      articleId: 'legacy-new-set-based-identifier-race',
      articleTitle: 'Package Set Based Identifier Race',
      doi: '10.1000/set-based-identifier-race',
      identifierInputs: [],
      provenance: {sourceArticleId: 'source-set-based-identifier-race'},
      signature: {identifierKeys: ['doi:10.1000/set-based-identifier-race'], title: 'Package Set Based Identifier Race'},
      sourceArticleId: 'source-set-based-identifier-race',
    }
    const targetPlan = {
      articleMatches: [
        {
          action: 'create',
          candidates: [],
          conflicts: [],
          identifierKeys: ['doi:10.1000/set-based-identifier-race'],
          packageArticleId: 'legacy-new-set-based-identifier-race',
          selectedTargetArticleId: null,
          sourceArticleId: 'source-set-based-identifier-race',
        },
      ],
    }
    const operationTables = getProjectTransferOperationTableNames('commit_set_based_identifier_race')
    const errorMessage = await catchMessage(() => {
      return database.transaction(async (tx) => {
        await createOperationPayloadTable(tx, operationTables.tableNames.articles, [article])
        await createOperationPayloadTable(tx, operationTables.tableNames.articleImportRoutes, [])
        await createOperationPayloadTable(tx, operationTables.tableNames.projectArticles, [])

        return writeProjectTransferCommitAppTables({
          commitId: 'commit-set-based-identifier-race',
          database: operationDatabase(tx),
          now,
          operationTables,
          payloads: {
            articles: [article],
            models: [getModelPayload()],
            project: getProjectPayload(settings),
          },
          plan: getBasePlan(targetPlan, dependencyResolution),
          promotion: {
            articleCreates: [{article, sourceArticleId: 'source-set-based-identifier-race'}],
            articleFieldFills: [],
            manifest: {createdAt: now.toISOString(), promotions: [], sessionId: 'session-set-based-identifier-race', updatedAt: now.toISOString()},
            promotionPathByPackagePath: {},
          },
          schemaVersion: 1,
          sessionId: 'session-set-based-identifier-race',
        })
      })
    })
    const [projectCount] = await database.queryJson("SELECT COUNT(*)::INTEGER AS count FROM app.project WHERE name = 'Imported Writer Project'")
    const [newArticleCount] = await database.queryJson("SELECT COUNT(*)::INTEGER AS count FROM app.article WHERE article_id = 'legacy-new-set-based-identifier-race'")

    console.log(JSON.stringify({errorMessage, newArticleCount: newArticleCount.count, projectCount: projectCount.count}))
  `)

  expect(result.errorMessage).toContain(
    'article identifier doi:10.1000/set-based-identifier-race for source-set-based-identifier-race is no longer available',
  )
  expect(result.projectCount).toBe(0)
  expect(result.newArticleCount).toBe(0)
})

test('project transfer commit writer rejects set-based package identifier splits before insert', () => {
  const result = runCommitWriterScript<{errorMessage: string | null; newArticleCount: number; projectCount: number}>(`
    await database.run("INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode) VALUES ('target-provider', 'openai', 'Target Provider', TRUE, 'none')")
    await database.run("INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled) VALUES ('target-model', 'target-provider', 'target-model-name', 'target-remote', 'Target Model', 'manual', TRUE)")
    const escapeSql = (value) => String(value).replaceAll("'", "''")
    const jsonLiteral = (value) => "CAST('" + escapeSql(JSON.stringify(value)) + "' AS JSON)"
    const operationDatabase = (tx) => ({
      queryJson: tx.queryJson,
      run: tx.run,
      transaction: (work) => Promise.resolve(work(tx)),
    })
    const createOperationPayloadTable = (tx, tableName, rows) => {
      return tx.run(\`
        CREATE TEMP TABLE \${tableName} AS
        SELECT
          row_number() OVER () - 1 AS row_index,
          row_json AS payload_json
        FROM UNNEST(json_extract(\${jsonLiteral(rows)}, '$[*]')) AS rows(row_json)
      \`)
    }
    const settings = {humanJudgmentMode: null, useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true}
    const firstArticle = {
      articleId: 'legacy-package-identifier-split-1',
      articleTitle: 'Package Identifier Split 1',
      doi: '10.1000/package-identifier-split',
      identifierInputs: [],
      provenance: {sourceArticleId: 'source-package-identifier-split-1'},
      signature: {identifierKeys: ['doi:10.1000/package-identifier-split'], title: 'Package Identifier Split 1'},
      sourceArticleId: 'source-package-identifier-split-1',
    }
    const secondArticle = {
      articleId: 'legacy-package-identifier-split-2',
      articleTitle: 'Package Identifier Split 2',
      doi: '10.1000/package-identifier-split',
      identifierInputs: [],
      provenance: {sourceArticleId: 'source-package-identifier-split-2'},
      signature: {identifierKeys: ['doi:10.1000/package-identifier-split'], title: 'Package Identifier Split 2'},
      sourceArticleId: 'source-package-identifier-split-2',
    }
    const targetPlan = {
      articleMatches: [firstArticle, secondArticle].map((article) => ({
        action: 'create',
        candidates: [],
        conflicts: [],
        identifierKeys: ['doi:10.1000/package-identifier-split'],
        packageArticleId: article.articleId,
        selectedTargetArticleId: null,
        sourceArticleId: article.sourceArticleId,
      })),
    }
    const operationTables = getProjectTransferOperationTableNames('commit_set_based_package_identifier_split')
    const errorMessage = await catchMessage(() => {
      return database.transaction(async (tx) => {
        await createOperationPayloadTable(tx, operationTables.tableNames.articles, [firstArticle, secondArticle])
        await createOperationPayloadTable(tx, operationTables.tableNames.articleImportRoutes, [])
        await createOperationPayloadTable(tx, operationTables.tableNames.projectArticles, [])

        return writeProjectTransferCommitAppTables({
          commitId: 'commit-set-based-package-identifier-split',
          database: operationDatabase(tx),
          now,
          operationTables,
          payloads: {
            articles: [firstArticle, secondArticle],
            models: [getModelPayload()],
            project: getProjectPayload(settings),
          },
          plan: getBasePlan(targetPlan, dependencyResolution),
          promotion: {
            articleCreates: [
              {article: firstArticle, sourceArticleId: firstArticle.sourceArticleId},
              {article: secondArticle, sourceArticleId: secondArticle.sourceArticleId},
            ],
            articleFieldFills: [],
            manifest: {createdAt: now.toISOString(), promotions: [], sessionId: 'session-set-based-package-identifier-split', updatedAt: now.toISOString()},
            promotionPathByPackagePath: {},
          },
          schemaVersion: 1,
          sessionId: 'session-set-based-package-identifier-split',
        })
      })
    })
    const [projectCount] = await database.queryJson("SELECT COUNT(*)::INTEGER AS count FROM app.project WHERE name = 'Imported Writer Project'")
    const [newArticleCount] = await database.queryJson("SELECT COUNT(*)::INTEGER AS count FROM app.article WHERE doi = '10.1000/package-identifier-split'")

    console.log(JSON.stringify({errorMessage, newArticleCount: newArticleCount.count, projectCount: projectCount.count}))
  `)

  expect(result.errorMessage).toContain(
    'article identifier doi:10.1000/package-identifier-split maps to multiple package article targets',
  )
  expect(result.projectCount).toBe(0)
  expect(result.newArticleCount).toBe(0)
})

test('project transfer commit writer blocks duplicate project prompt remaps before insert', () => {
  const result = runCommitWriterScript<{errorMessage: string | null; projectCount: number; promptCount: number}>(`
    await database.run("INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode) VALUES ('target-provider', 'openai', 'Target Provider', TRUE, 'none')")
    await database.run("INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled) VALUES ('target-model', 'target-provider', 'target-model-name', 'target-remote', 'Target Model', 'manual', TRUE)")
    const promptHash = computePromptContentHash('Duplicate prompt text', null, 'Duplicate', 'system')
    const settings = {humanJudgmentMode: 'prompt', useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true}
    const promptPayload = (sourcePromptId) => ({
      archived: false,
      contentHash: promptHash,
      originalText: 'Duplicate prompt text',
      promptHeading: 'Duplicate',
      provenance: {sourcePromptId},
      signature: {contentHash: promptHash, originalText: 'Duplicate prompt text'},
      sourcePromptId,
      transformedText: null,
      type: 'system',
    })
    const projectPromptPayload = (sourceProjectPromptId, sourcePromptId, order) => ({
      archived: false,
      enabled: true,
      order,
      provenance: {sourceProjectId: 'source-project', sourcePromptId},
      signature: {},
      sourceProjectId: 'source-project',
      sourceProjectPromptId,
      sourcePromptId,
    })
    const targetPlan = {
      projectPromptPlan: [
        {
          enabled: true,
          metadata: {archived: false},
          order: 0,
          sourceProjectPromptId: 'source-project-prompt-a',
          sourcePromptId: 'source-prompt-a',
          targetPromptId: 'new:' + promptHash,
        },
        {
          enabled: true,
          metadata: {archived: false},
          order: 1,
          sourceProjectPromptId: 'source-project-prompt-b',
          sourcePromptId: 'source-prompt-b',
          targetPromptId: 'new:' + promptHash,
        },
      ],
      promptPlan: [
        {
          action: 'create',
          computedContentHash: promptHash,
          packageContentHash: promptHash,
          sourcePromptId: 'source-prompt-a',
          targetPromptId: null,
        },
        {
          action: 'create',
          computedContentHash: promptHash,
          packageContentHash: promptHash,
          sourcePromptId: 'source-prompt-b',
          targetPromptId: null,
        },
      ],
    }
    const errorMessage = await catchMessage(() => {
      return writeProjectTransferCommitAppTables({
        commitId: 'commit-duplicate-prompt',
        now,
        payloads: {
          models: [getModelPayload()],
          project: getProjectPayload(settings),
          projectPrompts: [
            projectPromptPayload('source-project-prompt-a', 'source-prompt-a', 0),
            projectPromptPayload('source-project-prompt-b', 'source-prompt-b', 1),
          ],
          prompts: [promptPayload('source-prompt-a'), promptPayload('source-prompt-b')],
        },
        plan: getBasePlan(targetPlan, dependencyResolution),
        promotion: {
          articleCreates: [],
          articleFieldFills: [],
          manifest: {createdAt: now.toISOString(), promotions: [], sessionId: 'session-duplicate-prompt', updatedAt: now.toISOString()},
          promotionPathByPackagePath: {},
        },
        schemaVersion: 1,
        sessionId: 'session-duplicate-prompt',
      })
    })
    const [projectCount] = await database.queryJson("SELECT COUNT(*)::INTEGER AS count FROM app.project WHERE name = 'Imported Writer Project'")
    const [promptCount] = await database.queryJson("SELECT COUNT(*)::INTEGER AS count FROM app.prompt WHERE original_text = 'Duplicate prompt text'")

    console.log(JSON.stringify({errorMessage, projectCount: projectCount.count, promptCount: promptCount.count}))
  `)

  expect(result.errorMessage).toContain('duplicate project_prompt link after remap')
  expect(result.projectCount).toBe(0)
  expect(result.promptCount).toBe(0)
})

test('project transfer set-based commit preserves judgment ids and counts from compact app payloads', () => {
  const result = runCommitWriterScript<{
    completionJudgmentCount: number
    humanJudgmentRow: {answer: string | null; articleId: string; projectId: string; promptId: string}
    humanSummaryRow: {answer: string | null; articleId: string; origin: string; projectId: string}
    judgmentIdBySourceId: Record<string, string>
    newAssessmentRow: {assessmentIsCorrect: boolean; judgmentId: string}
    newJudgmentRow: {
      articleId: string
      answeredOriginal: string | null
      confidenceOriginal: number
      deleteGeneration: number
      deletedAt: string | null
      id: string
      isAnswered: boolean
      projectId: string
      snapshotProjectId: string | null
      snapshotProjectModelName: string | null
      systemPromptVariant: string
      useMetadata: boolean
    }
    reusedAssessmentCount: number
    reusedJudgmentRow: {snapshotProjectModelName: string | null; systemPromptVariant: string; useMetadata: boolean}
    reviewRow: {
      articleId: string
      opened: boolean
      projectId: string
      reviewedTitle: boolean
      reviewedTitleComment: string | null
    }
    targetNewArticleId: string
    targetProjectId: string
    warningCodes: string[]
  }>(`
    await database.run("INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode) VALUES ('target-provider', 'openai', 'Target Provider', TRUE, 'none')")
    await database.run("INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled) VALUES ('target-model', 'target-provider', 'target-model-name', 'target-remote', 'Target Model', 'manual', TRUE)")
    const promptHash = computePromptContentHash('Decision prompt?', null, 'Decision', 'system')
    await database.run("INSERT INTO app.prompt (id, original_text, transformed_text, prompt_heading, type, content_hash, archived) VALUES ('target-prompt', 'Decision prompt?', NULL, 'Decision', 'system', '" + promptHash + "', FALSE)")
    await database.run("INSERT INTO app.article (id, article_title) VALUES ('reuse-decision-article', 'Reusable Decision Article')")
    await database.run("INSERT INTO app.judgment (id, article_id, prompt_id, model_id, project_id, snapshot_project_id, snapshot_project_model_name, use_title, use_abstract, use_fulltext, use_fulltext_no_images, is_answered, answered_original, answered_original_as_array, confidence_original, explanation, quotes, delete_generation, deleted_at, created_at, updated_at) VALUES ('target-judgment-reuse', 'reuse-decision-article', 'target-prompt', 'target-model', 'existing-project', 'existing-snapshot-project', 'target-existing-label', TRUE, TRUE, FALSE, FALSE, TRUE, 'reuse-answer', ['reuse-answer'], 77, 'reuse-answer explanation', CAST('[{\\"quote\\":\\"reuse-answer quote\\"}]' AS JSON), 0, NULL, TIMESTAMPTZ '2026-05-01T00:00:00.000Z', TIMESTAMPTZ '2026-05-01T00:00:00.000Z')")
    await database.run("INSERT INTO app.judgment_assessment (id, judgment_id, assessment_is_correct, assessment_comment, created_at, updated_at) VALUES ('target-assessment-reuse', 'target-judgment-reuse', TRUE, 'Reused assessment', TIMESTAMPTZ '2026-05-01T00:00:00.000Z', TIMESTAMPTZ '2026-05-01T00:00:00.000Z')")
    const escapeSql = (value) => String(value).replaceAll("'", "''")
    const jsonLiteral = (value) => "CAST('" + escapeSql(JSON.stringify(value)) + "' AS JSON)"
    const operationDatabase = (tx) => ({
      queryJson: tx.queryJson,
      run: tx.run,
      transaction: (work) => Promise.resolve(work(tx)),
    })
    const createOperationPayloadTable = (tx, tableName, rows) => {
      return tx.run(\`
        CREATE TEMP TABLE \${tableName} AS
        SELECT
          row_number() OVER () - 1 AS row_index,
          row_json AS payload_json
        FROM UNNEST(json_extract(\${jsonLiteral(rows)}, '$[*]')) AS rows(row_json)
      \`)
    }

    const settings = {
      humanJudgmentMode: 'prompt',
      useAbstract: true,
      useFulltext: false,
      useFulltextNoImages: false,
      useTitle: true,
    }
    const newArticle = {
      articleId: 'legacy-decision-new',
      articleTitle: 'New Decision Article',
      identifierInputs: [],
      provenance: {sourceArticleId: 'source-decision-new'},
      signature: {identifierKeys: [], title: 'New Decision Article'},
      sourceArticleId: 'source-decision-new',
    }
    const reusedArticle = {
      articleTitle: 'Reusable Decision Article',
      identifierInputs: [],
      provenance: {sourceArticleId: 'source-decision-reuse'},
      signature: {identifierKeys: [], title: 'Reusable Decision Article'},
      sourceArticleId: 'source-decision-reuse',
    }
    const promptPayload = {
      archived: false,
      contentHash: promptHash,
      originalText: 'Decision prompt?',
      promptHeading: 'Decision',
      provenance: {sourcePromptId: 'source-prompt-decision'},
      signature: {contentHash: promptHash, originalText: 'Decision prompt?'},
      sourcePromptId: 'source-prompt-decision',
      transformedText: null,
      type: 'system',
    }
    const projectPromptPayload = {
      archived: false,
      enabled: true,
      order: 0,
      provenance: {sourceProjectId: 'source-project', sourcePromptId: 'source-prompt-decision'},
      signature: {},
      sourceProjectId: 'source-project',
      sourceProjectPromptId: 'source-project-prompt-decision',
      sourcePromptId: 'source-prompt-decision',
    }
    const getJudgmentPayload = (sourceJudgmentId, sourceArticleId, answer, confidenceOriginal, snapshotProjectModelName) => ({
      answeredOriginal: answer,
      answeredOriginalAsArray: [answer],
      chunkingStrategy: null,
      confidenceOriginal,
      contentSettings: settings,
      createdAt: '2026-05-02T00:00:00.000Z',
      deleteGeneration: 0,
      deletedAt: null,
      explanation: answer + ' explanation',
      isAnswered: true,
      judgmentInputSignature: {article: sourceArticleId, prompt: 'decision'},
      judgmentInputSignatureProvenance: {kind: 'currentReviewRows', version: 1},
      provenance: {sourceArticleId, sourceModelId: 'source-model', sourcePromptId: 'source-prompt-decision'},
      quotes: [{quote: answer + ' quote'}],
      signature: {},
      snapshotProjectId: 'source-project',
      snapshotProjectModelName,
      sourceArticleId,
      sourceJudgmentId,
      sourceModelId: 'source-model',
      sourceProjectId: 'source-project',
      sourcePromptId: 'source-prompt-decision',
      updatedAt: '2026-05-03T00:00:00.000Z',
    })
    const newJudgmentPayload = getJudgmentPayload('source-judgment-new', 'source-decision-new', 'new-answer', null, 'exported-new-label')
    const reusedJudgmentPayload = getJudgmentPayload('source-judgment-reuse', 'source-decision-reuse', 'reuse-answer', 77, 'exported-reuse-label')
    const stagedNewJudgmentPayload = {
      ...newJudgmentPayload,
      answeredOriginal: 'new-answer-staged',
      answeredOriginalAsArray: ['new-answer-staged'],
      explanation: 'new-answer-staged explanation',
      contentSettings: {...settings, useMetadata: true},
      quotes: [{quote: 'new-answer-staged quote'}],
      systemPromptVariant: 'screening_v1',
    }
    const newAssessmentPayload = {
      assessmentComment: 'New assessment',
      assessmentIsCorrect: false,
      provenance: {sourceJudgmentId: 'source-judgment-new'},
      signature: {},
      sourceJudgmentAssessmentId: 'source-assessment-new',
      sourceJudgmentId: 'source-judgment-new',
    }
    const stagedNewAssessmentPayload = {...newAssessmentPayload, assessmentIsCorrect: true}
    const reusedAssessmentPayload = {
      assessmentComment: 'Reused assessment',
      assessmentIsCorrect: true,
      provenance: {sourceJudgmentId: 'source-judgment-reuse'},
      signature: {},
      sourceJudgmentAssessmentId: 'source-assessment-reuse',
      sourceJudgmentId: 'source-judgment-reuse',
    }
    const humanSummaryPayload = {
      answer: 'yes',
      humanReviewInputSignature: {article: 'source-decision-new'},
      humanReviewInputSignatureProvenance: {kind: 'currentReviewRows', version: 1},
      origin: 'manual_override',
      provenance: {sourceArticleId: 'source-decision-new', sourceProjectId: null},
      signature: {},
      sourceArticleId: 'source-decision-new',
      sourceHumanJudgmentSummaryId: 'source-human-summary',
      sourceProjectId: 'source-project',
    }
    const humanJudgmentPayload = {
      answer: 'include',
      comment: 'Human comment',
      humanReviewInputSignature: {article: 'source-decision-new', prompt: 'decision'},
      humanReviewInputSignatureProvenance: {kind: 'currentReviewRows', version: 1},
      isAnswered: true,
      provenance: {sourceArticleId: 'source-decision-new', sourceProjectId: null, sourcePromptId: 'source-prompt-decision'},
      signature: {},
      sourceArticleId: 'source-decision-new',
      sourceHumanJudgmentId: 'source-human-judgment',
      sourceProjectId: 'source-project',
      sourcePromptId: 'source-prompt-decision',
    }
    const reviewPayload = {
      humanReviewInputSignature: {article: 'source-decision-new', sections: {title: true}},
      humanReviewInputSignatureProvenance: {kind: 'currentReviewRows', version: 1},
      opened: true,
      provenance: {sourceArticleId: 'source-decision-new', sourceProjectId: null},
      sections: {title: {comment: 'Reviewed title', reviewed: true}},
      signature: {},
      sourceArticleId: 'source-decision-new',
      sourceProjectId: 'source-project',
      sourceReviewId: 'source-review',
    }
    const targetPlan = {
      articleMatches: [
        {
          action: 'create',
          candidates: [],
          conflicts: [],
          identifierKeys: [],
          packageArticleId: 'legacy-decision-new',
          selectedTargetArticleId: null,
          sourceArticleId: 'source-decision-new',
        },
        {
          action: 'reuse',
          candidates: [],
          conflicts: [],
          identifierKeys: [],
          packageArticleId: null,
          selectedTargetArticleId: 'reuse-decision-article',
          sourceArticleId: 'source-decision-reuse',
        },
      ],
      judgmentAssessmentPlan: [
        {
          action: 'insert',
          conflictCodes: [],
          sourceJudgmentAssessmentId: 'source-assessment-new',
          sourceJudgmentId: 'source-judgment-new',
          targetAssessmentId: null,
          targetJudgmentId: 'new:judgment:source-judgment-new',
        },
        {
          action: 'reuse',
          conflictCodes: [],
          sourceJudgmentAssessmentId: 'source-assessment-reuse',
          sourceJudgmentId: 'source-judgment-reuse',
          targetAssessmentId: 'target-assessment-reuse',
          targetJudgmentId: 'target-judgment-reuse',
        },
      ],
      judgmentPlan: [
        {
          action: 'insert',
          conflictCodes: [],
          inputSignatureMatches: true,
          physicalKey: 'new-physical',
          provenanceKind: 'currentReviewRows',
          reviewVisibleKey: 'new-visible',
          sourceJudgmentId: 'source-judgment-new',
          targetArticleId: 'new:article:source-decision-new',
          targetJudgmentId: 'new:judgment:source-judgment-new',
          targetModelId: 'target-model',
          targetPromptId: 'target-prompt',
        },
        {
          action: 'reuse',
          conflictCodes: [],
          inputSignatureMatches: true,
          physicalKey: 'reuse-physical',
          provenanceKind: 'currentReviewRows',
          reviewVisibleKey: 'reuse-visible',
          sourceJudgmentId: 'source-judgment-reuse',
          targetArticleId: 'reuse-decision-article',
          targetJudgmentId: 'target-judgment-reuse',
          targetModelId: 'target-model',
          targetPromptId: 'target-prompt',
        },
      ],
      humanReviewPlan: [
        {
          action: 'insert',
          conflictCodes: [],
          inputSignatureMatches: true,
          kind: 'humanJudgment',
          provenanceKind: 'currentReviewRows',
          sourceId: 'source-human-judgment',
          targetArticleId: 'new:article:source-decision-new',
          targetPromptId: 'target-prompt',
          uniqueKey: 'human-judgment-key',
        },
        {
          action: 'insert',
          conflictCodes: [],
          inputSignatureMatches: true,
          kind: 'humanJudgmentSummary',
          provenanceKind: 'currentReviewRows',
          sourceId: 'source-human-summary',
          targetArticleId: 'new:article:source-decision-new',
          targetPromptId: null,
          uniqueKey: 'human-summary-key',
        },
        {
          action: 'insert',
          conflictCodes: [],
          inputSignatureMatches: true,
          kind: 'review',
          provenanceKind: 'currentReviewRows',
          sourceId: 'source-review',
          targetArticleId: 'new:article:source-decision-new',
          targetPromptId: null,
          uniqueKey: 'review-key',
        },
      ],
      projectPromptPlan: [
        {
          enabled: true,
          metadata: {archived: false},
          order: 0,
          sourceProjectPromptId: 'source-project-prompt-decision',
          sourcePromptId: 'source-prompt-decision',
          targetPromptId: 'target-prompt',
        },
      ],
      promptPlan: [
        {
          action: 'reuse',
          computedContentHash: promptHash,
          packageContentHash: promptHash,
          sourcePromptId: 'source-prompt-decision',
          targetPromptId: 'target-prompt',
        },
      ],
    }
    const packageWarnings = [
      {
        action: 'used_current_review_rows',
        code: 'currentReviewRowsJudgmentInputSignature',
        details: {provenance: 'currentReviewRows', recordCount: 2},
        message: 'Current review rows were used',
        scope: 'judgments',
        severity: 'warning',
      },
      {
        action: 'noted',
        code: 'providerModelDependencyNote',
        details: {sourceModelId: 'source-model', targetModelId: 'target-model'},
        message: 'Provider/model dependency note',
        scope: 'models.source-model',
        severity: 'info',
      },
    ]
    const plan = getBasePlan(targetPlan, dependencyResolution)
    plan.packageWarnings = packageWarnings
    plan.summary = {...plan.summary, packageWarnings, warningCount: packageWarnings.length}
    const payloads = {
      articles: [newArticle, reusedArticle],
      humanJudgmentSummaries: [humanSummaryPayload],
      humanJudgments: [humanJudgmentPayload],
      judgmentAssessments: [newAssessmentPayload, reusedAssessmentPayload],
      judgments: [
        {sourceJudgmentId: newJudgmentPayload.sourceJudgmentId},
        {sourceJudgmentId: reusedJudgmentPayload.sourceJudgmentId},
      ],
      models: [getModelPayload()],
      project: getProjectPayload(settings),
      projectArticles: [
        {
          provenance: {sourceArticleId: 'source-decision-new', sourceProjectId: 'source-project'},
          signature: {},
          sourceArticleId: 'source-decision-new',
          sourceProjectArticleId: 'source-project-article-decision',
          sourceProjectId: 'source-project',
        },
      ],
      projectPrompts: [projectPromptPayload],
      prompts: [promptPayload],
      reviews: [reviewPayload],
    }
    const promotion = {
      articleCreates: [{article: newArticle, sourceArticleId: 'source-decision-new'}],
      articleFieldFills: [],
      manifest: {createdAt: now.toISOString(), promotions: [], sessionId: 'session-decision-writer', updatedAt: now.toISOString()},
      promotionPathByPackagePath: {},
    }
    const operationTables = getProjectTransferOperationTableNames('commit_decision_writer')
    const writeResult = await database.transaction(async (tx) => {
      await createOperationPayloadTable(tx, operationTables.tableNames.articles, [newArticle, reusedArticle])
      await createOperationPayloadTable(tx, operationTables.tableNames.articleImportRoutes, [])
      await createOperationPayloadTable(tx, operationTables.tableNames.projectArticles, payloads.projectArticles)
      await createOperationPayloadTable(tx, operationTables.tableNames.judgments, [stagedNewJudgmentPayload, reusedJudgmentPayload])
      await createOperationPayloadTable(tx, operationTables.tableNames.judgmentAssessments, [stagedNewAssessmentPayload, reusedAssessmentPayload])
      await createOperationPayloadTable(tx, operationTables.tableNames.humanJudgments, [{...humanJudgmentPayload, answer: 'exclude-staged'}])
      await createOperationPayloadTable(tx, operationTables.tableNames.humanJudgmentSummaries, [{...humanSummaryPayload, answer: 'maybe'}])
      await createOperationPayloadTable(tx, operationTables.tableNames.reviews, [{...reviewPayload, sections: {title: {comment: 'Reviewed title staged', reviewed: true}}}])

      return writeProjectTransferCommitAppTables({
        commitId: 'commit-decision-writer',
        database: operationDatabase(tx),
        now,
        operationTables,
        payloads,
        plan,
        promotion,
        schemaVersion: 1,
        sessionId: 'session-decision-writer',
      })
    })
    const targetNewArticleId = writeResult.articleIdBySourceId['source-decision-new']
    const [newJudgmentRow] = await database.queryJson("SELECT id, article_id AS articleId, project_id AS projectId, snapshot_project_id AS snapshotProjectId, snapshot_project_model_name AS snapshotProjectModelName, is_answered AS isAnswered, answered_original AS answeredOriginal, confidence_original AS confidenceOriginal, delete_generation::INTEGER AS deleteGeneration, deleted_at AS deletedAt, system_prompt_variant AS systemPromptVariant, use_metadata AS useMetadata FROM app.judgment WHERE article_id = '" + targetNewArticleId + "'")
    const [reusedJudgmentRow] = await database.queryJson("SELECT snapshot_project_model_name AS snapshotProjectModelName, system_prompt_variant AS systemPromptVariant, use_metadata AS useMetadata FROM app.judgment WHERE id = 'target-judgment-reuse'")
    const [newAssessmentRow] = await database.queryJson("SELECT judgment_id AS judgmentId, assessment_is_correct AS assessmentIsCorrect FROM app.judgment_assessment WHERE judgment_id = '" + newJudgmentRow.id + "'")
    const [reusedAssessmentCount] = await database.queryJson("SELECT COUNT(*)::INTEGER AS count FROM app.judgment_assessment WHERE judgment_id = 'target-judgment-reuse'")
    const [humanJudgmentRow] = await database.queryJson("SELECT project_id AS projectId, article_id AS articleId, prompt_id AS promptId, answer FROM app.judgment_human WHERE project_id = '" + writeResult.projectId + "'")
    const [humanSummaryRow] = await database.queryJson("SELECT project_id AS projectId, article_id AS articleId, answer, origin FROM app.judgment_human_summary WHERE project_id = '" + writeResult.projectId + "'")
    const [reviewRow] = await database.queryJson("SELECT project_id AS projectId, article_id AS articleId, opened, reviewed_title AS reviewedTitle, reviewed_title_comment AS reviewedTitleComment FROM app.review WHERE project_id = '" + writeResult.projectId + "'")

    console.log(JSON.stringify({
      completionJudgmentCount: writeResult.completion.finalCounts.judgments,
      humanJudgmentRow,
      humanSummaryRow,
      judgmentIdBySourceId: writeResult.commitIdMaps.judgmentIdBySourceId,
      newAssessmentRow,
      newJudgmentRow,
      reusedAssessmentCount: reusedAssessmentCount.count,
      reusedJudgmentRow,
      reviewRow,
      targetNewArticleId,
      targetProjectId: writeResult.projectId,
      warningCodes: writeResult.importWarnings.map((warning) => warning.code),
    }))
  `)

  expect(result.newJudgmentRow).toMatchObject({
    answeredOriginal: 'new-answer-staged',
    confidenceOriginal: 50,
    deleteGeneration: 0,
    deletedAt: null,
    isAnswered: true,
    projectId: result.targetProjectId,
    snapshotProjectId: result.targetProjectId,
    snapshotProjectModelName: 'exported-new-label',
    systemPromptVariant: 'screening_v1',
    useMetadata: true,
  })
  expect(result.completionJudgmentCount).toBe(2)
  expect(result.judgmentIdBySourceId).toEqual({
    'source-judgment-new': result.newJudgmentRow.id,
    'source-judgment-reuse': 'target-judgment-reuse',
  })
  expect(result.reusedJudgmentRow.snapshotProjectModelName).toBe('target-existing-label')
  expect(result.reusedJudgmentRow.systemPromptVariant).toBe('legacy')
  expect(result.reusedJudgmentRow.useMetadata).toBe(false)
  expect(result.newAssessmentRow).toMatchObject({assessmentIsCorrect: true, judgmentId: result.newJudgmentRow.id})
  expect(result.reusedAssessmentCount).toBe(1)
  expect(result.humanJudgmentRow).toMatchObject({
    answer: 'exclude-staged',
    articleId: result.targetNewArticleId,
    projectId: result.targetProjectId,
    promptId: 'target-prompt',
  })
  expect(result.humanSummaryRow).toMatchObject({
    answer: 'maybe',
    articleId: result.targetNewArticleId,
    origin: 'manual_override',
    projectId: result.targetProjectId,
  })
  expect(result.reviewRow).toMatchObject({
    articleId: result.targetNewArticleId,
    opened: true,
    projectId: result.targetProjectId,
    reviewedTitle: true,
    reviewedTitleComment: 'Reviewed title staged',
  })
  expect(result.warningCodes).toContain('currentReviewRowsJudgmentInputSignature')
  expect(result.warningCodes).toContain('providerModelDependencyNote')
  expect(result.warningCodes).toContain('equivalentTargetJudgmentReused')
})

test('project transfer commit writer rolls back partial set-based judgment writes on human review failure', () => {
  const result = runCommitWriterScript<{
    articleCount: number
    assessmentCount: number
    errorMessage: string | null
    judgmentCount: number
    projectCount: number
  }>(`
    await database.run("INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode) VALUES ('target-provider', 'openai', 'Target Provider', TRUE, 'none')")
    await database.run("INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled) VALUES ('target-model', 'target-provider', 'target-model-name', 'target-remote', 'Target Model', 'manual', TRUE)")
    const promptHash = computePromptContentHash('Rollback prompt?', null, 'Rollback', 'system')
    await database.run("INSERT INTO app.prompt (id, original_text, transformed_text, prompt_heading, type, content_hash, archived) VALUES ('target-rollback-prompt', 'Rollback prompt?', NULL, 'Rollback', 'system', '" + promptHash + "', FALSE)")
    const escapeSql = (value) => String(value).replaceAll("'", "''")
    const jsonLiteral = (value) => "CAST('" + escapeSql(JSON.stringify(value)) + "' AS JSON)"
    const operationDatabase = (tx) => ({
      queryJson: tx.queryJson,
      run: tx.run,
      transaction: (work) => Promise.resolve(work(tx)),
    })
    const createOperationPayloadTable = (tx, tableName, rows) => {
      return tx.run(\`
        CREATE TEMP TABLE \${tableName} AS
        SELECT
          row_number() OVER () - 1 AS row_index,
          row_json AS payload_json
        FROM UNNEST(json_extract(\${jsonLiteral(rows)}, '$[*]')) AS rows(row_json)
      \`)
    }
    const settings = {humanJudgmentMode: 'summary', useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true}
    const article = {
      articleId: 'legacy-rollback-article',
      articleTitle: 'Rollback Article',
      identifierInputs: [],
      provenance: {sourceArticleId: 'source-rollback-article'},
      signature: {identifierKeys: [], title: 'Rollback Article'},
      sourceArticleId: 'source-rollback-article',
    }
    const promptPayload = {
      archived: false,
      contentHash: promptHash,
      originalText: 'Rollback prompt?',
      promptHeading: 'Rollback',
      provenance: {sourcePromptId: 'source-rollback-prompt'},
      signature: {contentHash: promptHash},
      sourcePromptId: 'source-rollback-prompt',
      transformedText: null,
      type: 'system',
    }
    const projectPromptPayload = {
      archived: false,
      enabled: true,
      order: 0,
      provenance: {sourceProjectId: 'source-project', sourcePromptId: 'source-rollback-prompt'},
      signature: {},
      sourceProjectId: 'source-project',
      sourceProjectPromptId: 'source-rollback-project-prompt',
      sourcePromptId: 'source-rollback-prompt',
    }
    const projectArticle = {
      provenance: {sourceArticleId: 'source-rollback-article', sourceProjectId: 'source-project'},
      signature: {},
      sourceArticleId: 'source-rollback-article',
      sourceProjectArticleId: 'source-rollback-project-article',
      sourceProjectId: 'source-project',
    }
    const judgment = {
      answeredOriginal: 'rollback-answer',
      answeredOriginalAsArray: ['rollback-answer'],
      chunkingStrategy: null,
      confidenceOriginal: 50,
      contentSettings: settings,
      createdAt: '2026-05-02T00:00:00.000Z',
      deleteGeneration: 0,
      explanation: 'Rollback explanation',
      isAnswered: true,
      judgmentInputSignature: {article: 'source-rollback-article', prompt: 'rollback'},
      judgmentInputSignatureProvenance: {kind: 'currentReviewRows', version: 1},
      provenance: {sourceArticleId: 'source-rollback-article', sourceModelId: 'source-model', sourcePromptId: 'source-rollback-prompt'},
      quotes: [{quote: 'rollback quote'}],
      signature: {},
      snapshotProjectModelName: 'rollback model',
      sourceArticleId: 'source-rollback-article',
      sourceJudgmentId: 'source-rollback-judgment',
      sourceModelId: 'source-model',
      sourceProjectId: 'source-project',
      sourcePromptId: 'source-rollback-prompt',
      updatedAt: '2026-05-03T00:00:00.000Z',
    }
    const assessment = {
      assessmentComment: 'Rollback assessment',
      assessmentIsCorrect: true,
      provenance: {sourceJudgmentId: 'source-rollback-judgment'},
      signature: {},
      sourceJudgmentAssessmentId: 'source-rollback-assessment',
      sourceJudgmentId: 'source-rollback-judgment',
    }
    const summaryA = {
      answer: 'yes',
      humanReviewInputSignature: {article: 'source-rollback-article'},
      humanReviewInputSignatureProvenance: {kind: 'currentReviewRows', version: 1},
      origin: 'manual_override',
      provenance: {sourceArticleId: 'source-rollback-article', sourceProjectId: 'source-project'},
      signature: {},
      sourceArticleId: 'source-rollback-article',
      sourceHumanJudgmentSummaryId: 'source-rollback-summary-a',
      sourceProjectId: 'source-project',
    }
    const summaryB = {...summaryA, answer: 'no', sourceHumanJudgmentSummaryId: 'source-rollback-summary-b'}
    const targetPlan = {
      articleMatches: [
        {
          action: 'create',
          candidates: [],
          conflicts: [],
          identifierKeys: [],
          packageArticleId: 'legacy-rollback-article',
          selectedTargetArticleId: null,
          sourceArticleId: 'source-rollback-article',
        },
      ],
      judgmentAssessmentPlan: [
        {
          action: 'insert',
          conflictCodes: [],
          sourceJudgmentAssessmentId: 'source-rollback-assessment',
          sourceJudgmentId: 'source-rollback-judgment',
          targetAssessmentId: null,
          targetJudgmentId: 'new:judgment:source-rollback-judgment',
        },
      ],
      judgmentPlan: [
        {
          action: 'insert',
          conflictCodes: [],
          inputSignatureMatches: true,
          physicalKey: 'rollback-physical',
          provenanceKind: 'currentReviewRows',
          reviewVisibleKey: 'rollback-visible',
          sourceJudgmentId: 'source-rollback-judgment',
          targetArticleId: 'new:article:source-rollback-article',
          targetJudgmentId: 'new:judgment:source-rollback-judgment',
          targetModelId: 'target-model',
          targetPromptId: 'target-rollback-prompt',
        },
      ],
      humanReviewPlan: [
        {
          action: 'insert',
          conflictCodes: [],
          inputSignatureMatches: true,
          kind: 'humanJudgmentSummary',
          provenanceKind: 'currentReviewRows',
          sourceId: 'source-rollback-summary-a',
          targetArticleId: 'new:article:source-rollback-article',
          targetPromptId: null,
          uniqueKey: 'summary-a',
        },
        {
          action: 'insert',
          conflictCodes: [],
          inputSignatureMatches: true,
          kind: 'humanJudgmentSummary',
          provenanceKind: 'currentReviewRows',
          sourceId: 'source-rollback-summary-b',
          targetArticleId: 'new:article:source-rollback-article',
          targetPromptId: null,
          uniqueKey: 'summary-b',
        },
      ],
      projectPromptPlan: [
        {
          enabled: true,
          metadata: {archived: false},
          order: 0,
          sourceProjectPromptId: 'source-rollback-project-prompt',
          sourcePromptId: 'source-rollback-prompt',
          targetPromptId: 'target-rollback-prompt',
        },
      ],
      promptPlan: [
        {
          action: 'reuse',
          computedContentHash: promptHash,
          packageContentHash: promptHash,
          sourcePromptId: 'source-rollback-prompt',
          targetPromptId: 'target-rollback-prompt',
        },
      ],
    }
    const payloads = {
      articles: [article],
      humanJudgmentSummaries: [summaryA, summaryB],
      judgmentAssessments: [assessment],
      judgments: [judgment],
      models: [getModelPayload()],
      project: getProjectPayload(settings),
      projectArticles: [projectArticle],
      projectPrompts: [projectPromptPayload],
      prompts: [promptPayload],
    }
    const promotion = {
      articleCreates: [{article, sourceArticleId: 'source-rollback-article'}],
      articleFieldFills: [],
      manifest: {createdAt: now.toISOString(), promotions: [], sessionId: 'session-set-based-rollback', updatedAt: now.toISOString()},
      promotionPathByPackagePath: {},
    }
    const operationTables = getProjectTransferOperationTableNames('commit_set_based_rollback')
    const errorMessage = await catchMessage(() => {
      return database.transaction(async (tx) => {
        await createOperationPayloadTable(tx, operationTables.tableNames.articles, [article])
        await createOperationPayloadTable(tx, operationTables.tableNames.articleImportRoutes, [])
        await createOperationPayloadTable(tx, operationTables.tableNames.projectArticles, [projectArticle])
        await createOperationPayloadTable(tx, operationTables.tableNames.judgments, [judgment])
        await createOperationPayloadTable(tx, operationTables.tableNames.judgmentAssessments, [assessment])
        await createOperationPayloadTable(tx, operationTables.tableNames.humanJudgmentSummaries, [summaryA, summaryB])
        await createOperationPayloadTable(tx, operationTables.tableNames.humanJudgments, [])
        await createOperationPayloadTable(tx, operationTables.tableNames.reviews, [])

        return writeProjectTransferCommitAppTables({
          commitId: 'commit-set-based-rollback',
          database: operationDatabase(tx),
          now,
          operationTables,
          payloads,
          plan: getBasePlan(targetPlan, dependencyResolution),
          promotion,
          schemaVersion: 1,
          sessionId: 'session-set-based-rollback',
        })
      })
    })
    const [projectCount] = await database.queryJson("SELECT COUNT(*)::INTEGER AS count FROM app.project WHERE name = 'Imported Writer Project'")
    const [articleCount] = await database.queryJson("SELECT COUNT(*)::INTEGER AS count FROM app.article WHERE article_id = 'legacy-rollback-article'")
    const [judgmentCount] = await database.queryJson("SELECT COUNT(*)::INTEGER AS count FROM app.judgment WHERE answered_original = 'rollback-answer'")
    const [assessmentCount] = await database.queryJson("SELECT COUNT(*)::INTEGER AS count FROM app.judgment_assessment WHERE assessment_comment = 'Rollback assessment'")

    console.log(JSON.stringify({
      articleCount: articleCount.count,
      assessmentCount: assessmentCount.count,
      errorMessage,
      judgmentCount: judgmentCount.count,
      projectCount: projectCount.count,
    }))
  `)

  expect(result.errorMessage).toContain('duplicate judgment_human_summary after remap')
  expect(result.projectCount).toBe(0)
  expect(result.articleCount).toBe(0)
  expect(result.judgmentCount).toBe(0)
  expect(result.assessmentCount).toBe(0)
})

test('project transfer commit writer blocks active judgment review-visible conflicts before insert', () => {
  const result = runCommitWriterScript<{errorMessage: string | null; judgmentCount: number; projectCount: number}>(`
    await database.run("INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode) VALUES ('target-provider', 'openai', 'Target Provider', TRUE, 'none')")
    await database.run("INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled) VALUES ('target-model', 'target-provider', 'target-model-name', 'target-remote', 'Target Model', 'manual', TRUE)")
    const promptHash = computePromptContentHash('Conflict prompt?', null, 'Conflict', 'system')
    await database.run("INSERT INTO app.prompt (id, original_text, transformed_text, prompt_heading, type, content_hash, archived) VALUES ('target-prompt-conflict', 'Conflict prompt?', NULL, 'Conflict', 'system', '" + promptHash + "', FALSE)")
    await database.run("INSERT INTO app.article (id, article_title) VALUES ('target-conflict-article', 'Conflict Article')")
    await database.run("INSERT INTO app.judgment (id, article_id, prompt_id, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images, is_answered, answered_original, answered_original_as_array, confidence_original, explanation, quotes, delete_generation, deleted_at) VALUES ('target-visible-conflict', 'target-conflict-article', 'target-prompt-conflict', 'target-model', TRUE, TRUE, FALSE, FALSE, TRUE, 'existing', ['existing'], 50, 'Existing', CAST('[]' AS JSON), 1, NULL)")
    const settings = {humanJudgmentMode: 'prompt', useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true}
    const article = {
      articleTitle: 'Conflict Article',
      identifierInputs: [],
      provenance: {sourceArticleId: 'source-conflict-article'},
      signature: {identifierKeys: [], title: 'Conflict Article'},
      sourceArticleId: 'source-conflict-article',
    }
    const promptPayload = {
      archived: false,
      contentHash: promptHash,
      originalText: 'Conflict prompt?',
      promptHeading: 'Conflict',
      provenance: {sourcePromptId: 'source-conflict-prompt'},
      signature: {},
      sourcePromptId: 'source-conflict-prompt',
      transformedText: null,
      type: 'system',
    }
    const targetPlan = {
      articleMatches: [
        {
          action: 'reuse',
          candidates: [],
          conflicts: [],
          identifierKeys: [],
          packageArticleId: null,
          selectedTargetArticleId: 'target-conflict-article',
          sourceArticleId: 'source-conflict-article',
        },
      ],
      judgmentPlan: [
        {
          action: 'insert',
          conflictCodes: [],
          inputSignatureMatches: true,
          physicalKey: 'conflict-physical',
          provenanceKind: 'currentReviewRows',
          reviewVisibleKey: 'conflict-visible',
          sourceJudgmentId: 'source-conflict-judgment',
          targetArticleId: 'target-conflict-article',
          targetJudgmentId: 'new:judgment:source-conflict-judgment',
          targetModelId: 'target-model',
          targetPromptId: 'target-prompt-conflict',
        },
      ],
      projectPromptPlan: [
        {
          enabled: true,
          metadata: {archived: false},
          order: 0,
          sourceProjectPromptId: 'source-conflict-project-prompt',
          sourcePromptId: 'source-conflict-prompt',
          targetPromptId: 'target-prompt-conflict',
        },
      ],
      promptPlan: [
        {
          action: 'reuse',
          computedContentHash: promptHash,
          packageContentHash: promptHash,
          sourcePromptId: 'source-conflict-prompt',
          targetPromptId: 'target-prompt-conflict',
        },
      ],
    }
    const errorMessage = await catchMessage(() => {
      return writeProjectTransferCommitAppTables({
        commitId: 'commit-visible-conflict',
        now,
        payloads: {
          articles: [article],
          judgments: [
            {
              answeredOriginal: 'new',
              answeredOriginalAsArray: ['new'],
              confidenceOriginal: null,
              contentSettings: settings,
              deleteGeneration: 0,
              explanation: 'New',
              isAnswered: true,
              judgmentInputSignature: {},
              judgmentInputSignatureProvenance: {kind: 'currentReviewRows', version: 1},
              provenance: {sourceArticleId: 'source-conflict-article', sourceModelId: 'source-model', sourcePromptId: 'source-conflict-prompt'},
              quotes: [],
              signature: {},
              sourceArticleId: 'source-conflict-article',
              sourceJudgmentId: 'source-conflict-judgment',
              sourceModelId: 'source-model',
              sourcePromptId: 'source-conflict-prompt',
            },
          ],
          models: [getModelPayload()],
          project: getProjectPayload(settings),
          projectPrompts: [
            {
              archived: false,
              enabled: true,
              order: 0,
              provenance: {sourceProjectId: 'source-project', sourcePromptId: 'source-conflict-prompt'},
              signature: {},
              sourceProjectId: 'source-project',
              sourceProjectPromptId: 'source-conflict-project-prompt',
              sourcePromptId: 'source-conflict-prompt',
            },
          ],
          prompts: [promptPayload],
        },
        plan: getBasePlan(targetPlan, dependencyResolution),
        promotion: {
          articleCreates: [],
          articleFieldFills: [],
          manifest: {createdAt: now.toISOString(), promotions: [], sessionId: 'session-visible-conflict', updatedAt: now.toISOString()},
          promotionPathByPackagePath: {},
        },
        schemaVersion: 1,
        sessionId: 'session-visible-conflict',
      })
    })
    const [projectCount] = await database.queryJson("SELECT COUNT(*)::INTEGER AS count FROM app.project WHERE name = 'Imported Writer Project'")
    const [judgmentCount] = await database.queryJson("SELECT COUNT(*)::INTEGER AS count FROM app.judgment WHERE article_id = 'target-conflict-article'")

    console.log(JSON.stringify({errorMessage, judgmentCount: judgmentCount.count, projectCount: projectCount.count}))
  `)

  expect(result.errorMessage).toBe(
    "Project transfer commit writer: target judgment review-visible key already exists for source-conflict-judgment: existing active judgment target-visible-conflict is review-visible for the same article target-conflict-article (existing row reused by this import), prompt target-prompt-conflict (existing row reused by this import), model target-model (existing row reused by this import for package model source-model), content flags and system prompt variant, but the import analysis planned to insert a new judgment (the target changed after the analysis, or the analysis mapped a different article, prompt or model). Rerun the import analysis; if it repeats, map the package's provider and model to existing ones in the dependencies step.",
  )
  expect(result.projectCount).toBe(0)
  expect(result.judgmentCount).toBe(1)
})

test('project transfer set-based commit writer explains existing judgment physical key conflicts', () => {
  const result = runCommitWriterScript<{errorMessage: string | null; judgmentCount: number; projectCount: number}>(`
    await database.run("INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode) VALUES ('target-provider', 'openai', 'Target Provider', TRUE, 'none')")
    await database.run("INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled) VALUES ('target-model', 'target-provider', 'target-model-name', 'target-remote', 'Target Model', 'manual', TRUE)")
    const promptHash = computePromptContentHash('Set conflict prompt?', null, 'Set conflict', 'system')
    await database.run("INSERT INTO app.prompt (id, original_text, transformed_text, prompt_heading, type, content_hash, archived) VALUES ('target-set-prompt', 'Set conflict prompt?', NULL, 'Set conflict', 'system', '" + promptHash + "', FALSE)")
    await database.run("INSERT INTO app.article (id, article_title) VALUES ('target-set-article', 'Set Conflict Article')")
    await database.run("INSERT INTO app.judgment (id, article_id, prompt_id, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images, use_metadata, is_answered, answered_original, answered_original_as_array, confidence_original, explanation, quotes, delete_generation, deleted_at) VALUES ('target-set-existing-judgment', 'target-set-article', 'target-set-prompt', 'target-model', TRUE, TRUE, FALSE, FALSE, FALSE, TRUE, 'existing', ['existing'], 50, 'Existing', CAST('[]' AS JSON), 0, NULL)")
    const escapeSql = (value) => String(value).replaceAll("'", "''")
    const jsonLiteral = (value) => "CAST('" + escapeSql(JSON.stringify(value)) + "' AS JSON)"
    const operationDatabase = (tx) => ({
      queryJson: tx.queryJson,
      run: tx.run,
      transaction: (work) => Promise.resolve(work(tx)),
    })
    const createOperationPayloadTable = (tx, tableName, rows) => {
      return tx.run(\`
        CREATE TEMP TABLE \${tableName} AS
        SELECT
          row_number() OVER () - 1 AS row_index,
          row_json AS payload_json
        FROM UNNEST(json_extract(\${jsonLiteral(rows)}, '$[*]')) AS rows(row_json)
      \`)
    }
    const settings = {humanJudgmentMode: 'prompt', useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true}
    const article = {
      articleTitle: 'Set Conflict Article',
      identifierInputs: [],
      provenance: {sourceArticleId: 'source-set-article'},
      signature: {identifierKeys: [], title: 'Set Conflict Article'},
      sourceArticleId: 'source-set-article',
    }
    const judgmentPayload = {
      answeredOriginal: 'new',
      answeredOriginalAsArray: ['new'],
      chunkingStrategy: null,
      confidenceOriginal: 60,
      contentSettings: settings,
      createdAt: '2026-05-02T00:00:00.000Z',
      deleteGeneration: 0,
      deletedAt: null,
      explanation: 'New',
      isAnswered: true,
      judgmentInputSignature: {},
      judgmentInputSignatureProvenance: {kind: 'currentReviewRows', version: 1},
      provenance: {sourceArticleId: 'source-set-article', sourceModelId: 'source-model', sourcePromptId: 'source-set-prompt'},
      quotes: [],
      signature: {},
      snapshotProjectId: 'source-project',
      snapshotProjectModelName: null,
      sourceArticleId: 'source-set-article',
      sourceJudgmentId: 'source-set-judgment',
      sourceModelId: 'source-model',
      sourceProjectId: 'source-project',
      sourcePromptId: 'source-set-prompt',
      updatedAt: '2026-05-03T00:00:00.000Z',
    }
    const targetPlan = {
      articleMatches: [
        {
          action: 'reuse',
          candidates: [],
          conflicts: [],
          identifierKeys: [],
          packageArticleId: null,
          selectedTargetArticleId: 'target-set-article',
          sourceArticleId: 'source-set-article',
        },
      ],
      judgmentAssessmentPlan: [],
      judgmentPlan: [
        {
          action: 'insert',
          conflictCodes: [],
          inputSignatureMatches: true,
          physicalKey: 'set-physical',
          provenanceKind: 'currentReviewRows',
          reviewVisibleKey: 'set-visible',
          sourceJudgmentId: 'source-set-judgment',
          targetArticleId: 'target-set-article',
          targetJudgmentId: 'new:judgment:source-set-judgment',
          targetModelId: 'target-model',
          targetPromptId: 'target-set-prompt',
        },
      ],
      humanReviewPlan: [],
      projectPromptPlan: [
        {
          enabled: true,
          metadata: {archived: false},
          order: 0,
          sourceProjectPromptId: 'source-set-project-prompt',
          sourcePromptId: 'source-set-prompt',
          targetPromptId: 'target-set-prompt',
        },
      ],
      promptPlan: [
        {
          action: 'reuse',
          computedContentHash: promptHash,
          packageContentHash: promptHash,
          sourcePromptId: 'source-set-prompt',
          targetPromptId: 'target-set-prompt',
        },
      ],
    }
    const payloads = {
      articles: [article],
      judgments: [{sourceJudgmentId: 'source-set-judgment'}],
      models: [getModelPayload()],
      project: getProjectPayload(settings),
      projectPrompts: [
        {
          archived: false,
          enabled: true,
          order: 0,
          provenance: {sourceProjectId: 'source-project', sourcePromptId: 'source-set-prompt'},
          signature: {},
          sourceProjectId: 'source-project',
          sourceProjectPromptId: 'source-set-project-prompt',
          sourcePromptId: 'source-set-prompt',
        },
      ],
      prompts: [
        {
          archived: false,
          contentHash: promptHash,
          originalText: 'Set conflict prompt?',
          promptHeading: 'Set conflict',
          provenance: {sourcePromptId: 'source-set-prompt'},
          signature: {},
          sourcePromptId: 'source-set-prompt',
          transformedText: null,
          type: 'system',
        },
      ],
    }
    const operationTables = getProjectTransferOperationTableNames('commit_set_conflict')
    const errorMessage = await catchMessage(() => {
      return database.transaction(async (tx) => {
        await createOperationPayloadTable(tx, operationTables.tableNames.articles, [article])
        await createOperationPayloadTable(tx, operationTables.tableNames.articleImportRoutes, [])
        await createOperationPayloadTable(tx, operationTables.tableNames.projectArticles, [])
        await createOperationPayloadTable(tx, operationTables.tableNames.judgments, [judgmentPayload])
        await createOperationPayloadTable(tx, operationTables.tableNames.judgmentAssessments, [])
        await createOperationPayloadTable(tx, operationTables.tableNames.humanJudgments, [])
        await createOperationPayloadTable(tx, operationTables.tableNames.humanJudgmentSummaries, [])
        await createOperationPayloadTable(tx, operationTables.tableNames.reviews, [])

        return writeProjectTransferCommitAppTables({
          commitId: 'commit-set-conflict',
          database: operationDatabase(tx),
          now,
          operationTables,
          payloads,
          plan: getBasePlan(targetPlan, dependencyResolution),
          promotion: {
            articleCreates: [],
            articleFieldFills: [],
            manifest: {createdAt: now.toISOString(), promotions: [], sessionId: 'session-set-conflict', updatedAt: now.toISOString()},
            promotionPathByPackagePath: {},
          },
          schemaVersion: 1,
          sessionId: 'session-set-conflict',
        })
      })
    })
    const [projectCount] = await database.queryJson("SELECT COUNT(*)::INTEGER AS count FROM app.project WHERE name = 'Imported Writer Project'")
    const [judgmentCount] = await database.queryJson("SELECT COUNT(*)::INTEGER AS count FROM app.judgment WHERE article_id = 'target-set-article'")

    console.log(JSON.stringify({errorMessage, judgmentCount: judgmentCount.count, projectCount: projectCount.count}))
  `)

  expect(result.errorMessage).toBe(
    "Project transfer commit writer: target judgment physical key already exists for source-set-judgment: existing judgment target-set-existing-judgment has the same article target-set-article (existing row reused by this import), prompt target-set-prompt (existing row reused by this import), model target-model (existing row reused by this import for package model source-model), content flags, system prompt variant and delete generation, but the import analysis planned to insert a new judgment (the target changed after the analysis, or the analysis mapped a different article, prompt or model). Rerun the import analysis; if it repeats, map the package's provider and model to existing ones in the dependencies step.",
  )
  expect(result.projectCount).toBe(0)
  expect(result.judgmentCount).toBe(1)
})

test('project transfer commit writer stores judgment system prompt variants and keeps other variants distinct', () => {
  const result = runCommitWriterScript<{
    deltaRows: Array<{
      contentFlagSystemPromptVariant: string | null
      judgmentId: string
      projectId: string
      systemPromptVariant: string | null
    }>
    judgmentRows: Array<{answeredOriginal: string; articleId: string; id: string; systemPromptVariant: string}>
    projectId: string
    projectSystemPromptVariant: string | null
  }>(`
    await database.run("INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode) VALUES ('target-provider', 'openai', 'Target Provider', TRUE, 'none')")
    await database.run("INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled) VALUES ('target-model', 'target-provider', 'target-model-name', 'target-remote', 'Target Model', 'manual', TRUE)")
    const promptHash = computePromptContentHash('Variant prompt?', null, 'Variant', 'system')
    await database.run("INSERT INTO app.prompt (id, original_text, transformed_text, prompt_heading, type, content_hash, archived) VALUES ('target-prompt-variant', 'Variant prompt?', NULL, 'Variant', 'system', '" + promptHash + "', FALSE)")
    await database.run("INSERT INTO app.article (id, article_title) VALUES ('target-variant-article', 'Variant Article'), ('target-old-article', 'Old Package Article')")
    await database.run("INSERT INTO app.judgment (id, article_id, prompt_id, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images, is_answered, answered_original, answered_original_as_array, confidence_original, explanation, quotes, delete_generation, deleted_at) VALUES ('target-legacy-judgment', 'target-variant-article', 'target-prompt-variant', 'target-model', TRUE, TRUE, FALSE, FALSE, TRUE, 'existing-legacy', ['existing-legacy'], 50, 'Existing legacy', CAST('[]' AS JSON), 0, NULL)")
    const settings = {
      humanJudgmentMode: 'prompt',
      systemPromptVariant: 'screening_v1',
      useAbstract: true,
      useFulltext: false,
      useFulltextNoImages: false,
      useTitle: true,
    }
    const contentSettings = {useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true}
    const getArticlePayload = (sourceArticleId, articleTitle) => ({
      articleTitle,
      identifierInputs: [],
      provenance: {sourceArticleId},
      signature: {identifierKeys: [], title: articleTitle},
      sourceArticleId,
    })
    const getArticleMatch = (sourceArticleId, selectedTargetArticleId) => ({
      action: 'reuse',
      candidates: [],
      conflicts: [],
      identifierKeys: [],
      packageArticleId: null,
      selectedTargetArticleId,
      sourceArticleId,
    })
    const getProjectArticlePayload = (sourceArticleId) => ({
      provenance: {sourceArticleId, sourceProjectId: 'source-project'},
      signature: {},
      sourceArticleId,
      sourceProjectArticleId: 'source-project-article-' + sourceArticleId,
      sourceProjectId: 'source-project',
    })
    const getJudgmentPlanEntry = (sourceJudgmentId, targetArticleId) => ({
      action: 'insert',
      conflictCodes: [],
      inputSignatureMatches: true,
      physicalKey: sourceJudgmentId + '-physical',
      provenanceKind: 'currentReviewRows',
      reviewVisibleKey: sourceJudgmentId + '-visible',
      sourceJudgmentId,
      targetArticleId,
      targetJudgmentId: 'new:judgment:' + sourceJudgmentId,
      targetModelId: 'target-model',
      targetPromptId: 'target-prompt-variant',
    })
    const getJudgmentPayload = (sourceJudgmentId, sourceArticleId, answer) => ({
      answeredOriginal: answer,
      answeredOriginalAsArray: [answer],
      confidenceOriginal: 80,
      contentSettings,
      deleteGeneration: 0,
      explanation: answer + ' explanation',
      isAnswered: true,
      judgmentInputSignature: {},
      judgmentInputSignatureProvenance: {kind: 'currentReviewRows', version: 1},
      provenance: {sourceArticleId, sourceModelId: 'source-model', sourcePromptId: 'source-variant-prompt'},
      quotes: [],
      signature: {},
      sourceArticleId,
      sourceJudgmentId,
      sourceModelId: 'source-model',
      sourcePromptId: 'source-variant-prompt',
    })
    const targetPlan = {
      articleMatches: [
        getArticleMatch('source-variant-article', 'target-variant-article'),
        getArticleMatch('source-old-article', 'target-old-article'),
      ],
      judgmentPlan: [
        getJudgmentPlanEntry('source-screening-judgment', 'target-variant-article'),
        getJudgmentPlanEntry('source-old-package-judgment', 'target-old-article'),
      ],
      projectPromptPlan: [
        {
          enabled: true,
          metadata: {archived: false},
          order: 0,
          sourceProjectPromptId: 'source-variant-project-prompt',
          sourcePromptId: 'source-variant-prompt',
          targetPromptId: 'target-prompt-variant',
        },
      ],
      promptPlan: [
        {
          action: 'reuse',
          computedContentHash: promptHash,
          packageContentHash: promptHash,
          sourcePromptId: 'source-variant-prompt',
          targetPromptId: 'target-prompt-variant',
        },
      ],
    }
    const writeResult = await writeProjectTransferCommitAppTables({
      commitId: 'commit-judgment-variant',
      now,
      payloads: {
        articles: [
          getArticlePayload('source-variant-article', 'Variant Article'),
          getArticlePayload('source-old-article', 'Old Package Article'),
        ],
        judgments: [
          {...getJudgmentPayload('source-screening-judgment', 'source-variant-article', 'screening-answer'), systemPromptVariant: 'screening_v1'},
          getJudgmentPayload('source-old-package-judgment', 'source-old-article', 'old-package-answer'),
        ],
        models: [getModelPayload()],
        project: getProjectPayload(settings),
        projectArticles: [getProjectArticlePayload('source-variant-article'), getProjectArticlePayload('source-old-article')],
        projectPrompts: [
          {
            archived: false,
            enabled: true,
            order: 0,
            provenance: {sourceProjectId: 'source-project', sourcePromptId: 'source-variant-prompt'},
            signature: {},
            sourceProjectId: 'source-project',
            sourceProjectPromptId: 'source-variant-project-prompt',
            sourcePromptId: 'source-variant-prompt',
          },
        ],
        prompts: [
          {
            archived: false,
            contentHash: promptHash,
            originalText: 'Variant prompt?',
            promptHeading: 'Variant',
            provenance: {sourcePromptId: 'source-variant-prompt'},
            signature: {},
            sourcePromptId: 'source-variant-prompt',
            transformedText: null,
            type: 'system',
          },
        ],
      },
      plan: getBasePlan(targetPlan, dependencyResolution),
      promotion: {
        articleCreates: [],
        articleFieldFills: [],
        manifest: {createdAt: now.toISOString(), promotions: [], sessionId: 'session-judgment-variant', updatedAt: now.toISOString()},
        promotionPathByPackagePath: {},
      },
      schemaVersion: 1,
      sessionId: 'session-judgment-variant',
    })
    const [projectRow] = await database.queryJson("SELECT system_prompt_variant AS systemPromptVariant FROM app.project WHERE id = '" + writeResult.projectId + "'")
    const judgmentRows = await database.queryJson("SELECT id, article_id AS articleId, answered_original AS answeredOriginal, system_prompt_variant AS systemPromptVariant FROM app.judgment WHERE prompt_id = 'target-prompt-variant' ORDER BY article_id ASC, system_prompt_variant ASC")
    const deltaRows = await database.queryJson("SELECT judgment_id AS judgmentId, project_id AS projectId, system_prompt_variant AS systemPromptVariant, json_extract_string(payload_json, '$.contentFlags.systemPromptVariant') AS contentFlagSystemPromptVariant FROM app.review_change_delta WHERE change_kind = 'judgment.llm.created' ORDER BY judgment_id ASC")

    console.log(JSON.stringify({
      deltaRows,
      judgmentRows,
      projectId: writeResult.projectId,
      projectSystemPromptVariant: projectRow.systemPromptVariant,
    }))
  `)
  const screeningJudgment = result.judgmentRows.find((row) => {
    return row.answeredOriginal === 'screening-answer'
  })

  expect(result.projectSystemPromptVariant).toBe('screening_v1')
  expect(
    result.judgmentRows.map((row) => {
      return {
        answeredOriginal: row.answeredOriginal,
        articleId: row.articleId,
        systemPromptVariant: row.systemPromptVariant,
      }
    }),
  ).toEqual([
    {answeredOriginal: 'old-package-answer', articleId: 'target-old-article', systemPromptVariant: 'legacy'},
    {answeredOriginal: 'existing-legacy', articleId: 'target-variant-article', systemPromptVariant: 'legacy'},
    {answeredOriginal: 'screening-answer', articleId: 'target-variant-article', systemPromptVariant: 'screening_v1'},
  ])
  expect(result.deltaRows).toEqual([
    {
      contentFlagSystemPromptVariant: 'screening_v1',
      judgmentId: screeningJudgment?.id ?? '',
      projectId: result.projectId,
      systemPromptVariant: 'screening_v1',
    },
  ])
})

test('project transfer commit writer stores use_metadata from the package and reads a missing flag as false', () => {
  const result = runCommitWriterScript<{
    deltaRows: Array<{
      contentFlagUseMetadata: boolean | null
      judgmentId: string
      projectId: string
      useMetadata: boolean | null
    }>
    judgmentRows: Array<{answeredOriginal: string; articleId: string; id: string; useMetadata: boolean}>
    projectId: string
    projectUseMetadata: boolean | null
  }>(`
    await database.run("INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode) VALUES ('target-provider', 'openai', 'Target Provider', TRUE, 'none')")
    await database.run("INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled) VALUES ('target-model', 'target-provider', 'target-model-name', 'target-remote', 'Target Model', 'manual', TRUE)")
    const promptHash = computePromptContentHash('Metadata prompt?', null, 'Metadata', 'system')
    await database.run("INSERT INTO app.prompt (id, original_text, transformed_text, prompt_heading, type, content_hash, archived) VALUES ('target-prompt-metadata', 'Metadata prompt?', NULL, 'Metadata', 'system', '" + promptHash + "', FALSE)")
    await database.run("INSERT INTO app.article (id, article_title) VALUES ('target-metadata-article', 'Metadata Article'), ('target-old-article', 'Old Package Article')")
    await database.run("INSERT INTO app.judgment (id, article_id, prompt_id, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images, is_answered, answered_original, answered_original_as_array, confidence_original, explanation, quotes, delete_generation, deleted_at) VALUES ('target-plain-judgment', 'target-metadata-article', 'target-prompt-metadata', 'target-model', TRUE, TRUE, FALSE, FALSE, TRUE, 'existing-plain', ['existing-plain'], 50, 'Existing plain', CAST('[]' AS JSON), 0, NULL)")
    const settings = {
      humanJudgmentMode: 'prompt',
      useAbstract: true,
      useFulltext: false,
      useFulltextNoImages: false,
      useMetadata: true,
      useTitle: true,
    }
    const contentSettings = {useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true}
    const getArticlePayload = (sourceArticleId, articleTitle) => ({
      articleTitle,
      identifierInputs: [],
      provenance: {sourceArticleId},
      signature: {identifierKeys: [], title: articleTitle},
      sourceArticleId,
    })
    const getArticleMatch = (sourceArticleId, selectedTargetArticleId) => ({
      action: 'reuse',
      candidates: [],
      conflicts: [],
      identifierKeys: [],
      packageArticleId: null,
      selectedTargetArticleId,
      sourceArticleId,
    })
    const getProjectArticlePayload = (sourceArticleId) => ({
      provenance: {sourceArticleId, sourceProjectId: 'source-project'},
      signature: {},
      sourceArticleId,
      sourceProjectArticleId: 'source-project-article-' + sourceArticleId,
      sourceProjectId: 'source-project',
    })
    const getJudgmentPlanEntry = (sourceJudgmentId, targetArticleId) => ({
      action: 'insert',
      conflictCodes: [],
      inputSignatureMatches: true,
      physicalKey: sourceJudgmentId + '-physical',
      provenanceKind: 'currentReviewRows',
      reviewVisibleKey: sourceJudgmentId + '-visible',
      sourceJudgmentId,
      targetArticleId,
      targetJudgmentId: 'new:judgment:' + sourceJudgmentId,
      targetModelId: 'target-model',
      targetPromptId: 'target-prompt-metadata',
    })
    const getJudgmentPayload = (sourceJudgmentId, sourceArticleId, answer) => ({
      answeredOriginal: answer,
      answeredOriginalAsArray: [answer],
      confidenceOriginal: 80,
      contentSettings,
      deleteGeneration: 0,
      explanation: answer + ' explanation',
      isAnswered: true,
      judgmentInputSignature: {},
      judgmentInputSignatureProvenance: {kind: 'currentReviewRows', version: 1},
      provenance: {sourceArticleId, sourceModelId: 'source-model', sourcePromptId: 'source-metadata-prompt'},
      quotes: [],
      signature: {},
      sourceArticleId,
      sourceJudgmentId,
      sourceModelId: 'source-model',
      sourcePromptId: 'source-metadata-prompt',
    })
    const targetPlan = {
      articleMatches: [
        getArticleMatch('source-metadata-article', 'target-metadata-article'),
        getArticleMatch('source-old-article', 'target-old-article'),
      ],
      judgmentPlan: [
        getJudgmentPlanEntry('source-metadata-judgment', 'target-metadata-article'),
        getJudgmentPlanEntry('source-old-package-judgment', 'target-old-article'),
      ],
      projectPromptPlan: [
        {
          enabled: true,
          metadata: {archived: false},
          order: 0,
          sourceProjectPromptId: 'source-metadata-project-prompt',
          sourcePromptId: 'source-metadata-prompt',
          targetPromptId: 'target-prompt-metadata',
        },
      ],
      promptPlan: [
        {
          action: 'reuse',
          computedContentHash: promptHash,
          packageContentHash: promptHash,
          sourcePromptId: 'source-metadata-prompt',
          targetPromptId: 'target-prompt-metadata',
        },
      ],
    }
    const writeResult = await writeProjectTransferCommitAppTables({
      commitId: 'commit-judgment-metadata',
      now,
      payloads: {
        articles: [
          getArticlePayload('source-metadata-article', 'Metadata Article'),
          getArticlePayload('source-old-article', 'Old Package Article'),
        ],
        judgments: [
          {
            ...getJudgmentPayload('source-metadata-judgment', 'source-metadata-article', 'metadata-answer'),
            contentSettings: {...contentSettings, useMetadata: true},
          },
          getJudgmentPayload('source-old-package-judgment', 'source-old-article', 'old-package-answer'),
        ],
        models: [getModelPayload()],
        project: getProjectPayload(settings),
        projectArticles: [getProjectArticlePayload('source-metadata-article'), getProjectArticlePayload('source-old-article')],
        projectPrompts: [
          {
            archived: false,
            enabled: true,
            order: 0,
            provenance: {sourceProjectId: 'source-project', sourcePromptId: 'source-metadata-prompt'},
            signature: {},
            sourceProjectId: 'source-project',
            sourceProjectPromptId: 'source-metadata-project-prompt',
            sourcePromptId: 'source-metadata-prompt',
          },
        ],
        prompts: [
          {
            archived: false,
            contentHash: promptHash,
            originalText: 'Metadata prompt?',
            promptHeading: 'Metadata',
            provenance: {sourcePromptId: 'source-metadata-prompt'},
            signature: {},
            sourcePromptId: 'source-metadata-prompt',
            transformedText: null,
            type: 'system',
          },
        ],
      },
      plan: getBasePlan(targetPlan, dependencyResolution),
      promotion: {
        articleCreates: [],
        articleFieldFills: [],
        manifest: {createdAt: now.toISOString(), promotions: [], sessionId: 'session-judgment-metadata', updatedAt: now.toISOString()},
        promotionPathByPackagePath: {},
      },
      schemaVersion: 1,
      sessionId: 'session-judgment-metadata',
    })
    const [projectRow] = await database.queryJson("SELECT use_metadata AS useMetadata FROM app.project WHERE id = '" + writeResult.projectId + "'")
    const judgmentRows = await database.queryJson("SELECT id, article_id AS articleId, answered_original AS answeredOriginal, use_metadata AS useMetadata FROM app.judgment WHERE prompt_id = 'target-prompt-metadata' ORDER BY article_id ASC, use_metadata ASC")
    const deltaRows = await database.queryJson("SELECT judgment_id AS judgmentId, project_id AS projectId, use_metadata AS useMetadata, TRY_CAST(json_extract_string(payload_json, '$.contentFlags.useMetadata') AS BOOLEAN) AS contentFlagUseMetadata FROM app.review_change_delta WHERE change_kind = 'judgment.llm.created' ORDER BY judgment_id ASC")

    console.log(JSON.stringify({
      deltaRows,
      judgmentRows,
      projectId: writeResult.projectId,
      projectUseMetadata: projectRow.useMetadata,
    }))
  `)
  const metadataJudgment = result.judgmentRows.find((row) => {
    return row.answeredOriginal === 'metadata-answer'
  })

  expect(result.projectUseMetadata).toBe(true)
  expect(
    result.judgmentRows.map((row) => {
      return {answeredOriginal: row.answeredOriginal, articleId: row.articleId, useMetadata: row.useMetadata}
    }),
  ).toEqual([
    {answeredOriginal: 'existing-plain', articleId: 'target-metadata-article', useMetadata: false},
    {answeredOriginal: 'metadata-answer', articleId: 'target-metadata-article', useMetadata: true},
    {answeredOriginal: 'old-package-answer', articleId: 'target-old-article', useMetadata: false},
  ])
  expect(result.deltaRows).toEqual([
    {
      contentFlagUseMetadata: true,
      judgmentId: metadataJudgment?.id ?? '',
      projectId: result.projectId,
      useMetadata: true,
    },
  ])
})

test('project transfer commit writer blocks extra target assessment state on reused judgments', () => {
  const result = runCommitWriterScript<{assessmentCount: number; errorMessage: string | null; projectCount: number}>(`
    await database.run("INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode) VALUES ('target-provider', 'openai', 'Target Provider', TRUE, 'none')")
    await database.run("INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled) VALUES ('target-model', 'target-provider', 'target-model-name', 'target-remote', 'Target Model', 'manual', TRUE)")
    const promptHash = computePromptContentHash('Extra assessment prompt?', null, 'Extra', 'system')
    await database.run("INSERT INTO app.prompt (id, original_text, transformed_text, prompt_heading, type, content_hash, archived) VALUES ('target-prompt-extra', 'Extra assessment prompt?', NULL, 'Extra', 'system', '" + promptHash + "', FALSE)")
    await database.run("INSERT INTO app.article (id, article_title) VALUES ('target-extra-article', 'Extra Assessment Article')")
    await database.run("INSERT INTO app.judgment (id, article_id, prompt_id, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images, is_answered, answered_original, answered_original_as_array, confidence_original, explanation, quotes, delete_generation, deleted_at) VALUES ('target-judgment-extra', 'target-extra-article', 'target-prompt-extra', 'target-model', TRUE, TRUE, FALSE, FALSE, TRUE, 'include', ['include'], 50, 'Equivalent', CAST('[]' AS JSON), 0, NULL)")
    await database.run("INSERT INTO app.judgment_assessment (id, judgment_id, assessment_is_correct, assessment_comment) VALUES ('target-assessment-extra', 'target-judgment-extra', TRUE, 'Extra state')")
    const settings = {humanJudgmentMode: 'prompt', useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true}
    const article = {
      articleTitle: 'Extra Assessment Article',
      identifierInputs: [],
      provenance: {sourceArticleId: 'source-extra-article'},
      signature: {identifierKeys: [], title: 'Extra Assessment Article'},
      sourceArticleId: 'source-extra-article',
    }
    const promptPayload = {
      archived: false,
      contentHash: promptHash,
      originalText: 'Extra assessment prompt?',
      promptHeading: 'Extra',
      provenance: {sourcePromptId: 'source-extra-prompt'},
      signature: {},
      sourcePromptId: 'source-extra-prompt',
      transformedText: null,
      type: 'system',
    }
    const targetPlan = {
      articleMatches: [
        {
          action: 'reuse',
          candidates: [],
          conflicts: [],
          identifierKeys: [],
          packageArticleId: null,
          selectedTargetArticleId: 'target-extra-article',
          sourceArticleId: 'source-extra-article',
        },
      ],
      judgmentPlan: [
        {
          action: 'reuse',
          conflictCodes: [],
          inputSignatureMatches: true,
          physicalKey: 'extra-physical',
          provenanceKind: 'currentReviewRows',
          reviewVisibleKey: 'extra-visible',
          sourceJudgmentId: 'source-extra-judgment',
          targetArticleId: 'target-extra-article',
          targetJudgmentId: 'target-judgment-extra',
          targetModelId: 'target-model',
          targetPromptId: 'target-prompt-extra',
        },
      ],
      projectPromptPlan: [
        {
          enabled: true,
          metadata: {archived: false},
          order: 0,
          sourceProjectPromptId: 'source-extra-project-prompt',
          sourcePromptId: 'source-extra-prompt',
          targetPromptId: 'target-prompt-extra',
        },
      ],
      promptPlan: [
        {
          action: 'reuse',
          computedContentHash: promptHash,
          packageContentHash: promptHash,
          sourcePromptId: 'source-extra-prompt',
          targetPromptId: 'target-prompt-extra',
        },
      ],
    }
    const errorMessage = await catchMessage(() => {
      return writeProjectTransferCommitAppTables({
        commitId: 'commit-extra-assessment',
        now,
        payloads: {
          articles: [article],
          judgments: [
            {
              answeredOriginal: 'include',
              answeredOriginalAsArray: ['include'],
              confidenceOriginal: 50,
              contentSettings: settings,
              deleteGeneration: 0,
              explanation: 'Equivalent',
              isAnswered: true,
              judgmentInputSignature: {},
              judgmentInputSignatureProvenance: {kind: 'currentReviewRows', version: 1},
              provenance: {sourceArticleId: 'source-extra-article', sourceModelId: 'source-model', sourcePromptId: 'source-extra-prompt'},
              quotes: [],
              signature: {},
              sourceArticleId: 'source-extra-article',
              sourceJudgmentId: 'source-extra-judgment',
              sourceModelId: 'source-model',
              sourcePromptId: 'source-extra-prompt',
            },
          ],
          models: [getModelPayload()],
          project: getProjectPayload(settings),
          projectPrompts: [
            {
              archived: false,
              enabled: true,
              order: 0,
              provenance: {sourceProjectId: 'source-project', sourcePromptId: 'source-extra-prompt'},
              signature: {},
              sourceProjectId: 'source-project',
              sourceProjectPromptId: 'source-extra-project-prompt',
              sourcePromptId: 'source-extra-prompt',
            },
          ],
          prompts: [promptPayload],
        },
        plan: getBasePlan(targetPlan, dependencyResolution),
        promotion: {
          articleCreates: [],
          articleFieldFills: [],
          manifest: {createdAt: now.toISOString(), promotions: [], sessionId: 'session-extra-assessment', updatedAt: now.toISOString()},
          promotionPathByPackagePath: {},
        },
        schemaVersion: 1,
        sessionId: 'session-extra-assessment',
      })
    })
    const [projectCount] = await database.queryJson("SELECT COUNT(*)::INTEGER AS count FROM app.project WHERE name = 'Imported Writer Project'")
    const [assessmentCount] = await database.queryJson("SELECT COUNT(*)::INTEGER AS count FROM app.judgment_assessment WHERE judgment_id = 'target-judgment-extra'")

    console.log(JSON.stringify({assessmentCount: assessmentCount.count, errorMessage, projectCount: projectCount.count}))
  `)

  expect(result.errorMessage).toContain('has assessment state missing from package')
  expect(result.projectCount).toBe(0)
  expect(result.assessmentCount).toBe(1)
})
