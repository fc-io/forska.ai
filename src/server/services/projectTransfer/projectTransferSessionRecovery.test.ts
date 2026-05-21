import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

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

const getRecoveryScript = (body: string) => {
  return `
    const {access, mkdir, writeFile} = await import('node:fs/promises')
    const {dirname, join} = await import('node:path')
    const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
    const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
    const {getProjectTransferHistoryRepository} = await import('./src/server/services/projectTransfer/projectTransferHistoryRepository.ts')
    const {getProjectTransferImportTempLayout} = await import('./src/server/services/projectTransfer/projectTransferSession.ts')
    const {getProjectTransferSessionRecoveryService} = await import('./src/server/services/projectTransfer/projectTransferSessionRecovery.ts')
    const {getProjectTransferSessionRepository} = await import('./src/server/services/projectTransfer/projectTransferSessionRepository.ts')

    const runtimeRoot = process.env.TRANSFER_RUNTIME_ROOT
    if (!runtimeRoot) {
      throw new Error('TRANSFER_RUNTIME_ROOT is required')
    }

    await migrateDuckdb()

    const database = getAppDatabaseService()
    const sessionRepository = getProjectTransferSessionRepository()
    const historyRepository = getProjectTransferHistoryRepository()
    const recovery = getProjectTransferSessionRecoveryService()
    const now = new Date('2026-05-21T12:00:00.000Z')
    const expiredAt = new Date('2026-05-21T10:00:00.000Z')
    const futureAt = new Date('2026-05-21T14:00:00.000Z')
    const runtimePath = (pathValue) => {
      return join(runtimeRoot, pathValue)
    }
    const writeRuntimeFile = async (pathValue, content = 'test') => {
      const filePath = runtimePath(pathValue)
      await mkdir(dirname(filePath), {recursive: true})
      await writeFile(filePath, content)
      return filePath
    }
    const fileExists = async (pathValue) => {
      return access(runtimePath(pathValue)).then(() => true, () => false)
    }
    const getStates = async () => {
      const rows = await database.queryJson(\`
        SELECT id, state
        FROM app.project_transfer_session
        ORDER BY id ASC
      \`)

      return Object.fromEntries(rows.map((row) => {
        return [row.id, row.state]
      }))
    }
    const completedPayload = (projectId, projectName, packageFingerprint) => {
      return {
        packageFingerprint,
        projectId,
        projectName,
        status: 'completed',
      }
    }
    const promotionMetadata = (sessionId, promotedPath) => {
      return {
        byteLength: 4,
        checksumSha256: 'abc123',
        packagePath: 'assets/article-pdfs/article-1.pdf',
        promotedPath,
        sessionId,
      }
    }
    const writePromotionManifest = async (sessionId, metadata) => {
      const layout = getProjectTransferImportTempLayout(sessionId)
      await writeRuntimeFile(layout.promotionManifestPath, JSON.stringify(metadata))
    }

    ${body}

    await database.close()
  `
}

const runRecoveryScript = <T>(body: string) => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), `f2-project-transfer-recovery-${process.pid}-`))
  const duckdbPath = join(runtimeRoot, 'forska.duckdb')
  const result = globalThis.Bun.spawnSync(['bun', '-e', getRecoveryScript(body)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      API_SERVER_PORT: '3001',
      DUCKDB_PATH: duckdbPath,
      SERVER_ROLE: 'dev-single',
      TRANSFER_RUNTIME_ROOT: runtimeRoot,
      VITE_PORT: '3000',
    },
  })

  try {
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString() || result.stdout.toString() || 'Project transfer recovery test failed')
    }

    return JSON.parse(getLastJsonLine(result.stdout.toString())) as T
  } finally {
    removeFileIfExists(runtimeRoot)
  }
}

