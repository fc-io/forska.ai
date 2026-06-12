import {rmSync} from 'node:fs'

import {expect, test} from 'bun:test'

const removeFileIfExists = (filePath: string) => {
  rmSync(filePath, {force: true, recursive: true})
}

const getLastJsonLine = (stdout: string) => {
  const lines = stdout
    .split('\n')
    .map((line) => {
      return line.trim()
    })
    .filter((line) => {
      return line !== ''
    })

  return lines.at(-1) ?? ''
}

const getSessionRepositoryScript = (body: string) => {
  return `
    const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
    const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
    const {
      getProjectTransferImportTempLayout,
      toProjectTransferSessionResponse,
    } = await import('./src/server/services/projectTransfer/projectTransferSession.ts')
    const {getProjectTransferSessionRepository} = await import('./src/server/services/projectTransfer/projectTransferSessionRepository.ts')

    await migrateDuckdb()

    const database = getAppDatabaseService()
    const sessionRepository = getProjectTransferSessionRepository()
    const expiresAt = new Date('2026-05-21T12:00:00.000Z')
    const getFinalConflictCounts = (packageContractConflictCount = 0) => {
      return {
        articleConflictCount: 0,
        humanReviewFidelityConflictCount: 0,
        judgmentConflictCount: 0,
        packageContractConflictCount,
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
    const readyPlan = {
      blockerCount: 0,
      conflictCounts: getFinalConflictCounts(),
      dependencyStatuses: {
        model: 'resolved',
        providerConnection: 'resolved',
      },
      overlapCounts: getFinalOverlapCounts(),
      warningCount: 0,
    }
    const catchMessage = async (operation) => {
      try {
        await operation()
        return null
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    }

    ${body}

    await database.close()
  `
}

const runSessionRepositoryScript = <T>(body: string) => {
  const duckdbPath = `/tmp/f2-project-transfer-session-repository-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}.duckdb`
  const result = globalThis.Bun.spawnSync(['bun', '-e', getSessionRepositoryScript(body)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      API_SERVER_PORT: '3001',
      DUCKDB_PATH: duckdbPath,
      SERVER_ROLE: 'dev-single',
      VITE_PORT: '3000',
    },
  })

  try {
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString() || result.stdout.toString() || 'Project transfer session test failed')
    }

    return JSON.parse(getLastJsonLine(result.stdout.toString())) as T
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
    removeFileIfExists(`${duckdbPath}.tmp`)
    removeFileIfExists(`${duckdbPath}.tmp/`)
    removeFileIfExists('/tmp/duckdb-temp')
  }
}

test('project transfer session ids must be path-safe before persistence or temp layout use', () => {
  const result = runSessionRepositoryScript<{
    createErrors: Array<string | null>
    layoutError: string | null
    persistedCount: number
  }>(`
    const invalidSessionIds = ['../bad', 'bad/id', 'bad\\\\id', ' bad']
    const createErrors = await Promise.all(invalidSessionIds.map((sessionId) => {
      return catchMessage(() => {
        return sessionRepository.createProjectTransferSession({
          direction: 'import',
          expiresAt,
          id: sessionId,
          state: 'queued',
        })
      })
    }))
    const layoutError = await catchMessage(() => {
      getProjectTransferImportTempLayout('../bad')
      return Promise.resolve()
    })
    const [{count}] = await database.queryJson(\`
      SELECT COUNT(*) AS count
      FROM app.project_transfer_session
    \`)

    console.log(JSON.stringify({
      createErrors,
      layoutError,
      persistedCount: Number(count),
    }))
  `)

  expect(result.createErrors).toEqual([
    'Project transfer session id must be path-safe',
    'Project transfer session id must be path-safe',
    'Project transfer session id must be path-safe',
    'Project transfer session id must be path-safe',
  ])
  expect(result.layoutError).toBe('Project transfer session id must be path-safe')
  expect(result.persistedCount).toBe(0)
})

