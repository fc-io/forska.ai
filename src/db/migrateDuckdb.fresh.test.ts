import {mkdtempSync, readdirSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {expect, test} from 'bun:test'

test('fresh migrations and scoped title-posting updates work on the installed engine without deprecated lambdas', () => {
  const root = mkdtempSync(join(tmpdir(), 'forska-fresh-migrations-'))
  const migrationNames = readdirSync(join(import.meta.dir, 'duckdbMigrations'))
    .filter((name) => {
      return name.endsWith('.sql')
    })
    .sort()

  try {
    const result = globalThis.Bun.spawnSync(
      [
        process.execPath,
        '-e',
        `
        const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
        const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
        const {getRemoveReviewServingTitleSearchArticleIdsStatements} = await import('./src/server/reviewServing/reviewServingProjectorWriter.ts')
        const database = getAppDatabaseService()
        try {
          await migrateDuckdb()
          const before = await database.queryJson('SELECT name, applied_at FROM app_schema_migration ORDER BY name')
          await database.run(\`
            INSERT INTO mart.review_title_search_serving_v4
              (project_id, search_identity, project_scope_identity, snapshot_id, token, article_ids)
            VALUES
              ('project-1', 'search-1', 'scope-1', 'snapshot-1', 'partial', ['article-1', 'article-2']),
              ('project-1', 'search-1', 'scope-1', 'snapshot-1', 'empty', ['article-1']),
              ('project-2', 'search-1', 'scope-1', 'snapshot-1', 'unrelated', ['article-1'])
          \`)
          for (const statement of getRemoveReviewServingTitleSearchArticleIdsStatements({
            articleIds: ['article-1'], projectId: 'project-1', projectScopeIdentity: 'scope-1',
            searchIdentity: 'search-1', snapshotId: 'snapshot-1',
          })) await database.run(statement)
          await migrateDuckdb()
          const after = await database.queryJson('SELECT name, applied_at FROM app_schema_migration ORDER BY name')
          const postings = await database.queryJson('SELECT token, article_ids AS articleIds FROM mart.review_title_search_serving_v4 ORDER BY token')
          console.log(JSON.stringify({before, after, postings}))
        } finally {
          await database.close({checkpointBeforeClose: false})
        }
        `,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DUCKDB_MEMORY_LIMIT: '512MiB',
          DUCKDB_PATH: join(root, 'fresh.duckdb'),
          SERVER_DUCKDB_OWNER_URL: '',
          SERVER_ROLE: 'maintenance-worker',
        },
        stderr: 'pipe',
        stdout: 'pipe',
        timeout: 120_000,
      },
    )

    expect(result.exitCode, result.stderr.toString() || result.stdout.toString()).toBe(0)
    const output = JSON.parse(result.stdout.toString().trim().split('\n').at(-1) ?? '{}') as {
      before: Array<{name: string; applied_at: string}>
      after: Array<{name: string; applied_at: string}>
      postings: Array<{token: string; articleIds: string[]}>
    }

    expect(
      output.before.map(({name}) => {
        return name
      }),
    ).toEqual(migrationNames)
    expect(output.after).toEqual(output.before)
    expect(output.postings).toEqual([
      {token: 'partial', articleIds: ['article-2']},
      {token: 'unrelated', articleIds: ['article-1']},
    ])
  } finally {
    rmSync(root, {recursive: true, force: true})
  }
}, 125_000)
