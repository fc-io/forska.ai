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

const getHistoryRepositoryScript = (body: string) => {
  return `
    const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
    const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
    const {getProjectTransferHistoryRepository} = await import('./src/server/services/projectTransfer/projectTransferHistoryRepository.ts')

    await migrateDuckdb()

    const database = getAppDatabaseService()
    const historyRepository = getProjectTransferHistoryRepository()
    const catchMessage = async (operation) => {
      try {
        await operation()
        return null
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    }
    const completedPayload = (projectId, projectName, packageFingerprint, transferHistoryId = undefined) => {
      return {
        packageFingerprint,
        projectId,
        projectName,
        status: 'completed',
        ...(transferHistoryId ? {transferHistoryId} : {}),
      }
    }

    ${body}

    await database.close()
  `
}

const runHistoryRepositoryScript = <T>(body: string) => {
  const duckdbPath = `/tmp/f2-project-transfer-history-repository-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}.duckdb`
  const result = globalThis.Bun.spawnSync(['bun', '-e', getHistoryRepositoryScript(body)], {
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
      throw new Error(result.stderr.toString() || result.stdout.toString() || 'Project transfer history test failed')
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

test('project transfer history enforces completed import invariants and session-id idempotency', () => {
  const result = runHistoryRepositoryScript<{
    invalidError: string | null
    retryHistoryId: string | null
    rowCount: number
    validCompletionProjectId: string | null
    validHistoryId: string | null
  }>(`
    const invalidError = await catchMessage(() => {
      return historyRepository.createProjectTransferHistory({
        direction: 'import',
        id: 'invalid-import-history',
        packageFingerprint: 'fingerprint-invalid',
        payloadCounts: {articles: 1},
        schemaVersion: 1,
        sessionId: 'invalid-session',
        sourceProjectName: 'Source Project',
      })
    })
    const validHistory = await historyRepository.createProjectTransferHistory({
      commitId: 'commit-valid',
      completionPayload: completedPayload(
        'target-project-valid',
        'Target Project Valid',
        'fingerprint-valid',
        'valid-import-history',
      ),
      direction: 'import',
      id: 'valid-import-history',
      packageFingerprint: 'fingerprint-valid',
      payloadCounts: {articles: 1, judgments: 2},
      schemaVersion: 1,
      sessionId: 'valid-session',
      sourceProjectId: 'source-project-valid',
      sourceProjectName: 'Source Project Valid',
      targetProjectId: 'target-project-valid',
      targetProjectName: 'Target Project Valid',
    })
    const retryHistory = await historyRepository.createProjectTransferHistory({
      commitId: 'commit-valid-retry',
      completionPayload: completedPayload('target-project-other', 'Target Project Other', 'fingerprint-valid-retry'),
      direction: 'import',
      id: 'valid-import-history-retry',
      packageFingerprint: 'fingerprint-valid-retry',
      payloadCounts: {articles: 99},
      schemaVersion: 1,
      sessionId: 'valid-session',
      sourceProjectName: 'Source Project Retry',
      targetProjectId: 'target-project-other',
      targetProjectName: 'Target Project Other',
    })
    const [countRow] = await database.queryJson(\`
      SELECT CAST(COUNT(*) AS INTEGER) AS rowCount
      FROM app.project_transfer_history
    \`)

    console.log(JSON.stringify({
      invalidError,
      retryHistoryId: retryHistory?.id ?? null,
      rowCount: countRow?.rowCount ?? null,
      validCompletionProjectId: validHistory?.completionPayloadJson?.projectId ?? null,
      validHistoryId: validHistory?.id ?? null,
    }))
  `)

  expect(result.invalidError).toContain('import commit id')
  expect(result.validHistoryId).toBe('valid-import-history')
  expect(result.retryHistoryId).toBe('valid-import-history')
  expect(result.validCompletionProjectId).toBe('target-project-valid')
  expect(result.rowCount).toBe(1)
})

test('project transfer history rereads completed import after insert conflict', async () => {
  const {getProjectTransferHistoryRepository} = await import('./projectTransferHistoryRepository.ts')
  const statements: string[] = []
  const existingRow = {
    commitId: 'commit-existing',
    completionPayloadJson: {
      projectId: 'target-project-existing',
      projectName: 'Target Project Existing',
      status: 'completed',
    },
    createdAt: new Date('2026-05-21T10:00:00.000Z'),
    direction: 'import',
    id: 'existing-import-history',
    packageFingerprint: 'fingerprint-existing',
    payloadCountsJson: {articles: 1},
    schemaVersion: 1,
    sessionId: 'conflicting-session',
    sourceProjectId: 'source-project-existing',
    sourceProjectName: 'Source Project Existing',
    targetProjectId: 'target-project-existing',
    targetProjectName: 'Target Project Existing',
  }
  const runner = {
    queryJson: async <T>(statement: string): Promise<T[]> => {
      statements.push(statement)

      return statement.includes('INSERT INTO app.project_transfer_history') ? [] : ([existingRow] as T[])
    },
  }

  const history = await getProjectTransferHistoryRepository().createProjectTransferHistory({
    commitId: 'commit-retry',
    completionPayload: {
      packageFingerprint: 'fingerprint-retry',
      projectId: 'target-project-retry',
      projectName: 'Target Project Retry',
      status: 'completed',
    },
    direction: 'import',
    id: 'retry-import-history',
    packageFingerprint: 'fingerprint-retry',
    payloadCounts: {articles: 99},
    runner,
    schemaVersion: 1,
    sessionId: 'conflicting-session',
    sourceProjectName: 'Source Project Retry',
    targetProjectId: 'target-project-retry',
    targetProjectName: 'Target Project Retry',
  })

  expect(history.id).toBe('existing-import-history')
  expect(statements).toHaveLength(2)
  expect(statements[0]).toContain('INSERT INTO app.project_transfer_history')
  expect(statements[0]).toContain('ON CONFLICT(direction, session_id) DO NOTHING')
  expect(statements[1]).toContain('WHERE direction =')
  expect(statements[1]).toContain("session_id = 'conflicting-session'")
})

test('project transfer history duplicate warnings use fingerprint while completion recovery uses session id', () => {
  const result = runHistoryRepositoryScript<{
    completionBySessionId: string | null
    duplicateDirections: string[]
    duplicateHistoryIds: string[]
    duplicateTargetIds: string[]
  }>(`
    await historyRepository.createProjectTransferHistory({
      commitId: 'commit-a',
      completionPayload: completedPayload('target-project-a', 'Target Project A', 'fingerprint-shared'),
      direction: 'import',
      id: 'history-import-a',
      now: new Date('2026-05-21T10:00:00.000Z'),
      packageFingerprint: 'fingerprint-shared',
      payloadCounts: {articles: 1},
      schemaVersion: 1,
      sessionId: 'session-import-a',
      sourceProjectName: 'Source Project A',
      targetProjectId: 'target-project-a',
      targetProjectName: 'Target Project A',
    })
    await historyRepository.createProjectTransferHistory({
      commitId: 'commit-b',
      completionPayload: completedPayload('target-project-b', 'Target Project B', 'fingerprint-shared'),
      direction: 'import',
      id: 'history-import-b',
      now: new Date('2026-05-21T10:01:00.000Z'),
      packageFingerprint: 'fingerprint-shared',
      payloadCounts: {articles: 2},
      schemaVersion: 1,
      sessionId: 'session-import-b',
      sourceProjectName: 'Source Project B',
      targetProjectId: 'target-project-b',
      targetProjectName: 'Target Project B',
    })
    await historyRepository.createProjectTransferHistory({
      direction: 'export',
      id: 'history-export-shared',
      now: new Date('2026-05-21T10:02:00.000Z'),
      packageFingerprint: 'fingerprint-shared',
      payloadCounts: {articles: 3},
      schemaVersion: 1,
      sourceProjectName: 'Export Source Project',
    })

    const duplicates = await historyRepository.findDuplicateImportHistoryByPackageFingerprint({
      packageFingerprint: 'fingerprint-shared',
    })
    const completionBySession = await historyRepository.getCompletedImportHistoryBySessionId({
      sessionId: 'session-import-a',
    })

    console.log(JSON.stringify({
      completionBySessionId: completionBySession?.targetProjectId ?? null,
      duplicateDirections: duplicates.map((row) => row.direction),
      duplicateHistoryIds: duplicates.map((row) => row.id).sort(),
      duplicateTargetIds: duplicates.map((row) => row.targetProjectId).sort(),
    }))
  `)

  expect(result.duplicateDirections).toEqual(['import', 'import'])
  expect(result.duplicateHistoryIds).toEqual(['history-import-a', 'history-import-b'])
  expect(result.duplicateTargetIds).toEqual(['target-project-a', 'target-project-b'])
  expect(result.completionBySessionId).toBe('target-project-a')
})
