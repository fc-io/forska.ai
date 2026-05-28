import {mkdtempSync, rmSync} from 'node:fs'
import {mkdir, readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'

import {expect, test} from 'bun:test'

import type {ProjectTransferSessionRecord} from '../../../db/schemaTypes.ts'
import type {
  ProjectTransferImportAnalysisArtifact,
  ProjectTransferImportPlanArtifact,
} from './projectTransferAnalyze.ts'
import {
  commitProjectTransferImportSession,
  type ProjectTransferCommitInput,
  type ProjectTransferCommitResult,
} from './projectTransferCommit.ts'
import {getProjectTransferCanonicalJson} from './projectTransferFingerprint.ts'
import type {ProjectTransferPlanSummary} from './projectTransferSession.ts'
import {getProjectTransferImportTempLayout} from './projectTransferSession.ts'

type MutableSessionRepository = NonNullable<ProjectTransferCommitInput['repositories']>['sessionRepository']
type RevalidateInput = Parameters<NonNullable<NonNullable<ProjectTransferCommitInput['repositories']>['revalidate']>>[0]

const getRuntimeRoot = () => {
  return mkdtempSync(join(tmpdir(), `f2-project-transfer-commit-${process.pid}-`))
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

const getReadySummary = (overrides?: Partial<ProjectTransferPlanSummary>): ProjectTransferPlanSummary => {
  return {
    blockerCount: 0,
    blockers: [],
    conflictCounts: getFinalConflictCounts(),
    dependencyStatuses: {},
    judgmentConflictStatus: 'clear',
    overlapCounts: getFinalOverlapCounts(),
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
    packageCounts: {
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
    },
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

const getAnalysis = (planRevision: number): ProjectTransferImportAnalysisArtifact => {
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
    } as ProjectTransferImportAnalysisArtifact['manifest'],
    packageCounts: getPlan({planRevision}).packageCounts,
    packageFingerprint: 'fingerprint-commit',
    packageWarnings: [],
    payloads: {},
    planRevision,
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
  const layout = getProjectTransferImportTempLayout(sessionId)
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
  const calls: {reopen: unknown[]; transition: unknown[]; updatePlan: unknown[]} = {
    reopen: [],
    transition: [],
    updatePlan: [],
  }
  let session = initialSession
  const repository: MutableSessionRepository = {
    getProjectTransferSession: async () => {
      return session
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
              state: 'awaiting_resolution',
            }
          : session

      return session.state === 'awaiting_resolution' ? session : null
    },
    transitionProjectTransferSessionState: async (params) => {
      calls.transition = [...calls.transition, params]
      session =
        session.state === params.expectedState
        && session.ownerToken === null
        && session.planRevision === params.expectedPlanRevision
          ? {
              ...session,
              commitId: params.commitId ?? null,
              heartbeatAt: params.now ?? null,
              ownerToken: params.nextOwnerToken ?? null,
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
  repository,
  revalidate,
  sessionId = 'commit-session',
}: {
  cwd: string
  repository: MutableSessionRepository
  revalidate: NonNullable<ProjectTransferCommitInput['repositories']>['revalidate']
  sessionId?: string
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
      revalidate,
      sessionRepository: repository,
    },
    request: {planRevision: 1},
    sessionId,
  })
}

test('project transfer commit loads frozen artifacts and claims with server generated fencing ids', async () => {
  const cwd = getRuntimeRoot()

  try {
    const summary = getReadySummary()
    const plan = getPlan({planRevision: 1, summary})
    await writeArtifacts({analysis: getAnalysis(1), cwd, plan, sessionId: 'commit-session'})
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

    expect(result.status).toBe('claimed')
    expect(result.statusCode).toBe(202)
    expect(fake.getSession()).toMatchObject({
      commitId: 'commit-generated',
      ownerToken: 'owner-generated',
      state: 'committing',
    })
    expect(fake.calls.transition).toHaveLength(1)
    expect(fake.calls.updatePlan).toHaveLength(0)
    expect(revalidationInputs).toHaveLength(2)
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
