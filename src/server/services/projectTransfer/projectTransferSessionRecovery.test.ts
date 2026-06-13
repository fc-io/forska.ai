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
    const {
      getProjectTransferExportTempLayout,
      getProjectTransferImportTempLayout,
    } = await import('./src/server/services/projectTransfer/projectTransferSession.ts')
    const {getProjectTransferSessionRecoveryService} = await import('./src/server/services/projectTransfer/projectTransferSessionRecovery.ts')
    const {getProjectTransferSessionRepository} = await import('./src/server/services/projectTransfer/projectTransferSessionRepository.ts')
    const {getProjectTransferImportStagingLayout} = await import('./src/server/services/projectTransfer/projectTransferStaging.ts')

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

test('project transfer recovery marks terminal cleanup and prioritizes stale active sessions', () => {
  const result = runRecoveryScript<{
    afterFirstStates: Record<string, string>
    afterSecondStates: Record<string, string>
    afterThirdStates: Record<string, string>
    firstResult: {expiredSessionCount: number; scannedSessionCount: number}
    secondResult: {expiredSessionCount: number; scannedSessionCount: number}
    tempAfterFirst: Record<string, boolean>
    tempAfterSecond: Record<string, boolean>
    thirdResult: {expiredSessionCount: number; scannedSessionCount: number}
  }>(`
    const sessionIds = ['terminal-a', 'terminal-b', 'terminal-c', 'stale-active']
    await Promise.all(sessionIds.map(async (sessionId) => {
      const layout = getProjectTransferImportTempLayout(sessionId)
      await sessionRepository.createProjectTransferSession({
        direction: 'import',
        expiresAt: sessionId.startsWith('terminal') ? expiredAt : new Date('2026-05-21T11:00:00.000Z'),
        id: sessionId,
        state: sessionId.startsWith('terminal') ? 'completed' : 'queued',
      })
      await writeRuntimeFile(layout.uploadPath)
    }))

    const getTempState = async () => {
      return Object.fromEntries(await Promise.all(sessionIds.map(async (sessionId) => {
        const layout = getProjectTransferImportTempLayout(sessionId)
        return [sessionId, await fileExists(layout.uploadPath)]
      })))
    }
    const firstResult = await recovery.runProjectTransferStartupRecovery({
      batchSize: 2,
      cwd: runtimeRoot,
      isActiveWriter: () => true,
      now,
      ownerToken: 'recovery-owner',
    })
    const afterFirstStates = await getStates()
    const tempAfterFirst = await getTempState()
    const secondResult = await recovery.runProjectTransferStartupRecovery({
      batchSize: 2,
      cwd: runtimeRoot,
      isActiveWriter: () => true,
      now,
      ownerToken: 'recovery-owner',
    })
    const afterSecondStates = await getStates()
    const tempAfterSecond = await getTempState()
    const thirdResult = await recovery.runProjectTransferStartupRecovery({
      batchSize: 2,
      cwd: runtimeRoot,
      isActiveWriter: () => true,
      now,
      ownerToken: 'recovery-owner',
    })
    const afterThirdStates = await getStates()

    console.log(JSON.stringify({
      afterFirstStates,
      afterSecondStates,
      afterThirdStates,
      firstResult,
      secondResult,
      tempAfterFirst,
      tempAfterSecond,
      thirdResult,
    }))
  `)

  expect(result.firstResult.scannedSessionCount).toBe(2)
  expect(result.firstResult.expiredSessionCount).toBe(1)
  expect(result.afterFirstStates).toEqual({
    'stale-active': 'expired',
    'terminal-a': 'completed',
    'terminal-b': 'completed',
    'terminal-c': 'completed',
  })
  expect(result.tempAfterFirst).toEqual({
    'stale-active': false,
    'terminal-a': false,
    'terminal-b': true,
    'terminal-c': true,
  })
  expect(result.secondResult.scannedSessionCount).toBe(2)
  expect(result.secondResult.expiredSessionCount).toBe(0)
  expect(result.afterSecondStates).toEqual(result.afterFirstStates)
  expect(result.tempAfterSecond).toEqual({
    'stale-active': false,
    'terminal-a': false,
    'terminal-b': false,
    'terminal-c': false,
  })
  expect(result.thirdResult.scannedSessionCount).toBe(0)
  expect(result.thirdResult.expiredSessionCount).toBe(0)
  expect(result.afterThirdStates).toEqual(result.afterFirstStates)
})

