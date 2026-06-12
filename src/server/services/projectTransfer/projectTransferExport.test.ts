import {rmSync} from 'node:fs'

import {expect, test} from 'bun:test'

import {
  assertProjectTransferExportModelDependencies,
  getProjectTransferExportHumanReviewInputSignature,
  getProjectTransferExportJudgmentInputSignature,
} from './projectTransferExport.ts'
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
      getProjectTransferExportPreflightEstimate,
      getProjectTransferExportPayloads,
      getProjectTransferExportSourceProjectSettings,
      getProjectTransferExportSummary,
      serializeProjectTransferExportPayloads,
    } = await import('./src/server/services/projectTransfer/projectTransferExport.ts')
    const {buildProjectTransferExportPackage: buildExportPackage} = await import('./src/server/services/projectTransfer/projectTransferExportPackage.ts')
    const {getProjectTransferPackageFingerprint, getProjectTransferSha256Checksum} = await import('./src/server/services/projectTransfer/projectTransferFingerprint.ts')
    const {projectTransferPayloadKeys} = await import('./src/server/services/projectTransfer/projectTransferSchemas.ts')
    const {getProjectTransferExportTempLayout} = await import('./src/server/services/projectTransfer/projectTransferSession.ts')

    await migrateDuckdb()

    const database = getAppDatabaseService()
    const textEncoder = new TextEncoder()
    const getFakeZipModule = () => {
      const state = {writtenEntries: []}

      class FakeUint8ArrayReader {
        constructor(bytes) {
          this.bytes = bytes
        }
      }

      class FakeUint8ArrayWriter {
        getData = () => new Uint8Array()
      }

      class FakeZipReader {
        close = async () => {}
        getEntries = async () => []
      }

      class FakeZipWriter {
        add = async (path, reader) => {
          state.writtenEntries.push({bytes: reader.bytes, path})
        }

        close = async () => {
          return textEncoder.encode(JSON.stringify(state.writtenEntries.map((entry) => entry.path)))
        }
      }

      return {
        state,
        zipModule: {
          Uint8ArrayReader: FakeUint8ArrayReader,
          Uint8ArrayWriter: FakeUint8ArrayWriter,
          ZipReader: FakeZipReader,
          ZipWriter: FakeZipWriter,
        },
      }
    }
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
    removeFileIfExists('assets/project-transfer-export-test')
    removeFileIfExists('/tmp/duckdb-temp')
  }
}

