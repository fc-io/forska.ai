import {existsSync, mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'

import {expect, setDefaultTimeout, test} from 'bun:test'

setDefaultTimeout(240_000)

type ExportError = {code: string | null; message: string; name: string}

type SourceExportResult = {
  articleId: string
  converterMarkdownBytes: number
  exportError: ExportError | null
  figureCount: number
  hash: string
  layoutBytes: number
  pdfBytes: number
  version: string
}

type ImportedArticleState = {
  converterMarkdownBytes: number | null
  cropFilesExist: boolean[]
  figureModeBuilt: string | null
  fullTextAssets: {imagePath: string; index: number}[]
  fullTextPdf: string | null
  hash: string | null
  id: string
  layoutBytes: number | null
  metadata: {converterMarkdownPath: string; layoutPath: string}
  pdfBytes: number | null
  status: string | null
  textHash: string
  version: string | null
}

type ImportStep = {blockerCodes: string[]; commitState: string | null; fieldFills: string[]; state: string}

type FreshImportResult = {
  article: ImportedArticleState
  import: ImportStep
  rebuilt: {changed: boolean; hash: string; version: string}
  sourceAssetDirectoryExists: boolean
}

type ReusedImportResult = {
  hashConflict: ImportStep
  reimport: ImportStep
  stateConflict: ImportStep
  unitFill: ImportStep
  unitFillArticle: ImportedArticleState
  unitFillRebuilt: {changed: boolean; hash: string; version: string}
}

const repoRoot = resolve(import.meta.dir, '../../../..')
const fixtureName = 'frontiers-fmed-2023-1283512.mineru'
const fixtureRoot = join(repoRoot, 'src/server/fullText/fixtures/canonical')

const getLastJsonLine = (stdout: string) => {
  return (
    stdout
      .split('\n')
      .map((line) => {
        return line.trim()
      })
      .filter((line) => {
        return line.startsWith('{')
      })
      .at(-1) ?? ''
  )
}

const getScriptPrelude = () => {
  return `
    const repoRoot = ${JSON.stringify(repoRoot)}
    const {readFileSync, writeFileSync, existsSync, statSync, mkdirSync} = await import('node:fs')
    const {join} = await import('node:path')
    const {createHash} = await import('node:crypto')
    const {migrateDuckdb} = await import(repoRoot + '/src/db/migrateDuckdb.ts')
    const {getAppDatabaseService} = await import(repoRoot + '/src/server/services/appDatabaseService.ts')

    await migrateDuckdb()

    const database = getAppDatabaseService()
    const runtimeRoot = process.cwd()
    const getFileBytes = (pathValue) => {
      const absolutePath = pathValue ? join(runtimeRoot, pathValue) : null

      return absolutePath && existsSync(absolutePath) ? statSync(absolutePath).size : null
    }
  `
}

const runRuntimeRootScript = <T>({body, label}: {body: string; label: string}) => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), `f2-transfer-canonical-${label}-`))
  const result = globalThis.Bun.spawnSync(['bun', '-'], {
    cwd: runtimeRoot,
    env: {
      ...process.env,
      API_SERVER_PORT: '39995',
      DUCKDB_PATH: join(runtimeRoot, 'forska.duckdb'),
      DUCKDB_TEMP_DIRECTORY: join(runtimeRoot, 'duckdb-temp'),
      SERVER_ROLE: 'dev-single',
      VITE_PORT: '39996',
    },
    stdin: Buffer.from(`${getScriptPrelude()}\n${body}\nawait database.close()\n`),
  })

  try {
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString() || result.stdout.toString() || `${label} script failed`)
    }

    return {output: JSON.parse(getLastJsonLine(result.stdout.toString())) as T, runtimeRoot}
  } finally {
    rmSync(runtimeRoot, {force: true, recursive: true})
  }
}

