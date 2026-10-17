import {rmSync} from 'node:fs'

import {expect, setDefaultTimeout, test} from 'bun:test'

import {createTransientJudgmentExecutionSnapshotsForClaims} from './judgmentExecutionSnapshotService.ts'

setDefaultTimeout(120_000)

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

test('snapshot hydration reads only the resolved articles instead of hash-joining the whole article table', async () => {
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
        useFulltextNoImages: false,
      },
    ],
    {
      queryJson: async (statement) => {
        snapshotSql = statement
        return []
      },
    },
  )

  expect(snapshotSql).toContain('WHERE article.id IN (SELECT canonical_article_id FROM snapshot_article_resolution)')
  expect(snapshotSql).not.toContain('LEFT JOIN app.article a ON')
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

test('snapshots carry use_metadata and the PubMed id, and the identity check compares use_metadata', () => {
  const result = runScript<{
    article: {pubmedId: string | null; sourceMetadata: {journalTitle?: string} | null}
    contentSettings: Record<string, boolean | string>
    identityValidWithMetadata: boolean
    identityValidWithoutMetadata: boolean
    snapshotUseMetadata: boolean
    snapshotVersion: number
    storedUseMetadata: boolean
  }>(`
    const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
    const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
    const {
      createJudgmentExecutionSnapshotsForClaims,
      getJudgmentExecutionSnapshot,
      isJudgmentExecutionSnapshotIdentityValid,
    } = await import('./src/server/services/judgmentExecutionSnapshotService.ts')

    await migrateDuckdb()

    const database = getAppDatabaseService()

    await database.run(\`
      INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
      VALUES ('provider-snapshot-metadata', 'sglang', 'Provider Snapshot Metadata', TRUE, 'none', 'http://localhost:30001/v1')
    \`)
    await database.run(\`
      INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, variant, source, enabled, metadata_json)
      VALUES ('model-snapshot-metadata', 'provider-snapshot-metadata', 'Model Snapshot Metadata', 'model-snapshot-metadata', 'Model Snapshot Metadata', 'manual', 'manual', TRUE, '{}'::JSON)
    \`)
    await database.run(\`
      INSERT INTO app.project (id, name, description, model_id, human_judgment_mode, use_metadata)
      VALUES ('project-snapshot-metadata', 'Project Snapshot Metadata', NULL, 'model-snapshot-metadata', 'prompt', TRUE)
    \`)
    await database.run(\`
      INSERT INTO app.prompt (id, original_text, transformed_text, prompt_heading, type, content_hash)
      VALUES ('prompt-snapshot-metadata', 'Prompt text', 'Prompt text', 'Prompt', 'boolean', 'snapshot-metadata-prompt')
    \`)
    await database.run(\`
      INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order)
      VALUES ('project-prompt-snapshot-metadata', 'project-snapshot-metadata', 'prompt-snapshot-metadata', 1)
    \`)
    await database.run(\`
      INSERT INTO app.judgment_job (id, project_id, status)
      VALUES ('job-snapshot-metadata', 'project-snapshot-metadata', 'ready')
    \`)
    await database.run(\`
      INSERT INTO app.article (id, article_id, article_title, article_summary, pubmed_id, source_metadata)
      VALUES ('article-snapshot-metadata', 'article-snapshot-metadata', 'Metadata Article', 'Metadata summary', '12345678', '{"journalTitle":"The Lancet"}'::JSON)
    \`)

    const [snapshot] = await createJudgmentExecutionSnapshotsForClaims([{
      articleId: 'article-snapshot-metadata',
      claimId: 'claim-snapshot-metadata',
      claimedBy: 'server-1',
      jobId: 'job-snapshot-metadata',
      promptId: 'prompt-snapshot-metadata',
      queueRecordId: 'queue-snapshot-metadata',
      useFulltext: false,
      useFulltextNoImages: false,
    }])
    const record = await getJudgmentExecutionSnapshot({
      executionSnapshotHash: snapshot.executionSnapshotHash,
      executionSnapshotId: snapshot.executionSnapshotId,
    })
    const identityInput = {
      articleId: 'article-snapshot-metadata',
      claimId: 'claim-snapshot-metadata',
      executionSnapshotHash: snapshot.executionSnapshotHash,
      executionSnapshotId: snapshot.executionSnapshotId,
      fullTextStrategyId: 'fts-none',
      jobId: 'job-snapshot-metadata',
      modelId: 'model-snapshot-metadata',
      projectId: 'project-snapshot-metadata',
      promptId: 'prompt-snapshot-metadata',
      queueRecordId: 'queue-snapshot-metadata',
      useAbstract: true,
      useFulltext: false,
      useFulltextNoImages: false,
      useTitle: true,
    }

    console.log(JSON.stringify({
      article: {pubmedId: record.payload.article.pubmedId, sourceMetadata: record.payload.article.sourceMetadata},
      contentSettings: record.payload.contentSettings,
      identityValidWithMetadata: await isJudgmentExecutionSnapshotIdentityValid({...identityInput, useMetadata: true}),
      identityValidWithoutMetadata: await isJudgmentExecutionSnapshotIdentityValid({...identityInput, useMetadata: false}),
      snapshotUseMetadata: snapshot.useMetadata,
      snapshotVersion: record.payload.snapshotVersion,
      storedUseMetadata: record.useMetadata,
    }))

    await database.close()
  `)

  expect(result).toEqual({
    article: {pubmedId: '12345678', sourceMetadata: {journalTitle: 'The Lancet'}},
    contentSettings: {
      fullTextStrategyId: 'fts-none',
      useAbstract: true,
      useFulltext: false,
      useFulltextNoImages: false,
      useMetadata: true,
      useTitle: true,
    },
    identityValidWithMetadata: true,
    identityValidWithoutMetadata: false,
    snapshotUseMetadata: true,
    snapshotVersion: 4,
    storedUseMetadata: true,
  })
})

