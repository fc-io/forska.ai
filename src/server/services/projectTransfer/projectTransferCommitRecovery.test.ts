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
    const {getProjectTransferSessionRepository} = await import('./src/server/services/projectTransfer/projectTransferSessionRepository.ts')

    await migrateDuckdb()

    const database = getAppDatabaseService()
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
