import {rmSync} from 'node:fs'

import {expect, test} from 'bun:test'

import {createTransientJudgmentExecutionSnapshotsForClaims} from './judgmentExecutionSnapshotService.ts'

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

const runScript = <T>(body: string) => {
  const duckdbPath = `/tmp/f1-judgment-execution-snapshot-${Date.now()}-${Math.random().toString(16).slice(2)}.duckdb`
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
      throw new Error(runResult.stderr.toString() || runResult.stdout.toString() || 'Snapshot test failed')
    }

    return JSON.parse(getLastJsonLine(runResult.stdout.toString())) as T
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
  }
}

test('snapshot article resolution rejects ambiguous matches and ignores quarantined source records', async () => {
  let snapshotSql = ''

  await createTransientJudgmentExecutionSnapshotsForClaims(
    [
      {
        articleId: 'legacy-or-external-article-id',
        claimId: 'claim-1',
        claimedBy: 'server-1',
        jobId: 'job-1',
        promptId: 'prompt-1',
        queueRecordId: 'queue-1',
      },
    ],
    {
      queryJson: async (statement) => {
        snapshotSql = statement
        return []
      },
    },
  )

  expect(snapshotSql).toContain('COUNT(DISTINCT candidate.canonical_article_id) = 1')
  expect(snapshotSql).toContain('source_record.quarantined_at IS NULL')
  expect(snapshotSql).not.toContain('resolution_order = 1')
})

test('snapshot scoped import selection prefers the requested source identifier', async () => {
  let snapshotSql = ''

  await createTransientJudgmentExecutionSnapshotsForClaims(
    [
      {
        articleId: 'requested-external-id',
        claimId: 'claim-1',
        claimedBy: 'server-1',
        jobId: 'job-1',
        promptId: 'prompt-1',
        queueRecordId: 'queue-1',
      },
    ],
    {
      queryJson: async (statement) => {
        snapshotSql = statement
        return []
      },
    },
  )

  expect(snapshotSql).toContain('current_import.external_article_id = snapshot_request_project.article_id')
  expect(snapshotSql).toContain('selected_identifier_rank')
  expect(snapshotSql).toContain('source_record.external_article_id = snapshot_request_project.article_id')
  expect(snapshotSql).toContain('ORDER BY selected_identifier_rank ASC, selected_source_rank ASC')
})

test('snapshot scoped import selection ranks lightweight rows before reading raw payloads', async () => {
  let snapshotSql = ''

  await createTransientJudgmentExecutionSnapshotsForClaims(
    [
      {
        articleId: 'requested-external-id',
        claimId: 'claim-1',
        claimedBy: 'server-1',
        jobId: 'job-1',
        promptId: 'prompt-1',
        queueRecordId: 'queue-1',
      },
    ],
    {
      queryJson: async (statement) => {
        snapshotSql = statement
        return []
      },
    },
  )

  const candidateStart = snapshotSql.indexOf('scoped_article_import_candidate AS')
  const candidateEnd = snapshotSql.indexOf('selected_scoped_article_import_key AS')
  const candidateSql = snapshotSql.slice(candidateStart, candidateEnd)

  expect(candidateSql).not.toContain('raw_payload')
  expect(snapshotSql).toContain('selected_scoped_article_import_key AS')
  expect(snapshotSql).toContain('current_import.id = selected_key.source_row_id')
  expect(snapshotSql).toContain('source_record.id = selected_key.source_row_id')
})

test('snapshot hydration avoids bulky raw payloads for no-image fulltext claims', async () => {
  let snapshotSql = ''

  await createTransientJudgmentExecutionSnapshotsForClaims(
    [
      {
        articleId: 'requested-external-id',
        claimId: 'claim-1',
        claimedBy: 'server-1',
        jobId: 'job-1',
        promptId: 'prompt-1',
        queueRecordId: 'queue-1',
        useFulltext: false,
        useFulltextNoImages: true,
      },
    ],
    {
      queryJson: async (statement) => {
        snapshotSql = statement
        return []
      },
    },
  )

  expect(snapshotSql).toContain('regexp_replace(a.full_text')
  expect(snapshotSql).toContain('NULL AS fullTextHtml')
  expect(snapshotSql).toContain('NULL AS fullTextAssets')
  expect(snapshotSql).toContain('NULL AS fullTextConversionMetadata')
  expect(snapshotSql).toContain('NULL AS originalData')
  expect(snapshotSql).toContain('NULL AS scopedRawPayload')
  expect(snapshotSql).not.toContain('TO_JSON(scoped_import.raw_payload)')
  expect(snapshotSql).not.toContain('TO_JSON(a.original_data)')
  expect(snapshotSql).not.toContain('TO_JSON(a.full_text_assets)')
})