const getSourceExportScript = ({packagePath, removeFile}: {packagePath: string; removeFile?: string}) => {
  return `
    const {writeFullTextAssetFiles} = await import(repoRoot + '/src/server/fullText/converters/fullTextAssetFiles.ts')
    const {storeConvertedFullText} = await import(repoRoot + '/src/server/fullText/canonicalFullTextStore.ts')
    const {createProjectTransferExport} = await import(repoRoot + '/src/server/services/projectTransfer/projectTransferExportPackage.ts')
    const fixtureRoot = ${JSON.stringify(fixtureRoot)}
    const layout = JSON.parse(readFileSync(join(fixtureRoot, '${fixtureName}.layout.json'), 'utf8')).blocks
    const fixtureFigures = JSON.parse(readFileSync(join(fixtureRoot, '${fixtureName}.assets.json'), 'utf8'))
    const articleId = 'source-canonical-article'
    const pdfPath = 'assets/article_pdfs/source-canonical-article.pdf'
    const markdown = '# Converter markdown\\n\\nKept for audit.\\n'

    mkdirSync(join(runtimeRoot, 'assets/article_pdfs'), {recursive: true})
    writeFileSync(join(runtimeRoot, pdfPath), '%PDF-1.7 canonical round trip')
    await database.run(\`
      INSERT INTO app.article (id, article_id, article_title, doi, full_text_pdf, article_created_at, created_at, updated_at)
      VALUES (
        '\${articleId}',
        'source-app-article',
        'Canonical round trip article',
        '10.3389/fmed.2023.1283512',
        '\${pdfPath}',
        TIMESTAMPTZ '2026-01-05T00:00:00Z',
        TIMESTAMPTZ '2026-01-05T00:00:00Z',
        TIMESTAMPTZ '2026-01-05T00:00:00Z'
      )
    \`)

    const files = await writeFullTextAssetFiles({
      articleId,
      figures: fixtureFigures.map((figure) => {
        return {
          bbox: figure.bbox,
          caption: figure.caption,
          image: {bytes: new Uint8Array([0xff, 0xd8, 0xff, figure.index]), extension: 'jpg'},
          index: figure.index,
          page: figure.page,
        }
      }),
      layout,
      markdown,
    })
    const canonical = await storeConvertedFullText({
      articleId,
      attempts: 1,
      mutationSource: 'projectTransferCanonicalFullTextRoundtrip.test',
      result: {
        converterKind: 'mineru',
        converterMarkdownPath: files.converterMarkdownPath,
        converterVersion: '4.0.12',
        figures: files.figures,
        html: null,
        layout,
        layoutPath: files.layoutPath,
        markdown,
        optionsHash: 'options-hash',
      },
      runtimeConfig: {
        baseURL: 'http://127.0.0.1:8000',
        modelId: 'mineru-model',
        modelName: 'MinerU',
        providerConnectionId: 'mineru-connection',
        providerKind: 'mineru',
      },
    })

    await database.run(\`
      INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode)
      VALUES ('source-provider', 'openai', 'Source Provider', TRUE, 'none')
    \`)
    await database.run(\`
      INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
      VALUES ('source-model', 'source-provider', 'source-model-name', 'source-remote', 'Source Model', 'manual', TRUE)
    \`)
    await database.run(\`
      INSERT INTO app.project (
        id, name, model_id, human_judgment_mode, use_title, use_abstract, use_fulltext, use_fulltext_no_images,
        full_text_figure_mode, full_text_strategy_id, archived, created_at, updated_at
      )
      VALUES (
        'source-project', 'Canonical Source Project', 'source-model', 'prompt', TRUE, TRUE, TRUE, FALSE,
        'none', 'fts-legacy-v0', FALSE, TIMESTAMPTZ '2026-01-05T00:00:00Z', TIMESTAMPTZ '2026-01-05T00:00:00Z'
      )
    \`)
    await database.run(\`
      INSERT INTO app.project_article (id, project_id, article_id, imported_from_project_id, created_at, updated_at)
      VALUES ('source-project-article', 'source-project', '\${articleId}', NULL, TIMESTAMPTZ '2026-01-05T00:00:00Z', TIMESTAMPTZ '2026-01-05T00:00:00Z')
    \`)

    const removeFile = ${JSON.stringify(removeFile ?? null)}

    if (removeFile !== null) {
      const {rmSync} = await import('node:fs')
      rmSync(join(runtimeRoot, removeFile === 'layout' ? files.layoutPath : files.converterMarkdownPath))
    }

    const exportError = await createProjectTransferExport({projectId: 'source-project'}).then(
      (created) => {
        writeFileSync(${JSON.stringify(packagePath)}, created.packageBytes)

        return null
      },
      (error) => {
        return {code: error.code ?? null, message: error.message, name: error.name}
      },
    )

    console.log(JSON.stringify({
      articleId,
      converterMarkdownBytes: getFileBytes(files.converterMarkdownPath),
      exportError,
      figureCount: files.figures.length,
      hash: canonical.hash,
      layoutBytes: getFileBytes(files.layoutPath),
      pdfBytes: getFileBytes(pdfPath),
      version: canonical.version,
    }))
  `
}