test('project transfer recovery prunes expired terminal-cleaned session rows', () => {
  const result = runRecoveryScript<{
    recoveryResult: {cleanupTempArtifactCount: number; expiredSessionCount: number; scannedSessionCount: number}
    remainingIds: string[]
  }>(`
    await sessionRepository.createProjectTransferSession({
      direction: 'import',
      expiresAt: expiredAt,
      id: 'terminal-cleaned-old',
      state: 'completed',
    })
    await database.run(
      "UPDATE app.project_transfer_session SET terminal_cleanup_at = TIMESTAMPTZ '2026-05-20T10:00:00.000Z' WHERE id = 'terminal-cleaned-old'",
    )
    await sessionRepository.createProjectTransferSession({
      direction: 'import',
      expiresAt: futureAt,
      id: 'terminal-cleaned-fresh',
      state: 'completed',
    })
    await database.run(
      "UPDATE app.project_transfer_session SET terminal_cleanup_at = TIMESTAMPTZ '2026-05-21T11:30:00.000Z' WHERE id = 'terminal-cleaned-fresh'",
    )

    const recoveryResult = await recovery.runProjectTransferStartupRecovery({
      cwd: runtimeRoot,
      isActiveWriter: () => true,
      now,
      ownerToken: 'recovery-owner',
    })
    const remainingIds = (await database.queryJson(\`SELECT id FROM app.project_transfer_session ORDER BY id ASC\`)).map((row) => row.id)

    console.log(JSON.stringify({recoveryResult, remainingIds}))
  `)

  expect(result.recoveryResult.scannedSessionCount).toBe(0)
  expect(result.remainingIds).toEqual(['terminal-cleaned-fresh'])
})

test('project transfer recovery removes stale staging revisions for ownerless ready imports', () => {
  const result = runRecoveryScript<{
    currentRevisionExists: boolean
    recoveryResult: {cleanupStaleStagingRevisionCount: number; scannedSessionCount: number}
    staleRevisionExists: boolean
    state: string
  }>(`
    const sessionId = 'session-stale-staging'
    const layout = getProjectTransferImportTempLayout(sessionId)
    const staleLayout = getProjectTransferImportStagingLayout({layout, stagingRevision: 1})
    const currentLayout = getProjectTransferImportStagingLayout({layout, stagingRevision: 2})

    await sessionRepository.createProjectTransferSession({
      direction: 'import',
      expiresAt: futureAt,
      id: sessionId,
      progress: {
        phase: 'analyze',
        staging: {stagingRevision: 2},
        stagingRevision: 2,
        status: 'completed',
      },
      state: 'ready_to_commit',
    })
    await writeRuntimeFile(staleLayout.planPath)
    await writeRuntimeFile(currentLayout.planPath)

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
      WHERE id = 'session-stale-staging'
    \`)

    console.log(JSON.stringify({
      currentRevisionExists: await fileExists(currentLayout.planPath),
      recoveryResult,
      staleRevisionExists: await fileExists(staleLayout.planPath),
      state: row.state,
    }))
  `)

  expect(result.recoveryResult.scannedSessionCount).toBe(0)
  expect(result.recoveryResult.cleanupStaleStagingRevisionCount).toBe(1)
  expect(result.currentRevisionExists).toBe(true)
  expect(result.staleRevisionExists).toBe(false)
  expect(result.state).toBe('ready_to_commit')
})

