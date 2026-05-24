import {rmSync} from 'node:fs'

import {expect, test} from 'bun:test'

import {assertProjectTransferExportModelDependencies} from './projectTransferExport.ts'
import {projectTransferPayloadKeys} from './projectTransferSchemas.ts'

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

const getProjectTransferExportScript = (body: string) => {
  return `
    const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
    const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
    const {
      getProjectTransferExportPayloads,
      getProjectTransferExportSourceProjectSettings,
      serializeProjectTransferExportPayloads,
    } = await import('./src/server/services/projectTransfer/projectTransferExport.ts')

    await migrateDuckdb()

    const database = getAppDatabaseService()
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

const runProjectTransferExportScript = <T>(body: string) => {
  const duckdbPath = `/tmp/f2-project-transfer-export-${Date.now()}-${Math.random().toString(16).slice(2)}.duckdb`
  const result = globalThis.Bun.spawnSync(['bun', '-e', getProjectTransferExportScript(body)], {
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
      throw new Error(result.stderr.toString() || result.stdout.toString() || 'Project transfer export test failed')
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

test('project-transfer export reads archived app-table scope and serializes locked payload fields', () => {
  const result = runProjectTransferExportScript<{
    articleIds: string[]
    articleImportRouteIds: string[]
    articleKeys: string[]
    duplicateWarning: unknown
    humanJudgmentIds: string[]
    humanSummaryIds: string[]
    importRouteActiveValues: boolean[]
    invalidDateMessage: string | null
    invalidFulltextMessage: string | null
    judgmentAssessmentIds: string[]
    judgmentIds: string[]
    judgmentKeys: string[]
    modelDescriptors: Array<{
      displayName: string | null
      modelName: string | null
      name: string
      remoteModelId: string | null
      variant: string | null
      version: string | null
    }>
    payloadKeys: string[]
    projectArchived: boolean
    projectArticleIds: string[]
    providerConnectionIds: string[]
    reviewIds: string[]
    serializedArticleHasFullTextPdf: boolean
    serializedJudgmentHasDeleteGeneration: boolean
    settingsArchived: boolean
    summaryReviewIds: string[]
    warnings: unknown[]
  }>(`
    await database.run(\`
      INSERT INTO app.provider_connection (
        id,
        provider_kind,
        label,
        enabled,
        auth_mode,
        base_url,
        max_inflight_requests,
        config_json,
        secret_ref,
        created_at,
        updated_at
      )
      VALUES (
        'provider-null-remote',
        'codex',
        'Codex Local',
        TRUE,
        'codex-cli',
        NULL,
        2,
        CAST('{"runtime":"local"}' AS JSON),
        'env:CODEX_API_KEY',
        TIMESTAMPTZ '2026-01-01T00:00:00Z',
        TIMESTAMPTZ '2026-01-02T00:00:00Z'
      )
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
        metadata_json,
        created_at,
        updated_at
      )
      VALUES (
        'model-null-remote',
        'provider-null-remote',
        'Local fallback model',
        NULL,
        NULL,
        'medium',
        'manual',
        TRUE,
        CAST('{"options":{"thinking":"medium"}}' AS JSON),
        TIMESTAMPTZ '2026-01-01T00:00:00Z',
        TIMESTAMPTZ '2026-01-02T00:00:00Z'
      ),
      (
        'model-missing-provider',
        'provider-missing',
        'Missing provider model',
        'missing-provider-model',
        NULL,
        NULL,
        'manual',
        TRUE,
        NULL,
        TIMESTAMPTZ '2026-01-01T00:00:00Z',
        TIMESTAMPTZ '2026-01-02T00:00:00Z'
      )
    \`)
    await database.run(\`
      INSERT INTO app.project (
        id,
        name,
        description,
        model_id,
        human_judgment_mode,
        use_title,
        use_abstract,
        use_fulltext,
        use_fulltext_no_images,
        date_from,
        date_to,
        archived,
        created_at,
        updated_at
      )
      VALUES
        (
          'project-archived-export',
          'Archived Export',
          'Archived package source',
          'model-null-remote',
          'prompt',
          TRUE,
          TRUE,
          FALSE,
          FALSE,
          TIMESTAMPTZ '2026-01-01T00:00:00Z',
          TIMESTAMPTZ '2026-12-31T23:59:59Z',
          TRUE,
          TIMESTAMPTZ '2026-01-01T00:00:00Z',
          TIMESTAMPTZ '2026-01-02T00:00:00Z'
        ),
        (
          'project-summary-export',
          'Summary Export',
          NULL,
          'model-null-remote',
          'summary',
          TRUE,
          TRUE,
          FALSE,
          FALSE,
          NULL,
          NULL,
          FALSE,
          TIMESTAMPTZ '2026-01-01T00:00:00Z',
          TIMESTAMPTZ '2026-01-02T00:00:00Z'
        ),
        (
          'project-invalid-date',
          'Invalid Date',
          NULL,
          'model-null-remote',
          'prompt',
          TRUE,
          TRUE,
          FALSE,
          FALSE,
          TIMESTAMPTZ '2026-02-01T00:00:00Z',
          TIMESTAMPTZ '2026-01-01T00:00:00Z',
          FALSE,
          TIMESTAMPTZ '2026-01-01T00:00:00Z',
          TIMESTAMPTZ '2026-01-02T00:00:00Z'
        ),
        (
          'project-invalid-fulltext',
          'Invalid Fulltext',
          NULL,
          'model-null-remote',
          'prompt',
          TRUE,
          TRUE,
          TRUE,
          TRUE,
          NULL,
          NULL,
          FALSE,
          TIMESTAMPTZ '2026-01-01T00:00:00Z',
          TIMESTAMPTZ '2026-01-02T00:00:00Z'
        ),
        (
          'project-missing-provider',
          'Missing Provider',
          NULL,
          'model-missing-provider',
          'prompt',
          TRUE,
          TRUE,
          FALSE,
          FALSE,
          NULL,
          NULL,
          FALSE,
          TIMESTAMPTZ '2026-01-01T00:00:00Z',
          TIMESTAMPTZ '2026-01-02T00:00:00Z'
        )
    \`)
    await database.run(\`
      INSERT INTO app.prompt (
        id,
        original_text,
        transformed_text,
        prompt_heading,
        type,
        content_hash,
        archived,
        created_at,
        updated_at
      )
      VALUES
        ('prompt-enabled', 'Include?', NULL, 'Eligibility', 'string', 'hash-enabled', FALSE, TIMESTAMPTZ '2026-01-01T00:00:00Z', TIMESTAMPTZ '2026-01-02T00:00:00Z'),
        ('prompt-disabled', 'Disabled?', NULL, 'Disabled', 'string', 'hash-disabled', FALSE, TIMESTAMPTZ '2026-01-01T00:00:00Z', TIMESTAMPTZ '2026-01-02T00:00:00Z')
    \`)
    await database.run(\`
      INSERT INTO app.project_prompt (
        id,
        project_id,
        prompt_id,
        prompt_order,
        enabled,
        archived,
        criteria_disposition,
        criteria_section_key,
        criteria_section_label,
        created_at,
        updated_at
      )
      VALUES
        ('pp-enabled', 'project-archived-export', 'prompt-enabled', 1, TRUE, FALSE, 'include', 'inclusion', 'Inclusion', TIMESTAMPTZ '2026-01-01T00:00:00Z', TIMESTAMPTZ '2026-01-02T00:00:00Z'),
        ('pp-disabled', 'project-archived-export', 'prompt-disabled', 2, FALSE, FALSE, 'exclude', 'exclusion', 'Exclusion', TIMESTAMPTZ '2026-01-01T00:00:00Z', TIMESTAMPTZ '2026-01-02T00:00:00Z'),
        ('pp-summary', 'project-summary-export', 'prompt-enabled', 1, TRUE, FALSE, 'include', 'inclusion', 'Inclusion', TIMESTAMPTZ '2026-01-01T00:00:00Z', TIMESTAMPTZ '2026-01-02T00:00:00Z'),
        ('pp-missing-provider', 'project-missing-provider', 'prompt-enabled', 1, TRUE, FALSE, 'include', 'inclusion', 'Inclusion', TIMESTAMPTZ '2026-01-01T00:00:00Z', TIMESTAMPTZ '2026-01-02T00:00:00Z')
    \`)
    await database.run(\`
      INSERT INTO app.import_route (
        id,
        route,
        name,
        description,
        active,
        created_at,
        updated_at
      )
      VALUES
        ('route-inactive', 'inactive-covidence', 'Inactive Covidence', 'Inactive route still scopes export', FALSE, TIMESTAMPTZ '2026-01-01T00:00:00Z', TIMESTAMPTZ '2026-01-02T00:00:00Z')
    \`)
    await database.run(\`
      INSERT INTO app.project_import_route (
        id,
        project_id,
        import_route_id,
        created_at,
        updated_at
      )
      VALUES ('pir-inactive', 'project-archived-export', 'route-inactive', TIMESTAMPTZ '2026-01-01T00:00:00Z', TIMESTAMPTZ '2026-01-02T00:00:00Z')
    \`)
    await database.run(\`
      INSERT INTO app.article (
        id,
        article_id,
        article_title,
        article_summary,
        article_authors,
        article_version,
        article_created_at,
        article_updated_at,
        arxiv_id,
        biorxiv_id,
        medrxiv_id,
        doi,
        pubmed_id,
        url,
        full_text,
        full_text_html,
        full_text_pdf,
        full_text_source,
        full_text_original_format,
        full_text_fetched_at,
        full_text_assets,
        full_text_conversion_status,
        full_text_conversion_error,
        full_text_conversion_attempts,
        full_text_conversion_model_id,
        full_text_conversion_metadata,
        full_text_char_count,
        content_hash,
        import_route,
        original_data,
        publication_status,
        source_metadata,
        created_at,
        updated_at
      )
      VALUES
        (
          'article-route-in',
          'legacy-route-in',
          'Route Article',
          'Route summary',
          ['Ada Lovelace'],
          1,
          TIMESTAMPTZ '2026-02-01T00:00:00Z',
          TIMESTAMPTZ '2026-02-02T00:00:00Z',
          '2401.00001',
          NULL,
          NULL,
          '10.1000/route',
          '12345',
          'https://example.test/route',
          'full text',
          '<p>full text</p>',
          'assets/route.pdf',
          'pdf',
          'pdf',
          TIMESTAMPTZ '2026-02-03T00:00:00Z',
          CAST('{"files":["route.png"]}' AS JSON),
          'completed',
          NULL,
          1,
          'model-null-remote',
          CAST('{"pages":2}' AS JSON),
          9,
          'article-route-hash',
          'legacy-route',
          CAST('{"legacy":true}' AS JSON),
          'published',
          CAST('{"canonical":true}' AS JSON),
          TIMESTAMPTZ '2026-01-01T00:00:00Z',
          TIMESTAMPTZ '2026-01-02T00:00:00Z'
        ),
        (
          'article-curated-in',
          'legacy-curated-in',
          'Curated Article',
          NULL,
          ['Grace Hopper'],
          1,
          TIMESTAMPTZ '2026-03-01T00:00:00Z',
          TIMESTAMPTZ '2026-03-02T00:00:00Z',
          NULL,
          NULL,
          NULL,
          '10.1000/curated',
          NULL,
          'https://example.test/curated',
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          0,
          NULL,
          NULL,
          NULL,
          'article-curated-hash',
          NULL,
          CAST('{"curated":true}' AS JSON),
          'published',
          CAST('{"manual":true}' AS JSON),
          TIMESTAMPTZ '2026-01-01T00:00:00Z',
          TIMESTAMPTZ '2026-01-02T00:00:00Z'
        ),
        (
          'article-null-date',
          'legacy-null-date',
          'Null Date Article',
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          '10.1000/null-date',
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          0,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          CAST('{}' AS JSON),
          'published',
          CAST('{}' AS JSON),
          TIMESTAMPTZ '2026-01-01T00:00:00Z',
          TIMESTAMPTZ '2026-01-02T00:00:00Z'
        ),
        (
          'article-outside-date',
          'legacy-outside-date',
          'Outside Date Article',
          NULL,
          NULL,
          NULL,
          TIMESTAMPTZ '2027-01-01T00:00:00Z',
          NULL,
          NULL,
          NULL,
          NULL,
          '10.1000/outside-date',
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          0,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          CAST('{}' AS JSON),
          'published',
          CAST('{}' AS JSON),
          TIMESTAMPTZ '2026-01-01T00:00:00Z',
          TIMESTAMPTZ '2026-01-02T00:00:00Z'
        )
    \`)
    await database.run(\`
      INSERT INTO app.article_identifier (
        id,
        article_id,
        kind,
        normalized_value,
        source,
        is_primary,
        created_at,
        updated_at
      )
      VALUES ('identifier-route-doi', 'article-route-in', 'doi', '10.1000/route', 'article_identifier', TRUE, TIMESTAMPTZ '2026-01-01T00:00:00Z', TIMESTAMPTZ '2026-01-02T00:00:00Z')
    \`)
    await database.run(\`
      INSERT INTO app.article_import_route (
        id,
        article_id,
        import_route_id,
        external_article_id,
        source_kind,
        import_metadata,
        match_metadata,
        import_run_id,
        source_record_key,
        source_record_hash,
        raw_payload,
        created_at,
        updated_at
      )
      VALUES
        ('air-route-in', 'article-route-in', 'route-inactive', 'external-route-in', 'covidence', CAST('{"covidence":{"studyKey":"study-route"}}' AS JSON), CAST('{"matched":true}' AS JSON), 'run-1', 'source-key-route', 'source-hash-route', CAST('{"raw":"route"}' AS JSON), TIMESTAMPTZ '2026-01-01T00:00:00Z', TIMESTAMPTZ '2026-01-02T00:00:00Z'),
        ('air-null-date', 'article-null-date', 'route-inactive', 'external-null-date', 'covidence', CAST('{}' AS JSON), CAST('{}' AS JSON), 'run-1', 'source-key-null', 'source-hash-null', CAST('{}' AS JSON), TIMESTAMPTZ '2026-01-01T00:00:00Z', TIMESTAMPTZ '2026-01-02T00:00:00Z'),
        ('air-outside-date', 'article-outside-date', 'route-inactive', 'external-outside-date', 'covidence', CAST('{}' AS JSON), CAST('{}' AS JSON), 'run-1', 'source-key-outside', 'source-hash-outside', CAST('{}' AS JSON), TIMESTAMPTZ '2026-01-01T00:00:00Z', TIMESTAMPTZ '2026-01-02T00:00:00Z')
    \`)
    await database.run(\`
      INSERT INTO app.project_article (
        id,
        project_id,
        article_id,
        imported_from_project_id,
        created_at,
        updated_at
      )
      VALUES
        ('pa-curated', 'project-archived-export', 'article-curated-in', NULL, TIMESTAMPTZ '2026-01-01T00:00:00Z', TIMESTAMPTZ '2026-01-02T00:00:00Z'),
        ('pa-summary', 'project-summary-export', 'article-route-in', NULL, TIMESTAMPTZ '2026-01-01T00:00:00Z', TIMESTAMPTZ '2026-01-02T00:00:00Z'),
        ('pa-missing-provider', 'project-missing-provider', 'article-route-in', NULL, TIMESTAMPTZ '2026-01-01T00:00:00Z', TIMESTAMPTZ '2026-01-02T00:00:00Z')
    \`)
    await database.run(\`
      INSERT INTO app.judgment (
        id,
        article_id,
        prompt_id,
        model_id,
        project_id,
        use_title,
        use_abstract,
        use_fulltext,
        use_fulltext_no_images,
        chunking_strategy,
        is_answered,
        answered_original,
        answered_original_as_array,
        confidence_original,
        explanation,
        quotes,
        delete_generation,
        snapshot_project_id,
        snapshot_project_model_name,
        created_at,
        updated_at
      )
      VALUES
        ('judgment-export', 'article-route-in', 'prompt-enabled', 'model-null-remote', 'project-other', TRUE, TRUE, FALSE, FALSE, 'markdown', TRUE, 'yes', ['yes'], 92, 'export explanation', CAST('[{"quote":"export quote"}]' AS JSON), 0, 'project-other', 'Snapshot Model', TIMESTAMPTZ '2026-04-01T00:00:00Z', TIMESTAMPTZ '2026-04-02T00:00:00Z'),
        ('judgment-duplicate-answered', 'article-curated-in', 'prompt-enabled', 'model-null-remote', NULL, TRUE, TRUE, FALSE, FALSE, 'markdown', TRUE, 'maybe', ['maybe'], 50, 'duplicate answered', CAST('[{"quote":"duplicate"}]' AS JSON), 0, NULL, NULL, TIMESTAMPTZ '2026-04-03T00:00:00Z', TIMESTAMPTZ '2026-04-04T00:00:00Z'),
        ('judgment-duplicate-unanswered', 'article-curated-in', 'prompt-enabled', 'model-null-remote', NULL, TRUE, TRUE, FALSE, FALSE, 'markdown', FALSE, NULL, NULL, 50, NULL, CAST('[]' AS JSON), 1, NULL, NULL, TIMESTAMPTZ '2026-04-05T00:00:00Z', TIMESTAMPTZ '2026-04-06T00:00:00Z')
    \`)
    await database.run(\`
      INSERT INTO app.judgment_assessment (
        id,
        judgment_id,
        assessment_is_correct,
        assessment_comment,
        created_at,
        updated_at
      )
      VALUES
        ('assessment-export', 'judgment-export', TRUE, 'correct', TIMESTAMPTZ '2026-04-03T00:00:00Z', TIMESTAMPTZ '2026-04-04T00:00:00Z'),
        ('assessment-duplicate', 'judgment-duplicate-answered', FALSE, 'ambiguous', TIMESTAMPTZ '2026-04-05T00:00:00Z', TIMESTAMPTZ '2026-04-06T00:00:00Z')
    \`)
    await database.run(\`
      INSERT INTO app.judgment_human (
        id,
        project_id,
        article_id,
        prompt_id,
        is_answered,
        answer,
        comment,
        created_at,
        updated_at
      )
      VALUES
        ('human-disabled', 'project-archived-export', 'article-route-in', 'prompt-disabled', TRUE, 'include', 'disabled prompt answer', TIMESTAMPTZ '2026-04-01T00:00:00Z', TIMESTAMPTZ '2026-04-02T00:00:00Z')
    \`)
    await database.run(\`
      INSERT INTO app.judgment_human_summary (
        id,
        project_id,
        article_id,
        answer,
        origin,
        created_at,
        updated_at
      )
      VALUES ('summary-human', 'project-summary-export', 'article-route-in', 'yes', 'manual_override', TIMESTAMPTZ '2026-04-01T00:00:00Z', TIMESTAMPTZ '2026-04-02T00:00:00Z')
    \`)
    await database.run(\`
      INSERT INTO app.review (
        id,
        project_id,
        article_id,
        opened,
        reviewed_title,
        reviewed_title_comment,
        reviewed_abstract,
        reviewed_abstract_comment,
        created_at,
        updated_at
      )
      VALUES
        ('review-archived', 'project-archived-export', 'article-route-in', TRUE, TRUE, 'title checked', FALSE, NULL, TIMESTAMPTZ '2026-04-01T00:00:00Z', TIMESTAMPTZ '2026-04-02T00:00:00Z'),
        ('review-summary', 'project-summary-export', 'article-route-in', TRUE, TRUE, 'summary title checked', TRUE, 'summary abstract checked', TIMESTAMPTZ '2026-04-01T00:00:00Z', TIMESTAMPTZ '2026-04-02T00:00:00Z')
    \`)

    const archived = await getProjectTransferExportPayloads('project-archived-export')
    const summary = await getProjectTransferExportPayloads('project-summary-export')
    const serialized = serializeProjectTransferExportPayloads(archived.payloads)
    const [serializedArticle] = serialized.articles.trim().split('\\n').map((line) => JSON.parse(line))
    const [serializedJudgment] = serialized.judgments.trim().split('\\n').map((line) => JSON.parse(line))
    const settings = await getProjectTransferExportSourceProjectSettings('project-archived-export')
    const invalidDateMessage = await catchMessage(() => getProjectTransferExportPayloads('project-invalid-date'))
    const invalidFulltextMessage = await catchMessage(() => getProjectTransferExportPayloads('project-invalid-fulltext'))
    const missingProviderMessage = await catchMessage(() => getProjectTransferExportPayloads('project-missing-provider'))

    console.log(JSON.stringify({
      articleIds: archived.payloads.articles.map((article) => article.sourceArticleId),
      articleImportRouteIds: archived.payloads.articleImportRoutes.map((link) => link.sourceArticleImportRouteId),
      articleKeys: Object.keys(archived.payloads.articles[0]).sort(),
      duplicateWarning: archived.warnings[0] ?? null,
      humanJudgmentIds: archived.payloads.humanJudgments.map((judgment) => judgment.sourceHumanJudgmentId),
      humanSummaryIds: summary.payloads.humanJudgmentSummaries.map((judgment) => judgment.sourceHumanJudgmentSummaryId),
      importRouteActiveValues: archived.payloads.importRoutes.records.map((route) => route.active),
      invalidDateMessage,
      invalidFulltextMessage,
      judgmentAssessmentIds: archived.payloads.judgmentAssessments.map((assessment) => assessment.sourceJudgmentAssessmentId),
      judgmentIds: archived.payloads.judgments.map((judgment) => judgment.sourceJudgmentId),
      judgmentKeys: Object.keys(archived.payloads.judgments[0]).sort(),
      missingProviderMessage,
      modelDescriptors: archived.payloads.models.records.map((model) => {
        return {
          displayName: model.displayName,
          modelName: model.modelName,
          name: model.name,
          remoteModelId: model.remoteModelId,
          variant: model.variant,
          version: model.version,
        }
      }),
      payloadKeys: Object.keys(archived.payloads).sort(),
      projectArchived: archived.payloads.project.archived,
      projectArticleIds: archived.payloads.projectArticles.map((link) => link.sourceArticleId),
      providerConnectionIds: archived.payloads.providerConnections.records.map((connection) => connection.sourceProviderConnectionId),
      reviewIds: archived.payloads.reviews.map((review) => review.sourceReviewId),
      serializedArticleHasFullTextPdf: Object.hasOwn(serializedArticle, 'fullTextPdf'),
      serializedJudgmentHasDeleteGeneration: Object.hasOwn(serializedJudgment, 'deleteGeneration'),
      settingsArchived: settings.archived,
      summaryReviewIds: summary.payloads.reviews.map((review) => review.sourceReviewId),
      warnings: archived.warnings,
    }))
  `)

  expect(result.payloadKeys).toEqual([...projectTransferPayloadKeys].sort())
  expect(result.settingsArchived).toBe(true)
  expect(result.projectArchived).toBe(true)
  expect(result.articleIds).toEqual(['article-route-in', 'article-curated-in'])
  expect(result.articleImportRouteIds).toEqual(['air-route-in'])
  expect(result.projectArticleIds).toEqual(['article-curated-in'])
  expect(result.importRouteActiveValues).toEqual([false])
  expect(result.judgmentIds).toEqual(['judgment-export'])
  expect(result.judgmentAssessmentIds).toEqual(['assessment-export'])
  expect(result.humanJudgmentIds).toEqual(['human-disabled'])
  expect(result.humanSummaryIds).toEqual(['summary-human'])
  expect(result.reviewIds).toEqual(['review-archived'])
  expect(result.summaryReviewIds).toEqual(['review-summary'])
  expect(result.providerConnectionIds).toEqual(['provider-null-remote'])
  expect(result.modelDescriptors).toEqual([
    {
      displayName: 'Local fallback model',
      modelName: 'Local fallback model',
      name: 'Local fallback model',
      remoteModelId: null,
      variant: 'medium',
      version: 'medium',
    },
  ])
  expect(result.articleKeys).toContain('originalData')
  expect(result.articleKeys).toContain('sourceMetadata')
  expect(result.articleKeys).toContain('fullTextPdf')
  expect(result.articleKeys).toContain('fullTextHtml')
  expect(result.articleKeys).toContain('fullTextAssets')
  expect(result.articleKeys).toContain('selectedSourceRecordHash')
  expect(result.judgmentKeys).toContain('answeredOriginal')
  expect(result.judgmentKeys).toContain('answeredOriginalAsArray')
  expect(result.judgmentKeys).toContain('confidenceOriginal')
  expect(result.judgmentKeys).toContain('chunkingStrategy')
  expect(result.judgmentKeys).toContain('deleteGeneration')
  expect(result.judgmentKeys).toContain('snapshotProjectModelName')
  expect(result.serializedArticleHasFullTextPdf).toBe(true)
  expect(result.serializedJudgmentHasDeleteGeneration).toBe(true)
  expect(result.warnings).toHaveLength(1)
  expect(result.duplicateWarning).toMatchObject({code: 'ambiguousJudgmentVisibleKey', payloadKey: 'judgments'})
  expect(result.invalidDateMessage).toContain('date_from must be before or equal to date_to')
  expect(result.invalidFulltextMessage).toContain('use_fulltext and use_fulltext_no_images cannot both be enabled')
})

test('project-transfer export dependency checks fail instead of silently dropping missing models', () => {
  expect(() => {
    assertProjectTransferExportModelDependencies({
      modelRows: [{modelId: 'model-present'}],
      requiredModelIds: ['model-present', 'model-missing'],
    })
  }).toThrow('Project transfer export missing required model rows: model-missing')
})