const getTargetImportPrelude = (packagePath: string) => {
  return `
    const {createProjectTransferRoutes} = await import(repoRoot + '/src/server/routes/projectTransferRoutes.ts')
    const {rebuildCanonicalFullText} = await import(repoRoot + '/src/server/fullText/canonicalFullTextStore.ts')
    const {getProjectTransferImportTempLayout} = await import(repoRoot + '/src/server/services/projectTransfer/projectTransferSession.ts')
    const app = createProjectTransferRoutes()
    const packageBytes = readFileSync(${JSON.stringify(packagePath)})
    const request = async (path, method, body, headers = {'content-type': 'application/json'}) => {
      const response = await app.handle(new Request('http://localhost' + path, {body, headers, method}))
      const json = await response.json()

      if (response.status >= 300) {
        throw new Error(path + ' ' + response.status + ' ' + JSON.stringify(json))
      }

      return json.data
    }
    const importPackage = async (sessionId) => {
      await request('/api/projects/import/sessions', 'POST', JSON.stringify({sessionId}))
      await request('/api/projects/import/' + sessionId + '/upload', 'PUT', packageBytes, {
        'content-type': 'application/zip',
        'x-project-transfer-filename': 'canonical-roundtrip.zip',
      })
      const analyzed = await request(
        '/api/projects/import/' + sessionId + '/analyze',
        'POST',
        JSON.stringify({expandedBytes: 0, zipBytes: packageBytes.byteLength}),
      )
      const plan = JSON.parse(readFileSync(join(runtimeRoot, getProjectTransferImportTempLayout(sessionId).planPath), 'utf8'))
      const committed = analyzed.state === 'ready_to_commit'
        ? await request('/api/projects/import/' + sessionId + '/commit', 'POST', JSON.stringify({planRevision: analyzed.planRevision}))
        : null

      return {
        blockerCodes: (analyzed.planSummary.blockers ?? []).map((blocker) => blocker.code),
        commitState: committed?.state ?? null,
        fieldFills: plan.targetPlan.articleUpdatePlan.flatMap((update) => update.fieldFills.map((fill) => fill.field)).sort(),
        state: analyzed.state,
      }
    }
    const getArticleState = async () => {
      const [article] = await database.queryJson(\`
        SELECT
          id,
          full_text AS fullText,
          full_text_pdf AS fullTextPdf,
          full_text_canonical_hash AS hash,
          full_text_canonical_version AS version,
          full_text_figure_mode_built AS figureModeBuilt,
          full_text_conversion_status AS status,
          CAST(full_text_conversion_metadata AS VARCHAR) AS metadata,
          CAST(full_text_assets AS VARCHAR) AS fullTextAssets
        FROM app.article
      \`)
      const metadata = JSON.parse(article.metadata)
      const fullTextAssets = JSON.parse(article.fullTextAssets)

      return {
        converterMarkdownBytes: getFileBytes(metadata.converterMarkdownPath),
        cropFilesExist: fullTextAssets.map((asset) => existsSync(join(runtimeRoot, asset.imagePath))),
        figureModeBuilt: article.figureModeBuilt,
        fullTextAssets: fullTextAssets.map((asset) => ({imagePath: asset.imagePath, index: asset.index})),
        fullTextPdf: article.fullTextPdf,
        hash: article.hash,
        id: article.id,
        layoutBytes: getFileBytes(metadata.layoutPath),
        metadata: {converterMarkdownPath: metadata.converterMarkdownPath, layoutPath: metadata.layoutPath},
        pdfBytes: getFileBytes(article.fullTextPdf),
        status: article.status,
        textHash: createHash('sha256').update(article.fullText, 'utf8').digest('hex'),
        version: article.version,
      }
    }
    const getRebuilt = async (articleId) => {
      const rebuilt = await rebuildCanonicalFullText({articleId})

      return {changed: rebuilt.changed, hash: rebuilt.hash, version: rebuilt.version}
    }
  `
}