test('snapshots carry the job full-text strategy and the identity check compares it', () => {
  const result = runScript<{
    contentStrategyId: string
    identityValidWithLegacy: boolean
    identityValidWithStrategy: boolean
    projectFallbackStrategyId: string
    snapshotStrategyId: string
    storedStrategyId: string
  }>(`
    const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
    const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
    const {
      createJudgmentExecutionSnapshotsForClaims,
      getJudgmentExecutionSnapshot,
      isJudgmentExecutionSnapshotIdentityValid,
    } = await import('./src/server/services/judgmentExecutionSnapshotService.ts')

    await migrateDuckdb()

    const database = getAppDatabaseService()

    await database.run(\`
      INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
      VALUES ('provider-snapshot-strategy', 'sglang', 'Provider Snapshot Strategy', TRUE, 'none', 'http://localhost:30001/v1')
    \`)
    await database.run(\`
      INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, variant, source, enabled, metadata_json)
      VALUES ('model-snapshot-strategy', 'provider-snapshot-strategy', 'Model Snapshot Strategy', 'model-snapshot-strategy', 'Model Snapshot Strategy', 'manual', 'manual', TRUE, '{}'::JSON)
    \`)
    await database.run(\`
      INSERT INTO app.project (id, name, description, model_id, human_judgment_mode, use_fulltext, full_text_strategy_id)
      VALUES
        ('project-snapshot-strategy', 'Project Snapshot Strategy', NULL, 'model-snapshot-strategy', 'prompt', TRUE, 'fts-fedcba9876543210'),
        ('project-snapshot-strategy-fallback', 'Project Snapshot Strategy Fallback', NULL, 'model-snapshot-strategy', 'prompt', TRUE, 'fts-0123456789abcdef')
    \`)
    await database.run(\`
      INSERT INTO app.prompt (id, original_text, transformed_text, prompt_heading, type, content_hash)
      VALUES ('prompt-snapshot-strategy', 'Prompt text', 'Prompt text', 'Prompt', 'boolean', 'snapshot-strategy-prompt')
    \`)
    await database.run(\`
      INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order)
      VALUES
        ('project-prompt-snapshot-strategy', 'project-snapshot-strategy', 'prompt-snapshot-strategy', 1),
        ('project-prompt-snapshot-strategy-fallback', 'project-snapshot-strategy-fallback', 'prompt-snapshot-strategy', 1)
    \`)
    await database.run(\`
      INSERT INTO app.judgment_job (id, project_id, status, full_text_strategy_id)
      VALUES
        ('job-snapshot-strategy', 'project-snapshot-strategy', 'ready', 'fts-0123456789abcdef'),
        ('job-snapshot-strategy-fallback', 'project-snapshot-strategy-fallback', 'ready', NULL)
    \`)
    await database.run(\`
      INSERT INTO app.article (id, article_id, article_title, article_summary)
      VALUES ('article-snapshot-strategy', 'article-snapshot-strategy', 'Strategy Article', 'Strategy summary')
    \`)

    const getClaim = (jobId) => {
      return {
        articleId: 'article-snapshot-strategy',
        claimId: \`claim-\${jobId}\`,
        claimedBy: 'server-1',
        jobId,
        promptId: 'prompt-snapshot-strategy',
        queueRecordId: \`queue-\${jobId}\`,
        useFulltext: true,
        useFulltextNoImages: false,
      }
    }
    const [snapshot, fallbackSnapshot] = await createJudgmentExecutionSnapshotsForClaims([
      getClaim('job-snapshot-strategy'),
      getClaim('job-snapshot-strategy-fallback'),
    ])
    const record = await getJudgmentExecutionSnapshot({
      executionSnapshotHash: snapshot.executionSnapshotHash,
      executionSnapshotId: snapshot.executionSnapshotId,
    })
    const identityInput = {
      articleId: 'article-snapshot-strategy',
      claimId: 'claim-job-snapshot-strategy',
      executionSnapshotHash: snapshot.executionSnapshotHash,
      executionSnapshotId: snapshot.executionSnapshotId,
      jobId: 'job-snapshot-strategy',
      modelId: 'model-snapshot-strategy',
      projectId: 'project-snapshot-strategy',
      promptId: 'prompt-snapshot-strategy',
      queueRecordId: 'queue-job-snapshot-strategy',
      useAbstract: true,
      useFulltext: true,
      useFulltextNoImages: false,
      useMetadata: false,
      useTitle: true,
    }

    console.log(JSON.stringify({
      contentStrategyId: record.payload.contentSettings.fullTextStrategyId,
      identityValidWithLegacy: await isJudgmentExecutionSnapshotIdentityValid({...identityInput, fullTextStrategyId: 'fts-legacy-v0'}),
      identityValidWithStrategy: await isJudgmentExecutionSnapshotIdentityValid({...identityInput, fullTextStrategyId: 'fts-0123456789abcdef'}),
      projectFallbackStrategyId: fallbackSnapshot.fullTextStrategyId,
      snapshotStrategyId: snapshot.fullTextStrategyId,
      storedStrategyId: record.fullTextStrategyId,
    }))

    await database.close()
  `)

  expect(result).toEqual({
    contentStrategyId: 'fts-0123456789abcdef',
    identityValidWithLegacy: false,
    identityValidWithStrategy: true,
    projectFallbackStrategyId: 'fts-0123456789abcdef',
    snapshotStrategyId: 'fts-0123456789abcdef',
    storedStrategyId: 'fts-0123456789abcdef',
  })
})
