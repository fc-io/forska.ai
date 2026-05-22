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
    const {getProjectTransferImportTempLayout} = await import('./src/server/services/projectTransfer/projectTransferSession.ts')
    const {getProjectTransferSessionRepository} = await import('./src/server/services/projectTransfer/projectTransferSessionRepository.ts')

    await migrateDuckdb()

    const database = getAppDatabaseService()
    const sessionRepository = getProjectTransferSessionRepository()
    const expiresAt = new Date('2026-05-21T12:00:00.000Z')
    const readyPlan = {
      blockerCount: 0,
      conflictCounts: {
        articleIdentifier: 0,
        dependency: 0,
        humanReview: 0,
        judgment: 0,
        packageContract: 0,
        projectPrompt: 0,
      },
      dependencyStatuses: {
        model: 'resolved',
        providerConnection: 'resolved',
      },
      overlapCounts: {
        exactDuplicateImports: 0,
        reusedArticles: 0,
      },
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
      articleIdentifier: 0,
      dependency: 0,
      humanReview: 0,
      judgment: 0,
      packageContract: 0,
      projectPrompt: 0,
    },
    dependencyStatuses: {model: 'resolved', providerConnection: 'resolved'},
    overlapCounts: {exactDuplicateImports: 0, reusedArticles: 0},
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
    heartbeatOwner: string | null
    mismatchHeartbeat: unknown
    mismatchTransition: unknown
    secondClaim: unknown
    stateAfterClaim: string | null
    stateAfterCompletion: string | null
  }>(`
    await sessionRepository.createProjectTransferSession({
      direction: 'import',
      expiresAt,
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
  expect(result.firstClaimExpiresAt).toBe('2026-05-21T12:31:00.000Z')
  expect(result.secondClaim).toBeNull()
  expect(result.mismatchHeartbeat).toBeNull()
  expect(result.heartbeatOwner).toBe('owner-a')
  expect(result.mismatchTransition).toBeNull()
  expect(result.stateAfterClaim).toBe('committing')
  expect(result.stateAfterCompletion).toBe('completed')
  expect(result.completionOwner).toBeNull()
  expect(result.completionProjectId).toBe('target-project-claim')
})

test('project transfer session progress updates reject regressed totals and accept monotonic progress', () => {
  const result = runSessionRepositoryScript<{
    afterProgress: {completedBytes?: number | null; totalBytes?: number | null} | null
    firstProgress: {completedBytes?: number | null; totalBytes?: number | null} | null
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

    console.log(JSON.stringify({
      afterProgress: afterProgress?.progressJson ?? null,
      firstProgress: firstProgress?.progressJson ?? null,
      regressionError,
    }))
  `)

  expect(result.firstProgress).toEqual({completedBytes: 2, phase: 'upload', status: 'running', totalBytes: 10})
  expect(result.regressionError).toContain('totalBytes must be monotonic')
  expect(result.afterProgress).toEqual({completedBytes: 3, phase: 'upload', status: 'running', totalBytes: 12})
})