const getFreshImportScript = (packagePath: string) => {
  return `
    ${getTargetImportPrelude(packagePath)}
    const imported = await importPackage('canonical-fresh-import')
    const article = await getArticleState()

    console.log(JSON.stringify({
      article,
      import: imported,
      rebuilt: await getRebuilt(article.id),
      sourceAssetDirectoryExists: existsSync(join(runtimeRoot, 'assets/full-text-assets')),
    }))
  `
}

const getReusedImportScript = (packagePath: string) => {
  return `
    ${getTargetImportPrelude(packagePath)}
    await importPackage('canonical-first-import')
    const reimport = await importPackage('canonical-reimport')
    await database.run(\`
      UPDATE app.article
      SET full_text = NULL,
          full_text_assets = NULL,
          full_text_canonical_hash = NULL,
          full_text_canonical_version = NULL,
          full_text_figure_mode_built = NULL,
          full_text_conversion_status = NULL,
          full_text_conversion_metadata = NULL,
          full_text_conversion_model_id = NULL,
          full_text_conversion_attempts = NULL,
          full_text_conversion_error = NULL
    \`)
    const unitFill = await importPackage('canonical-unit-fill')
    const unitFillArticle = await getArticleState()
    const unitFillRebuilt = await getRebuilt(unitFillArticle.id)
    await database.run("UPDATE app.article SET full_text = 'A different target text'")
    const hashConflict = await importPackage('canonical-hash-conflict')
    await database.run('UPDATE app.article SET full_text = NULL')
    const stateConflict = await importPackage('canonical-state-conflict')

    console.log(JSON.stringify({hashConflict, reimport, stateConflict, unitFill, unitFillArticle, unitFillRebuilt}))
  `
}

const withExportedPackage = <T>(work: (input: {exported: SourceExportResult; packagePath: string}) => T) => {
  const packageDirectory = mkdtempSync(join(tmpdir(), 'f2-transfer-canonical-package-'))
  const packagePath = join(packageDirectory, 'package.zip')

  try {
    const source = runRuntimeRootScript<SourceExportResult>({
      body: getSourceExportScript({packagePath}),
      label: 'source',
    })

    expect(source.output.exportError).toBeNull()

    return work({exported: source.output, packagePath})
  } finally {
    rmSync(packageDirectory, {force: true, recursive: true})
  }
}

const expectCanonicalArticle = ({
  article,
  exported,
  rebuilt,
}: {
  article: ImportedArticleState
  exported: SourceExportResult
  rebuilt: {changed: boolean; hash: string; version: string}
}) => {
  expect(article.id).not.toBe(exported.articleId)
  expect(article.hash).toBe(exported.hash)
  expect(article.textHash).toBe(exported.hash)
  expect(article.version).toBe(exported.version)
  expect(article.figureModeBuilt).toBe('markers')
  expect(article.status).toBe('success')
  expect(article.metadata.layoutPath).toStartWith('assets/project-transfer/')
  expect(article.metadata.converterMarkdownPath).toStartWith('assets/project-transfer/')
  expect(article.layoutBytes).toBe(exported.layoutBytes)
  expect(article.converterMarkdownBytes).toBe(exported.converterMarkdownBytes)
  expect(article.fullTextAssets).toHaveLength(exported.figureCount)
  expect(
    article.fullTextAssets.every((asset) => {
      return asset.imagePath.startsWith('assets/project-transfer/')
    }),
  ).toBe(true)
  expect(article.cropFilesExist).toEqual(
    article.fullTextAssets.map(() => {
      return true
    }),
  )
  expect(rebuilt).toEqual({changed: false, hash: exported.hash, version: exported.version})
}