test('snapshot article resolution prefers project-scoped imports over legacy ids', () => {
  const result = runScript<{articleId: string; articleTitle: string; selectedExternalArticleId: string}>(`
    const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
    const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
    const {createTransientJudgmentExecutionSnapshotsForClaims} = await import('./src/server/services/judgmentExecutionSnapshotService.ts')

    await migrateDuckdb()

    const database = getAppDatabaseService()

    await database.run(\`
      INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
      VALUES ('provider-snapshot-resolution', 'sglang', 'Provider Snapshot Resolution', TRUE, 'none', 'http://localhost:30001/v1')
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
      ) VALUES ('model-snapshot-resolution', 'provider-snapshot-resolution', 'Model Snapshot Resolution', 'model-snapshot-resolution', 'Model Snapshot Resolution', 'manual', 'manual', TRUE, '{}'::JSON)
    \`)

    await database.run(\`
      INSERT INTO app.project (id, name, description, model_id, human_judgment_mode)
      VALUES ('project-snapshot-resolution', 'Project Snapshot Resolution', NULL, 'model-snapshot-resolution', 'prompt')
    \`)

    await database.run(\`
      INSERT INTO app.prompt (id, original_text, transformed_text, prompt_heading, type, content_hash)
      VALUES ('prompt-snapshot-resolution', 'Prompt text', 'Prompt text', 'Prompt', 'boolean', 'snapshot-resolution-prompt')
    \`)

    await database.run(\`
      INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order)
      VALUES ('project-prompt-snapshot-resolution', 'project-snapshot-resolution', 'prompt-snapshot-resolution', 1)
    \`)

    await database.run(\`
      INSERT INTO app.judgment_job (id, project_id, status)
      VALUES ('job-snapshot-resolution', 'project-snapshot-resolution', 'ready')
    \`)

    await database.run(\`
      INSERT INTO app.import_route (id, route, name)
      VALUES ('route-snapshot-resolution', 'route-snapshot-resolution', 'Route Snapshot Resolution')
    \`)

    await database.run(\`
      INSERT INTO app.project_import_route (id, project_id, import_route_id)
      VALUES ('project-route-snapshot-resolution', 'project-snapshot-resolution', 'route-snapshot-resolution')
    \`)

    await database.run(\`
      INSERT INTO app.article (id, article_id, article_title, article_summary)
      VALUES
        ('article-snapshot-legacy', 'snapshot-collision', 'Snapshot Legacy Article', 'Legacy summary'),
        ('article-snapshot-scoped', NULL, 'Snapshot Scoped Article', 'Scoped summary')
    \`)

    await database.run(\`
      INSERT INTO app.article_import_route (id, article_id, import_route_id, external_article_id)
      VALUES ('air-snapshot-scoped', 'article-snapshot-scoped', 'route-snapshot-resolution', 'snapshot-collision')
    \`)

    const [snapshot] = await createTransientJudgmentExecutionSnapshotsForClaims(
      [{
        articleId: 'snapshot-collision',
        claimId: 'claim-snapshot-resolution',
        claimedBy: 'server-1',
        jobId: 'job-snapshot-resolution',
        promptId: 'prompt-snapshot-resolution',
        queueRecordId: 'queue-snapshot-resolution',
      }],
      database,
    )

    console.log(JSON.stringify({
      articleId: snapshot.executionSnapshotPayload.identity.articleId,
      articleTitle: snapshot.executionSnapshotPayload.article.articleTitle,
      selectedExternalArticleId: snapshot.executionSnapshotPayload.article.selectedExternalArticleId,
    }))

    await database.close()
  `)

  expect(result).toEqual({
    articleId: 'article-snapshot-scoped',
    articleTitle: 'Snapshot Scoped Article',
    selectedExternalArticleId: 'snapshot-collision',
  })
})