test('project-transfer export reads archived app-table scope and serializes locked payload fields', () => {
  const result = runProjectTransferExportScript<{
    articleIds: string[]
    articleImportRouteIds: string[]
    articleKeys: string[]
    assetEntryPaths: string[]
    assetManifestEntries: Array<{
      byteLength: number
      checksumSha256: string
      packagePath: string
      references: Array<{
        fieldPath?: string
        jsonPointer?: string
        kind: string
        payloadFile: string
        sourceArticleId?: string
        sourceRef: string
      }>
    }>
    assetManifestHasAssets: boolean
    assetManifestHasEnvelope: boolean
    buildTempCleaned: boolean
    chunkedWarning: unknown
    curatedArticleDoi: string | null
    curatedArticleIdentifierKeys: string[]
    humanJudgmentIds: string[]
    humanReviewProvenanceKinds: string[]
    humanReviewSignatureModes: string[]
    humanSummaryIds: string[]
    importRouteActiveValues: boolean[]
    invalidDateMessage: string | null
    invalidFulltextMessage: string | null
    judgmentAssessmentIds: string[]
    judgmentInputSignature: {
      model: {modelOptions: {thinking: string | null}; promptTokenLimit: number}
      provider: {transportFamily: string | null}
      request: {invocationTemperature: number; reservedCompletionTokens: number}
      version: number
    }
    judgmentIds: string[]
    judgmentKeys: string[]
    judgmentProvenanceKind: string | null
    missingProviderMessage: string | null
    packageChecksumMatches: boolean
    packageExecutionMode: string
    packageFingerprint: string | null
    packageFingerprintMatchesAnalyze: boolean
    packageHasAllPayloadFiles: boolean
    packageHasManifest: boolean
    packageManifestAssetSummary: {byteLength: number; entryCount: number} | undefined
    packageManifestExportedAt: string | undefined
    packageManifestPayloadKeys: string[]
    packageManifestProject: {
      currentModel: {modelName: string | null; remoteModelId: string | null; sourceModelId: string | null}
      humanJudgmentMode: string
      name: string
      sourceProjectId: string
    }
    packageManifestSourceAppVersion: string | undefined
    packageMetadataHasTempPath: boolean
    packagePayloadJsonCollectionIsArray: boolean
    packageZipEntryPaths: string[]
    preflightEstimate: {assetBytes: number; packageBytes: number}
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
    rawForcedOmittedArticleImportRouteImportMetadata: unknown
    rawForcedOmittedArticleImportRouteRawPayload: unknown
    rawForcedOmittedArticleOriginalData: unknown
    rawForcedOmittedWarning: {details: {rawArticleProvenanceMode: string}} | null
    rawIncludedArticleImportRouteImportMetadata: unknown
    rawIncludedArticleImportRouteRawPayload: unknown
    rawIncludedArticleOriginalData: unknown
    rawIncludedWarning: unknown
    rawOmittedArticleImportRouteImportMetadata: unknown
    rawOmittedArticleImportRouteRawPayload: unknown
    rawOmittedArticleOriginalData: unknown
    rawOmittedArticleSourceMetadata: unknown
    rawOmittedWarning: {details: {rawArticleProvenanceMode: string; thresholdChars: number}} | null
    reviewIds: string[]
    routeArticleImportRoute: string | null
    identifierRejectedWarnings: Array<{
      details: {inputKind: string; reason: string; source: string}
      jsonPointer: string
      sourceRef: string
    }>
    routeArticleIdentifierInputs: Array<{inputKind: string; source: string; value: string}>
    routeArticleSelectedImportRoute: string | null
    routeArticleUrl: string | null
    serializedArticleFullTextAssets: unknown
    serializedArticleFullTextHtml: string | null
    serializedArticleFullTextPdf: string | null
    serializedArticleUrl: string | null
    serializedArticleHasFullTextPdf: boolean
    serializedJudgmentHasDeleteGeneration: boolean
    settingsArchived: boolean
    summaryReviewIds: string[]
    preservedUrlWarnings: Array<{action: string; code: string; jsonPointer: string; severity: string}>
    warnings: unknown[]
    warningCodes: string[]
    warningsHaveSharedShape: boolean
  }>(`
    const exportAssetRoot = 'assets/project-transfer-export-test'
    const {mkdir} = await import('node:fs/promises')

    await mkdir(exportAssetRoot, {recursive: true})
    await Bun.write(exportAssetRoot + '/route.pdf', 'route-pdf-content')
    await Bun.write(exportAssetRoot + '/figure.png', 'figure-content')
    await Bun.write(exportAssetRoot + '/html-image.png', 'html-image-content')

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
        ('prompt-chunked', 'Chunked include?', NULL, 'Chunked', 'string', 'hash-chunked', FALSE, TIMESTAMPTZ '2026-01-01T00:00:00Z', TIMESTAMPTZ '2026-01-02T00:00:00Z'),
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
        ('pp-chunked', 'project-archived-export', 'prompt-chunked', 2, TRUE, FALSE, 'include', 'inclusion', 'Inclusion', TIMESTAMPTZ '2026-01-01T00:00:00Z', TIMESTAMPTZ '2026-01-02T00:00:00Z'),
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
        ('route-inactive', '/Users/export/inactive-covidence.csv', 'Inactive Covidence', 'Inactive route still scopes export', FALSE, TIMESTAMPTZ '2026-01-01T00:00:00Z', TIMESTAMPTZ '2026-01-02T00:00:00Z')
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
          'https://user:pass@example.test/route?X-Amz-Credential=abc%2F20260611&X-Amz-Signature=secret#source',
          'full text',
          '<p>full text</p><img src="/api/runtime-asset?path=assets/project-transfer-export-test/html-image.png">',
          'assets/project-transfer-export-test/route.pdf',
          'pdf',
          'pdf',
          TIMESTAMPTZ '2026-02-03T00:00:00Z',
          CAST('{"files":["assets/project-transfer-export-test/figure.png"],"label":"route.png"}' AS JSON),
          'completed',
          NULL,
          1,
          'model-null-remote',
          CAST('{"pages":2}' AS JSON),
          9,
          'article-route-hash',
          '/Users/export/legacy-route.csv',
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
          'https://www.chictr.org.cn/showproj.html?proj=285095',
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
      VALUES
        ('identifier-route-doi', 'article-route-in', 'doi', '10.1000/route', 'article_identifier', TRUE, TIMESTAMPTZ '2026-01-01T00:00:00Z', TIMESTAMPTZ '2026-01-02T00:00:00Z'),
        ('identifier-route-rejected-doi', 'article-route-in', 'doi', 'https://www.chictr.org.cn/showproj.html?proj=285095', 'article_identifier', FALSE, TIMESTAMPTZ '2026-01-01T00:00:00Z', TIMESTAMPTZ '2026-01-02T00:00:00Z')
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
        ('judgment-export', 'article-route-in', 'prompt-enabled', 'model-null-remote', 'project-other', TRUE, TRUE, FALSE, FALSE, NULL, TRUE, 'yes', ['yes'], 92, 'export explanation', CAST('[{"quote":"export quote"}]' AS JSON), 0, 'project-other', 'Snapshot Model', TIMESTAMPTZ '2026-04-01T00:00:00Z', TIMESTAMPTZ '2026-04-02T00:00:00Z'),
        ('judgment-chunked-no-proof', 'article-route-in', 'prompt-chunked', 'model-null-remote', NULL, TRUE, TRUE, FALSE, FALSE, 'article_paragraph_greedy', TRUE, 'yes', ['yes'], 88, 'chunked explanation', CAST('[{"quote":"chunked"}]' AS JSON), 0, NULL, NULL, TIMESTAMPTZ '2026-04-02T00:00:00Z', TIMESTAMPTZ '2026-04-03T00:00:00Z'),
        ('judgment-duplicate-answered', 'article-curated-in', 'prompt-enabled', 'model-null-remote', NULL, TRUE, TRUE, FALSE, FALSE, NULL, TRUE, 'maybe', ['maybe'], 50, 'duplicate answered', CAST('[{"quote":"duplicate"}]' AS JSON), 0, NULL, NULL, TIMESTAMPTZ '2026-04-03T00:00:00Z', TIMESTAMPTZ '2026-04-04T00:00:00Z'),
        ('judgment-duplicate-unanswered', 'article-curated-in', 'prompt-enabled', 'model-null-remote', NULL, TRUE, TRUE, FALSE, FALSE, NULL, FALSE, NULL, NULL, 50, NULL, CAST('[]' AS JSON), 1, NULL, NULL, TIMESTAMPTZ '2026-04-05T00:00:00Z', TIMESTAMPTZ '2026-04-06T00:00:00Z')
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
        ('assessment-chunked', 'judgment-chunked-no-proof', TRUE, 'chunked omitted', TIMESTAMPTZ '2026-04-04T00:00:00Z', TIMESTAMPTZ '2026-04-05T00:00:00Z'),
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
    const rawOmitted = await getProjectTransferExportPayloads('project-archived-export', {
      articleRawJsonOmissionThresholdChars: 1,
    })
    const rawIncluded = await getProjectTransferExportPayloads('project-archived-export', {
      articleRawJsonOmissionThresholdChars: 1,
      rawArticleProvenanceMode: 'include',
    })
    const rawForcedOmitted = await getProjectTransferExportPayloads('project-archived-export', {
      rawArticleProvenanceMode: 'omit',
    })
    const summary = await getProjectTransferExportPayloads('project-summary-export')
    const serialized = serializeProjectTransferExportPayloads(archived.payloads)
    const [serializedArticle] = serialized.articles.trim().split('\\n').map((line) => JSON.parse(line))
    const [serializedJudgment] = serialized.judgments.trim().split('\\n').map((line) => JSON.parse(line))
    const routeArticle = archived.payloads.articles.find((article) => article.sourceArticleId === 'article-route-in')
    const curatedArticle = archived.payloads.articles.find((article) => article.sourceArticleId === 'article-curated-in')
    const rawOmittedArticle = rawOmitted.payloads.articles.find((article) => article.sourceArticleId === 'article-route-in')
    const rawIncludedArticle = rawIncluded.payloads.articles.find((article) => article.sourceArticleId === 'article-route-in')
    const rawForcedOmittedArticle = rawForcedOmitted.payloads.articles.find((article) => {
      return article.sourceArticleId === 'article-route-in'
    })
    const rawOmittedArticleImportRoute = rawOmitted.payloads.articleImportRoutes.find((link) => {
      return link.sourceArticleImportRouteId === 'air-route-in'
    })
    const rawIncludedArticleImportRoute = rawIncluded.payloads.articleImportRoutes.find((link) => {
      return link.sourceArticleImportRouteId === 'air-route-in'
    })
    const rawForcedOmittedArticleImportRoute = rawForcedOmitted.payloads.articleImportRoutes.find((link) => {
      return link.sourceArticleImportRouteId === 'air-route-in'
    })
    const identifierRejectedWarnings = archived.warnings.filter((warning) => warning.code === 'identifierRejected')
    const settings = await getProjectTransferExportSourceProjectSettings('project-archived-export')
    const invalidDateMessage = await catchMessage(() => getProjectTransferExportPayloads('project-invalid-date'))
    const invalidFulltextMessage = await catchMessage(() => getProjectTransferExportPayloads('project-invalid-fulltext'))
    const missingProviderMessage = await catchMessage(() => getProjectTransferExportPayloads('project-missing-provider'))
    const preflightEstimate = await getProjectTransferExportPreflightEstimate('project-archived-export')
    const exportSummary = await getProjectTransferExportSummary('project-archived-export')
    const packageLayout = getProjectTransferExportTempLayout('export-package-test')
    const fakeZip = getFakeZipModule()
    const packageBuild = await buildExportPackage({
      exportedAt: new Date('2026-05-24T08:00:00.000Z'),
      expiresAt: new Date('2026-05-25T08:00:00.000Z'),
      layout: packageLayout,
      projectId: 'project-archived-export',
      sessionId: 'export-package-test',
      zipModule: fakeZip.zipModule,
    })
    const packageBytes = packageBuild.packageBytes ?? new Uint8Array()
    const packageZipEntryPaths = [
      'manifest.json',
      ...Object.values(packageBuild.manifest.payloads).map((entry) => {
        return entry.path
      }),
      ...archived.assetEntries.map((entry) => {
        return entry.path
      }),
    ].sort()
    const packageManifest = packageBuild.manifest
    const payloadFilePathSet = new Set(packageZipEntryPaths)
    const packagePayloadJsonCollection = JSON.parse(packageBuild.serializedPayloads.providerConnections)

    console.log(JSON.stringify({
      articleIds: archived.payloads.articles.map((article) => article.sourceArticleId),
      articleImportRouteIds: archived.payloads.articleImportRoutes.map((link) => link.sourceArticleImportRouteId),
      articleKeys: Object.keys(archived.payloads.articles[0]).sort(),
      assetEntryPaths: archived.assetEntries.map((entry) => entry.path).sort(),
      assetManifestEntries: archived.payloads.assetManifest.entries.map((entry) => {
        return {
          byteLength: entry.byteLength,
          checksumSha256: entry.checksumSha256,
          packagePath: entry.packagePath,
          references: entry.references,
        }
      }).sort((left, right) => left.packagePath.localeCompare(right.packagePath)),
      assetManifestHasAssets: Object.hasOwn(archived.payloads.assetManifest, 'assets'),
      assetManifestHasEnvelope: Object.hasOwn(archived.payloads.assetManifest, 'signature') || Object.hasOwn(archived.payloads.assetManifest, 'provenance'),
      buildTempCleaned: !(await Bun.file(packageLayout.buildPath).exists()),
      chunkedWarning: archived.warnings.find((warning) => warning.code === 'chunkedJudgmentInputProofMissing') ?? null,
      curatedArticleDoi: curatedArticle?.doi ?? null,
      curatedArticleIdentifierKeys: curatedArticle?.signature.identifierKeys ?? [],
      humanJudgmentIds: archived.payloads.humanJudgments.map((judgment) => judgment.sourceHumanJudgmentId),
      humanReviewProvenanceKinds: [
        ...archived.payloads.humanJudgments.map((judgment) => judgment.humanReviewInputSignatureProvenance.kind),
        ...summary.payloads.humanJudgmentSummaries.map((judgment) => judgment.humanReviewInputSignatureProvenance.kind),
        ...archived.payloads.reviews.map((review) => review.humanReviewInputSignatureProvenance.kind),
      ],
      humanReviewSignatureModes: [
        ...archived.payloads.humanJudgments.map((judgment) => judgment.humanReviewInputSignature.mode),
        ...summary.payloads.humanJudgmentSummaries.map((judgment) => judgment.humanReviewInputSignature.mode),
        ...archived.payloads.reviews.map((review) => review.humanReviewInputSignature.mode),
      ],
      humanSummaryIds: summary.payloads.humanJudgmentSummaries.map((judgment) => judgment.sourceHumanJudgmentSummaryId),
      importRouteActiveValues: archived.payloads.importRoutes.map((route) => route.active),
      invalidDateMessage,
      invalidFulltextMessage,
      judgmentAssessmentIds: archived.payloads.judgmentAssessments.map((assessment) => assessment.sourceJudgmentAssessmentId),
      judgmentInputSignature: archived.payloads.judgments[0].judgmentInputSignature,
      judgmentIds: archived.payloads.judgments.map((judgment) => judgment.sourceJudgmentId),
      judgmentKeys: Object.keys(archived.payloads.judgments[0]).sort(),
      judgmentProvenanceKind: archived.payloads.judgments[0].judgmentInputSignatureProvenance.kind,
      missingProviderMessage,
      packageChecksumMatches: packageBuild.metadata.checksumSha256 === getProjectTransferSha256Checksum(packageBytes),
      packageExecutionMode: packageBuild.executionMode,
      exportSummary,
      packageFingerprint: packageBuild.manifest.packageFingerprint ?? null,
      packageFingerprintMatchesAnalyze:
        (packageBuild.manifest.packageFingerprint ?? null)
        === getProjectTransferPackageFingerprint({manifest: packageBuild.manifest, payloads: archived.payloads}),
      packageHasAllPayloadFiles: projectTransferPayloadKeys.every((key) => {
        return payloadFilePathSet.has(packageBuild.manifest.payloads[key].path)
      }),
      packageHasManifest: packageZipEntryPaths.includes('manifest.json'),
      packageManifestAssetSummary: packageBuild.manifest.assetSummary,
      packageManifestExportedAt: packageManifest.exportedAt,
      packageManifestPayloadKeys: Object.keys(packageManifest.payloads).sort(),
      packageManifestProject: {
        currentModel: packageManifest.project.currentModel,
        humanJudgmentMode: packageManifest.project.humanJudgmentMode,
        name: packageManifest.project.name,
        sourceProjectId: packageManifest.project.sourceProjectId,
      },
      packageManifestSourceAppVersion: packageManifest.sourceAppVersion,
      packageMetadataHasTempPath: JSON.stringify(packageBuild.metadata).includes('tmp/project-transfer'),
      packagePayloadJsonCollectionIsArray: Array.isArray(packagePayloadJsonCollection),
      packageZipEntryPaths,
      preflightEstimate,
      modelDescriptors: archived.payloads.models.map((model) => {
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
      providerConnectionIds: archived.payloads.providerConnections.map((connection) => connection.sourceProviderConnectionId),
      rawForcedOmittedArticleImportRouteImportMetadata: rawForcedOmittedArticleImportRoute?.importMetadata ?? null,
      rawForcedOmittedArticleImportRouteRawPayload: rawForcedOmittedArticleImportRoute?.rawPayload ?? null,
      rawOmittedArticleOriginalData: rawOmittedArticle?.originalData ?? null,
      rawOmittedArticleImportRouteImportMetadata: rawOmittedArticleImportRoute?.importMetadata ?? null,
      rawOmittedArticleImportRouteRawPayload: rawOmittedArticleImportRoute?.rawPayload ?? null,
      rawOmittedArticleSourceMetadata: rawOmittedArticle?.sourceMetadata ?? null,
      rawIncludedArticleOriginalData: rawIncludedArticle?.originalData ?? null,
      rawIncludedArticleImportRouteImportMetadata: rawIncludedArticleImportRoute?.importMetadata ?? null,
      rawIncludedArticleImportRouteRawPayload: rawIncludedArticleImportRoute?.rawPayload ?? null,
      rawIncludedWarning: rawIncluded.warnings.find((warning) => warning.code === 'payloadOmitted' && warning.scope === 'articles') ?? null,
      rawForcedOmittedArticleOriginalData: rawForcedOmittedArticle?.originalData ?? null,
      rawForcedOmittedWarning: rawForcedOmitted.warnings.find((warning) => {
        return warning.code === 'payloadOmitted' && warning.scope === 'articles'
      }) ?? null,
      rawOmittedWarning: rawOmitted.warnings.find((warning) => warning.code === 'payloadOmitted' && warning.scope === 'articles') ?? null,
      reviewIds: archived.payloads.reviews.map((review) => review.sourceReviewId),
      routeArticleImportRoute: routeArticle?.importRoute ?? null,
      identifierRejectedWarnings,
      routeArticleIdentifierInputs: routeArticle?.identifierInputs ?? [],
      routeArticleSelectedImportRoute: routeArticle?.selectedImportRoute ?? null,
      routeArticleUrl: routeArticle?.url ?? null,
      serializedArticleFullTextAssets: serializedArticle.fullTextAssets,
      serializedArticleFullTextHtml: serializedArticle.fullTextHtml,
      serializedArticleFullTextPdf: serializedArticle.fullTextPdf,
      serializedArticleUrl: serializedArticle.url,
      serializedArticleHasFullTextPdf: Object.hasOwn(serializedArticle, 'fullTextPdf'),
      serializedJudgmentHasDeleteGeneration: Object.hasOwn(serializedJudgment, 'deleteGeneration'),
      settingsArchived: settings.archived,
      summaryReviewIds: summary.payloads.reviews.map((review) => review.sourceReviewId),
      preservedUrlWarnings: archived.warnings.filter((warning) => warning.code === 'nonLocalUrlPreserved').map((warning) => {
        return {
          action: warning.action,
          code: warning.code,
          jsonPointer: warning.jsonPointer,
          severity: warning.severity,
        }
      }),
      warnings: archived.warnings,
      warningCodes: archived.warnings.map((warning) => warning.code).sort(),
      warningsHaveSharedShape: archived.warnings.every((warning) => {
        return warning.action && warning.code && warning.message && warning.scope && warning.severity
      }),
    }))
  `)

  expect(result.payloadKeys).toEqual([...projectTransferPayloadKeys].sort())
  expect(result.settingsArchived).toBe(true)
  expect(result.projectArchived).toBe(true)
  expect(result.articleIds).toEqual(['article-route-in', 'article-curated-in'])
  expect(result.curatedArticleDoi).toBeNull()
  expect(result.curatedArticleIdentifierKeys).toEqual([])
  expect(
    result.routeArticleIdentifierInputs.some((input) => {
      return input.value === 'https://www.chictr.org.cn/showproj.html?proj=285095'
    }),
  ).toBe(false)
  expect(result.articleImportRouteIds).toEqual(['air-route-in'])
  expect(result.projectArticleIds).toEqual(['article-curated-in'])
  expect(result.importRouteActiveValues).toEqual([false])
  expect(result.judgmentIds).toEqual(['judgment-duplicate-answered', 'judgment-export'])
  expect(result.judgmentAssessmentIds).toEqual(['assessment-duplicate', 'assessment-export'])
  expect(result.humanJudgmentIds).toEqual(['human-disabled'])
  expect(result.humanSummaryIds).toEqual(['summary-human'])
  expect(result.exportSummary).toEqual({
    articleCount: 2,
    humanJudgmentCount: 1,
    judgmentCount: 2,
    promptHumanJudgmentCount: 1,
    summaryHumanJudgmentCount: 0,
  })
  expect(result.reviewIds).toEqual(['review-archived'])
  expect(result.summaryReviewIds).toEqual(['review-summary'])
  expect(result.judgmentProvenanceKind).toBe('currentReviewRows')
  expect(result.judgmentInputSignature).toMatchObject({
    model: {modelOptions: {thinking: 'medium'}, promptTokenLimit: 28768},
    provider: {transportFamily: 'codex-app'},
    request: {invocationTemperature: 0.2, reservedCompletionTokens: 4000},
    version: 1,
  })
  expect(result.humanReviewProvenanceKinds).toEqual(['currentReviewRows', 'currentReviewRows', 'currentReviewRows'])
  expect(result.humanReviewSignatureModes).toEqual(['promptHumanJudgment', 'summaryHumanJudgment', 'reviewRow'])
  expect(result.providerConnectionIds).toEqual(['provider-null-remote'])
  expect(result.routeArticleImportRoute).toBe('/Users/export/inactive-covidence.csv')
  expect(result.routeArticleSelectedImportRoute).toBe('/Users/export/inactive-covidence.csv')
  expect(result.routeArticleUrl).toBe(
    'https://user:pass@example.test/route?X-Amz-Credential=abc%2F20260611&X-Amz-Signature=secret#source',
  )
  expect(result.serializedArticleUrl).toBe(result.routeArticleUrl)
  expect(result.rawOmittedArticleOriginalData).toBeNull()
  expect(result.rawOmittedArticleImportRouteImportMetadata).toBeNull()
  expect(result.rawOmittedArticleImportRouteRawPayload).toBeNull()
  expect(result.rawOmittedArticleSourceMetadata).toBeNull()
  expect(result.rawOmittedWarning).toMatchObject({
    action: 'omitted',
    code: 'payloadOmitted',
    details: {rawArticleProvenanceMode: 'omit', thresholdChars: 1},
    scope: 'articles',
    severity: 'fidelity',
  })
  expect(result.rawIncludedArticleOriginalData).toEqual({raw: 'route'})
  expect(result.rawIncludedArticleImportRouteImportMetadata).toEqual({covidence: {studyKey: 'study-route'}})
  expect(result.rawIncludedArticleImportRouteRawPayload).toEqual({raw: 'route'})
  expect(result.rawIncludedWarning).toBeNull()
  expect(result.rawForcedOmittedArticleOriginalData).toBeNull()
  expect(result.rawForcedOmittedArticleImportRouteImportMetadata).toBeNull()
  expect(result.rawForcedOmittedArticleImportRouteRawPayload).toBeNull()
  expect(result.rawForcedOmittedWarning).toMatchObject({details: {rawArticleProvenanceMode: 'omit'}})
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
  expect(result.assetEntryPaths).toEqual([
    'assets/project-transfer-export-test/figure.png',
    'assets/project-transfer-export-test/html-image.png',
    'assets/project-transfer-export-test/route.pdf',
  ])
  expect(result.assetManifestHasAssets).toBe(false)
  expect(result.assetManifestHasEnvelope).toBe(false)
  expect(result.buildTempCleaned).toBe(true)
  expect(result.packageExecutionMode).toBe('inline')
  expect(result.packageHasManifest).toBe(true)
  expect(result.packageHasAllPayloadFiles).toBe(true)
  expect(result.packageFingerprintMatchesAnalyze).toBe(true)
  expect(result.packageManifestPayloadKeys).toEqual([...projectTransferPayloadKeys].sort())
  expect(result.packageManifestExportedAt).toBe('2026-05-24T08:00:00.000Z')
  expect(result.packageManifestSourceAppVersion).toMatch(/^\d+\.\d+\.\d+/)
  expect(result.packageManifestProject).toEqual({
    currentModel: {modelName: 'Local fallback model', remoteModelId: null, sourceModelId: 'model-null-remote'},
    humanJudgmentMode: 'prompt',
    name: 'Archived Export',
    sourceProjectId: 'project-archived-export',
  })
  expect(result.packageManifestAssetSummary).toEqual({byteLength: 49, entryCount: 3})
  expect(result.packageFingerprint).toMatch(/^[a-f0-9]{64}$/)
  expect(result.packageChecksumMatches).toBe(true)
  expect(result.packageMetadataHasTempPath).toBe(false)
  expect(result.packagePayloadJsonCollectionIsArray).toBe(true)
  expect(result.preflightEstimate.assetBytes).toBe(49)
  expect(result.preflightEstimate.packageBytes).toBeGreaterThan(result.preflightEstimate.assetBytes)
  expect(result.packageZipEntryPaths).toContain('manifest.json')
  expect(result.packageZipEntryPaths).toContain('providerConnections.json')
  expect(
    result.assetManifestEntries.map((entry) => {
      return entry.packagePath
    }),
  ).toEqual(result.assetEntryPaths)
  expect(
    result.assetManifestEntries.every((entry) => {
      return entry.byteLength > 0 && /^[a-f0-9]{64}$/.test(entry.checksumSha256)
    }),
  ).toBe(true)
  expect(
    result.assetManifestEntries.flatMap((entry) => {
      return entry.references.map((reference) => {
        return reference.kind
      })
    }),
  ).toEqual(['fullTextAssets', 'fullTextHtml', 'fullTextPdf'])
  expect(
    result.assetManifestEntries.flatMap((entry) => {
      return entry.references.map((reference) => {
        return {
          payloadFile: reference.payloadFile,
          sourceArticleId: reference.sourceArticleId,
          sourceRef: reference.sourceRef,
        }
      })
    }),
  ).toEqual([
    {payloadFile: 'articles.ndjson', sourceArticleId: 'article-route-in', sourceRef: 'article:article-route-in'},
    {payloadFile: 'articles.ndjson', sourceArticleId: 'article-route-in', sourceRef: 'article:article-route-in'},
    {payloadFile: 'articles.ndjson', sourceArticleId: 'article-route-in', sourceRef: 'article:article-route-in'},
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
  expect(result.serializedArticleFullTextPdf).toBe('assets/project-transfer-export-test/route.pdf')
  expect(result.serializedArticleFullTextAssets).toEqual({
    files: ['assets/project-transfer-export-test/figure.png'],
    label: 'route.png',
  })
  expect(result.serializedArticleFullTextHtml ?? '').toContain(
    'src="assets/project-transfer-export-test/html-image.png"',
  )
  expect(result.serializedArticleFullTextHtml ?? '').not.toContain('/api/runtime-asset')
  expect(result.serializedJudgmentHasDeleteGeneration).toBe(true)
  expect(result.warningCodes).toContain('chunkedJudgmentInputProofMissing')
  expect(result.warningCodes).toContain('currentReviewRowsHumanReviewInputSignature')
  expect(result.warningCodes).toContain('currentReviewRowsJudgmentInputSignature')
  expect(result.warningCodes).toContain('identifierRejected')
  expect(result.warningCodes).not.toContain('articleFullTextOmitted')
  expect(result.warningCodes).not.toContain('nonLocalUrlPreserved')
  expect(result.warningCodes).not.toContain('ambiguousJudgmentVisibleKey')
  expect(result.preservedUrlWarnings).toEqual([])
  expect(result.identifierRejectedWarnings).toHaveLength(2)
  expect(
    result.identifierRejectedWarnings.map((warning) => {
      return warning.jsonPointer
    }),
  ).toContain('/doi')
  expect(
    result.identifierRejectedWarnings.some((warning) => {
      return warning.jsonPointer.startsWith('/identifierInputs/')
    }),
  ).toBe(true)
  expect(
    result.identifierRejectedWarnings.every((warning) => {
      return warning.details.reason === 'malformed' && warning.sourceRef.startsWith('article:')
    }),
  ).toBe(true)
  expect(result.warningsHaveSharedShape).toBe(true)
  expect(result.chunkedWarning).toMatchObject({
    action: 'omitted',
    code: 'chunkedJudgmentInputProofMissing',
    details: {omittedJudgmentCount: 1, sourceJudgmentIds: ['judgment-chunked-no-proof']},
    scope: 'judgments',
    severity: 'fidelity',
  })
  expect(result.invalidDateMessage).toContain('date_from must be before or equal to date_to')
  expect(result.invalidFulltextMessage).toContain('use_fulltext and use_fulltext_no_images cannot both be enabled')
})

test('project-transfer judgment input signatures are stable across database id remapping and sensitive to critical settings', () => {
  type JudgmentSignatureInput = Parameters<typeof getProjectTransferExportJudgmentInputSignature>[0]
  const contentSettings = {useAbstract: true, useFulltext: false, useFulltextNoImages: true, useTitle: true}
  const article = {
    articleCreatedAt: '2026-01-01T00:00:00.000Z',
    articleId: 'external-article',
    articleSummary: 'Signature abstract',
    articleTitle: 'Signature title',
    articleUpdatedAt: '2026-01-02T00:00:00.000Z',
    articleVersion: 1,
    arxivId: null,
    biorxivId: null,
    contentHash: 'article-content-hash',
    createdAt: '2026-01-01T00:00:00.000Z',
    doi: '10.1000/signature',
    fullText: 'Visible text ![image](data:image/png;base64,AAA)',
    fullTextAssets: {figures: ['figure-1']},
    fullTextCharCount: 42,
    fullTextConversionAttempts: 1,
    fullTextConversionError: null,
    fullTextConversionMetadata: {pages: 2},
    fullTextConversionModelId: 'conversion-model',
    fullTextConversionStatus: 'completed',
    fullTextFetchedAt: '2026-01-03T00:00:00.000Z',
    fullTextHtml: '<p>Visible text</p>',
    fullTextOriginalFormat: 'pdf',
    fullTextPdf: 'assets/source.pdf',
    fullTextSource: 'pdf',
    identifierInputs: [],
    importRoute: 'covidence',
    medrxivId: null,
    originalData: null,
    provenance: {sourceArticleId: 'source-article-a'},
    publicationStatus: 'published',
    pubmedId: null,
    signature: {identifierKeys: ['doi:10.1000/signature'], title: 'Signature title'},
    sourceArticleId: 'source-article-a',
    sourceMetadata: null,
    updatedAt: '2026-01-02T00:00:00.000Z',
    url: 'https://example.test/signature',
  } as JudgmentSignatureInput['article']
  const prompt = {
    archived: false,
    contentHash: 'prompt-hash',
    criteriaDisposition: 'include',
    criteriaSectionKey: 'inclusion',
    criteriaSectionLabel: 'Inclusion',
    enabled: true,
    order: 1,
    originProjectId: null,
    originalText: 'Include this study?',
    projectPromptCreatedAt: '2026-01-01T00:00:00.000Z',
    projectPromptId: 'source-project-prompt-a',
    projectPromptUpdatedAt: '2026-01-02T00:00:00.000Z',
    promptArchived: false,
    promptCreatedAt: '2026-01-01T00:00:00.000Z',
    promptHeading: 'Eligibility',
    promptId: 'source-prompt-a',
    promptUpdatedAt: '2026-01-02T00:00:00.000Z',
    sourceProjectId: 'source-project-a',
    transformedText: null,
    type: 'string',
  } as JudgmentSignatureInput['prompt']
  const providerConnection = {
    authMode: 'apiKey',
    baseURL: null,
    configJson: {runtime: 'local'},
    createdAt: '2026-01-01T00:00:00.000Z',
    enabled: true,
    label: 'Codex',
    lastCheckedAt: null,
    lastError: null,
    maxInflightRequests: 2,
    providerConnectionId: 'source-provider-a',
    providerKind: 'codex',
    secretRef: null,
    updatedAt: '2026-01-02T00:00:00.000Z',
  } as JudgmentSignatureInput['providerConnection']
  const model = {
    createdAt: '2026-01-01T00:00:00.000Z',
    displayName: 'Codex Thinking',
    enabled: true,
    metadataJson: {discovery: {contextWindow: {totalTokens: 200000}}, options: {thinking: 'medium'}},
    modelId: 'source-model-a',
    name: 'Codex Thinking',
    providerConnectionId: 'source-provider-a',
    remoteModelId: 'codex-thinking',
    source: 'manual',
    updatedAt: '2026-01-02T00:00:00.000Z',
    variant: 'medium',
  } as JudgmentSignatureInput['model']
  const signature = getProjectTransferExportJudgmentInputSignature({
    article,
    chunkingStrategy: null,
    contentSettings,
    model,
    prompt,
    providerConnection,
  })
  const remappedSignature = getProjectTransferExportJudgmentInputSignature({
    article: {...article, provenance: {sourceArticleId: 'target-article-b'}, sourceArticleId: 'target-article-b'},
    chunkingStrategy: null,
    contentSettings,
    model: {...model, modelId: 'target-model-b', providerConnectionId: 'target-provider-b'},
    prompt: {...prompt, promptId: 'target-prompt-b', projectPromptId: 'target-project-prompt-b'},
    providerConnection: {...providerConnection, providerConnectionId: 'target-provider-b'},
  })
  const thinkingChangedSignature = getProjectTransferExportJudgmentInputSignature({
    article,
    chunkingStrategy: null,
    contentSettings,
    model: {...model, metadataJson: {discovery: {contextWindow: {totalTokens: 200000}}, options: {thinking: 'high'}}},
    prompt,
    providerConnection,
  })
  const providerChangedSignature = getProjectTransferExportJudgmentInputSignature({
    article,
    chunkingStrategy: null,
    contentSettings,
    model,
    prompt,
    providerConnection: {...providerConnection, providerKind: 'openai'},
  })

  expect(signature).toEqual(remappedSignature)
  expect(signature).not.toEqual(thinkingChangedSignature)
  expect(signature).not.toEqual(providerChangedSignature)
  expect(JSON.stringify(signature)).not.toContain('source-model-a')
  expect(JSON.stringify(signature)).not.toContain('source-prompt-a')
  expect(signature.fullTextProcessing.processedTextDigest).not.toBeNull()
  expect(signature.provider.transportFamily).toBe('codex-app')
})

test('project-transfer human review input signatures omit database ids and detect content mismatches', () => {
  type HumanReviewSignatureInput = Parameters<typeof getProjectTransferExportHumanReviewInputSignature>[0]
  const article = {
    articleSummary: 'Human summary',
    articleTitle: 'Human title',
    contentHash: 'human-article-hash',
    doi: '10.1000/human',
    fullText: 'Human full text',
    fullTextAssets: {pdf: 'asset-ref'},
    fullTextHtml: '<p>Human full text</p>',
    fullTextPdf: 'assets/human.pdf',
    identifierInputs: [],
    provenance: {sourceArticleId: 'source-human-article'},
    signature: {identifierKeys: ['doi:10.1000/human'], title: 'Human title'},
    sourceArticleId: 'source-human-article',
  } as HumanReviewSignatureInput['article']
  const signature = getProjectTransferExportHumanReviewInputSignature({
    article,
    mode: 'reviewRow',
    sections: {abstract: true, title: true},
  })
  const remappedSignature = getProjectTransferExportHumanReviewInputSignature({
    article: {
      ...article,
      provenance: {sourceArticleId: 'target-human-article'},
      sourceArticleId: 'target-human-article',
    },
    mode: 'reviewRow',
    sections: {abstract: true, title: true},
  })
  const mismatchedSignature = getProjectTransferExportHumanReviewInputSignature({
    article: {...article, fullTextHtml: '<p>Changed full text</p>'},
    mode: 'reviewRow',
    sections: {abstract: true, title: true},
  })

  expect(signature).toEqual(remappedSignature)
  expect(signature).not.toEqual(mismatchedSignature)
  expect(JSON.stringify(signature)).not.toContain('source-human-article')
  expect(signature.article.fullTextHtmlDigest).not.toBeNull()
  expect(signature.article.fullTextPdfReferenceDigest).not.toBeNull()
  expect(signature.article.fullTextAssetsDigest).not.toBeNull()
})

test('project-transfer export dependency checks fail instead of silently dropping missing models', () => {
  expect(() => {
    assertProjectTransferExportModelDependencies({
      modelRows: [{modelId: 'model-present'}],
      requiredModelIds: ['model-present', 'model-missing'],
    })
  }).toThrow('Project transfer export missing required model rows: model-missing')
})