test('project transfer recovery runs only on active writer and batch-limits stale scans', () => {
  const result = runRecoveryScript<{
    afterBatchStates: Record<string, string>
    batchResult: {cleanupTempArtifactCount: number; expiredSessionCount: number; scannedSessionCount: number}
    skippedResult: {scannedSessionCount: number; skippedActiveWriterCheck: boolean}
    tempAfterBatch: Record<string, boolean>
    tempAfterSkipped: Record<string, boolean>
  }>(`
    const sessionIds = ['stale-a', 'stale-b', 'stale-c', 'future-a']
    await Promise.all(sessionIds.map(async (sessionId) => {
      const layout = getProjectTransferImportTempLayout(sessionId)
      await sessionRepository.createProjectTransferSession({
        direction: 'import',
        expiresAt: sessionId === 'future-a' ? futureAt : expiredAt,
        id: sessionId,
        state: 'queued',
      })
      await writeRuntimeFile(layout.uploadPath)
    }))

    const skippedResult = await recovery.runProjectTransferStartupRecovery({
      batchSize: 10,
      cwd: runtimeRoot,
      isActiveWriter: () => false,
      now,
      ownerToken: 'recovery-owner',
    })
    const tempAfterSkipped = Object.fromEntries(await Promise.all(sessionIds.map(async (sessionId) => {
      const layout = getProjectTransferImportTempLayout(sessionId)
      return [sessionId, await fileExists(layout.uploadPath)]
    })))
    const batchResult = await recovery.runProjectTransferStartupRecovery({
      batchSize: 2,
      cwd: runtimeRoot,
      isActiveWriter: () => true,
      now,
      ownerToken: 'recovery-owner',
    })
    const afterBatchStates = await getStates()
    const tempAfterBatch = Object.fromEntries(await Promise.all(sessionIds.map(async (sessionId) => {
      const layout = getProjectTransferImportTempLayout(sessionId)
      return [sessionId, await fileExists(layout.uploadPath)]
    })))

    console.log(JSON.stringify({
      afterBatchStates,
      batchResult,
      skippedResult,
      tempAfterBatch,
      tempAfterSkipped,
    }))
  `)

  expect(result.skippedResult.skippedActiveWriterCheck).toBe(true)
  expect(result.skippedResult.scannedSessionCount).toBe(0)
  expect(result.tempAfterSkipped).toEqual({'future-a': true, 'stale-a': true, 'stale-b': true, 'stale-c': true})
  expect(result.batchResult.scannedSessionCount).toBe(2)
  expect(result.batchResult.expiredSessionCount).toBe(2)
  expect(result.batchResult.cleanupTempArtifactCount).toBe(2)
  expect(result.afterBatchStates).toEqual({
    'future-a': 'queued',
    'stale-a': 'expired',
    'stale-b': 'expired',
    'stale-c': 'queued',
  })
  expect(result.tempAfterBatch).toEqual({'future-a': true, 'stale-a': false, 'stale-b': false, 'stale-c': true})
})