test('project transfer session transitions reject stale plan revisions', () => {
  const result = runSessionRepositoryScript<{
    currentState: string
    currentRevision: number
    freshReadyState: string | null
    revisionAfterUpdate: number
    staleTransition: unknown
  }>(`
    await sessionRepository.createProjectTransferSession({
      direction: 'import',
      expiresAt,
      id: 'session-stale-revision',
      state: 'awaiting_resolution',
    })

    const revisionUpdate = await sessionRepository.updateProjectTransferSessionPlanRevision({
      expectedPlanRevision: 0,
      planSummary: readyPlan,
      sessionId: 'session-stale-revision',
    })
    const staleTransition = await sessionRepository.transitionProjectTransferSessionState({
      expectedPlanRevision: 0,
      expectedState: 'awaiting_resolution',
      nextState: 'ready_to_commit',
      planSummary: readyPlan,
      sessionId: 'session-stale-revision',
    })
    const freshTransition = await sessionRepository.transitionProjectTransferSessionState({
      expectedPlanRevision: 1,
      expectedState: 'awaiting_resolution',
      nextState: 'ready_to_commit',
      planSummary: readyPlan,
      sessionId: 'session-stale-revision',
    })
    const current = await sessionRepository.getProjectTransferSession({sessionId: 'session-stale-revision'})

    console.log(JSON.stringify({
      currentRevision: current?.planRevision ?? null,
      currentState: current?.state ?? null,
      freshReadyState: freshTransition?.state ?? null,
      revisionAfterUpdate: revisionUpdate?.planRevision ?? null,
      staleTransition,
    }))
  `)

  expect(result.revisionAfterUpdate).toBe(1)
  expect(result.staleTransition).toBeNull()
  expect(result.freshReadyState).toBe('ready_to_commit')
  expect(result.currentState).toBe('ready_to_commit')
  expect(result.currentRevision).toBe(1)
})

test('project transfer session repository normalizes DuckDB timestamps to Date objects', () => {
  const expectedExpiresAt = new Date('2026-05-21T12:00:00.000Z')
  const result = runSessionRepositoryScript<{
    createdAtIsDate: boolean
    expiresAtGetTime: number | null
    progressExpiresAt: string | null
    updatedAtIsDate: boolean
  }>(`
    await sessionRepository.createProjectTransferSession({
      direction: 'export',
      expiresAt,
      id: 'session-date-normalization',
      progress: {phase: 'export_assembly', status: 'pending'},
      state: 'queued',
    })

    const current = await sessionRepository.getProjectTransferSession({sessionId: 'session-date-normalization'})
    const response = current === null ? null : toProjectTransferSessionResponse(current)

    console.log(JSON.stringify({
      createdAtIsDate: current?.createdAt instanceof Date ?? false,
      expiresAtGetTime: response?.expiresAt.getTime() ?? null,
      progressExpiresAt: response?.progress?.expiresAt ?? null,
      updatedAtIsDate: current?.updatedAt instanceof Date ?? false,
    }))
  `)

  expect(result.createdAtIsDate).toBe(true)
  expect(result.expiresAtGetTime).toBe(expectedExpiresAt.getTime())
  expect(result.progressExpiresAt).toBe(expectedExpiresAt.toISOString())
  expect(result.updatedAtIsDate).toBe(true)
})

test('project transfer session plan revision update can publish final analyze state atomically', () => {
  const result = runSessionRepositoryScript<{
    ownerToken: string | null
    packageFingerprint: string | null
    planRevision: number | null
    progress: {phase: string; status: string; warningCount?: number | null} | null
    state: string | null
  }>(`
    await sessionRepository.createProjectTransferSession({
      direction: 'import',
      expiresAt,
      id: 'session-analyze-publish',
      state: 'extracting',
    })
    await sessionRepository.transitionProjectTransferSessionState({
      expectedState: 'extracting',
      nextOwnerToken: 'analyze-owner',
      nextState: 'analyzing',
      progress: {completedBytes: 4, phase: 'analyze', status: 'running', totalBytes: 4},
      sessionId: 'session-analyze-publish',
    })

    const updated = await sessionRepository.updateProjectTransferSessionPlanRevision({
      expectedOwnerToken: 'analyze-owner',
      expectedPlanRevision: 0,
      nextOwnerToken: null,
      nextState: 'ready_to_commit',
      packageFingerprint: 'package-fingerprint-analyze',
      planSummary: readyPlan,
      progress: {completedBytes: 4, phase: 'analyze', status: 'completed', totalBytes: 4, warningCount: 0},
      sessionId: 'session-analyze-publish',
    })

    console.log(JSON.stringify({
      ownerToken: updated?.ownerToken ?? null,
      packageFingerprint: updated?.packageFingerprint ?? null,
      planRevision: updated?.planRevision ?? null,
      progress: updated?.progressJson ?? null,
      state: updated?.state ?? null,
    }))
  `)

  expect(result).toEqual({
    ownerToken: null,
    packageFingerprint: 'package-fingerprint-analyze',
    planRevision: 1,
    progress: {completedBytes: 4, phase: 'analyze', status: 'completed', totalBytes: 4, warningCount: 0},
    state: 'ready_to_commit',
  })
})

