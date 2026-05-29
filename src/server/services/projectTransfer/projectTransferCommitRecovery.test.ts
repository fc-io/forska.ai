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

const getCommitRecoveryScript = (body: string) => {
  return `
    const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
    const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
    const {commitProjectTransferImportSession} = await import('./src/server/services/projectTransfer/projectTransferCommit.ts')
    const {getProjectTransferHistoryRepository} = await import('./src/server/services/projectTransfer/projectTransferHistoryRepository.ts')
    const {getProjectTransferSessionRecoveryService} = await import('./src/server/services/projectTransfer/projectTransferSessionRecovery.ts')
    const {getProjectTransferSessionRepository} = await import('./src/server/services/projectTransfer/projectTransferSessionRepository.ts')

    await migrateDuckdb()

    const database = getAppDatabaseService()
    const historyRepository = getProjectTransferHistoryRepository()
    const recovery = getProjectTransferSessionRecoveryService()
    const sessionRepository = getProjectTransferSessionRepository()
    const expiresAt = new Date('2026-05-28T11:00:00.000Z')
    const readyPlan = {
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
    }

    ${body}

    await database.close()
  `
}

const runCommitRecoveryScript = <T>(body: string) => {
  const duckdbPath = `/tmp/f2-project-transfer-commit-recovery-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}.duckdb`
  const result = globalThis.Bun.spawnSync(['bun', '-e', getCommitRecoveryScript(body)], {
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
      throw new Error(result.stderr.toString() || result.stdout.toString() || 'Project transfer recovery test failed')
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

test('project transfer commit recovery reopens post-claim stale plans and clears fencing atomically', () => {
  const result = runCommitRecoveryScript<{
    heartbeatAfterReopen: string | null
    mismatch: unknown
    reopenedCommitId: string | null
    reopenedOwnerToken: string | null
    reopenedPlanRevision: number | null
    reopenedState: string | null
  }>(`
    await sessionRepository.createProjectTransferSession({
      direction: 'import',
      expiresAt,
      id: 'commit-recovery-session',
      planSummary: readyPlan,
      state: 'ready_to_commit',
    })

    const claimNow = new Date('2026-05-28T10:00:00.000Z')
    await sessionRepository.transitionProjectTransferSessionState({
      commitId: 'commit-1',
      expectedOwnerToken: null,
      expectedPlanRevision: 0,
      expectedState: 'ready_to_commit',
      nextOwnerToken: 'owner-1',
      nextState: 'committing',
      now: claimNow,
      sessionId: 'commit-recovery-session',
    })
    const mismatch = await sessionRepository.reopenProjectTransferCommitSession({
      commitId: 'commit-other',
      expectedPlanRevision: 0,
      ownerToken: 'owner-1',
      planSummary: {...readyPlan, blockerCount: 1},
      sessionId: 'commit-recovery-session',
    })
    const reopened = await sessionRepository.reopenProjectTransferCommitSession({
      commitId: 'commit-1',
      expectedPlanRevision: 0,
      ownerToken: 'owner-1',
      planSummary: {...readyPlan, blockerCount: 1},
      sessionId: 'commit-recovery-session',
    })

    console.log(JSON.stringify({
      heartbeatAfterReopen: reopened?.heartbeatAt ? new Date(reopened.heartbeatAt).toISOString() : null,
      mismatch,
      reopenedCommitId: reopened?.commitId ?? null,
      reopenedOwnerToken: reopened?.ownerToken ?? null,
      reopenedPlanRevision: reopened?.planRevision ?? null,
      reopenedState: reopened?.state ?? null,
    }))
  `)

  expect(result.mismatch).toBeNull()
  expect(result.reopenedState).toBe('awaiting_resolution')
  expect(result.reopenedPlanRevision).toBe(1)
  expect(result.reopenedOwnerToken).toBeNull()
  expect(result.reopenedCommitId).toBeNull()
  expect(result.heartbeatAfterReopen).toBe('2026-05-28T10:00:00.000Z')
})

test('project transfer commit retry reads completed import history before expired-session handling', () => {
  const result = runCommitRecoveryScript<{
    completionProjectId: string | null
    projectCount: number
    status: string
    statusCode: number
  }>(`
    await sessionRepository.createProjectTransferSession({
      direction: 'import',
      expiresAt: new Date('2026-05-28T10:00:00.000Z'),
      id: 'commit-history-retry-session',
      packageFingerprint: 'fingerprint-before-history',
      planSummary: readyPlan,
      state: 'ready_to_commit',
    })
    await historyRepository.createProjectTransferHistory({
      commitId: 'commit-history-retry',
      completionPayload: {
        packageFingerprint: 'fingerprint-history',
        projectId: 'target-project-history',
        projectName: 'Target Project History',
        status: 'completed',
        transferHistoryId: 'history-commit-retry',
      },
      direction: 'import',
      id: 'history-commit-retry',
      packageFingerprint: 'fingerprint-history',
      payloadCounts: {project: 1},
      schemaVersion: 1,
      sessionId: 'commit-history-retry-session',
      sourceProjectName: 'Source Project History',
      targetProjectId: 'target-project-history',
      targetProjectName: 'Target Project History',
    })

    const commitResult = await commitProjectTransferImportSession({
      now: new Date('2026-05-28T12:00:00.000Z'),
      repositories: {
        historyRepository,
        revalidate: async () => {
          throw new Error('unexpected revalidation')
        },
        runAppTableWrites: async () => {
          throw new Error('unexpected project creation')
        },
        sessionRepository,
      },
      request: {planRevision: 0},
      sessionId: 'commit-history-retry-session',
    })
    const [projectCount] = await database.queryJson("SELECT COUNT(*)::INTEGER AS count FROM app.project")

    console.log(JSON.stringify({
      completionProjectId: commitResult.status === 'completed' ? commitResult.completion.projectId ?? null : null,
      projectCount: projectCount.count,
      status: commitResult.status,
      statusCode: commitResult.statusCode,
    }))
  `)

  expect(result.status).toBe('completed')
  expect(result.statusCode).toBe(200)
  expect(result.completionProjectId).toBe('target-project-history')
  expect(result.projectCount).toBe(0)
})

test('project transfer stale committing recovery fails orphaned imports before expiry', () => {
  const result = runCommitRecoveryScript<{
    errorReason: string | null
    recoveryResult: {expiredSessionCount: number; recoveredCompletionCount: number; scannedSessionCount: number}
    state: string | null
    terminalCleanupAt: string | null
  }>(`
    await sessionRepository.createProjectTransferSession({
      direction: 'import',
      expiresAt: new Date('2026-05-28T12:00:00.000Z'),
      id: 'committing-stale-before-expiry',
      packageFingerprint: 'fingerprint-stale-before-expiry',
      planSummary: readyPlan,
      state: 'ready_to_commit',
    })
    await sessionRepository.transitionProjectTransferSessionState({
      commitId: 'commit-stale-before-expiry',
      expectedOwnerToken: null,
      expectedPlanRevision: 0,
      expectedState: 'ready_to_commit',
      nextOwnerLeaseMs: 60_000,
      nextOwnerToken: 'owner-stale-before-expiry',
      nextState: 'committing',
      now: new Date('2026-05-28T10:00:00.000Z'),
      sessionId: 'committing-stale-before-expiry',
    })

    const recoveryResult = await recovery.runProjectTransferStartupRecovery({
      batchSize: 10,
      cwd: '/tmp/f2-project-transfer-commit-recovery-artifacts',
      isActiveWriter: () => true,
      now: new Date('2026-05-28T10:10:00.000Z'),
      ownerToken: 'recovery-owner',
    })
    const session = await sessionRepository.getProjectTransferSession({sessionId: 'committing-stale-before-expiry'})

    console.log(JSON.stringify({
      errorReason: session?.errorJson?.reason ?? null,
      recoveryResult,
      state: session?.state ?? null,
      terminalCleanupAt: session?.terminalCleanupAt ? new Date(session.terminalCleanupAt).toISOString() : null,
    }))
  `)

  expect(result.recoveryResult.scannedSessionCount).toBe(1)
  expect(result.recoveryResult.recoveredCompletionCount).toBe(0)
  expect(result.recoveryResult.expiredSessionCount).toBe(0)
  expect(result.state).toBe('failed')
  expect(result.errorReason).toBe('project_transfer_import_commit_worker_stale')
  expect(result.terminalCleanupAt).toBe('2026-05-28T10:10:00.000Z')
})

test('project transfer stale committing recovery restores history-backed imports and expires orphans', () => {
  const result = runCommitRecoveryScript<{
    historyBackedCompletionProjectId: string | null
    historyBackedState: string | null
    orphanErrorReason: string | null
    orphanState: string | null
    recoveryResult: {expiredSessionCount: number; recoveredCompletionCount: number; scannedSessionCount: number}
  }>(`
    await sessionRepository.createProjectTransferSession({
      direction: 'import',
      expiresAt,
      id: 'committing-history-backed',
      packageFingerprint: 'fingerprint-before-history',
      planSummary: readyPlan,
      state: 'ready_to_commit',
    })
    await sessionRepository.createProjectTransferSession({
      direction: 'import',
      expiresAt,
      id: 'committing-orphan',
      packageFingerprint: 'fingerprint-orphan',
      planSummary: readyPlan,
      state: 'ready_to_commit',
    })
    await sessionRepository.transitionProjectTransferSessionState({
      commitId: 'commit-history-backed',
      expectedOwnerToken: null,
      expectedPlanRevision: 0,
      expectedState: 'ready_to_commit',
      nextOwnerLeaseMs: 60_000,
      nextOwnerToken: 'owner-history-backed',
      nextState: 'committing',
      now: new Date('2026-05-28T10:30:00.000Z'),
      sessionId: 'committing-history-backed',
    })
    await sessionRepository.transitionProjectTransferSessionState({
      commitId: 'commit-orphan',
      expectedOwnerToken: null,
      expectedPlanRevision: 0,
      expectedState: 'ready_to_commit',
      nextOwnerLeaseMs: 60_000,
      nextOwnerToken: 'owner-orphan',
      nextState: 'committing',
      now: new Date('2026-05-28T10:30:00.000Z'),
      sessionId: 'committing-orphan',
    })
    await historyRepository.createProjectTransferHistory({
      commitId: 'commit-history-backed',
      completionPayload: {
        packageFingerprint: 'fingerprint-history-backed',
        projectId: 'target-project-history-backed',
        projectName: 'Target Project History Backed',
        status: 'completed',
        transferHistoryId: 'history-backed',
      },
      direction: 'import',
      id: 'history-backed',
      packageFingerprint: 'fingerprint-history-backed',
      payloadCounts: {project: 1},
      schemaVersion: 1,
      sessionId: 'committing-history-backed',
      sourceProjectName: 'Source Project History Backed',
      targetProjectId: 'target-project-history-backed',
      targetProjectName: 'Target Project History Backed',
    })

    const recoveryResult = await recovery.runProjectTransferStartupRecovery({
      batchSize: 10,
      cwd: '/tmp/f2-project-transfer-commit-recovery-artifacts',
      isActiveWriter: () => true,
      now: new Date('2026-05-28T12:00:00.000Z'),
      ownerToken: 'recovery-owner',
    })
    const historyBacked = await sessionRepository.getProjectTransferSession({sessionId: 'committing-history-backed'})
    const orphan = await sessionRepository.getProjectTransferSession({sessionId: 'committing-orphan'})

    console.log(JSON.stringify({
      historyBackedCompletionProjectId: historyBacked?.completionPayloadJson?.projectId ?? null,
      historyBackedState: historyBacked?.state ?? null,
      orphanErrorReason: orphan?.errorJson?.reason ?? null,
      orphanState: orphan?.state ?? null,
      recoveryResult,
    }))
  `)

  expect(result.recoveryResult.scannedSessionCount).toBe(2)
  expect(result.recoveryResult.recoveredCompletionCount).toBe(1)
  expect(result.recoveryResult.expiredSessionCount).toBe(1)
  expect(result.historyBackedState).toBe('completed')
  expect(result.historyBackedCompletionProjectId).toBe('target-project-history-backed')
  expect(result.orphanState).toBe('expired')
  expect(result.orphanErrorReason).toBe('project_transfer_session_recovery_expired')
})
