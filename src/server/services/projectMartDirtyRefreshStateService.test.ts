import {rmSync} from 'node:fs'

import {expect, test} from 'bun:test'

import type {ProjectMartDirtyRefreshStateRecord, ProjectMartRefreshArticleStateRecord} from '../../db/schemaTypes.ts'

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

const getRefreshStateScript = (body: string) => {
  return `
    const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
    const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')

    await migrateDuckdb()

    const database = getAppDatabaseService()

    await database.run(\`
      INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
      VALUES ('refresh-state-connection', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
    \`)
    await database.run(\`
      INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
      VALUES ('refresh-state-model', 'refresh-state-connection', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
    \`)
    await database.run(\`
      INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
      VALUES
        ('refresh-project-1', 'Refresh Project 1', 'refresh-state-model', TRUE, TRUE, FALSE, FALSE),
        ('refresh-project-2', 'Refresh Project 2', 'refresh-state-model', TRUE, TRUE, FALSE, FALSE)
    \`)
    await database.run(\`
      INSERT INTO app.article (id, article_title)
      VALUES
        ('refresh-article-1', 'Refresh Article 1'),
        ('refresh-article-2', 'Refresh Article 2')
    \`)

    ${body}
  `
}

const runRefreshStateScript = <T>(body: string) => {
  const duckdbPath = `/tmp/f1-project-mart-refresh-state-${Date.now()}-${Math.random().toString(16).slice(2)}.duckdb`
  const runScript = globalThis.Bun.spawnSync(['bun', '-e', getRefreshStateScript(body)], {
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
    if (runScript.exitCode !== 0) {
      throw new Error(runScript.stderr.toString() || runScript.stdout.toString() || 'Refresh state test failed')
    }

    return JSON.parse(getLastJsonLine(runScript.stdout.toString())) as T
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

test('project mart refresh state migrations create typed bounded refresh schemas', () => {
  const result = runRefreshStateScript<{
    articleRow: ProjectMartRefreshArticleStateRecord
    articleStateColumns: Array<{columnName: string}>
    articleStateCount: {rowCount: number}
    articleStateIndexes: Array<{indexName: string}>
    refreshStateColumns: Array<{columnName: string}>
    refreshStateIndexes: Array<{indexName: string}>
    row: ProjectMartDirtyRefreshStateRecord
  }>(`
    await database.run(\`
      INSERT INTO app.project_mart_refresh_state (
        project_id,
        dirty_token,
        active_dirty_token,
        last_completed_dirty_token,
        last_request_reason,
        requested_by,
        refresh_status,
        last_started_at,
        last_completed_at,
        last_failed_at,
        last_error,
        worker_id,
        lease_expires_at
      ) VALUES (
        'refresh-project-1',
        7,
        7,
        5,
        'judgment-import',
        'worker-test',
        'running',
        TIMESTAMPTZ '2026-04-02 10:00:00+00',
        TIMESTAMPTZ '2026-04-02 10:01:00+00',
        TIMESTAMPTZ '2026-04-02 10:02:00+00',
        'transient error',
        'worker-1',
        TIMESTAMPTZ '2026-04-02 10:05:00+00'
      )
    \`)
    await database.run(\`
      INSERT INTO app.project_mart_refresh_article_state (
        project_id,
        article_id,
        first_dirty_token,
        last_dirty_token
      ) VALUES (
        'refresh-project-1',
        'refresh-article-1',
        5,
        7
      )
    \`)
    await database.run(\`
      UPDATE app.project_mart_refresh_article_state
      SET
        first_dirty_token = LEAST(first_dirty_token, 3),
        last_dirty_token = GREATEST(last_dirty_token, 11),
        updated_at = TIMESTAMPTZ '2026-04-02 10:06:00+00'
      WHERE project_id = 'refresh-project-1'
        AND article_id = 'refresh-article-1'
    \`)

    const refreshStateColumns = await database.queryJson(\`
      SELECT column_name AS columnName
      FROM information_schema.columns
      WHERE table_schema = 'app'
        AND table_name = 'project_mart_refresh_state'
      ORDER BY ordinal_position
    \`)
    const refreshStateIndexes = await database.queryJson(\`
      SELECT index_name AS indexName
      FROM duckdb_indexes()
      WHERE schema_name = 'app'
        AND table_name = 'project_mart_refresh_state'
      ORDER BY index_name
    \`)
    const [row] = await database.queryJson(\`
      SELECT
        project_id AS projectId,
        CAST(dirty_token AS INTEGER) AS dirtyToken,
        CAST(active_dirty_token AS INTEGER) AS activeDirtyToken,
        CAST(last_completed_dirty_token AS INTEGER) AS lastCompletedDirtyToken,
        last_requested_at AS lastRequestedAt,
        last_request_reason AS lastRequestReason,
        requested_by AS requestedBy,
        refresh_status AS refreshStatus,
        last_started_at AS lastStartedAt,
        last_completed_at AS lastCompletedAt,
        last_failed_at AS lastFailedAt,
        last_error AS lastError,
        worker_id AS workerId,
        lease_expires_at AS leaseExpiresAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM app.project_mart_refresh_state
      WHERE project_id = 'refresh-project-1'
      LIMIT 1
    \`)
    const articleStateColumns = await database.queryJson(\`
      SELECT column_name AS columnName
      FROM information_schema.columns
      WHERE table_schema = 'app'
        AND table_name = 'project_mart_refresh_article_state'
      ORDER BY ordinal_position
    \`)
    const articleStateIndexes = await database.queryJson(\`
      SELECT index_name AS indexName
      FROM duckdb_indexes()
      WHERE schema_name = 'app'
        AND table_name = 'project_mart_refresh_article_state'
      ORDER BY index_name
    \`)
    const [articleRow] = await database.queryJson(\`
      SELECT
        project_id AS projectId,
        article_id AS articleId,
        CAST(first_dirty_token AS INTEGER) AS firstDirtyToken,
        CAST(last_dirty_token AS INTEGER) AS lastDirtyToken,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM app.project_mart_refresh_article_state
      WHERE project_id = 'refresh-project-1'
        AND article_id = 'refresh-article-1'
      LIMIT 1
    \`)
    const [articleStateCount] = await database.queryJson(\`
      SELECT CAST(COUNT(*) AS INTEGER) AS rowCount
      FROM app.project_mart_refresh_article_state
      WHERE project_id = 'refresh-project-1'
        AND last_dirty_token > 0
        AND article_id = 'refresh-article-1'
    \`)

    console.log(JSON.stringify({
      articleRow,
      articleStateColumns,
      articleStateCount,
      articleStateIndexes,
      refreshStateColumns,
      refreshStateIndexes,
      row,
    }))
    await database.close()
  `)

  expect(
    result.refreshStateColumns.map((column) => {
      return column.columnName
    }),
  ).toEqual([
    'project_id',
    'dirty_token',
    'active_dirty_token',
    'last_completed_dirty_token',
    'last_requested_at',
    'last_request_reason',
    'requested_by',
    'refresh_status',
    'last_started_at',
    'last_completed_at',
    'last_failed_at',
    'last_error',
    'worker_id',
    'lease_expires_at',
    'created_at',
    'updated_at',
  ])
  expect(
    result.refreshStateIndexes.map((index) => {
      return index.indexName
    }),
  ).toEqual(['idx_app_project_mart_refresh_state_claim', 'idx_app_project_mart_refresh_state_stale_work'])
  expect(result.row.projectId).toBe('refresh-project-1')
  expect(result.row.dirtyToken).toBe(7)
  expect(result.row.activeDirtyToken).toBe(7)
  expect(result.row.lastCompletedDirtyToken).toBe(5)
  expect(result.row.lastRequestReason).toBe('judgment-import')
  expect(result.row.requestedBy).toBe('worker-test')
  expect(result.row.refreshStatus).toBe('running')
  expect(result.row.lastError).toBe('transient error')
  expect(result.row.workerId).toBe('worker-1')
  expect(result.row.lastRequestedAt).toBeTruthy()
  expect(result.row.lastStartedAt).toBeTruthy()
  expect(result.row.lastCompletedAt).toBeTruthy()
  expect(result.row.lastFailedAt).toBeTruthy()
  expect(result.row.leaseExpiresAt).toBeTruthy()
  expect(result.row.createdAt).toBeTruthy()
  expect(result.row.updatedAt).toBeTruthy()
  expect(
    result.articleStateColumns.map((column) => {
      return column.columnName
    }),
  ).toEqual(['project_id', 'article_id', 'first_dirty_token', 'last_dirty_token', 'created_at', 'updated_at'])
  expect(
    result.articleStateIndexes.map((index) => {
      return index.indexName
    }),
  ).toEqual([])
  expect(result.articleStateCount.rowCount).toBe(1)
  expect(result.articleRow.projectId).toBe('refresh-project-1')
  expect(result.articleRow.articleId).toBe('refresh-article-1')
  expect(result.articleRow.firstDirtyToken).toBe(3)
  expect(result.articleRow.lastDirtyToken).toBe(11)
  expect(result.articleRow.createdAt).toBeTruthy()
  expect(result.articleRow.updatedAt).toBeTruthy()
})

test('markProjectsDirtyAtomically bumps tokens once per project and merges unresolved article state', () => {
  const result = runRefreshStateScript<{
    articleRows: ProjectMartRefreshArticleStateRecord[]
    marks: Array<{dirtyToken: number; projectId: string}>
    secondMarks: Array<{dirtyToken: number; projectId: string}>
    stateRows: ProjectMartDirtyRefreshStateRecord[]
    unresolvedArticles: Array<{articleId: string}>
  }>(`
    const {getProjectMartDirtyRefreshStateService} = await import('./src/server/services/projectMartDirtyRefreshStateService.ts')

    const service = getProjectMartDirtyRefreshStateService()
    const marks = await service.markProjectsDirtyAtomically({
      projects: [
        {projectId: 'refresh-project-1', articleIds: ['refresh-article-1', 'refresh-article-1']},
        {projectId: 'refresh-project-1', articleIds: ['refresh-article-2']},
        {projectId: 'refresh-project-2', articleIds: ['refresh-article-1']},
      ],
      reason: 'judgment-import',
      requestedBy: 'import-worker',
      now: new Date('2026-04-02T10:00:00.000Z'),
    })
    const secondMarks = await service.markProjectsDirtyAtomically({
      projects: [{projectId: 'refresh-project-1', articleIds: ['refresh-article-1']}],
      reason: 'judgment-import',
      requestedBy: 'import-worker',
      now: new Date('2026-04-02T10:01:00.000Z'),
    })
    const stateRows = await database.queryJson(\`
      SELECT
        project_id AS projectId,
        CAST(dirty_token AS INTEGER) AS dirtyToken,
        CAST(active_dirty_token AS INTEGER) AS activeDirtyToken,
        CAST(last_completed_dirty_token AS INTEGER) AS lastCompletedDirtyToken,
        last_requested_at AS lastRequestedAt,
        last_request_reason AS lastRequestReason,
        requested_by AS requestedBy,
        refresh_status AS refreshStatus,
        last_started_at AS lastStartedAt,
        last_completed_at AS lastCompletedAt,
        last_failed_at AS lastFailedAt,
        last_error AS lastError,
        worker_id AS workerId,
        lease_expires_at AS leaseExpiresAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM app.project_mart_refresh_state
      ORDER BY project_id ASC
    \`)
    const articleRows = await database.queryJson(\`
      SELECT
        project_id AS projectId,
        article_id AS articleId,
        CAST(first_dirty_token AS INTEGER) AS firstDirtyToken,
        CAST(last_dirty_token AS INTEGER) AS lastDirtyToken,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM app.project_mart_refresh_article_state
      ORDER BY project_id ASC, article_id ASC
    \`)
    const unresolvedArticles = await service.getDirtyArticlesForClaim({
      projectId: 'refresh-project-1',
      lastCompletedToken: 0,
      claimedToken: 2,
    })

    console.log(JSON.stringify({articleRows, marks, secondMarks, stateRows, unresolvedArticles}))
    await database.close()
  `)

  expect(result.marks).toEqual([
    {dirtyToken: 1, projectId: 'refresh-project-1'},
    {dirtyToken: 1, projectId: 'refresh-project-2'},
  ])
  expect(result.secondMarks).toEqual([{dirtyToken: 2, projectId: 'refresh-project-1'}])
  expect(
    result.stateRows.map((row) => {
      return {dirtyToken: row.dirtyToken, projectId: row.projectId}
    }),
  ).toEqual([
    {dirtyToken: 2, projectId: 'refresh-project-1'},
    {dirtyToken: 1, projectId: 'refresh-project-2'},
  ])
  expect(
    result.articleRows.map((row) => {
      return {
        articleId: row.articleId,
        firstDirtyToken: row.firstDirtyToken,
        lastDirtyToken: row.lastDirtyToken,
        projectId: row.projectId,
      }
    }),
  ).toEqual([
    {articleId: 'refresh-article-1', firstDirtyToken: 1, lastDirtyToken: 2, projectId: 'refresh-project-1'},
    {articleId: 'refresh-article-2', firstDirtyToken: 1, lastDirtyToken: 1, projectId: 'refresh-project-1'},
    {articleId: 'refresh-article-1', firstDirtyToken: 1, lastDirtyToken: 1, projectId: 'refresh-project-2'},
  ])
  expect(result.unresolvedArticles).toEqual([{articleId: 'refresh-article-1'}, {articleId: 'refresh-article-2'}])
})

test('markArticleProjectsDirtyAtomically resolves active affected projects before recording dirty state', () => {
  const result = runRefreshStateScript<{
    articleRows: ProjectMartRefreshArticleStateRecord[]
    marks: Array<{dirtyToken: number; projectId: string}>
    stateRows: ProjectMartDirtyRefreshStateRecord[]
  }>(`
    const {getProjectMartDirtyRefreshStateService} = await import('./src/server/services/projectMartDirtyRefreshStateService.ts')

    const service = getProjectMartDirtyRefreshStateService()

    await database.run(\`
      INSERT INTO app.import_route (id, route, name)
      VALUES ('refresh-route-1', '/refresh-route-1', 'manual')
    \`)
    await database.run(\`
      INSERT INTO app.project (id, name, model_id, archived, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
      VALUES ('refresh-project-archived', 'Archived Project', 'refresh-state-model', TRUE, TRUE, TRUE, FALSE, FALSE)
    \`)
    await database.run(\`
      INSERT INTO app.project (
        id,
        name,
        model_id,
        date_from,
        date_to,
        use_title,
        use_abstract,
        use_fulltext,
        use_fulltext_no_images
      ) VALUES
        (
          'refresh-project-date-bounded',
          'Date Bounded Project',
          'refresh-state-model',
          TIMESTAMPTZ '2026-04-01T00:00:00.000Z',
          TIMESTAMPTZ '2026-04-30T23:59:59.999Z',
          TRUE,
          TRUE,
          FALSE,
          FALSE
        ),
        (
          'refresh-project-route-date-bounded',
          'Route Date Bounded Project',
          'refresh-state-model',
          TIMESTAMPTZ '2026-04-01T00:00:00.000Z',
          TIMESTAMPTZ '2026-04-30T23:59:59.999Z',
          TRUE,
          TRUE,
          FALSE,
          FALSE
        )
    \`)
    await database.run(\`
      INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
      VALUES ('refresh-project-3', 'Unused Project', 'refresh-state-model', TRUE, TRUE, FALSE, FALSE)
    \`)
    await database.run(\`
      UPDATE app.article
      SET article_created_at = TIMESTAMPTZ '2026-05-01T00:00:00.000Z'
      WHERE id = 'refresh-article-1'
    \`)
    await database.run(\`
      INSERT INTO app.project_article (id, project_id, article_id)
      VALUES
        ('refresh-project-1-article-1', 'refresh-project-1', 'refresh-article-1'),
        ('refresh-project-date-bounded-article-1', 'refresh-project-date-bounded', 'refresh-article-1'),
        ('refresh-project-archived-article-1', 'refresh-project-archived', 'refresh-article-1')
    \`)
    await database.run(\`
      INSERT INTO app.project_import_route (id, project_id, import_route_id)
      VALUES
        ('refresh-project-2-route', 'refresh-project-2', 'refresh-route-1'),
        ('refresh-project-route-date-bounded-route', 'refresh-project-route-date-bounded', 'refresh-route-1'),
        ('refresh-project-archived-route', 'refresh-project-archived', 'refresh-route-1')
    \`)
    await database.run(\`
      INSERT INTO app.article_import_route (id, article_id, import_route_id)
      VALUES ('refresh-article-1-route', 'refresh-article-1', 'refresh-route-1')
    \`)

    const marks = await service.markArticleProjectsDirtyAtomically({
      articleIds: ['refresh-article-1', 'refresh-article-1', 'refresh-article-2'],
      reason: 'judgment-import',
      requestedBy: 'import-worker',
      now: new Date('2026-04-02T10:02:00.000Z'),
    })
    const stateRows = await database.queryJson(\`
      SELECT
        project_id AS projectId,
        CAST(dirty_token AS INTEGER) AS dirtyToken,
        CAST(active_dirty_token AS INTEGER) AS activeDirtyToken,
        CAST(last_completed_dirty_token AS INTEGER) AS lastCompletedDirtyToken,
        last_requested_at AS lastRequestedAt,
        last_request_reason AS lastRequestReason,
        requested_by AS requestedBy,
        refresh_status AS refreshStatus,
        last_started_at AS lastStartedAt,
        last_completed_at AS lastCompletedAt,
        last_failed_at AS lastFailedAt,
        last_error AS lastError,
        worker_id AS workerId,
        lease_expires_at AS leaseExpiresAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM app.project_mart_refresh_state
      ORDER BY project_id ASC
    \`)
    const articleRows = await database.queryJson(\`
      SELECT
        project_id AS projectId,
        article_id AS articleId,
        CAST(first_dirty_token AS INTEGER) AS firstDirtyToken,
        CAST(last_dirty_token AS INTEGER) AS lastDirtyToken,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM app.project_mart_refresh_article_state
      ORDER BY project_id ASC, article_id ASC
    \`)

    console.log(JSON.stringify({articleRows, marks, stateRows}))
    await database.close()
  `)

  expect(result.marks).toEqual([
    {dirtyToken: 1, projectId: 'refresh-project-1'},
    {dirtyToken: 1, projectId: 'refresh-project-2'},
    {dirtyToken: 1, projectId: 'refresh-project-date-bounded'},
    {dirtyToken: 1, projectId: 'refresh-project-route-date-bounded'},
  ])
  expect(
    result.stateRows.map((row) => {
      return {dirtyToken: row.dirtyToken, projectId: row.projectId}
    }),
  ).toEqual([
    {dirtyToken: 1, projectId: 'refresh-project-1'},
    {dirtyToken: 1, projectId: 'refresh-project-2'},
    {dirtyToken: 1, projectId: 'refresh-project-date-bounded'},
    {dirtyToken: 1, projectId: 'refresh-project-route-date-bounded'},
  ])
  expect(
    result.articleRows.map((row) => {
      return {
        articleId: row.articleId,
        firstDirtyToken: row.firstDirtyToken,
        lastDirtyToken: row.lastDirtyToken,
        projectId: row.projectId,
      }
    }),
  ).toEqual([
    {articleId: 'refresh-article-1', firstDirtyToken: 1, lastDirtyToken: 1, projectId: 'refresh-project-1'},
    {articleId: 'refresh-article-1', firstDirtyToken: 1, lastDirtyToken: 1, projectId: 'refresh-project-2'},
    {articleId: 'refresh-article-1', firstDirtyToken: 1, lastDirtyToken: 1, projectId: 'refresh-project-date-bounded'},
    {
      articleId: 'refresh-article-1',
      firstDirtyToken: 1,
      lastDirtyToken: 1,
      projectId: 'refresh-project-route-date-bounded',
    },
  ])
})

test('getDirtyProjectsForProjectIds writes project-wide scoped article dirty state directly', () => {
  const result = runRefreshStateScript<{
    dirtyProjects: Array<{articleIds?: string[]; projectId: string}>
    dirtyRows: ProjectMartRefreshArticleStateRecord[]
    materializationRows: Array<{targetDirtyToken: number}>
  }>(`
    const {getProjectMartDirtyRefreshStateService} = await import('./src/server/services/projectMartDirtyRefreshStateService.ts')

    const service = getProjectMartDirtyRefreshStateService()

    await database.run(\`
      INSERT INTO app.project_article (id, project_id, article_id)
      VALUES ('refresh-project-1-current-article', 'refresh-project-1', 'refresh-article-1')
    \`)
    await database.run(\`
      INSERT INTO mart.project_scope_article (
        project_id,
        article_id,
        in_curated_scope,
        in_route_scope,
        article_created_at,
        article_updated_at
      ) VALUES (
        'refresh-project-1',
        'refresh-article-2',
        TRUE,
        FALSE,
        TIMESTAMPTZ '2026-04-01T00:00:00.000Z',
        TIMESTAMPTZ '2026-04-01T01:00:00.000Z'
      )
    \`)

    const dirtyProjects = await service.getDirtyProjectsForProjectIds(database, ['refresh-project-1'])
    await service.markProjectsDirtyAtomically({
      projects: dirtyProjects,
      reason: 'refresh-state-test.scope-delta',
    })
    const dirtyRows = await database.queryJson(\`
      SELECT
        project_id AS projectId,
        article_id AS articleId,
        CAST(first_dirty_token AS INTEGER) AS firstDirtyToken,
        CAST(last_dirty_token AS INTEGER) AS lastDirtyToken,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM app.project_mart_refresh_article_state
      WHERE project_id = 'refresh-project-1'
        AND last_dirty_token > 0
      ORDER BY article_id ASC
    \`)
    const materializationRows = await database.queryJson(\`
      SELECT
        CAST(target_dirty_token AS INTEGER) AS targetDirtyToken
      FROM app.project_mart_dirty_materialization_state
      WHERE project_id = 'refresh-project-1'
      ORDER BY target_dirty_token ASC
    \`)

    console.log(JSON.stringify({dirtyProjects, dirtyRows, materializationRows}))
    await database.close()
  `)

  expect(result.dirtyProjects).toEqual([{projectId: 'refresh-project-1'}])
  expect(result.materializationRows).toEqual([])
  expect(
    result.dirtyRows.map((row) => {
      return {articleId: row.articleId, firstDirtyToken: row.firstDirtyToken, lastDirtyToken: row.lastDirtyToken}
    }),
  ).toEqual([
    {articleId: 'refresh-article-1', firstDirtyToken: 1, lastDirtyToken: 1},
    {articleId: 'refresh-article-2', firstDirtyToken: 1, lastDirtyToken: 1},
  ])
})

test('claimDirtyProjects supports heartbeat extension and lease expiry recovery', () => {
  const result = runRefreshStateScript<{
    firstClaim: Array<{
      claimedToken: number
      lastCompletedToken: number
      leaseExpiresAt: string
      projectId: string
      workerId: string
    }>
    heartbeat: {
      claimedToken: number
      lastCompletedToken: number
      leaseExpiresAt: string
      projectId: string
      workerId: string
    } | null
    reclaimed: Array<{
      claimedToken: number
      lastCompletedToken: number
      leaseExpiresAt: string
      projectId: string
      workerId: string
    }>
    skippedWhileLeaseValid: Array<{
      claimedToken: number
      lastCompletedToken: number
      leaseExpiresAt: string
      projectId: string
      workerId: string
    }>
  }>(`
    const {getProjectMartDirtyRefreshStateService} = await import('./src/server/services/projectMartDirtyRefreshStateService.ts')

    const service = getProjectMartDirtyRefreshStateService()
    await service.markProjectsDirtyAtomically({
      projects: [{projectId: 'refresh-project-1', articleIds: ['refresh-article-1']}],
      reason: 'project-update',
      requestedBy: 'route-test',
      now: new Date('2026-04-02T11:00:00.000Z'),
    })

    const firstClaim = await service.claimDirtyProjects({
      workerId: 'worker-1',
      limit: 1,
      leaseMs: 1000,
      now: new Date('2026-04-02T11:00:00.000Z'),
    })
    const heartbeat = await service.heartbeatClaim({
      projectId: 'refresh-project-1',
      workerId: 'worker-1',
      leaseMs: 2000,
      now: new Date('2026-04-02T11:00:00.500Z'),
    })
    const skippedWhileLeaseValid = await service.claimDirtyProjects({
      workerId: 'worker-2',
      limit: 1,
      leaseMs: 1000,
      now: new Date('2026-04-02T11:00:01.500Z'),
    })
    const reclaimed = await service.claimDirtyProjects({
      workerId: 'worker-2',
      limit: 1,
      leaseMs: 1000,
      now: new Date('2026-04-02T11:00:02.600Z'),
    })

    console.log(JSON.stringify({firstClaim, heartbeat, reclaimed, skippedWhileLeaseValid}))
    await database.close()
  `)

  expect(result.firstClaim).toHaveLength(1)
  expect(result.firstClaim[0]).toMatchObject({
    claimedToken: 1,
    lastCompletedToken: 0,
    projectId: 'refresh-project-1',
    workerId: 'worker-1',
  })
  expect(result.heartbeat).toMatchObject({
    claimedToken: 1,
    lastCompletedToken: 0,
    projectId: 'refresh-project-1',
    workerId: 'worker-1',
  })
  expect(new Date(result.heartbeat?.leaseExpiresAt ?? '').toISOString()).toBe('2026-04-02T11:00:02.500Z')
  expect(result.skippedWhileLeaseValid).toEqual([])
  expect(result.reclaimed).toHaveLength(1)
  expect(result.reclaimed[0]).toMatchObject({
    claimedToken: 1,
    lastCompletedToken: 0,
    projectId: 'refresh-project-1',
    workerId: 'worker-2',
  })
})

test('completeProjectRefresh trims resolved article state and failProjectRefresh records failures', () => {
  const result = runRefreshStateScript<{
    completedState: ProjectMartDirtyRefreshStateRecord | null
    failedState: ProjectMartDirtyRefreshStateRecord | null
    remainingArticlesAfterComplete: ProjectMartRefreshArticleStateRecord[]
    unresolvedAfterComplete: Array<{articleId: string}>
  }>(`
    const {getProjectMartDirtyRefreshStateService} = await import('./src/server/services/projectMartDirtyRefreshStateService.ts')

    const service = getProjectMartDirtyRefreshStateService()
    await service.markProjectsDirtyAtomically({
      projects: [{projectId: 'refresh-project-1', articleIds: ['refresh-article-1']}],
      reason: 'project-update',
      requestedBy: 'route-test',
      now: new Date('2026-04-02T12:00:00.000Z'),
    })

    const [firstClaim] = await service.claimDirtyProjects({
      workerId: 'worker-1',
      limit: 1,
      leaseMs: 5000,
      now: new Date('2026-04-02T12:00:01.000Z'),
    })

    await service.markProjectsDirtyAtomically({
      projects: [{projectId: 'refresh-project-1', articleIds: ['refresh-article-1', 'refresh-article-2']}],
      reason: 'project-update',
      requestedBy: 'route-test',
      now: new Date('2026-04-02T12:00:02.000Z'),
    })

    const completedState = await service.completeProjectRefresh({
      projectId: 'refresh-project-1',
      workerId: 'worker-1',
      completedToken: firstClaim.claimedToken,
      now: new Date('2026-04-02T12:00:03.000Z'),
    })
    const remainingArticlesAfterComplete = await database.queryJson(\`
      SELECT
        project_id AS projectId,
        article_id AS articleId,
        CAST(first_dirty_token AS INTEGER) AS firstDirtyToken,
        CAST(last_dirty_token AS INTEGER) AS lastDirtyToken,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM app.project_mart_refresh_article_state
      WHERE project_id = 'refresh-project-1'
        AND last_dirty_token > 0
      ORDER BY article_id ASC
    \`)
    const unresolvedAfterComplete = await service.getDirtyArticlesForClaim({
      projectId: 'refresh-project-1',
      lastCompletedToken: 1,
      claimedToken: 2,
    })
    const [secondClaim] = await service.claimDirtyProjects({
      workerId: 'worker-2',
      limit: 1,
      leaseMs: 5000,
      now: new Date('2026-04-02T12:00:04.000Z'),
    })
    const failedState = await service.failProjectRefresh({
      projectId: 'refresh-project-1',
      workerId: 'worker-2',
      error: 'refresh exploded',
      now: new Date('2026-04-02T12:00:05.000Z'),
    })

    console.log(JSON.stringify({
      completedState,
      failedState,
      remainingArticlesAfterComplete,
      secondClaim,
      unresolvedAfterComplete,
    }))
    await database.close()
  `)

  expect(result.completedState?.projectId).toBe('refresh-project-1')
  expect(result.completedState?.dirtyToken).toBe(2)
  expect(result.completedState?.lastCompletedDirtyToken).toBe(1)
  expect(result.completedState?.activeDirtyToken).toBe(0)
  expect(result.completedState?.refreshStatus).toBe('idle')
  expect(result.completedState?.workerId).toBeNull()
  expect(
    result.remainingArticlesAfterComplete.map((row) => {
      return {articleId: row.articleId, firstDirtyToken: row.firstDirtyToken, lastDirtyToken: row.lastDirtyToken}
    }),
  ).toEqual([
    {articleId: 'refresh-article-1', firstDirtyToken: 2, lastDirtyToken: 2},
    {articleId: 'refresh-article-2', firstDirtyToken: 2, lastDirtyToken: 2},
  ])
  expect(result.unresolvedAfterComplete).toEqual([{articleId: 'refresh-article-1'}, {articleId: 'refresh-article-2'}])
  expect(result.failedState?.projectId).toBe('refresh-project-1')
  expect(result.failedState?.dirtyToken).toBe(2)
  expect(result.failedState?.lastCompletedDirtyToken).toBe(1)
  expect(result.failedState?.activeDirtyToken).toBe(0)
  expect(result.failedState?.refreshStatus).toBe('failed')
  expect(result.failedState?.lastError).toBe('refresh exploded')
  expect(result.failedState?.workerId).toBeNull()
  expect(result.failedState?.lastFailedAt).toBeTruthy()
})

test('dirty completion advances only after direct project-wide scoped article rows complete', () => {
  const result = runRefreshStateScript<{
    completionAfterBarrier: {completedState: ProjectMartDirtyRefreshStateRecord | null; isClaimComplete: boolean}
    completionBeforeBarrier: {completedState: ProjectMartDirtyRefreshStateRecord | null; isClaimComplete: boolean}
    refreshStateAfterBarrier: {
      activeDirtyToken: number
      dirtyToken: number
      lastCompletedDirtyToken: number
      refreshStatus: string
      workerId: string | null
    }
    refreshStateBeforeBarrier: {
      activeDirtyToken: number
      dirtyToken: number
      lastCompletedDirtyToken: number
      refreshStatus: string
      workerId: string | null
    }
  }>(`
    const {getProjectMartDirtyRefreshStateService} = await import('./src/server/services/projectMartDirtyRefreshStateService.ts')

    const service = getProjectMartDirtyRefreshStateService()
    await database.run(\`
      INSERT INTO app.project_article (id, project_id, article_id)
      VALUES ('refresh-project-1-materialization-article', 'refresh-project-1', 'refresh-article-2')
    \`)
    await service.markProjectsDirtyAtomically({
      projects: [{projectId: 'refresh-project-1'}],
      reason: 'project-wide-barrier',
      now: new Date('2026-04-02T12:11:00.000Z'),
    })
    await service.markProjectsDirtyAtomically({
      projects: [{projectId: 'refresh-project-1', articleIds: ['refresh-article-1']}],
      reason: 'article-after-barrier',
      now: new Date('2026-04-02T12:11:01.000Z'),
    })
    await database.run(\`
      UPDATE app.project_mart_refresh_state
      SET
        active_dirty_token = 2,
        refresh_status = 'running',
        worker_id = 'worker-1',
        lease_expires_at = TIMESTAMPTZ '2026-04-02T12:12:00.000Z'
      WHERE project_id = 'refresh-project-1'
    \`)
    const completionBeforeBarrier = await service.completeDirtyArticleBatchForClaim({
      articleIds: ['refresh-article-1'],
      claimedToken: 2,
      projectId: 'refresh-project-1',
      workerId: 'worker-1',
      now: new Date('2026-04-02T12:11:03.000Z'),
    })
    const [refreshStateBeforeBarrier] = await database.queryJson(\`
      SELECT
        CAST(active_dirty_token AS INTEGER) AS activeDirtyToken,
        CAST(dirty_token AS INTEGER) AS dirtyToken,
        CAST(last_completed_dirty_token AS INTEGER) AS lastCompletedDirtyToken,
        refresh_status AS refreshStatus,
        worker_id AS workerId
      FROM app.project_mart_refresh_state
      WHERE project_id = 'refresh-project-1'
      LIMIT 1
    \`)
    const completionAfterBarrier = await service.completeDirtyArticleBatchForClaim({
      articleIds: ['refresh-article-2'],
      claimedToken: 2,
      projectId: 'refresh-project-1',
      workerId: 'worker-1',
      now: new Date('2026-04-02T12:11:04.000Z'),
    })
    const [refreshStateAfterBarrier] = await database.queryJson(\`
      SELECT
        CAST(active_dirty_token AS INTEGER) AS activeDirtyToken,
        CAST(dirty_token AS INTEGER) AS dirtyToken,
        CAST(last_completed_dirty_token AS INTEGER) AS lastCompletedDirtyToken,
        refresh_status AS refreshStatus,
        worker_id AS workerId
      FROM app.project_mart_refresh_state
      WHERE project_id = 'refresh-project-1'
      LIMIT 1
    \`)

    console.log(JSON.stringify({
      completionAfterBarrier,
      completionBeforeBarrier,
      refreshStateAfterBarrier,
      refreshStateBeforeBarrier,
    }))
    await database.close()
  `)

  expect(result.completionBeforeBarrier).toMatchObject({completedState: null, isClaimComplete: false})
  expect(result.refreshStateBeforeBarrier).toEqual({
    activeDirtyToken: 2,
    dirtyToken: 2,
    lastCompletedDirtyToken: 0,
    refreshStatus: 'running',
    workerId: 'worker-1',
  })
  expect(result.completionAfterBarrier.isClaimComplete).toBe(true)
  expect(result.completionAfterBarrier.completedState?.lastCompletedDirtyToken).toBe(2)
  expect(result.refreshStateAfterBarrier).toEqual({
    activeDirtyToken: 0,
    dirtyToken: 2,
    lastCompletedDirtyToken: 2,
    refreshStatus: 'idle',
    workerId: null,
  })
})

test('getDirtyArticleBatchForClaim completes a one-article claim batch', () => {
  const result = runRefreshStateScript<{
    batch: {articleIds: string[]; hasMore: boolean}
    completion: {completedState: ProjectMartDirtyRefreshStateRecord | null; isClaimComplete: boolean}
    remainingRow: {rowCount: number}
    state: ProjectMartDirtyRefreshStateRecord
  }>(`
    const {getProjectMartDirtyRefreshStateService} = await import('./src/server/services/projectMartDirtyRefreshStateService.ts')

    const service = getProjectMartDirtyRefreshStateService()
    await service.markProjectsDirtyAtomically({
      projects: [{projectId: 'refresh-project-1', articleIds: ['refresh-article-1']}],
      reason: 'project-update',
      requestedBy: 'route-test',
      now: new Date('2026-04-02T12:20:00.000Z'),
    })
    const [claim] = await service.claimDirtyProjects({
      workerId: 'worker-1',
      limit: 1,
      leaseMs: 5000,
      now: new Date('2026-04-02T12:20:01.000Z'),
    })
    const batch = await service.getDirtyArticleBatchForClaim({
      batchSize: 10,
      claimedToken: claim.claimedToken,
      projectId: claim.projectId,
      workerId: claim.workerId,
    })
    const completion = await service.completeDirtyArticleBatchForClaim({
      articleIds: batch.articleIds,
      claimedToken: claim.claimedToken,
      projectId: claim.projectId,
      workerId: claim.workerId,
      now: new Date('2026-04-02T12:20:02.000Z'),
    })
    const [remainingRow] = await database.queryJson(\`
      SELECT CAST(COUNT(*) AS INTEGER) AS rowCount
      FROM app.project_mart_refresh_article_state
      WHERE project_id = 'refresh-project-1'
        AND last_dirty_token > 0
    \`)
    const [state] = await database.queryJson(\`
      SELECT
        project_id AS projectId,
        CAST(dirty_token AS INTEGER) AS dirtyToken,
        CAST(active_dirty_token AS INTEGER) AS activeDirtyToken,
        CAST(last_completed_dirty_token AS INTEGER) AS lastCompletedDirtyToken,
        refresh_status AS refreshStatus,
        worker_id AS workerId
      FROM app.project_mart_refresh_state
      WHERE project_id = 'refresh-project-1'
      LIMIT 1
    \`)

    console.log(JSON.stringify({batch, completion, remainingRow, state}))
    await database.close()
  `)

  expect(result.batch).toEqual({articleIds: ['refresh-article-1'], hasMore: false})
  expect(result.completion.isClaimComplete).toBe(true)
  expect(result.completion.completedState?.lastCompletedDirtyToken).toBe(1)
  expect(result.remainingRow.rowCount).toBe(0)
  expect(result.state).toMatchObject({
    activeDirtyToken: 0,
    dirtyToken: 1,
    lastCompletedDirtyToken: 1,
    refreshStatus: 'idle',
    workerId: null,
  })
})

test('markProjectsDirtyAtomically reuses inactive completed article state rows', () => {
  const result = runRefreshStateScript<{
    batch: {articleIds: string[]; hasMore: boolean}
    reactivatedRow: ProjectMartRefreshArticleStateRecord
    secondClaim: {claimedToken: number; lastCompletedToken: number; projectId: string}
  }>(`
    const {getProjectMartDirtyRefreshStateService} = await import('./src/server/services/projectMartDirtyRefreshStateService.ts')

    const service = getProjectMartDirtyRefreshStateService()
    await service.markProjectsDirtyAtomically({
      projects: [{projectId: 'refresh-project-1', articleIds: ['refresh-article-1']}],
      reason: 'project-update',
      requestedBy: 'route-test',
      now: new Date('2026-04-02T12:25:00.000Z'),
    })
    const [firstClaim] = await service.claimDirtyProjects({
      workerId: 'worker-1',
      limit: 1,
      leaseMs: 5000,
      now: new Date('2026-04-02T12:25:01.000Z'),
    })
    const firstBatch = await service.getDirtyArticleBatchForClaim({
      batchSize: 10,
      claimedToken: firstClaim.claimedToken,
      projectId: firstClaim.projectId,
      workerId: firstClaim.workerId,
    })
    await service.completeDirtyArticleBatchForClaim({
      articleIds: firstBatch.articleIds,
      claimedToken: firstClaim.claimedToken,
      projectId: firstClaim.projectId,
      workerId: firstClaim.workerId,
      now: new Date('2026-04-02T12:25:02.000Z'),
    })
    await service.markProjectsDirtyAtomically({
      projects: [{projectId: 'refresh-project-1', articleIds: ['refresh-article-1']}],
      reason: 'project-update-again',
      requestedBy: 'route-test',
      now: new Date('2026-04-02T12:25:03.000Z'),
    })
    const [secondClaim] = await service.claimDirtyProjects({
      workerId: 'worker-2',
      limit: 1,
      leaseMs: 5000,
      now: new Date('2026-04-02T12:25:04.000Z'),
    })
    const batch = await service.getDirtyArticleBatchForClaim({
      batchSize: 10,
      claimedToken: secondClaim.claimedToken,
      projectId: secondClaim.projectId,
      workerId: secondClaim.workerId,
    })
    const [reactivatedRow] = await database.queryJson(\`
      SELECT
        project_id AS projectId,
        article_id AS articleId,
        CAST(first_dirty_token AS INTEGER) AS firstDirtyToken,
        CAST(last_dirty_token AS INTEGER) AS lastDirtyToken,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM app.project_mart_refresh_article_state
      WHERE project_id = 'refresh-project-1'
        AND article_id = 'refresh-article-1'
      LIMIT 1
    \`)

    console.log(JSON.stringify({batch, reactivatedRow, secondClaim}))
    await database.close()
  `)

  expect(result.secondClaim).toMatchObject({claimedToken: 2, lastCompletedToken: 1, projectId: 'refresh-project-1'})
  expect(result.batch).toEqual({articleIds: ['refresh-article-1'], hasMore: false})
  expect(result.reactivatedRow).toMatchObject({
    articleId: 'refresh-article-1',
    firstDirtyToken: 2,
    lastDirtyToken: 2,
    projectId: 'refresh-project-1',
  })
})

test('getDirtyArticleBatchForClaim completes an exactly batch-sized claim', () => {
  const result = runRefreshStateScript<{
    batch: {articleIds: string[]; hasMore: boolean}
    completion: {completedState: ProjectMartDirtyRefreshStateRecord | null; isClaimComplete: boolean}
    remainingRow: {rowCount: number}
  }>(`
    const {getProjectMartDirtyRefreshStateService} = await import('./src/server/services/projectMartDirtyRefreshStateService.ts')

    const service = getProjectMartDirtyRefreshStateService()
    await service.markProjectsDirtyAtomically({
      projects: [{projectId: 'refresh-project-1', articleIds: ['refresh-article-2', 'refresh-article-1']}],
      reason: 'project-update',
      requestedBy: 'route-test',
      now: new Date('2026-04-02T12:30:00.000Z'),
    })
    const [claim] = await service.claimDirtyProjects({
      workerId: 'worker-1',
      limit: 1,
      leaseMs: 5000,
      now: new Date('2026-04-02T12:30:01.000Z'),
    })
    const batch = await service.getDirtyArticleBatchForClaim({
      batchSize: 2,
      claimedToken: claim.claimedToken,
      projectId: claim.projectId,
      workerId: claim.workerId,
    })
    const completion = await service.completeDirtyArticleBatchForClaim({
      articleIds: batch.articleIds,
      claimedToken: claim.claimedToken,
      projectId: claim.projectId,
      workerId: claim.workerId,
      now: new Date('2026-04-02T12:30:02.000Z'),
    })
    const [remainingRow] = await database.queryJson(\`
      SELECT CAST(COUNT(*) AS INTEGER) AS rowCount
      FROM app.project_mart_refresh_article_state
      WHERE project_id = 'refresh-project-1'
        AND last_dirty_token > 0
    \`)

    console.log(JSON.stringify({batch, completion, remainingRow}))
    await database.close()
  `)

  expect(result.batch).toEqual({articleIds: ['refresh-article-1', 'refresh-article-2'], hasMore: false})
  expect(result.completion.isClaimComplete).toBe(true)
  expect(result.completion.completedState?.lastCompletedDirtyToken).toBe(1)
  expect(result.remainingRow.rowCount).toBe(0)
})

test('completeDirtyArticleBatchForClaim clears multi-batch work before advancing the claim token', () => {
  const result = runRefreshStateScript<{
    firstBatch: {articleIds: string[]; hasMore: boolean}
    firstCompletion: {completedState: ProjectMartDirtyRefreshStateRecord | null; isClaimComplete: boolean}
    rowsAfterFirstBatch: ProjectMartRefreshArticleStateRecord[]
    secondBatch: {articleIds: string[]; hasMore: boolean}
    secondCompletion: {completedState: ProjectMartDirtyRefreshStateRecord | null; isClaimComplete: boolean}
    stateAfterFirstBatch: ProjectMartDirtyRefreshStateRecord
  }>(`
    const {getProjectMartDirtyRefreshStateService} = await import('./src/server/services/projectMartDirtyRefreshStateService.ts')

    const service = getProjectMartDirtyRefreshStateService()
    await database.run(\`
      INSERT INTO app.article (id, article_title)
      VALUES ('refresh-article-3', 'Refresh Article 3')
    \`)
    await service.markProjectsDirtyAtomically({
      projects: [{
        projectId: 'refresh-project-1',
        articleIds: ['refresh-article-3', 'refresh-article-1', 'refresh-article-2'],
      }],
      reason: 'project-update',
      requestedBy: 'route-test',
      now: new Date('2026-04-02T12:40:00.000Z'),
    })
    const [claim] = await service.claimDirtyProjects({
      workerId: 'worker-1',
      limit: 1,
      leaseMs: 5000,
      now: new Date('2026-04-02T12:40:01.000Z'),
    })
    const firstBatch = await service.getDirtyArticleBatchForClaim({
      batchSize: 2,
      claimedToken: claim.claimedToken,
      projectId: claim.projectId,
      workerId: claim.workerId,
    })
    const firstCompletion = await service.completeDirtyArticleBatchForClaim({
      articleIds: firstBatch.articleIds,
      claimedToken: claim.claimedToken,
      projectId: claim.projectId,
      workerId: claim.workerId,
      now: new Date('2026-04-02T12:40:02.000Z'),
    })
    const [stateAfterFirstBatch] = await database.queryJson(\`
      SELECT
        project_id AS projectId,
        CAST(dirty_token AS INTEGER) AS dirtyToken,
        CAST(active_dirty_token AS INTEGER) AS activeDirtyToken,
        CAST(last_completed_dirty_token AS INTEGER) AS lastCompletedDirtyToken,
        refresh_status AS refreshStatus,
        worker_id AS workerId
      FROM app.project_mart_refresh_state
      WHERE project_id = 'refresh-project-1'
      LIMIT 1
    \`)
    const rowsAfterFirstBatch = await database.queryJson(\`
      SELECT
        project_id AS projectId,
        article_id AS articleId,
        CAST(first_dirty_token AS INTEGER) AS firstDirtyToken,
        CAST(last_dirty_token AS INTEGER) AS lastDirtyToken,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM app.project_mart_refresh_article_state
      WHERE project_id = 'refresh-project-1'
        AND last_dirty_token > 0
      ORDER BY article_id ASC
    \`)
    const secondBatch = await service.getDirtyArticleBatchForClaim({
      batchSize: 2,
      claimedToken: claim.claimedToken,
      projectId: claim.projectId,
      workerId: claim.workerId,
    })
    const secondCompletion = await service.completeDirtyArticleBatchForClaim({
      articleIds: secondBatch.articleIds,
      claimedToken: claim.claimedToken,
      projectId: claim.projectId,
      workerId: claim.workerId,
      now: new Date('2026-04-02T12:40:03.000Z'),
    })

    console.log(JSON.stringify({
      firstBatch,
      firstCompletion,
      rowsAfterFirstBatch,
      secondBatch,
      secondCompletion,
      stateAfterFirstBatch,
    }))
    await database.close()
  `)

  expect(result.firstBatch).toEqual({articleIds: ['refresh-article-1', 'refresh-article-2'], hasMore: true})
  expect(result.firstCompletion.isClaimComplete).toBe(false)
  expect(result.firstCompletion.completedState).toBeNull()
  expect(result.stateAfterFirstBatch).toMatchObject({
    activeDirtyToken: 1,
    dirtyToken: 1,
    lastCompletedDirtyToken: 0,
    refreshStatus: 'running',
    workerId: 'worker-1',
  })
  expect(
    result.rowsAfterFirstBatch.map((row) => {
      return {articleId: row.articleId, firstDirtyToken: row.firstDirtyToken, lastDirtyToken: row.lastDirtyToken}
    }),
  ).toEqual([{articleId: 'refresh-article-3', firstDirtyToken: 1, lastDirtyToken: 1}])
  expect(result.secondBatch).toEqual({articleIds: ['refresh-article-3'], hasMore: false})
  expect(result.secondCompletion.isClaimComplete).toBe(true)
  expect(result.secondCompletion.completedState?.lastCompletedDirtyToken).toBe(1)
})

test('getDirtyArticleBatchForClaim keeps large-scope reads bounded and deterministic', () => {
  const result = runRefreshStateScript<{
    batch: {articleIds: string[]; hasMore: boolean}
    completion: {completedState: ProjectMartDirtyRefreshStateRecord | null; isClaimComplete: boolean}
    nextBatch: {articleIds: string[]; hasMore: boolean}
    remainingRow: {rowCount: number}
    state: ProjectMartDirtyRefreshStateRecord
  }>(`
    const {getProjectMartDirtyRefreshStateService} = await import('./src/server/services/projectMartDirtyRefreshStateService.ts')

    const service = getProjectMartDirtyRefreshStateService()
    const largeArticleIds = Array.from({length: 40}, (_value, index) => {
      return \`large-refresh-article-\${String(index + 1).padStart(3, '0')}\`
    })

    await database.run(\`
      INSERT INTO app.article (id, article_title)
      VALUES \${largeArticleIds
        .map((articleId) => {
          return \`('\${articleId}', '\${articleId}')\`
        })
        .join(', ')}
    \`)
    await service.markProjectsDirtyAtomically({
      projects: [{projectId: 'refresh-project-1', articleIds: largeArticleIds}],
      reason: 'project-update',
      requestedBy: 'route-test',
      now: new Date('2026-04-02T12:50:00.000Z'),
    })
    const [claim] = await service.claimDirtyProjects({
      workerId: 'worker-1',
      limit: 1,
      leaseMs: 5000,
      now: new Date('2026-04-02T12:50:01.000Z'),
    })
    const batch = await service.getDirtyArticleBatchForClaim({
      batchSize: 7,
      claimedToken: claim.claimedToken,
      projectId: claim.projectId,
      workerId: claim.workerId,
    })
    const completion = await service.completeDirtyArticleBatchForClaim({
      articleIds: batch.articleIds,
      claimedToken: claim.claimedToken,
      projectId: claim.projectId,
      workerId: claim.workerId,
      now: new Date('2026-04-02T12:50:02.000Z'),
    })
    const [remainingRow] = await database.queryJson(\`
      SELECT CAST(COUNT(*) AS INTEGER) AS rowCount
      FROM app.project_mart_refresh_article_state
      WHERE project_id = 'refresh-project-1'
        AND last_dirty_token > 0
    \`)
    const [state] = await database.queryJson(\`
      SELECT
        project_id AS projectId,
        CAST(dirty_token AS INTEGER) AS dirtyToken,
        CAST(active_dirty_token AS INTEGER) AS activeDirtyToken,
        CAST(last_completed_dirty_token AS INTEGER) AS lastCompletedDirtyToken,
        refresh_status AS refreshStatus,
        worker_id AS workerId
      FROM app.project_mart_refresh_state
      WHERE project_id = 'refresh-project-1'
      LIMIT 1
    \`)
    const nextBatch = await service.getDirtyArticleBatchForClaim({
      batchSize: 7,
      claimedToken: claim.claimedToken,
      projectId: claim.projectId,
      workerId: claim.workerId,
    })

    console.log(JSON.stringify({batch, completion, nextBatch, remainingRow, state}))
    await database.close()
  `)

  expect(result.batch).toEqual({
    articleIds: [
      'large-refresh-article-001',
      'large-refresh-article-002',
      'large-refresh-article-003',
      'large-refresh-article-004',
      'large-refresh-article-005',
      'large-refresh-article-006',
      'large-refresh-article-007',
    ],
    hasMore: true,
  })
  expect(result.completion).toMatchObject({completedState: null, isClaimComplete: false})
  expect(result.remainingRow.rowCount).toBe(33)
  expect(result.state).toMatchObject({
    activeDirtyToken: 1,
    dirtyToken: 1,
    lastCompletedDirtyToken: 0,
    refreshStatus: 'running',
    workerId: 'worker-1',
  })
  expect(result.nextBatch.articleIds).toEqual([
    'large-refresh-article-008',
    'large-refresh-article-009',
    'large-refresh-article-010',
    'large-refresh-article-011',
    'large-refresh-article-012',
    'large-refresh-article-013',
    'large-refresh-article-014',
  ])
  expect(result.nextBatch.hasMore).toBe(true)
})

test('completeDirtyArticleBatchForClaim clears many completed article states', () => {
  const result = runRefreshStateScript<{
    batch: {articleIds: string[]; hasMore: boolean}
    completion: {completedState: ProjectMartDirtyRefreshStateRecord | null; isClaimComplete: boolean}
    remainingRow: {rowCount: number}
  }>(`
    const {getProjectMartDirtyRefreshStateService} = await import('./src/server/services/projectMartDirtyRefreshStateService.ts')
    const service = getProjectMartDirtyRefreshStateService()
    const articleIds = Array.from({length: 75}, (_entry, index) => {
      return 'bulk-completion-article-' + String(index + 1).padStart(3, '0')
    })
    const articleValues = articleIds.map((articleId) => {
      return \`('\${articleId}', '\${articleId}')\`
    }).join(', ')

    await database.run(\`INSERT INTO app.article (id, article_title) VALUES \${articleValues}\`)
    await service.markProjectsDirtyAtomically({
      projects: [{projectId: 'refresh-project-1', articleIds}],
      reason: 'project-update',
      requestedBy: 'route-test',
      now: new Date('2026-04-02T12:55:00.000Z'),
    })

    const [claim] = await service.claimDirtyProjects({
      workerId: 'worker-1',
      limit: 1,
      leaseMs: 5000,
      now: new Date('2026-04-02T12:55:01.000Z'),
    })
    const batch = await service.getDirtyArticleBatchForClaim({
      batchSize: 100,
      claimedToken: claim.claimedToken,
      projectId: claim.projectId,
      workerId: claim.workerId,
    })
    const completion = await service.completeDirtyArticleBatchForClaim({
      articleIds: batch.articleIds,
      claimedToken: claim.claimedToken,
      projectId: claim.projectId,
      workerId: claim.workerId,
      now: new Date('2026-04-02T12:55:02.000Z'),
    })
    const [remainingRow] = await database.queryJson(\`
      SELECT CAST(COUNT(*) AS INTEGER) AS rowCount
      FROM app.project_mart_refresh_article_state
      WHERE project_id = 'refresh-project-1'
        AND last_dirty_token > 0
    \`)

    console.log(JSON.stringify({batch, completion, remainingRow}))
    await database.close()
  `)

  expect(result.batch.articleIds).toHaveLength(75)
  expect(result.batch.hasMore).toBe(false)
  expect(result.completion.isClaimComplete).toBe(true)
  expect(result.completion.completedState?.lastCompletedDirtyToken).toBe(1)
  expect(result.remainingRow.rowCount).toBe(0)
})

test('finalizeProjectRefreshAfterLargeRebuild advances refresh completion after claim release', () => {
  const result = runRefreshStateScript<{
    finalizedState: ProjectMartDirtyRefreshStateRecord | null
    remainingArticlesAfterFinalize: ProjectMartRefreshArticleStateRecord[]
    unresolvedAfterFinalize: Array<{articleId: string}>
  }>(`
    const {getProjectMartDirtyRefreshStateService} = await import('./src/server/services/projectMartDirtyRefreshStateService.ts')
    const service = getProjectMartDirtyRefreshStateService()

    await service.markProjectsDirtyAtomically({
      projects: [{projectId: 'refresh-project-1', articleIds: ['refresh-article-1']}],
      reason: 'project-update',
      requestedBy: 'route-test',
      now: new Date('2026-04-02T12:10:00.000Z'),
    })

    const [firstClaim] = await service.claimDirtyProjects({
      workerId: 'worker-1',
      limit: 1,
      leaseMs: 5000,
      now: new Date('2026-04-02T12:10:01.000Z'),
    })

    await service.markProjectsDirtyAtomically({
      projects: [{projectId: 'refresh-project-1', articleIds: ['refresh-article-1', 'refresh-article-2']}],
      reason: 'project-update',
      requestedBy: 'route-test',
      now: new Date('2026-04-02T12:10:02.000Z'),
    })

    await service.releaseProjectRefreshClaim({
      projectId: 'refresh-project-1',
      workerId: 'worker-1',
      now: new Date('2026-04-02T12:10:03.000Z'),
    })

    const finalizedState = await service.finalizeProjectRefreshAfterLargeRebuild({
      completedToken: firstClaim.claimedToken,
      projectId: 'refresh-project-1',
      now: new Date('2026-04-02T12:10:04.000Z'),
    })
    const remainingArticlesAfterFinalize = await database.queryJson(\`
      SELECT
        project_id AS projectId,
        article_id AS articleId,
        CAST(first_dirty_token AS INTEGER) AS firstDirtyToken,
        CAST(last_dirty_token AS INTEGER) AS lastDirtyToken,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM app.project_mart_refresh_article_state
      WHERE project_id = 'refresh-project-1'
        AND last_dirty_token > 0
      ORDER BY article_id ASC
    \`)
    const unresolvedAfterFinalize = await service.getDirtyArticlesForClaim({
      projectId: 'refresh-project-1',
      lastCompletedToken: 1,
      claimedToken: 2,
    })

    console.log(JSON.stringify({
      finalizedState,
      remainingArticlesAfterFinalize,
      unresolvedAfterFinalize,
    }))
    await database.close()
  `)

  expect(result.finalizedState?.projectId).toBe('refresh-project-1')
  expect(result.finalizedState?.dirtyToken).toBe(2)
  expect(result.finalizedState?.lastCompletedDirtyToken).toBe(1)
  expect(result.finalizedState?.activeDirtyToken).toBe(0)
  expect(result.finalizedState?.refreshStatus).toBe('idle')
  expect(result.finalizedState?.workerId).toBeNull()
  expect(
    result.remainingArticlesAfterFinalize.map((row) => {
      return {articleId: row.articleId, firstDirtyToken: row.firstDirtyToken, lastDirtyToken: row.lastDirtyToken}
    }),
  ).toEqual([
    {articleId: 'refresh-article-1', firstDirtyToken: 2, lastDirtyToken: 2},
    {articleId: 'refresh-article-2', firstDirtyToken: 2, lastDirtyToken: 2},
  ])
  expect(result.unresolvedAfterFinalize).toEqual([{articleId: 'refresh-article-1'}, {articleId: 'refresh-article-2'}])
})

test('finalizeProjectRefreshAfterLargeRebuild clears many completed article states', () => {
  const result = runRefreshStateScript<{
    finalizedState: ProjectMartDirtyRefreshStateRecord | null
    remainingRow: {rowCount: number}
  }>(`
    const {getProjectMartDirtyRefreshStateService} = await import('./src/server/services/projectMartDirtyRefreshStateService.ts')
    const service = getProjectMartDirtyRefreshStateService()
    const articleIds = Array.from({length: 75}, (_entry, index) => {
      return 'bulk-refresh-article-' + String(index + 1).padStart(3, '0')
    })
    const articleValues = articleIds.map((articleId) => {
      return \`('\${articleId}', '\${articleId}')\`
    }).join(', ')

    await database.run(\`INSERT INTO app.article (id, article_title) VALUES \${articleValues}\`)
    await service.markProjectsDirtyAtomically({
      projects: [{projectId: 'refresh-project-1', articleIds}],
      reason: 'project-update',
      requestedBy: 'route-test',
      now: new Date('2026-04-02T12:20:00.000Z'),
    })

    const [claim] = await service.claimDirtyProjects({
      workerId: 'worker-1',
      limit: 1,
      leaseMs: 5000,
      now: new Date('2026-04-02T12:20:01.000Z'),
    })

    await service.releaseProjectRefreshClaim({
      projectId: 'refresh-project-1',
      workerId: 'worker-1',
      now: new Date('2026-04-02T12:20:02.000Z'),
    })

    const finalizedState = await service.finalizeProjectRefreshAfterLargeRebuild({
      completedToken: claim.claimedToken,
      projectId: 'refresh-project-1',
      now: new Date('2026-04-02T12:20:03.000Z'),
    })
    const [remainingRow] = await database.queryJson(\`
      SELECT CAST(COUNT(*) AS INTEGER) AS rowCount
      FROM app.project_mart_refresh_article_state
      WHERE project_id = 'refresh-project-1'
        AND last_dirty_token > 0
    \`)

    console.log(JSON.stringify({finalizedState, remainingRow}))
    await database.close()
  `)

  expect(result.finalizedState?.projectId).toBe('refresh-project-1')
  expect(result.finalizedState?.lastCompletedDirtyToken).toBe(1)
  expect(result.finalizedState?.refreshStatus).toBe('idle')
  expect(result.remainingRow.rowCount).toBe(0)
})

test('clearArchivedProjectRefreshStates removes archived refresh debt and claimDirtyProjects skips archived projects', () => {
  const result = runRefreshStateScript<{
    activeClaims: Array<{projectId: string}>
    archivedRefreshRows: number
    archivedArticleRows: number
  }>(`
    const {getProjectMartDirtyRefreshStateService} = await import('./src/server/services/projectMartDirtyRefreshStateService.ts')
    const service = getProjectMartDirtyRefreshStateService()

    await database.run(\`
      UPDATE app.project
      SET archived = TRUE
      WHERE id = 'refresh-project-2'
    \`)
    await service.markProjectsDirtyAtomically({
      projects: [
        {articleIds: ['refresh-article-1'], projectId: 'refresh-project-1'},
        {articleIds: ['refresh-article-2'], projectId: 'refresh-project-2'},
      ],
      reason: 'refresh-state-test.archived-cleanup',
    })

    const activeClaims = await service.claimDirtyProjects({leaseMs: 5000, limit: 5, workerId: 'worker-1'})
    await service.clearArchivedProjectRefreshStates()
    const [archivedRefreshRow] = await database.queryJson(\`
      SELECT CAST(COUNT(*) AS INTEGER) AS rowCount
      FROM app.project_mart_refresh_state
      WHERE project_id = 'refresh-project-2'
    \`)
    const [archivedArticleRow] = await database.queryJson(\`
      SELECT CAST(COUNT(*) AS INTEGER) AS rowCount
      FROM app.project_mart_refresh_article_state
      WHERE project_id = 'refresh-project-2'
        AND last_dirty_token > 0
    \`)

    console.log(JSON.stringify({
      activeClaims: activeClaims.map((claim) => ({projectId: claim.projectId})),
      archivedArticleRows: archivedArticleRow?.rowCount ?? 0,
      archivedRefreshRows: archivedRefreshRow?.rowCount ?? 0,
    }))
    await database.close()
  `)

  expect(result.activeClaims).toEqual([{projectId: 'refresh-project-1'}])
  expect(result.archivedRefreshRows).toBe(0)
  expect(result.archivedArticleRows).toBe(0)
})

test('dirty project claims keep quarantined articles as completion barriers', () => {
  const result = runRefreshStateScript<{
    articleRows: ProjectMartRefreshArticleStateRecord[]
    batch: {articleIds: string[]; hasMore: boolean} | null
    claims: Array<{projectId: string}>
    claimsAfterCompletion: Array<{projectId: string}>
    completion: {completedState: ProjectMartDirtyRefreshStateRecord | null; isClaimComplete: boolean} | null
    quarantine: {articleId: string; detectedBy: string | null; error: string} | null
    quarantinedArticles: Array<{articleId: string; detectedBy: string | null; error: string}>
    refreshState: {
      activeDirtyToken: number
      dirtyToken: number
      lastCompletedDirtyToken: number
      lastError: string | null
      refreshStatus: string
      workerId: string | null
    } | null
  }>(`
    const {getProjectMartDirtyRefreshStateService} = await import('./src/server/services/projectMartDirtyRefreshStateService.ts')
    const service = getProjectMartDirtyRefreshStateService()

    await service.markProjectsDirtyAtomically({
      projects: [{articleIds: ['refresh-article-1', 'refresh-article-2'], projectId: 'refresh-project-1'}],
      reason: 'refresh-state-test.quarantine',
    })
    const claims = await service.claimDirtyProjects({leaseMs: 5000, limit: 5, workerId: 'worker-1'})
    const quarantine = await service.quarantineProjectRefreshArticle({
      articleId: 'refresh-article-1',
      detectedBy: 'test-suite',
      error: 'native crash repro',
    })
    const [claim] = claims
    const batch = claim
      ? await service.getDirtyArticleBatchForClaim({
          batchSize: 5,
          claimedToken: claim.claimedToken,
          projectId: claim.projectId,
          workerId: claim.workerId,
        })
      : null
    const completion = claim && batch
      ? await service.completeDirtyArticleBatchForClaim({
          articleIds: batch.articleIds,
          claimedToken: claim.claimedToken,
          projectId: claim.projectId,
          workerId: claim.workerId,
          now: new Date('2026-04-02T13:00:00.000Z'),
        })
      : null
    const claimsAfterCompletion = await service.claimDirtyProjects({leaseMs: 5000, limit: 5, workerId: 'worker-2'})
    const quarantinedArticles = await service.getQuarantinedArticlesForProject({projectId: 'refresh-project-1'})
    const articleRows = await database.queryJson(\`
      SELECT
        project_id AS projectId,
        article_id AS articleId,
        CAST(first_dirty_token AS INTEGER) AS firstDirtyToken,
        CAST(last_dirty_token AS INTEGER) AS lastDirtyToken,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM app.project_mart_refresh_article_state
      WHERE project_id = 'refresh-project-1'
        AND last_dirty_token > 0
      ORDER BY article_id ASC
    \`)
    const [refreshState] = await database.queryJson(\`
      SELECT
        CAST(active_dirty_token AS INTEGER) AS activeDirtyToken,
        CAST(dirty_token AS INTEGER) AS dirtyToken,
        CAST(last_completed_dirty_token AS INTEGER) AS lastCompletedDirtyToken,
        last_error AS lastError,
        refresh_status AS refreshStatus,
        worker_id AS workerId
      FROM app.project_mart_refresh_state
      WHERE project_id = 'refresh-project-1'
      LIMIT 1
    \`)

    console.log(JSON.stringify({
      articleRows,
      batch,
      claims: claims.map((claim) => ({projectId: claim.projectId})),
      claimsAfterCompletion: claimsAfterCompletion.map((claim) => ({projectId: claim.projectId})),
      completion,
      quarantine,
      quarantinedArticles,
      refreshState,
    }))
    await database.close()
  `)

  expect(result.quarantine?.articleId).toBe('refresh-article-1')
  expect(result.quarantine?.detectedBy).toBe('test-suite')
  expect(result.quarantine?.error).toBe('native crash repro')
  expect(result.claims).toEqual([{projectId: 'refresh-project-1'}])
  expect(result.batch).toEqual({articleIds: ['refresh-article-2'], hasMore: false})
  expect(result.completion?.isClaimComplete).toBe(false)
  expect(result.completion?.isBlockedByQuarantine).toBe(true)
  expect(result.completion?.completedState).toBeNull()
  expect(result.claimsAfterCompletion).toEqual([])
  expect(
    result.articleRows.map((row) => {
      return {articleId: row.articleId, firstDirtyToken: row.firstDirtyToken, lastDirtyToken: row.lastDirtyToken}
    }),
  ).toEqual([{articleId: 'refresh-article-1', firstDirtyToken: 1, lastDirtyToken: 1}])
  expect(
    result.quarantinedArticles.map((row) => {
      return {articleId: row.articleId, detectedBy: row.detectedBy, error: row.error}
    }),
  ).toEqual([{articleId: 'refresh-article-1', detectedBy: 'test-suite', error: 'native crash repro'}])
  expect(result.refreshState).toMatchObject({
    activeDirtyToken: 1,
    dirtyToken: 1,
    lastCompletedDirtyToken: 0,
    lastError: null,
    refreshStatus: 'blocked_by_quarantine',
    workerId: null,
  })
})

test('claimDirtyProjects ignores retired large rebuild state', () => {
  const result = runRefreshStateScript<{claims: Array<{projectId: string}>}>(`
    const {getProjectMartDirtyRefreshStateService} = await import('./src/server/services/projectMartDirtyRefreshStateService.ts')
    const refreshStateService = getProjectMartDirtyRefreshStateService()

    await refreshStateService.markProjectsDirtyAtomically({
      projects: [{articleIds: ['refresh-article-1'], projectId: 'refresh-project-1'}],
      reason: 'refresh-state-test.large-rebuild-handoff',
    })
    await database.run(\`
      INSERT INTO app.project_mart_large_rebuild_state (
        project_id,
        refresh_token,
        rebuild_phase,
        refresh_status
      ) VALUES (
        'refresh-project-1',
        1,
        'prompt_answer_fact',
        'running'
      )
    \`)
    const claims = await refreshStateService.claimDirtyProjects({leaseMs: 5000, limit: 5, workerId: 'worker-1'})

    console.log(JSON.stringify({claims: claims.map((claim) => ({projectId: claim.projectId}))}))
    await database.close()
  `)

  expect(result.claims).toEqual([{projectId: 'refresh-project-1'}])
})