test('project transfer session staging revision publish and reviewed-plan validation are atomic', () => {
  const result = runSessionRepositoryScript<{
    currentPlanRevision: number | null
    currentStagingRevision: number | null
    currentState: string | null
    freshClaimState: string | null
    freshUpdateRevision: number | null
    publishedRevision: number | null
    publishedStagingRevision: number | null
    staleClaim: unknown
    staleUpdate: unknown
  }>(`
    await sessionRepository.createProjectTransferSession({
      direction: 'import',
      expiresAt,
      id: 'session-staging-revision',
      state: 'awaiting_resolution',
    })

    const published = await sessionRepository.updateProjectTransferSessionPlanRevision({
      expectedPlanRevision: 0,
      expectedStagingRevision: null,
      nextState: 'awaiting_resolution',
      planSummary: {...readyPlan, dependencyStatuses: {model: 'missing'}},
      progress: {
        phase: 'analyze',
        staging: {stagingRevision: 7},
        stagingRevision: 7,
        status: 'completed',
      },
      sessionId: 'session-staging-revision',
    })
    const staleUpdate = await sessionRepository.updateProjectTransferSessionPlanRevision({
      expectedPlanRevision: 1,
      expectedStagingRevision: 6,
      nextState: 'ready_to_commit',
      planSummary: readyPlan,
      sessionId: 'session-staging-revision',
    })
    const freshUpdate = await sessionRepository.updateProjectTransferSessionPlanRevision({
      expectedPlanRevision: 1,
      expectedStagingRevision: 7,
      nextState: 'ready_to_commit',
      planSummary: readyPlan,
      sessionId: 'session-staging-revision',
    })
    const staleClaim = await sessionRepository.transitionProjectTransferSessionState({
      commitId: 'commit-stale-staging',
      expectedOwnerToken: null,
      expectedPlanRevision: 2,
      expectedStagingRevision: 6,
      expectedState: 'ready_to_commit',
      nextOwnerToken: 'owner-stale',
      nextState: 'committing',
      sessionId: 'session-staging-revision',
    })
    const freshClaim = await sessionRepository.transitionProjectTransferSessionState({
      commitId: 'commit-fresh-staging',
      expectedOwnerToken: null,
      expectedPlanRevision: 2,
      expectedStagingRevision: 7,
      expectedState: 'ready_to_commit',
      nextOwnerToken: 'owner-fresh',
      nextState: 'committing',
      sessionId: 'session-staging-revision',
    })
    const current = await sessionRepository.getProjectTransferSession({sessionId: 'session-staging-revision'})

    console.log(JSON.stringify({
      currentPlanRevision: current?.planRevision ?? null,
      currentStagingRevision: current?.progressJson?.stagingRevision ?? null,
      currentState: current?.state ?? null,
      freshClaimState: freshClaim?.state ?? null,
      freshUpdateRevision: freshUpdate?.planRevision ?? null,
      publishedRevision: published?.planRevision ?? null,
      publishedStagingRevision: published?.progressJson?.stagingRevision ?? null,
      staleClaim,
      staleUpdate,
    }))
  `)

  expect(result.publishedRevision).toBe(1)
  expect(result.publishedStagingRevision).toBe(7)
  expect(result.staleUpdate).toBeNull()
  expect(result.freshUpdateRevision).toBe(2)
  expect(result.staleClaim).toBeNull()
  expect(result.freshClaimState).toBe('committing')
  expect(result.currentState).toBe('committing')
  expect(result.currentPlanRevision).toBe(2)
  expect(result.currentStagingRevision).toBe(7)
})