test('project transfer recovery fails stale export workers but keeps ready artifacts until public expiry', () => {
  const result = runRecoveryScript<{
    futureReadyPackageExists: boolean
    recoveryResult: {cleanupTempArtifactCount: number; expiredSessionCount: number; scannedSessionCount: number}
    stalePackageExists: boolean
    states: Record<string, string>
  }>(`
    const staleWorkerLayout = getProjectTransferExportTempLayout('export-stale-worker')
    const readyFutureLayout = getProjectTransferExportTempLayout('export-ready-future')

    await sessionRepository.createProjectTransferSession({
      direction: 'export',
      expiresAt: futureAt,
      id: 'export-stale-worker',
      state: 'queued',
    })
    await sessionRepository.claimProjectTransferExportSessionOwner({
      expectedState: 'queued',
      nextState: 'assembling',
      now: new Date('2026-05-21T11:00:00.000Z'),
      ownerToken: 'export-owner-stale',
      sessionId: 'export-stale-worker',
    })
    await sessionRepository.createProjectTransferSession({
      direction: 'export',
      expiresAt: futureAt,
      id: 'export-ready-future',
      state: 'ready',
    })
    await writeRuntimeFile(staleWorkerLayout.packagePath)
    await writeRuntimeFile(readyFutureLayout.packagePath)

    const recoveryResult = await recovery.runProjectTransferStartupRecovery({
      batchSize: 10,
      cwd: runtimeRoot,
      exportOwnerHeartbeatStaleMs: 60_000,
      isActiveWriter: () => true,
      now,
      ownerToken: 'recovery-owner',
    })
    const states = await getStates()

    console.log(JSON.stringify({
      futureReadyPackageExists: await fileExists(readyFutureLayout.packagePath),
      recoveryResult,
      stalePackageExists: await fileExists(staleWorkerLayout.packagePath),
      states,
    }))
  `)

  expect(result.recoveryResult.scannedSessionCount).toBe(1)
  expect(result.recoveryResult.expiredSessionCount).toBe(0)
  expect(result.recoveryResult.cleanupTempArtifactCount).toBe(1)
  expect(result.stalePackageExists).toBe(false)
  expect(result.futureReadyPackageExists).toBe(true)
  expect(result.states).toMatchObject({'export-ready-future': 'ready', 'export-stale-worker': 'failed'})
})

test('project transfer recovery fails stale import analysis workers before expiry', () => {
  const result = runRecoveryScript<{
    recoveryResult: {cleanupTempArtifactCount: number; expiredSessionCount: number; scannedSessionCount: number}
    rows: Array<{errorReason: string | null; id: string; state: string; terminalCleanupAt: string | null}>
    tempAfterRecovery: Record<string, boolean>
  }>(`
    const sessionIds = ['import-extracting-stale', 'import-analyzing-stale']
    await Promise.all(sessionIds.map(async (sessionId) => {
      const layout = getProjectTransferImportTempLayout(sessionId)
      await sessionRepository.createProjectTransferSession({
        direction: 'import',
        expiresAt: futureAt,
        id: sessionId,
        state: 'queued',
      })
      await sessionRepository.transitionProjectTransferSessionState({
        expectedOwnerToken: null,
        expectedState: 'queued',
        nextOwnerLeaseMs: 60_000,
        nextOwnerToken: 'analysis-owner-' + sessionId,
        nextState: 'extracting',
        now: new Date('2026-05-21T11:00:00.000Z'),
        sessionId,
      })
      await writeRuntimeFile(layout.uploadPath)
    }))
    await sessionRepository.transitionProjectTransferSessionState({
      expectedOwnerToken: 'analysis-owner-import-analyzing-stale',
      expectedState: 'extracting',
      nextOwnerLeaseMs: 60_000,
      nextOwnerToken: 'analysis-owner-import-analyzing-stale',
      nextState: 'analyzing',
      now: new Date('2026-05-21T11:00:01.000Z'),
      sessionId: 'import-analyzing-stale',
    })

    const recoveryResult = await recovery.runProjectTransferStartupRecovery({
      batchSize: 10,
      cwd: runtimeRoot,
      importAnalyzeHeartbeatStaleMs: 60_000,
      isActiveWriter: () => true,
      now,
      ownerToken: 'recovery-owner',
    })
    const rows = await database.queryJson(\`
      SELECT
        id,
        state,
        error_json->>'reason' AS errorReason,
        terminal_cleanup_at AS terminalCleanupAt
      FROM app.project_transfer_session
      WHERE id IN ('import-extracting-stale', 'import-analyzing-stale')
      ORDER BY id ASC
    \`)
    const tempAfterRecovery = Object.fromEntries(await Promise.all(sessionIds.map(async (sessionId) => {
      const layout = getProjectTransferImportTempLayout(sessionId)
      return [sessionId, await fileExists(layout.uploadPath)]
    })))

    console.log(JSON.stringify({recoveryResult, rows: rows.map((row) => {
      return {
        ...row,
        terminalCleanupAt: row.terminalCleanupAt === null ? null : new Date(row.terminalCleanupAt).toISOString(),
      }
    }), tempAfterRecovery}))
  `)

  expect(result.recoveryResult.scannedSessionCount).toBe(2)
  expect(result.recoveryResult.expiredSessionCount).toBe(0)
  expect(result.recoveryResult.cleanupTempArtifactCount).toBe(2)
  expect(result.tempAfterRecovery).toEqual({'import-analyzing-stale': false, 'import-extracting-stale': false})
  expect(result.rows).toEqual([
    {
      errorReason: 'project_transfer_import_analysis_worker_stale',
      id: 'import-analyzing-stale',
      state: 'failed',
      terminalCleanupAt: '2026-05-21T12:00:00.000Z',
    },
    {
      errorReason: 'project_transfer_import_analysis_worker_stale',
      id: 'import-extracting-stale',
      state: 'failed',
      terminalCleanupAt: '2026-05-21T12:00:00.000Z',
    },
  ])
})

