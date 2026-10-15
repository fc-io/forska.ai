import {mkdtempSync, rmSync} from 'node:fs'
import {readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

setDefaultTimeout(180_000)

type GuardedCommitOutcome = {
  changedSurfaces: string[]
  message: string | null
  reason: string | null
  rows: {articles: number; judgments: number; projects: number}
  status: 'error' | 'targetStateChanged' | 'written'
}

type GuardScriptResult = {
  clean: GuardedCommitOutcome
  epochChange: GuardedCommitOutcome
  legacyPlan: GuardedCommitOutcome
  recycleProbe: GuardedCommitOutcome & {
    epochUnchanged: boolean
    probeExternalWrites: number
    skipDecisionChangedSurfaces: string[]
    skipDecisionStatus: string
    statementWritesToProbedTable: number
  }
  windowWrite: GuardedCommitOutcome & {judgmentsBeforeCommit: number}
}

const guardScriptBody = `
  const [{migrateDuckdb}, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}, {writeProjectTransferCommitAppTables}, {getProjectTransferOperationTableNames}, dirtyTokens, {getProjectTransferDirtyTokenRevalidationDecision}, {isProjectTransferCommitTargetStateChangedError}] = await Promise.all([
    import('./src/db/migrateDuckdb.ts'),
    import('./src/server/services/appDatabaseService.ts'),
    import('./src/server/utils/duckdbService.ts'),
    import('./src/server/utils/serverRuntimeRole.ts'),
    import('./src/server/services/projectTransfer/projectTransferCommitWriter.ts'),
    import('./src/server/services/projectTransfer/projectTransferOperationTables.ts'),
    import('./src/server/services/projectTransfer/projectTransferTargetStateDirtyTokenService.ts'),
    import('./src/server/services/projectTransfer/projectTransferDirtyTokenRevalidation.ts'),
    import('./src/server/services/projectTransfer/projectTransferCommitWriteGuard.ts'),
  ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()
  await migrateDuckdb()

  const database = getAppDatabaseService()
  const service = dirtyTokens.getProjectTransferTargetStateDirtyTokenService()
  const now = new Date('2026-10-16T09:00:00.000Z')
  const escapeSql = (value) => String(value).replaceAll("'", "''")
  const jsonLiteral = (value) => "CAST('" + escapeSql(JSON.stringify(value)) + "' AS JSON)"
  const operationDatabase = (tx) => ({queryJson: tx.queryJson, run: tx.run, transaction: (work) => Promise.resolve(work(tx))})
  const createOperationPayloadTable = (tx, tableName, rows) => tx.run(
    'CREATE TEMP TABLE ' + tableName + " AS SELECT row_number() OVER () - 1 AS row_index, row_json AS payload_json FROM UNNEST(json_extract(" + jsonLiteral(rows) + ", '$[*]')) AS rows(row_json)",
  )
  const countRows = async (suffix) => {
    const [row] = await database.queryJson(
      "SELECT (SELECT count(*) FROM app.project WHERE name = 'Guard Project " + suffix + "')::INTEGER AS projects, " +
      "(SELECT count(*) FROM app.article WHERE doi = '10.1000/guard-" + suffix + "')::INTEGER AS articles, " +
      '(SELECT count(*) FROM app.judgment)::INTEGER AS judgments',
    )
    return row
  }
  const getFixture = (suffix) => {
    const settings = {humanJudgmentMode: 'prompt', useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true}
    const article = {
      articleId: 'guard-article-' + suffix,
      articleTitle: 'Guard Article ' + suffix,
      doi: '10.1000/guard-' + suffix,
      identifierInputs: [],
      provenance: {sourceArticleId: 'source-guard-article-' + suffix},
      signature: {identifierKeys: ['doi:10.1000/guard-' + suffix], title: 'Guard Article ' + suffix},
      sourceArticleId: 'source-guard-article-' + suffix,
    }
    const projectArticle = {
      provenance: {sourceArticleId: 'source-guard-article-' + suffix, sourceProjectId: 'source-project-' + suffix},
      signature: {},
      sourceArticleId: 'source-guard-article-' + suffix,
      sourceProjectArticleId: 'source-project-article-' + suffix,
      sourceProjectId: 'source-project-' + suffix,
    }
    const project = {
      dateFrom: null,
      dateTo: null,
      description: 'Guard project',
      modelSignature: {name: 'Model Signature'},
      name: 'Guard Project ' + suffix,
      provenance: {sourceProjectId: 'source-project-' + suffix},
      settings,
      signature: {modelSignature: {name: 'Model Signature'}, name: 'Guard Project ' + suffix, settings},
      sourceProjectId: 'source-project-' + suffix,
    }
    const model = {
      modelName: 'target-model-name',
      name: 'target-model-name',
      provenance: {sourceModelId: 'source-model', sourceProviderConnectionId: 'source-provider'},
      remoteModelId: 'target-remote',
      signature: {name: 'Model Signature'},
      sourceModelId: 'source-model',
      sourceProviderConnectionId: 'source-provider',
      variant: null,
      version: null,
    }
    const overlapCounts = {
      currentReviewRowsSignatureHumanReviewCount: 0, currentReviewRowsSignatureJudgmentCount: 0, dirtiedExistingProjectCount: 0,
      duplicateImportMatchCount: 0, newArticleCount: 1, omittedArticleRouteLinkCount: 0, omittedRouteLinkCount: 0,
      reusedArticleAssetPromotionCount: 0, reusedArticleCount: 0, reusedArticleFieldFillCount: 0, reusedArticleUpdateCount: 0,
      reusedJudgmentCount: 0, routeArticleSnapshotLinkCount: 0, snapshotVerifiedJudgmentCount: 0,
      storedSignatureHumanReviewCount: 0, storedSignatureJudgmentCount: 0,
    }
    const plan = {
      blockers: [],
      canCommit: true,
      dependencyResolution: {modelTargetBySourceId: {'source-model': 'target-model'}, providerTargetBySourceId: {'source-provider': 'target-provider'}},
      packageCounts: {
        articleImportRoutes: 0, assetManifest: 0, articles: 1, humanJudgmentSummaries: 0, humanJudgments: 0, importRoutes: 0,
        judgmentAssessments: 0, judgments: 0, models: 1, project: 1, projectArticles: 1, projectImportRoutes: 0,
        projectPrompts: 0, prompts: 0, providerConnections: 0, reviews: 0,
      },
      packageFingerprint: 'fingerprint-guard-' + suffix,
      packageWarnings: [],
      planRevision: 1,
      resolutionKinds: {},
      summary: {
        blockerCount: 0,
        conflictCounts: {articleConflictCount: 0, humanReviewFidelityConflictCount: 0, judgmentConflictCount: 0, packageContractConflictCount: 0, projectPromptConflictCount: 0},
        dependencyStatuses: {},
        judgmentConflictStatus: 'clear',
        overlapCounts,
        warningCount: 0,
      },
      targetPlan: {
        articleMatches: [{action: 'create', candidates: [], conflicts: [], identifierKeys: ['doi:10.1000/guard-' + suffix], packageArticleId: 'guard-article-' + suffix, selectedTargetArticleId: null, sourceArticleId: 'source-guard-article-' + suffix}],
        articleRoutePlan: [], articleUpdatePlan: [], assetPromotionPlan: [], duplicateImportMatches: [], projectPromptPlan: [], projectRoutePlan: [], promptPlan: [],
      },
    }
    const promotion = {
      articleCreates: [{article, sourceArticleId: 'source-guard-article-' + suffix}],
      articleFieldFills: [],
      manifest: {createdAt: now.toISOString(), promotions: [], sessionId: 'session-guard-' + suffix, updatedAt: now.toISOString()},
      promotionPathByPackagePath: {},
    }

    return {article, model, plan, project, projectArticle, promotion}
  }
  const runGuardedCommit = async (suffix, targetState) => {
    const fixture = getFixture(suffix)
    const operationTables = getProjectTransferOperationTableNames('commit_guard_' + suffix)
    const outcome = await database.transaction(async (tx) => {
      await createOperationPayloadTable(tx, operationTables.tableNames.articles, [fixture.article])
      await createOperationPayloadTable(tx, operationTables.tableNames.articleImportRoutes, [])
      await createOperationPayloadTable(tx, operationTables.tableNames.humanJudgments, [])
      await createOperationPayloadTable(tx, operationTables.tableNames.humanJudgmentSummaries, [])
      await createOperationPayloadTable(tx, operationTables.tableNames.judgmentAssessments, [])
      await createOperationPayloadTable(tx, operationTables.tableNames.judgments, [])
      await createOperationPayloadTable(tx, operationTables.tableNames.projectArticles, [fixture.projectArticle])
      await createOperationPayloadTable(tx, operationTables.tableNames.reviews, [])

      return writeProjectTransferCommitAppTables({
        commitId: 'commit-guard-' + suffix,
        cwd: process.env.PROJECT_TRANSFER_TEST_RUNTIME_ROOT,
        database: operationDatabase(tx),
        now,
        operationTables,
        payloads: {articles: [fixture.article], models: [fixture.model], project: fixture.project, projectArticles: [fixture.projectArticle]},
        plan: targetState === undefined ? fixture.plan : {...fixture.plan, targetState},
        promotion: fixture.promotion,
        schemaVersion: 1,
        sessionId: 'session-guard-' + suffix,
      })
    }).then(
      () => ({changedSurfaces: [], message: null, reason: null, status: 'written'}),
      (error) => ({
        changedSurfaces: error.decision?.changedSurfaces ?? [],
        message: error instanceof Error ? error.message : String(error),
        reason: error.decision?.reason ?? null,
        status: isProjectTransferCommitTargetStateChangedError(error) ? 'targetStateChanged' : 'error',
      }),
    )

    return {...outcome, rows: await countRows(suffix)}
  }

  await database.run("INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode) VALUES ('target-provider', 'openai', 'Target Provider', TRUE, 'none')")
  await database.run("INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled) VALUES ('target-model', 'target-provider', 'target-model-name', 'target-remote', 'Target Model', 'manual', TRUE)")
  await database.run("INSERT INTO app.article (id, article_title) VALUES ('target-article', 'Target Article')")
  await database.run("INSERT INTO app.prompt (id, original_text) VALUES ('target-prompt', 'Include?')")
  await database.run("INSERT INTO app.import_route (id, route) VALUES ('target-route', 'pubmed:target')")
  await database.run("INSERT INTO app.article_import_route (id, article_id, import_route_id) VALUES ('target-article-route', 'target-article', 'target-route')")
  await service.initializeTargetStateCoverage()

  const result = {}

  result.clean = await runGuardedCommit('clean', await service.getTargetStateDirtyTokenSnapshot())
  result.legacyPlan = await runGuardedCommit('legacy', undefined)

  const windowTargetState = await service.getTargetStateDirtyTokenSnapshot()
  await database.appendJudgments([{
    answeredOriginal: 'yes', answeredOriginalAsArray: ['yes'], articleId: 'target-article', chunkingStrategy: null,
    confidenceOriginal: 0.9, createdAt: now, explanation: 'Judge completion in the commit window', id: 'window-judgment',
    isAnswered: true, modelId: 'target-model', projectId: null, promptId: 'target-prompt', quotes: [],
    snapshotProjectId: null, snapshotProjectModelName: null, systemPromptVariant: 'screening_v1', updatedAt: now,
    useAbstract: true, useFulltext: false, useFulltextNoImages: false, useMetadata: false, useTitle: true,
  }])
  const judgmentsBeforeCommit = (await countRows('window')).judgments
  result.windowWrite = {...(await runGuardedCommit('window', windowTargetState)), judgmentsBeforeCommit}

  const recycleTargetState = await service.getTargetStateDirtyTokenSnapshot()
  await database.closeForReset()
  const afterRecycle = await service.getTargetStateDirtyTokenSnapshot()
  const skipDecision = getProjectTransferDirtyTokenRevalidationDecision({analyzedTargetState: recycleTargetState, currentTargetState: afterRecycle})
  const probedTable = 'app.article_import_route'
  result.recycleProbe = {
    ...(await runGuardedCommit('recycle', recycleTargetState)),
    epochUnchanged: afterRecycle.tableWrites.epoch === recycleTargetState.tableWrites.epoch,
    probeExternalWrites: afterRecycle.tableWrites.externalCounters[probedTable] - recycleTargetState.tableWrites.externalCounters[probedTable],
    skipDecisionChangedSurfaces: skipDecision.changedSurfaces,
    skipDecisionStatus: skipDecision.status,
    statementWritesToProbedTable:
      (afterRecycle.tableWrites.counters[probedTable] - afterRecycle.tableWrites.externalCounters[probedTable])
      - (recycleTargetState.tableWrites.counters[probedTable] - recycleTargetState.tableWrites.externalCounters[probedTable]),
  }

  const epochTargetState = await service.getTargetStateDirtyTokenSnapshot()
  await database.run("ATTACH ':memory:' AS guard_scratch")
  await database.run('DETACH guard_scratch')
  result.epochChange = await runGuardedCommit('epoch', epochTargetState)

  console.log(JSON.stringify(result))
  await database.close()
`

const getLastJsonLine = (stdout: string) => {
  return (
    stdout
      .split('\n')
      .filter((line) => {
        return line.startsWith('{')
      })
      .at(-1) ?? ''
  )
}

const runGuardScript = (): GuardScriptResult => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'f2-project-transfer-commit-guard-'))
  const result = globalThis.Bun.spawnSync(['bun', '-e', guardScriptBody], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      API_SERVER_PORT: '39991',
      DUCKDB_MEMORY_LIMIT: '8GB',
      DUCKDB_PATH: join(runtimeRoot, 'commit-guard.duckdb'),
      PROJECT_TRANSFER_TEST_RUNTIME_ROOT: runtimeRoot,
      SERVER_ROLE: 'dev-single',
      VITE_PORT: '39992',
    },
  })

  try {
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString() || result.stdout.toString() || 'Commit guard script failed')
    }

    return JSON.parse(getLastJsonLine(result.stdout.toString())) as GuardScriptResult
  } finally {
    rmSync(runtimeRoot, {force: true, recursive: true})
  }
}