test('project transfer carries the canonical full-text state, layout.json and converter.md into a fresh target', () => {
  withExportedPackage(({exported, packagePath}) => {
    const imported = runRuntimeRootScript<FreshImportResult>({
      body: getFreshImportScript(packagePath),
      label: 'fresh',
    }).output

    expect(exported.figureCount).toBeGreaterThan(0)
    expect(imported.import).toEqual({
      blockerCodes: [],
      commitState: 'completed',
      fieldFills: [],
      state: 'ready_to_commit',
    })
    expectCanonicalArticle({article: imported.article, exported, rebuilt: imported.rebuilt})
    expect(imported.article.fullTextPdf).toStartWith('assets/project-transfer/')
    expect(imported.article.pdfBytes).toBe(exported.pdfBytes)
    expect(imported.sourceAssetDirectoryExists).toBe(false)
  })
})

test('project transfer fills a reused article canonical state as one unit and reports hash or state conflicts', () => {
  withExportedPackage(({exported, packagePath}) => {
    const result = runRuntimeRootScript<ReusedImportResult>({
      body: getReusedImportScript(packagePath),
      label: 'reuse',
    }).output

    expect(result.reimport).toEqual({
      blockerCodes: [],
      commitState: 'completed',
      fieldFills: [],
      state: 'ready_to_commit',
    })
    expect(result.unitFill).toEqual({
      blockerCodes: [],
      commitState: 'completed',
      fieldFills: [
        'fullText',
        'fullTextAssets',
        'fullTextCanonicalHash',
        'fullTextCanonicalVersion',
        'fullTextConversionAttempts',
        'fullTextConversionMetadata',
        'fullTextConversionModelId',
        'fullTextConversionStatus',
        'fullTextFigureModeBuilt',
      ],
      state: 'ready_to_commit',
    })
    expectCanonicalArticle({article: result.unitFillArticle, exported, rebuilt: result.unitFillRebuilt})
    expect(result.hashConflict.state).toBe('awaiting_resolution')
    expect(result.hashConflict.blockerCodes).toContain('article_full_text_canonical_hash_conflict')
    expect(result.hashConflict.fieldFills).not.toContain('fullTextCanonicalHash')
    expect(result.stateConflict.state).toBe('awaiting_resolution')
    expect(result.stateConflict.blockerCodes).toContain('article_full_text_canonical_state_conflict')
    expect(result.stateConflict.fieldFills).not.toContain('fullText')
  })
})

test('project transfer export fails with a named asset error when layout.json or converter.md is missing', () => {
  const results = (['layout', 'converterMarkdown'] as const).map((removeFile) => {
    const packageDirectory = mkdtempSync(join(tmpdir(), 'f2-transfer-canonical-missing-'))

    try {
      const source = runRuntimeRootScript<SourceExportResult>({
        body: getSourceExportScript({packagePath: join(packageDirectory, 'package.zip'), removeFile}),
        label: `missing-${removeFile}`,
      })

      return {exportError: source.output.exportError, packageExists: existsSync(join(packageDirectory, 'package.zip'))}
    } finally {
      rmSync(packageDirectory, {force: true, recursive: true})
    }
  })

  expect(
    results.map((result) => {
      return {code: result.exportError?.code, name: result.exportError?.name, packageExists: result.packageExists}
    }),
  ).toEqual([
    {code: 'missing_runtime_asset', name: 'ProjectTransferExportAssetError', packageExists: false},
    {code: 'missing_runtime_asset', name: 'ProjectTransferExportAssetError', packageExists: false},
  ])
  expect(results[0]?.exportError?.message).toContain(
    'missing runtime asset assets/full-text-assets/source-canonical-article/layout.json referenced by articles[0].fullTextConversionMetadata.layoutPath',
  )
  expect(results[1]?.exportError?.message).toContain(
    'missing runtime asset assets/full-text-assets/source-canonical-article/converter.md referenced by articles[0].fullTextConversionMetadata.converterMarkdownPath',
  )
})