test('project transfer recovery publishes stale import analysis when completed artifacts exist', () => {
  const result = runRecoveryScript<{
    planExistsAfterRecovery: boolean
    recoveryResult: {cleanupTempArtifactCount: number; expiredSessionCount: number; scannedSessionCount: number}
    row: {
      fileName: string | null
      ownerToken: string | null
      planRevision: number
      state: string
      stagingRevision: number | null
      warningCount: number | null
    }
  }>(`
    const sessionId = 'import-analysis-artifacts-stale'
    const layout = getProjectTransferImportTempLayout(sessionId)
    const summary = {
      blockerCount: 0,
      blockers: [],
      conflictCounts: {},
      dependencyStatuses: {'provider:source-provider': 'missing'},
      overlapCounts: {},
      packageCounts: {project: 1},
      packageFingerprint: 'fingerprint-artifacts',
      packageWarnings: [{message: 'warning'}],
      warningCount: 1,
    }
    const plan = {
      blockers: [],
      canCommit: false,
      packageCounts: {project: 1},
      packageFingerprint: 'fingerprint-artifacts',
      packageWarnings: [{message: 'warning'}],
      planRevision: 1,
      resolutionKinds: {},
      stagingRevision: 1,
      summary,
      targetPlan: {},
    }
    const analysis = {
      analyzedAt: '2026-05-21T11:01:00.000Z',
      archive: {
        expandedBytes: 10,
        memberCount: 1,
        packageChecksumSha256: 'checksum',
        packageSizeBytes: 10,
      },
      assetSummary: {
        actualByteLength: 0,
        actualEntryCount: 0,
        manifestByteLength: 0,
        manifestEntryCount: 0,
      },
      computedPackageFingerprint: 'fingerprint-artifacts',
      manifest: {},
      packageCounts: {project: 1},
      packageFingerprint: 'fingerprint-artifacts',
      packageWarnings: [{message: 'warning'}],
      payloads: {},
      planRevision: 1,
      stagedPackage: {
        archiveAssetBytes: 0,
        archiveEntryByteCounts: {},
        archiveEntryChecksums: {},
        canonicalPayloadByteCounts: {},
        canonicalPayloadChecksums: {},
        declaredAssetBytes: 0,
        logicalPayloadDigests: {},
        packageFingerprintInputs: {
          checksumSha256: 'fingerprint-artifacts',
          fingerprintMode: 'stagedRowAndSingletonPayloadDigests',
          payloadDigests: {},
          schemaVersion: 2,
        },
        payloads: {},
        rowCounts: {project: 1},
        sourceProject: {
          exportedAt: '2026-05-21T10:00:00.000Z',
          humanJudgmentMode: 'summary',
          name: 'Source Project',
          schemaVersion: 2,
          sourceAppVersion: 'test',
          sourceProjectId: 'source-project',
        },
      },
      stagingRevision: 1,
    }

    await sessionRepository.createProjectTransferSession({
      direction: 'import',
      expiresAt: futureAt,
      id: sessionId,
      state: 'queued',
    })
    await sessionRepository.transitionProjectTransferSessionState({
      expectedOwnerToken: null,
      expectedState: 'queued',
      nextOwnerLeaseMs: 60_000,
      nextOwnerToken: 'analysis-owner-artifacts',
      nextState: 'extracting',
      now: new Date('2026-05-21T11:00:00.000Z'),
      progress: {
        phase: 'package_scan',
        status: 'running',
        uploadMetadata: {byteLength: 10, checksumSha256: 'checksum', fileName: 'package.zip'},
      },
      sessionId,
    })
    await sessionRepository.transitionProjectTransferSessionState({
      expectedOwnerToken: 'analysis-owner-artifacts',
      expectedState: 'extracting',
      nextOwnerLeaseMs: 60_000,
      nextOwnerToken: 'analysis-owner-artifacts',
      nextState: 'analyzing',
      now: new Date('2026-05-21T11:00:01.000Z'),
      progress: {
        phase: 'analyze',
        status: 'running',
        uploadMetadata: {byteLength: 10, checksumSha256: 'checksum', fileName: 'package.zip'},
      },
      sessionId,
    })
    await writeRuntimeFile(layout.analysisPath, JSON.stringify(analysis))
    await writeRuntimeFile(layout.planPath, JSON.stringify(plan))

    const recoveryResult = await recovery.runProjectTransferStartupRecovery({
      batchSize: 10,
      cwd: runtimeRoot,
      importAnalyzeHeartbeatStaleMs: 60_000,
      isActiveWriter: () => true,
      now,
      ownerToken: 'recovery-owner',
    })
    const [row] = await database.queryJson(
      "SELECT state, owner_token AS ownerToken, CAST(plan_revision AS INTEGER) AS planRevision, CAST(json_extract(progress_json, '$.stagingRevision') AS INTEGER) AS stagingRevision, CAST(json_extract(progress_json, '$.warningCount') AS INTEGER) AS warningCount, json_extract_string(progress_json, '$.uploadMetadata.fileName') AS fileName FROM app.project_transfer_session WHERE id = '" + sessionId + "'"
    )

    console.log(JSON.stringify({
      planExistsAfterRecovery: await fileExists(layout.planPath),
      recoveryResult,
      row,
    }))
  `)

  expect(result.recoveryResult.scannedSessionCount).toBe(1)
  expect(result.recoveryResult.cleanupTempArtifactCount).toBe(0)
  expect(result.planExistsAfterRecovery).toBe(true)
  expect(result.row).toMatchObject({
    fileName: 'package.zip',
    ownerToken: null,
    planRevision: 1,
    state: 'awaiting_resolution',
    stagingRevision: 1,
    warningCount: 1,
  })
})