test('project transfer ready transitions validate the explicitly persisted plan summary', () => {
  const result = runSessionRepositoryScript<{
    currentPlanSummary: unknown
    currentState: string | null
    readyError: string | null
  }>(`
    await sessionRepository.createProjectTransferSession({
      direction: 'import',
      expiresAt,
      id: 'session-explicit-null-plan',
      planSummary: readyPlan,
      state: 'awaiting_resolution',
    })

    const readyError = await catchMessage(() => {
      return sessionRepository.transitionProjectTransferSessionState({
        expectedState: 'awaiting_resolution',
        nextState: 'ready_to_commit',
        planSummary: null,
        sessionId: 'session-explicit-null-plan',
      })
    })
    const current = await sessionRepository.getProjectTransferSession({sessionId: 'session-explicit-null-plan'})

    console.log(JSON.stringify({
      currentPlanSummary: current?.planSummaryJson ?? null,
      currentState: current?.state ?? null,
      readyError,
    }))
  `)

  expect(result.readyError).toContain('Project transfer plan summary is required before ready_to_commit')
  expect(result.currentState).toBe('awaiting_resolution')
  expect(result.currentPlanSummary).toEqual({
    blockerCount: 0,
    conflictCounts: {
      articleConflictCount: 0,
      humanReviewFidelityConflictCount: 0,
      judgmentConflictCount: 0,
      packageContractConflictCount: 0,
      projectPromptConflictCount: 0,
    },
    dependencyStatuses: {model: 'resolved', providerConnection: 'resolved'},
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
})

test('project transfer session commit claims are single-flight and owner-token fenced', () => {
  const result = runSessionRepositoryScript<{
    completionOwner: string | null
    completionProjectId: string | null
    firstClaimExpiresAt: string | null
    firstClaimHeartbeatAt: string | null
    firstClaimOwner: string | null
    heartbeatExpiresAt: string | null
    heartbeatOwner: string | null
    mismatchHeartbeat: unknown
    mismatchTransition: unknown
    secondClaim: unknown
    stateAfterClaim: string | null
    stateAfterCompletion: string | null
  }>(`
    const commitExpiresAt = new Date('2026-05-21T13:00:00.000Z')
    await sessionRepository.createProjectTransferSession({
      direction: 'import',
      expiresAt: commitExpiresAt,
      id: 'session-commit-claim',
      planSummary: readyPlan,
      state: 'ready_to_commit',
    })

    const claimNow = new Date('2026-05-21T12:30:00.000Z')
    const firstClaim = await sessionRepository.transitionProjectTransferSessionState({
      commitId: 'commit-claim-1',
      expectedOwnerToken: null,
      expectedPlanRevision: 0,
      expectedState: 'ready_to_commit',
      nextOwnerLeaseMs: 60_000,
      nextOwnerToken: 'owner-a',
      nextState: 'committing',
      now: claimNow,
      sessionId: 'session-commit-claim',
    })
    const secondClaim = await sessionRepository.transitionProjectTransferSessionState({
      commitId: 'commit-claim-2',
      expectedOwnerToken: null,
      expectedPlanRevision: 0,
      expectedState: 'ready_to_commit',
      nextOwnerToken: 'owner-b',
      nextState: 'committing',
      sessionId: 'session-commit-claim',
    })
    const mismatchHeartbeat = await sessionRepository.heartbeatProjectTransferSessionOwner({
      leaseMs: 60_000,
      ownerToken: 'owner-b',
      sessionId: 'session-commit-claim',
    })
    const heartbeat = await sessionRepository.heartbeatProjectTransferSessionOwner({
      leaseMs: 60_000,
      ownerToken: 'owner-a',
      sessionId: 'session-commit-claim',
    })
    const mismatchTransition = await sessionRepository.transitionProjectTransferSessionState({
      error: {message: 'wrong owner'},
      expectedOwnerToken: 'owner-b',
      expectedState: 'committing',
      nextState: 'failed',
      sessionId: 'session-commit-claim',
    })
    const afterClaim = await sessionRepository.getProjectTransferSession({sessionId: 'session-commit-claim'})
    const completion = await sessionRepository.persistProjectTransferSessionCompletion({
      completionPayload: {
        packageFingerprint: 'fingerprint-claim',
        projectId: 'target-project-claim',
        projectName: 'Target Project Claim',
        status: 'completed',
      },
      expectedPlanRevision: 0,
      ownerToken: 'owner-a',
      sessionId: 'session-commit-claim',
    })
    const current = await sessionRepository.getProjectTransferSession({sessionId: 'session-commit-claim'})

    console.log(JSON.stringify({
      completionOwner: completion?.ownerToken ?? null,
      completionProjectId: completion?.completionPayloadJson?.projectId ?? null,
      firstClaimExpiresAt: firstClaim?.expiresAt ? new Date(firstClaim.expiresAt).toISOString() : null,
      firstClaimHeartbeatAt: firstClaim?.heartbeatAt ? new Date(firstClaim.heartbeatAt).toISOString() : null,
      firstClaimOwner: firstClaim?.ownerToken ?? null,
      heartbeatExpiresAt: heartbeat?.expiresAt ? new Date(heartbeat.expiresAt).toISOString() : null,
      heartbeatOwner: heartbeat?.ownerToken ?? null,
      mismatchHeartbeat,
      mismatchTransition,
      secondClaim,
      stateAfterClaim: afterClaim?.state ?? null,
      stateAfterCompletion: current?.state ?? null,
    }))
  `)

  expect(result.firstClaimOwner).toBe('owner-a')
  expect(result.firstClaimHeartbeatAt).toBe('2026-05-21T12:30:00.000Z')
  expect(result.firstClaimExpiresAt).toBe('2026-05-21T13:00:00.000Z')
  expect(result.heartbeatExpiresAt).toBe('2026-05-21T13:00:00.000Z')
  expect(result.secondClaim).toBeNull()
  expect(result.mismatchHeartbeat).toBeNull()
  expect(result.heartbeatOwner).toBe('owner-a')
  expect(result.mismatchTransition).toBeNull()
  expect(result.stateAfterClaim).toBe('committing')
  expect(result.stateAfterCompletion).toBe('completed')
  expect(result.completionOwner).toBeNull()
  expect(result.completionProjectId).toBe('target-project-claim')
})

test('project transfer export claims keep public expiry separate from owner heartbeat', () => {
  const result = runSessionRepositoryScript<{
    claimExpiresAt: string | null
    claimHeartbeatAt: string | null
    claimOwner: string | null
    currentCompletionStatus: string | null
    currentExpiresAt: string | null
    currentOwner: string | null
    currentState: string | null
    heartbeatExpiresAt: string | null
    failedErrorMessage: string | null
    failedExpiresAt: string | null
    failedOwner: string | null
    failedState: string | null
    packageFingerprint: string | null
    readyOwner: string | null
    readyState: string | null
  }>(`
    await sessionRepository.createProjectTransferSession({
      direction: 'export',
      expiresAt,
      id: 'export-session-claim',
      state: 'queued',
    })

    const claim = await sessionRepository.claimProjectTransferExportSessionOwner({
      expectedState: 'queued',
      nextState: 'assembling',
      now: new Date('2026-05-21T12:30:00.000Z'),
      ownerToken: 'export-owner-a',
      progress: {phase: 'export_assembly', status: 'running'},
      sessionId: 'export-session-claim',
    })
    const heartbeat = await sessionRepository.heartbeatProjectTransferExportSessionOwner({
      now: new Date('2026-05-21T12:31:00.000Z'),
      ownerToken: 'export-owner-a',
      progress: {bytesProcessed: 1, bytesTotal: 2, phase: 'export_assembly', status: 'running'},
      sessionId: 'export-session-claim',
    })
    await sessionRepository.claimProjectTransferExportSessionOwner({
      expectedState: 'assembling',
      nextState: 'packaging',
      ownerToken: 'export-owner-a',
      progress: {bytesProcessed: 2, bytesTotal: 2, phase: 'export_package', status: 'running'},
      sessionId: 'export-session-claim',
    })
    const ready = await sessionRepository.persistProjectTransferSessionExportReady({
      completionPayload: {
        byteLength: 123,
        checksumSha256: '${'a'.repeat(64)}',
        downloadUrl: '/api/projects/export/export-session-claim/download',
        expiresAt: expiresAt.toISOString(),
        filename: 'project-transfer.zip',
        packageFingerprint: 'fingerprint-export-ready',
        status: 'ready',
      },
      ownerToken: 'export-owner-a',
      progress: {bytesProcessed: 2, bytesTotal: 2, phase: 'export_package', status: 'completed'},
      sessionId: 'export-session-claim',
    })
    const current = await sessionRepository.getProjectTransferSession({sessionId: 'export-session-claim'})
    await sessionRepository.createProjectTransferSession({
      direction: 'export',
      expiresAt,
      id: 'export-session-fail',
      state: 'queued',
    })
    await sessionRepository.claimProjectTransferExportSessionOwner({
      expectedState: 'queued',
      nextState: 'assembling',
      ownerToken: 'export-owner-fail',
      sessionId: 'export-session-fail',
    })
    const failed = await sessionRepository.failProjectTransferSessionExport({
      error: {message: 'package failed'},
      now: new Date('2026-05-21T12:32:00.000Z'),
      ownerToken: 'export-owner-fail',
      progress: {phase: 'export_assembly', status: 'failed'},
      sessionId: 'export-session-fail',
    })

    console.log(JSON.stringify({
      claimExpiresAt: claim?.expiresAt ? new Date(claim.expiresAt).toISOString() : null,
      claimHeartbeatAt: claim?.heartbeatAt ? new Date(claim.heartbeatAt).toISOString() : null,
      claimOwner: claim?.ownerToken ?? null,
      currentCompletionStatus: current?.completionPayloadJson?.status ?? null,
      currentExpiresAt: current?.expiresAt ? new Date(current.expiresAt).toISOString() : null,
      currentOwner: current?.ownerToken ?? null,
      currentState: current?.state ?? null,
      failedErrorMessage: failed?.errorJson?.message ?? null,
      failedExpiresAt: failed?.expiresAt ? new Date(failed.expiresAt).toISOString() : null,
      failedOwner: failed?.ownerToken ?? null,
      failedState: failed?.state ?? null,
      heartbeatExpiresAt: heartbeat?.expiresAt ? new Date(heartbeat.expiresAt).toISOString() : null,
      packageFingerprint: current?.packageFingerprint ?? null,
      readyOwner: ready?.ownerToken ?? null,
      readyState: ready?.state ?? null,
    }))
  `)

  expect(result.claimOwner).toBe('export-owner-a')
  expect(result.claimHeartbeatAt).toBe('2026-05-21T12:30:00.000Z')
  expect(result.claimExpiresAt).toBe('2026-05-21T12:00:00.000Z')
  expect(result.heartbeatExpiresAt).toBe('2026-05-21T12:00:00.000Z')
  expect(result.readyOwner).toBeNull()
  expect(result.readyState).toBe('ready')
  expect(result.currentState).toBe('ready')
  expect(result.currentOwner).toBeNull()
  expect(result.currentExpiresAt).toBe('2026-05-21T12:00:00.000Z')
  expect(result.currentCompletionStatus).toBe('ready')
  expect(result.packageFingerprint).toBe('fingerprint-export-ready')
  expect(result.failedState).toBe('failed')
  expect(result.failedOwner).toBeNull()
  expect(result.failedExpiresAt).toBe('2026-05-21T12:00:00.000Z')
  expect(result.failedErrorMessage).toBe('package failed')
})

test('project transfer session progress updates reject regressed totals and accept monotonic progress', () => {
  const result = runSessionRepositoryScript<{
    afterProgress: {completedBytes?: number | null; phase: string; status: string; totalBytes?: number | null} | null
    firstProgress: {completedBytes?: number | null; phase: string; status: string; totalBytes?: number | null} | null
    phaseResetProgress: {
      completedBytes?: number | null
      phase: string
      status: string
      totalBytes?: number | null
    } | null
    regressionError: string | null
  }>(`
    await sessionRepository.createProjectTransferSession({
      direction: 'import',
      expiresAt,
      id: 'session-progress',
      state: 'uploading',
    })

    const firstProgress = await sessionRepository.updateProjectTransferSessionProgress({
      progress: {
        completedBytes: 2,
        phase: 'upload',
        status: 'running',
        totalBytes: 10,
      },
      sessionId: 'session-progress',
    })
    const regressionError = await catchMessage(() => {
      return sessionRepository.updateProjectTransferSessionProgress({
        progress: {
          completedBytes: 3,
          phase: 'upload',
          status: 'running',
          totalBytes: 9,
        },
        sessionId: 'session-progress',
      })
    })
    const afterProgress = await sessionRepository.updateProjectTransferSessionProgress({
      progress: {
        completedBytes: 3,
        phase: 'upload',
        status: 'running',
        totalBytes: 12,
      },
      sessionId: 'session-progress',
    })
    const phaseResetProgress = await sessionRepository.updateProjectTransferSessionProgress({
      progress: {
        completedBytes: 0,
        phase: 'commit',
        status: 'running',
        totalBytes: 5,
      },
      sessionId: 'session-progress',
    })

    console.log(JSON.stringify({
      afterProgress: afterProgress?.progressJson ?? null,
      firstProgress: firstProgress?.progressJson ?? null,
      phaseResetProgress: phaseResetProgress?.progressJson ?? null,
      regressionError,
    }))
  `)

  expect(result.firstProgress).toEqual({completedBytes: 2, phase: 'upload', status: 'running', totalBytes: 10})
  expect(result.regressionError).toContain('totalBytes must be monotonic')
  expect(result.afterProgress).toEqual({completedBytes: 3, phase: 'upload', status: 'running', totalBytes: 12})
  expect(result.phaseResetProgress).toEqual({completedBytes: 0, phase: 'commit', status: 'running', totalBytes: 5})
})

test('project transfer import cancellation is owner-fenced and marks terminal cleanup once', () => {
  const result = runSessionRepositoryScript<{
    cancelledOwner: string | null
    cancelledReason: string | null
    cancelledState: string | null
    cleanupAt: string | null
    staleCleanup: unknown
    staleOwnerCancel: unknown
  }>(`
    await sessionRepository.createProjectTransferSession({
      direction: 'import',
      expiresAt,
      id: 'session-cancel',
      state: 'analyzing',
    })

    const staleOwnerCancel = await sessionRepository.cancelProjectTransferImportSession({
      error: {cleanupTempArtifacts: true, reason: 'user_cancelled'},
      expectedOwnerToken: 'stale-owner',
      expectedState: ['analyzing'],
      nextState: 'cancelled',
      ownerToken: 'cancel-owner',
      sessionId: 'session-cancel',
    })
    const cancelled = await sessionRepository.cancelProjectTransferImportSession({
      error: {cleanupTempArtifacts: true, reason: 'user_cancelled'},
      expectedState: ['analyzing'],
      nextState: 'cancelled',
      now: new Date('2026-05-21T12:30:00.000Z'),
      ownerToken: 'cancel-owner',
      progress: {phase: 'cleanup', status: 'completed'},
      sessionId: 'session-cancel',
    })
    const staleCleanup = await sessionRepository.markProjectTransferSessionTerminalCleanupComplete({
      expectedOwnerToken: 'stale-owner',
      expectedState: 'cancelled',
      sessionId: 'session-cancel',
    })
    const cleanup = await sessionRepository.markProjectTransferSessionTerminalCleanupComplete({
      expectedOwnerToken: 'cancel-owner',
      expectedState: 'cancelled',
      now: new Date('2026-05-21T12:31:00.000Z'),
      sessionId: 'session-cancel',
    })

    console.log(JSON.stringify({
      cancelledOwner: cancelled?.ownerToken ?? null,
      cancelledReason: cancelled?.errorJson?.reason ?? null,
      cancelledState: cancelled?.state ?? null,
      cleanupAt: cleanup?.terminalCleanupAt ? new Date(cleanup.terminalCleanupAt).toISOString() : null,
      staleCleanup,
      staleOwnerCancel,
    }))
  `)

  expect(result.staleOwnerCancel).toBeNull()
  expect(result.cancelledState).toBe('cancelled')
  expect(result.cancelledOwner).toBe('cancel-owner')
  expect(result.cancelledReason).toBe('user_cancelled')
  expect(result.staleCleanup).toBeNull()
  expect(result.cleanupAt).toBe('2026-05-21T12:31:00.000Z')
})
