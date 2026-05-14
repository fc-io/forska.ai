import {rmSync} from 'node:fs'

import {expect, test} from 'bun:test'

type ResolutionResult = {rows: Array<{articleId: string; canonicalArticleId: string | null; projectId: string | null}>}

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

const getResolutionScript = () => {
  return `
    const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
    const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
    const {resolveCanonicalArticleIds} = await import('./src/server/services/articleIdCompatibilityAdapter.ts')

    await migrateDuckdb()

    const database = getAppDatabaseService()

    await database.run(\`
      INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
      VALUES ('provider-article-id-resolution', 'sglang', 'Provider Article ID Resolution', TRUE, 'none', 'http://localhost:30001/v1')
    \`)

    await database.run(\`
      INSERT INTO app.model (
        id,
        provider_connection_id,
        name,
        remote_model_id,
        display_name,
        variant,
        source,
        enabled,
        metadata_json
      ) VALUES ('model-article-id-resolution', 'provider-article-id-resolution', 'Model Article ID Resolution', 'model-article-id-resolution', 'Model Article ID Resolution', 'manual', 'manual', TRUE, '{}'::JSON)
    \`)

    await database.run(\`
      INSERT INTO app.project (id, name, description, model_id, human_judgment_mode)
      VALUES ('project-1', 'Project 1', NULL, 'model-article-id-resolution', 'prompt')
    \`)

    await database.run(\`
      INSERT INTO app.import_route (id, route, name, description)
      VALUES
        ('route-a', 'route-a', 'Route A', NULL),
        ('route-b', 'route-b', 'Route B', NULL)
    \`)

    await database.run(\`
      INSERT INTO app.project_import_route (id, project_id, import_route_id)
      VALUES
        ('project-route-a', 'project-1', 'route-a'),
        ('project-route-b', 'project-1', 'route-b')
    \`)

    await database.run(\`
      INSERT INTO app.article (id, article_id, article_title)
      VALUES
        ('article-a', 'legacy-a', 'Article A'),
        ('article-b', 'legacy-b', 'Article B'),
        ('article-legacy-a', 'duplicate-legacy', 'Legacy A'),
        ('article-legacy-b', 'duplicate-legacy', 'Legacy B')
    \`)

    await database.run(\`
      INSERT INTO app.article_import_route (id, article_id, import_route_id, external_article_id)
      VALUES
        ('air-a', 'article-a', 'route-a', 'duplicate-current'),
        ('air-b', 'article-b', 'route-b', 'duplicate-current')
    \`)

    await database.run(\`
      INSERT INTO app.article_import_route_source_record (
        id,
        article_id,
        import_route_id,
        external_article_id,
        source_record_key,
        source_record_hash,
        quarantined_at
      ) VALUES
        ('source-quarantined-only', 'article-a', 'route-a', 'quarantined-source', 'record-quarantined-only', 'hash-quarantined-only', TIMESTAMPTZ '2026-01-01T00:00:00.000Z'),
        ('source-quarantined', 'article-a', 'route-a', 'active-source', 'record-quarantined', 'hash-quarantined', TIMESTAMPTZ '2026-01-01T00:00:00.000Z'),
        ('source-active', 'article-b', 'route-b', 'active-source', 'record-active', 'hash-active', NULL)
    \`)

    const rows = await resolveCanonicalArticleIds(database, [
      {articleId: 'duplicate-current', projectId: 'project-1'},
      {articleId: 'duplicate-legacy', projectId: 'project-1'},
      {articleId: 'quarantined-source', projectId: 'project-1'},
      {articleId: 'active-source', projectId: 'project-1'},
      {articleId: 'article-a', projectId: 'project-1'},
    ])

    console.log(JSON.stringify({rows}))
  `
}

const runScript = <T>(body: string) => {
  const duckdbPath = `/tmp/f1-article-id-compatibility-${Date.now()}-${Math.random().toString(16).slice(2)}.duckdb`
  const runResult = globalThis.Bun.spawnSync(['bun', '-e', body], {
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
    if (runResult.exitCode !== 0) {
      throw new Error(
        runResult.stderr.toString() || runResult.stdout.toString() || 'Article ID compatibility test failed',
      )
    }

    return JSON.parse(getLastJsonLine(runResult.stdout.toString())) as T
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
  }
}

test('canonical article ID resolution rejects ambiguous matches and ignores quarantined source records', () => {
  const result = runScript<ResolutionResult>(getResolutionScript())

  expect(result.rows).toEqual([
    {articleId: 'duplicate-current', canonicalArticleId: null, projectId: 'project-1'},
    {articleId: 'duplicate-legacy', canonicalArticleId: null, projectId: 'project-1'},
    {articleId: 'quarantined-source', canonicalArticleId: null, projectId: 'project-1'},
    {articleId: 'active-source', canonicalArticleId: 'article-b', projectId: 'project-1'},
    {articleId: 'article-a', canonicalArticleId: 'article-a', projectId: 'project-1'},
  ])
})