test('project transfer recovery fails abandoned import upload claims before expiry', () => {
  const result = runRecoveryScript<{
    recoveryResult: {cleanupTempArtifactCount: number; expiredSessionCount: number; scannedSessionCount: number}
    rows: Array<{errorReason: string | null; id: string; state: string; terminalCleanupAt: string | null}>
    tempAfterRecovery: Record<string, boolean>
  }>(`
    const sessionIds = ['import-upload-stale', 'import-upload-fresh']
    await Promise.all(sessionIds.map(async (sessionId) => {
      const layout = getProjectTransferImportTempLayout(sessionId)
      await sessionRepository.createProjectTransferSession({
        direction: 'import',
        expiresAt: futureAt,
        id: sessionId,
        state: 'awaiting_upload',
      })
      await sessionRepository.transitionProjectTransferSessionState({
        expectedOwnerToken: null,
        expectedState: 'awaiting_upload',
        nextOwnerLeaseMs: 60_000,
        nextOwnerToken: 'upload-owner-' + sessionId,
        nextState: 'uploading',
        now: sessionId === 'import-upload-stale'
          ? new Date('2026-05-21T11:00:00.000Z')
          : new Date('2026-05-21T11:59:30.000Z'),
        sessionId,
      })
      await writeRuntimeFile(layout.uploadPath)
    }))

    const recoveryResult = await recovery.runProjectTransferStartupRecovery({
      batchSize: 10,
      cwd: runtimeRoot,
      importAnalyzeHeartbeatStaleMs: 60_000,
      isActiveWriter: () => true,
      now,
      ownerToken: 'recovery-owner',
    })
    const rows = await database.queryJson(
      \`
        SELECT
          id,
          state,
          error_json->>'reason' AS errorReason,
          terminal_cleanup_at AS terminalCleanupAt
        FROM app.project_transfer_session
        WHERE id IN ('import-upload-stale', 'import-upload-fresh')
        ORDER BY id ASC
      \`,
    )
    const tempAfterRecovery = Object.fromEntries(await Promise.all(sessionIds.map(async (sessionId) => {
      const layout = getProjectTransferImportTempLayout(sessionId)
      return [sessionId, await fileExists(layout.uploadPath)]
    })))

    console.log(JSON.stringify({recoveryResult, rows: rows.map((row) => {
      return {
        ...row,
        terminalCleanupAt: row.terminalCleanupAt === null ? null : new Date(row.terminalCleanupAt).toISOString(),
      }
    }), tempAfterRecovery}))
  `)

  expect(result.recoveryResult.scannedSessionCount).toBe(1)
  expect(result.recoveryResult.expiredSessionCount).toBe(0)
  expect(result.recoveryResult.cleanupTempArtifactCount).toBe(1)
  expect(result.tempAfterRecovery).toEqual({'import-upload-fresh': true, 'import-upload-stale': false})
  expect(result.rows).toEqual([
    {errorReason: null, id: 'import-upload-fresh', state: 'uploading', terminalCleanupAt: null},
    {
      errorReason: 'project_transfer_import_upload_worker_stale',
      id: 'import-upload-stale',
      state: 'failed',
      terminalCleanupAt: '2026-05-21T12:00:00.000Z',
    },
  ])
})