let scriptResult: GuardScriptResult | null = null

const getScriptResult = () => {
  if (scriptResult === null) {
    throw new Error('Commit guard script did not run')
  }

  return scriptResult
}

beforeAll(() => {
  scriptResult = runGuardScript()
})

test('the commit writes when no tracked table changed since the commit-time snapshot', () => {
  const {clean, legacyPlan} = getScriptResult()

  expect(clean).toMatchObject({rows: {articles: 1, projects: 1}, status: 'written'})
  expect(legacyPlan).toMatchObject({rows: {articles: 1, projects: 1}, status: 'written'})
})

test('a context-free judgment append between the snapshot and the writes aborts the commit before any app write', () => {
  const {windowWrite} = getScriptResult()

  expect(windowWrite).toMatchObject({
    changedSurfaces: ['judgment'],
    reason: 'target_state_table_write_changed',
    rows: {articles: 0, judgments: windowWrite.judgmentsBeforeCommit, projects: 0},
    status: 'targetStateChanged',
  })
  expect(windowWrite.message).toContain('nothing was written')
})

test('a DuckDB recycle whose startup probe rewrites a tracked table does not trip the pre-write guard', () => {
  const {recycleProbe} = getScriptResult()

  expect(recycleProbe.probeExternalWrites).toBeGreaterThan(0)
  expect(recycleProbe.statementWritesToProbedTable).toBe(0)
  expect(recycleProbe.epochUnchanged).toBe(true)
  expect(recycleProbe.skipDecisionStatus).toBe('full_revalidation_required')
  expect(recycleProbe.skipDecisionChangedSurfaces).toContain('importRoute')
  expect(recycleProbe).toMatchObject({rows: {articles: 1, projects: 1}, status: 'written'})
})

test('an epoch renewal between the snapshot and the writes aborts the commit', () => {
  const {epochChange} = getScriptResult()

  expect(epochChange).toMatchObject({
    reason: 'target_state_table_write_epoch_changed',
    rows: {articles: 0, projects: 0},
    status: 'targetStateChanged',
  })
})

test('the pre-write guard is the first statement of the commit write transaction', async () => {
  const writerSource = await readFile(new URL('./projectTransferCommitWriter.ts', import.meta.url), 'utf8')
  const transactionStart = writerSource.indexOf('const writeProjectTransferCommitAppTablesTx = async')
  const bodyStart = writerSource.indexOf('{tx: ProjectTransferCommitWriterTx}) => {', transactionStart)
  const guardCall = writerSource.indexOf(
    'assertProjectTransferCommitTargetStateUnchanged({plan, sessionId})',
    bodyStart,
  )
  const beforeGuard = writerSource.slice(bodyStart + '{tx: ProjectTransferCommitWriterTx}) => {'.length, guardCall)

  expect(transactionStart).toBeGreaterThan(-1)
  expect(bodyStart).toBeGreaterThan(transactionStart)
  expect(guardCall).toBeGreaterThan(bodyStart)
  expect(beforeGuard.trim()).toBe('')
})