test('project transfer recovery uses import session history and completed sessions only clean temp files', () => {
  const result = runRecoveryScript<{
    crashPromotedExists: boolean
    completedPromotedExists: boolean
    completedTempExists: boolean
    crashTempExists: boolean
    result: {cleanupTempArtifactCount: number; deletedPromotedAssetCount: number; recoveredCompletionCount: number}
    rows: Array<{
      commitId: string | null
      completionProjectId: string | null
      id: string
      packageFingerprint: string | null
      state: string
    }>
  }>(`
    const crashLayout = getProjectTransferImportTempLayout('session-crash')
    const completedLayout = getProjectTransferImportTempLayout('session-completed')
    const crashPromotedPath = 'assets/project-transfer/session-crash/article-1.pdf'
    const completedPromotedPath = 'assets/project-transfer/session-completed/article-1.pdf'

    await sessionRepository.createProjectTransferSession({
      direction: 'import',
      expiresAt: expiredAt,
      id: 'session-crash',
      packageFingerprint: 'fingerprint-before-history',
      state: 'committing',
    })
    await sessionRepository.createProjectTransferSession({
      direction: 'import',
      expiresAt: expiredAt,
      id: 'session-completed',
      packageFingerprint: 'fingerprint-completed',
      state: 'completed',
    })
    await historyRepository.createProjectTransferHistory({
      commitId: 'commit-history',
      completionPayload: completedPayload('target-project-history', 'Target Project History', 'fingerprint-history'),
      direction: 'import',
      id: 'history-session-crash',
      packageFingerprint: 'fingerprint-history',
      payloadCounts: {articles: 1},
      schemaVersion: 1,
      sessionId: 'session-crash',
      sourceProjectName: 'Source Project History',
      targetProjectId: 'target-project-history',
      targetProjectName: 'Target Project History',
    })
    await writeRuntimeFile(crashLayout.uploadPath)
    await writeRuntimeFile(completedLayout.uploadPath)
    await writeRuntimeFile(crashPromotedPath)
    await writeRuntimeFile(completedPromotedPath)
    await writePromotionManifest('session-crash', [promotionMetadata('session-crash', crashPromotedPath)])
    await writePromotionManifest('session-completed', [promotionMetadata('session-completed', completedPromotedPath)])

    const result = await recovery.runProjectTransferStartupRecovery({
      batchSize: 10,
      cwd: runtimeRoot,
      isActiveWriter: () => true,
      now,
      ownerToken: 'recovery-owner',
    })
    const rows = await database.queryJson(\`
      SELECT
        id,
        state,
        package_fingerprint AS packageFingerprint,
        commit_id AS commitId,
        completion_payload_json->>'projectId' AS completionProjectId
      FROM app.project_transfer_session
      ORDER BY id ASC
    \`)

    console.log(JSON.stringify({
      completedPromotedExists: await fileExists(completedPromotedPath),
      completedTempExists: await fileExists(completedLayout.uploadPath),
      crashPromotedExists: await fileExists(crashPromotedPath),
      crashTempExists: await fileExists(crashLayout.uploadPath),
      result,
      rows,
    }))
  `)

  expect(result.result.recoveredCompletionCount).toBe(1)
  expect(result.result.cleanupTempArtifactCount).toBe(2)
  expect(result.result.deletedPromotedAssetCount).toBe(0)
  expect(result.crashTempExists).toBe(false)
  expect(result.completedTempExists).toBe(false)
  expect(result.crashPromotedExists).toBe(true)
  expect(result.completedPromotedExists).toBe(true)
  expect(result.rows).toEqual([
    {
      commitId: null,
      completionProjectId: null,
      id: 'session-completed',
      packageFingerprint: 'fingerprint-completed',
      state: 'completed',
    },
    {
      commitId: 'commit-history',
      completionProjectId: 'target-project-history',
      id: 'session-crash',
      packageFingerprint: 'fingerprint-history',
      state: 'completed',
    },
  ])
})

test('project transfer recovery deletes promoted assets only for abandoned imports without history', () => {
  const result = runRecoveryScript<{
    outsideAssetExists: boolean
    promotedAssetExists: boolean
    recoveryResult: {deletedPromotedAssetCount: number; expiredSessionCount: number; skippedPromotedAssetCount: number}
    state: string
    tempExists: boolean
  }>(`
    const sessionId = 'session-abandoned'
    const layout = getProjectTransferImportTempLayout(sessionId)
    const promotedPath = 'assets/project-transfer/session-abandoned/article-1.pdf'
    const unsafeTraversalPath = 'assets/project-transfer/session-abandoned/../../outside.pdf'
    const outsideAssetPath = 'assets/outside.pdf'

    await sessionRepository.createProjectTransferSession({
      direction: 'import',
      expiresAt: expiredAt,
      id: sessionId,
      state: 'analyzing',
    })
    await writeRuntimeFile(layout.uploadPath)
    await writeRuntimeFile(promotedPath)
    await writeRuntimeFile(outsideAssetPath)
    await writePromotionManifest(sessionId, [
      promotionMetadata(sessionId, promotedPath),
      promotionMetadata(sessionId, unsafeTraversalPath),
    ])

    const recoveryResult = await recovery.runProjectTransferStartupRecovery({
      batchSize: 10,
      cwd: runtimeRoot,
      isActiveWriter: () => true,
      now,
      ownerToken: 'recovery-owner',
    })
    const [row] = await database.queryJson(\`
      SELECT state
      FROM app.project_transfer_session
      WHERE id = 'session-abandoned'
    \`)

    console.log(JSON.stringify({
      outsideAssetExists: await fileExists(outsideAssetPath),
      promotedAssetExists: await fileExists(promotedPath),
      recoveryResult,
      state: row.state,
      tempExists: await fileExists(layout.uploadPath),
    }))
  `)

  expect(result.state).toBe('expired')
  expect(result.recoveryResult.expiredSessionCount).toBe(1)
  expect(result.recoveryResult.deletedPromotedAssetCount).toBe(1)
  expect(result.recoveryResult.skippedPromotedAssetCount).toBe(1)
  expect(result.tempExists).toBe(false)
  expect(result.promotedAssetExists).toBe(false)
  expect(result.outsideAssetExists).toBe(true)
})