test('project transfer recovery re-checks export worker staleness before failing active sessions', () => {
  const result = runRecoveryScript<{
    packageExists: boolean
    recoveryResult: {cleanupTempArtifactCount: number; expiredSessionCount: number; scannedSessionCount: number}
    states: Record<string, string>
  }>(`
    const layout = getProjectTransferExportTempLayout('export-race')
    await sessionRepository.createProjectTransferSession({
      direction: 'export',
      expiresAt: futureAt,
      id: 'export-race',
      state: 'queued',
    })
    await sessionRepository.claimProjectTransferExportSessionOwner({
      expectedState: 'queued',
      nextState: 'assembling',
      now: new Date('2026-05-21T11:00:00.000Z'),
      ownerToken: 'export-owner-race',
      sessionId: 'export-race',
    })
    await writeRuntimeFile(layout.packagePath)

    let selectedStaleSessions = false
    const racingRunner = {
      queryJson: async (statement) => {
        const rows = await database.queryJson(statement)
        if (!selectedStaleSessions && statement.includes("state IN ('assembling', 'packaging')") && statement.includes('LIMIT')) {
          selectedStaleSessions = true
          await sessionRepository.heartbeatProjectTransferExportSessionOwner({
            now: new Date('2026-05-21T11:59:30.000Z'),
            ownerToken: 'export-owner-race',
            sessionId: 'export-race',
          })
        }

        return rows
      },
      run: (statement) => {
        return database.run(statement)
      },
    }
    const recoveryResult = await recovery.runProjectTransferStartupRecovery({
      batchSize: 10,
      cwd: runtimeRoot,
      exportOwnerHeartbeatStaleMs: 60_000,
      isActiveWriter: () => true,
      now,
      ownerToken: 'recovery-owner',
      runner: racingRunner,
    })
    const states = await getStates()

    console.log(JSON.stringify({
      packageExists: await fileExists(layout.packagePath),
      recoveryResult,
      states,
    }))
  `)

  expect(result.recoveryResult.scannedSessionCount).toBe(1)
  expect(result.recoveryResult.expiredSessionCount).toBe(0)
  expect(result.recoveryResult.cleanupTempArtifactCount).toBe(0)
  expect(result.packageExists).toBe(true)
  expect(result.states).toMatchObject({'export-race': 'assembling'})
})

test('project transfer recovery expires ready export artifacts only after public expiry', () => {
  const result = runRecoveryScript<{
    packageExists: boolean
    recoveryResult: {cleanupTempArtifactCount: number; expiredSessionCount: number; scannedSessionCount: number}
    state: string
  }>(`
    const layout = getProjectTransferExportTempLayout('export-ready-expired')
    await sessionRepository.createProjectTransferSession({
      direction: 'export',
      expiresAt: expiredAt,
      id: 'export-ready-expired',
      state: 'ready',
    })
    await writeRuntimeFile(layout.packagePath)

    const recoveryResult = await recovery.runProjectTransferStartupRecovery({
      batchSize: 10,
      cwd: runtimeRoot,
      isActiveWriter: () => true,
      now,
      ownerToken: 'recovery-owner',
    })
    const states = await getStates()

    console.log(JSON.stringify({
      packageExists: await fileExists(layout.packagePath),
      recoveryResult,
      state: states['export-ready-expired'],
    }))
  `)

  expect(result.recoveryResult.scannedSessionCount).toBe(1)
  expect(result.recoveryResult.expiredSessionCount).toBe(1)
  expect(result.recoveryResult.cleanupTempArtifactCount).toBe(1)
  expect(result.packageExists).toBe(false)
  expect(result.state).toBe('expired')
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
      errorMessage: string | null
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
      state: 'failed',
    })
    await database.run(\`
      UPDATE app.project_transfer_session
      SET error_json = CAST('{"message":"stale failure"}' AS JSON)
      WHERE id = 'session-crash'
    \`)
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
        error_json->>'message' AS errorMessage,
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
      errorMessage: null,
      id: 'session-completed',
      packageFingerprint: 'fingerprint-completed',
      state: 'completed',
    },
    {
      commitId: 'commit-history',
      completionProjectId: 'target-project-history',
      errorMessage: null,
      id: 'session-crash',
      packageFingerprint: 'fingerprint-history',
      state: 'completed',
    },
  ])
})

test('project transfer recovery deletes promoted assets only for abandoned imports without history', () => {
  const result = runRecoveryScript<{
    otherSessionPromotedExists: boolean
    outsideAssetExists: boolean
    promotedAssetExists: boolean
    recoveryResult: {deletedPromotedAssetCount: number; expiredSessionCount: number; skippedPromotedAssetCount: number}
    state: string
    tempExists: boolean
  }>(`
    const sessionId = 'session-abandoned'
    const layout = getProjectTransferImportTempLayout(sessionId)
    const promotedPath = 'assets/project-transfer/session-abandoned/article-1.pdf'
    const otherSessionPromotedPath = 'assets/project-transfer/other-session/article-2.pdf'
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
    await writeRuntimeFile(otherSessionPromotedPath)
    await writeRuntimeFile(outsideAssetPath)
    await writePromotionManifest(sessionId, [
      promotionMetadata(sessionId, promotedPath),
      promotionMetadata(sessionId, otherSessionPromotedPath),
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
      otherSessionPromotedExists: await fileExists(otherSessionPromotedPath),
      promotedAssetExists: await fileExists(promotedPath),
      recoveryResult,
      state: row.state,
      tempExists: await fileExists(layout.uploadPath),
    }))
  `)

  expect(result.state).toBe('expired')
  expect(result.recoveryResult.expiredSessionCount).toBe(1)
  expect(result.recoveryResult.deletedPromotedAssetCount).toBe(1)
  expect(result.recoveryResult.skippedPromotedAssetCount).toBe(2)
  expect(result.tempExists).toBe(false)
  expect(result.promotedAssetExists).toBe(false)
  expect(result.otherSessionPromotedExists).toBe(true)
  expect(result.outsideAssetExists).toBe(true)
})

test('project transfer recovery keeps cleanup pending when promotion manifest is malformed', () => {
  const result = runRecoveryScript<{
    manifestError: string | null
    promotedAssetExists: boolean
    state: string
    tempRootExists: boolean
    terminalCleanupAt: string | null
  }>(`
    const sessionId = 'session-malformed-manifest'
    const layout = getProjectTransferImportTempLayout(sessionId)
    const promotedPath = 'assets/project-transfer/session-malformed-manifest/article-1.pdf'

    await sessionRepository.createProjectTransferSession({
      direction: 'import',
      expiresAt: expiredAt,
      id: sessionId,
      state: 'analyzing',
    })
    await writeRuntimeFile(layout.uploadPath)
    await writeRuntimeFile(promotedPath)
    await writeRuntimeFile(layout.promotionManifestPath, '{malformed')

    const manifestError = await recovery.runProjectTransferStartupRecovery({
      batchSize: 10,
      cwd: runtimeRoot,
      isActiveWriter: () => true,
      now,
      ownerToken: 'recovery-owner',
    }).then(
      () => null,
      (error) => error instanceof Error ? error.message : String(error),
    )
    const [row] = await database.queryJson(\`
      SELECT state, terminal_cleanup_at AS terminalCleanupAt
      FROM app.project_transfer_session
      WHERE id = 'session-malformed-manifest'
    \`)

    console.log(JSON.stringify({
      manifestError,
      promotedAssetExists: await fileExists(promotedPath),
      state: row.state,
      tempRootExists: await fileExists(layout.rootPath),
      terminalCleanupAt: row.terminalCleanupAt,
    }))
  `)

  expect(result.manifestError).toContain('promotion manifest is unreadable or malformed')
  expect(result.state).toBe('expired')
  expect(result.terminalCleanupAt).toBeNull()
  expect(result.tempRootExists).toBe(true)
  expect(result.promotedAssetExists).toBe(true)
})

test('project transfer recovery isolates cleanup failures and marks later sessions complete', () => {
  const result = runRecoveryScript<{
    badPromotedAssetExists: boolean
    badTempRootExists: boolean
    cleanupError: string | null
    goodTempRootExists: boolean
    rows: Array<{id: string; state: string; terminalCleanupAt: string | null}>
  }>(`
    const badSessionId = 'session-bad-manifest-batch'
    const goodSessionId = 'session-good-later-batch'
    const badLayout = getProjectTransferImportTempLayout(badSessionId)
    const goodLayout = getProjectTransferImportTempLayout(goodSessionId)
    const badPromotedPath = 'assets/project-transfer/session-bad-manifest-batch/article-1.pdf'

    await sessionRepository.createProjectTransferSession({
      direction: 'import',
      expiresAt: expiredAt,
      id: badSessionId,
      state: 'analyzing',
    })
    await sessionRepository.createProjectTransferSession({
      direction: 'import',
      expiresAt: expiredAt,
      id: goodSessionId,
      state: 'analyzing',
    })
    await writeRuntimeFile(badLayout.uploadPath)
    await writeRuntimeFile(goodLayout.uploadPath)
    await writeRuntimeFile(badPromotedPath)
    await writeRuntimeFile(badLayout.promotionManifestPath, '{malformed')

    const cleanupError = await recovery.runProjectTransferStartupRecovery({
      batchSize: 10,
      cwd: runtimeRoot,
      isActiveWriter: () => true,
      now,
      ownerToken: 'recovery-owner',
    }).then(
      () => null,
      (error) => error instanceof Error ? error.message : String(error),
    )
    const rows = await database.queryJson(\`
      SELECT
        id,
        state,
        terminal_cleanup_at AS terminalCleanupAt
      FROM app.project_transfer_session
      WHERE id IN ('session-bad-manifest-batch', 'session-good-later-batch')
      ORDER BY id ASC
    \`)

    console.log(JSON.stringify({
      badPromotedAssetExists: await fileExists(badPromotedPath),
      badTempRootExists: await fileExists(badLayout.rootPath),
      cleanupError,
      goodTempRootExists: await fileExists(goodLayout.rootPath),
      rows: rows.map((row) => {
        return {
          id: row.id,
          state: row.state,
          terminalCleanupAt: row.terminalCleanupAt === null ? null : new Date(row.terminalCleanupAt).toISOString(),
        }
      }),
    }))
  `)

  expect(result.cleanupError).toContain('promotion manifest is unreadable or malformed')
  expect(result.badTempRootExists).toBe(true)
  expect(result.badPromotedAssetExists).toBe(true)
  expect(result.goodTempRootExists).toBe(false)
  expect(result.rows).toEqual([
    {id: 'session-bad-manifest-batch', state: 'expired', terminalCleanupAt: null},
    {id: 'session-good-later-batch', state: 'expired', terminalCleanupAt: '2026-05-21T12:00:00.000Z'},
  ])
})

test('project transfer recovery keeps cleanup pending when promoted asset deletion fails', () => {
  const result = runRecoveryScript<{
    deleteError: string | null
    promotedAssetExists: boolean
    state: string
    tempRootExists: boolean
    terminalCleanupAt: string | null
  }>(`
    const sessionId = 'session-delete-failure'
    const layout = getProjectTransferImportTempLayout(sessionId)
    const promotedPath = 'assets/project-transfer/session-delete-failure/article-1.pdf'

    await sessionRepository.createProjectTransferSession({
      direction: 'import',
      expiresAt: expiredAt,
      id: sessionId,
      state: 'analyzing',
    })
    await writeRuntimeFile(layout.uploadPath)
    await mkdir(runtimePath(promotedPath), {recursive: true})
    await writePromotionManifest(sessionId, [promotionMetadata(sessionId, promotedPath)])

    const deleteError = await recovery.runProjectTransferStartupRecovery({
      batchSize: 10,
      cwd: runtimeRoot,
      isActiveWriter: () => true,
      now,
      ownerToken: 'recovery-owner',
    }).then(
      () => null,
      (error) => error instanceof Error ? error.message : String(error),
    )
    const [row] = await database.queryJson(\`
      SELECT state, terminal_cleanup_at AS terminalCleanupAt
      FROM app.project_transfer_session
      WHERE id = 'session-delete-failure'
    \`)

    console.log(JSON.stringify({
      deleteError,
      promotedAssetExists: await fileExists(promotedPath),
      state: row.state,
      tempRootExists: await fileExists(layout.rootPath),
      terminalCleanupAt: row.terminalCleanupAt,
    }))
  `)

  expect(result.deleteError).not.toBeNull()
  expect(result.state).toBe('expired')
  expect(result.terminalCleanupAt).toBeNull()
  expect(result.tempRootExists).toBe(true)
  expect(result.promotedAssetExists).toBe(true)
})
