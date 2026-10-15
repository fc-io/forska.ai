import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import {
  getProjectTransferDirtyTokenRevalidationDecision,
  getProjectTransferDirtyTokenStalePlanReasons,
} from './projectTransferDirtyTokenRevalidation.ts'
import {
  projectTransferDependencyFingerprintAlgorithm,
  projectTransferDependencyFingerprintCodeVersion,
  projectTransferTargetStateCoverageCodeVersion,
  type ProjectTransferTargetStateDirtyTokenSnapshot,
  type ProjectTransferTargetStateSafetySurface,
  projectTransferTargetStateSafetySurfaces,
  projectTransferTargetStateTrackedTables,
} from './projectTransferTargetStateDirtyTokenService.ts'

setDefaultTimeout(120_000)

type SnapshotPair = {
  after: ProjectTransferTargetStateDirtyTokenSnapshot
  before: ProjectTransferTargetStateDirtyTokenSnapshot
}

type TableWriteScenarioName =
  | 'afterSearchPathReopen'
  | 'attach'
  | 'closedTracker'
  | 'committedTransaction'
  | 'fileIdentityChange'
  | 'noWrites'
  | 'recycle'
  | 'rolledBackTransaction'
  | 'searchPathChanged'
  | 'unrelatedWrites'

type TableWriteScriptResult = {
  appTables: string[]
  scenarios: Record<TableWriteScenarioName, SnapshotPair>
  surfaceWrites: Record<ProjectTransferTargetStateSafetySurface, SnapshotPair>
}

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

const tableWriteScriptBody = `
  const [{migrateDuckdb}, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}, tracker, dirtyTokens] = await Promise.all([
    import('./src/db/migrateDuckdb.ts'),
    import('./src/server/services/appDatabaseService.ts'),
    import('./src/server/utils/duckdbService.ts'),
    import('./src/server/utils/serverRuntimeRole.ts'),
    import('./src/server/utils/duckdbTableWriteTracker.ts'),
    import('./src/server/services/projectTransfer/projectTransferTargetStateDirtyTokenService.ts'),
  ])
  const {copyFileSync, renameSync} = await import('node:fs')

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()
  await migrateDuckdb()

  const database = getAppDatabaseService()
  const service = dirtyTokens.getProjectTransferTargetStateDirtyTokenService()
  const snapshot = () => service.getTargetStateDirtyTokenSnapshot()
  const trackerOnlySnapshot = (base) => ({
    ...base,
    capturedAt: new Date().toISOString(),
    tableWrites: tracker.getDuckdbTableWriteTrackerSnapshot(dirtyTokens.projectTransferTargetStateTrackedTables),
  })
  const pair = async (write) => {
    const before = await snapshot()
    await write()
    return {after: await snapshot(), before}
  }

  await database.run("INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode) VALUES ('target-provider', 'openai', 'Target Provider', TRUE, 'none')")
  await database.run("INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled) VALUES ('target-model', 'target-provider', 'target-model-name', 'target-remote', 'Target Model', 'manual', TRUE)")
  await database.run("INSERT INTO app.project (id, name, model_id) VALUES ('target-project', 'Target Project', 'target-model')")
  await database.run("INSERT INTO app.article (id, article_title) VALUES ('target-article', 'Target Article')")
  await database.run("INSERT INTO app.prompt (id, original_text) VALUES ('target-prompt', 'Include?'), ('editable-prompt', 'Exclude?')")
  await database.run("INSERT INTO app.article (id, article_title) VALUES ('editable-article', 'Editable Article')")
  await database.run("INSERT INTO app.import_route (id, route) VALUES ('target-route', 'pubmed:target')")
  await database.run("INSERT INTO app.project_article (id, project_id, article_id) VALUES ('target-project-article', 'target-project', 'target-article')")
  await database.run("INSERT INTO app.judgment (id, article_id, prompt_id, model_id) VALUES ('target-judgment', 'target-article', 'target-prompt', 'target-model')")
  await service.initializeTargetStateCoverage()

  const surfaceWrites = {}
  const now = new Date('2026-10-15T12:00:00.000Z')

  surfaceWrites.project = await pair(() => database.run("UPDATE app.project SET archived = TRUE, updated_at = current_timestamp WHERE id = 'target-project'"))
  surfaceWrites.article = await pair(() => database.transaction(async (tx) => {
    await tx.run("INSERT INTO app.article (id, article_title, doi, created_at, updated_at) VALUES ('imported-article', 'Imported Article', '10.1000/imported', current_timestamp, current_timestamp) ON CONFLICT (id) DO NOTHING")
  }))
  surfaceWrites.articleIdentifier = await pair(() => database.transactionBackground(async (tx) => {
    await tx.run("INSERT INTO app.article_identifier (id, article_id, kind, normalized_value, source) VALUES ('target-identifier', 'target-article', 'doi', '10.1000/target', 'import')")
  }))
  surfaceWrites.importRoute = await pair(() => database.runBackground("UPDATE app.import_route SET active = FALSE, updated_at = current_timestamp WHERE id = 'target-route'"))
  surfaceWrites.projectImportRoute = await pair(() => database.run("INSERT INTO app.project_import_route (id, project_id, import_route_id) VALUES ('target-project-route', 'target-project', 'target-route')"))
  surfaceWrites.projectArticle = await pair(() => database.transaction(async (tx) => {
    await tx.run("DELETE FROM app.project_article WHERE project_id = 'target-project' AND article_id = 'target-article'")
  }))
  surfaceWrites.prompt = await pair(() => database.run("UPDATE app.prompt SET content_hash = 'edited-hash', updated_at = current_timestamp WHERE id = 'editable-prompt'"))
  surfaceWrites.projectPrompt = await pair(() => database.transaction(async (tx) => {
    await tx.run("INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, archived, enabled) VALUES ('target-project-prompt', 'target-project', 'target-prompt', 0, FALSE, TRUE)")
  }))
  surfaceWrites.judgment = await pair(() => database.appendJudgments([{
    answeredOriginal: 'yes',
    answeredOriginalAsArray: ['yes'],
    articleId: 'target-article',
    chunkingStrategy: null,
    confidenceOriginal: 0.9,
    createdAt: now,
    explanation: 'Judge completion',
    id: 'appended-judgment',
    isAnswered: true,
    modelId: 'target-model',
    projectId: 'target-project',
    promptId: 'target-prompt',
    quotes: [],
    snapshotProjectId: null,
    snapshotProjectModelName: null,
    systemPromptVariant: 'screening_v1',
    updatedAt: now,
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useMetadata: false,
    useTitle: true,
  }]))
  surfaceWrites.judgmentAssessment = await pair(() => database.queryJson("INSERT INTO app.judgment_assessment (id, judgment_id, assessment_is_correct) VALUES ('target-assessment', 'target-judgment', TRUE) RETURNING id"))
  surfaceWrites.humanJudgment = await pair(() => database.transaction(async (tx) => {
    await tx.queryJson("INSERT INTO app.judgment_human (id, article_id, prompt_id, project_id, is_answered, answer, comment) VALUES ('target-human', 'target-article', 'target-prompt', 'target-project', FALSE, NULL, NULL) RETURNING id, prompt_id AS promptId, is_answered AS isAnswered")
  }))
  surfaceWrites.humanJudgmentSummary = await pair(() => database.run("INSERT INTO app.judgment_human_summary (id, project_id, article_id, origin) VALUES ('target-summary', 'target-project', 'target-article', 'manual_override')"))
  surfaceWrites.review = await pair(() => database.run("INSERT INTO app.review (id, project_id, article_id, opened) VALUES ('target-review', 'target-project', 'target-article', TRUE)"))
  surfaceWrites.model = await pair(() => database.run("UPDATE app.model SET enabled = FALSE, updated_at = current_timestamp WHERE id = 'target-model'"))
  surfaceWrites.providerConnection = await pair(() => database.run("INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode) VALUES ('second-provider', 'openai', 'Second Provider', TRUE, 'none')"))
  surfaceWrites.importedSnapshotMarker = await pair(() => database.run("UPDATE app.provider_connection SET label = 'Imported Snapshot Provider', updated_at = current_timestamp WHERE id = 'second-provider'"))
  surfaceWrites.snapshotFingerprintInput = await pair(() => database.run("UPDATE app.model SET remote_model_id = 'changed-remote', updated_at = current_timestamp WHERE id = 'target-model'"))
  surfaceWrites.projectTransferHistory = await pair(() => database.run("INSERT INTO app.project_transfer_history (id, direction, package_fingerprint, schema_version, source_project_name, payload_counts_json, created_at) VALUES ('history-1', 'export', 'fingerprint-1', 2, 'Source Project', CAST('{}' AS JSON), current_timestamp)"))

  const scenarios = {}

  scenarios.noWrites = await pair(async () => {})
  scenarios.unrelatedWrites = await pair(async () => {
    await database.queryJson("SELECT count(*) AS count FROM app.article WHERE article_title <> 'article:all'")
    await database.run("INSERT INTO app.review_serving_dirty_work (dirty_work_id, project_id, scope_kind, scope_id, article_id, dirty_kind, source_partition, first_source_high_water_mark, latest_source_high_water_mark) SELECT 'dirty-' || id, 'target-project', 'article', 'article:all', id, 'article', 'article:all', 1, 1 FROM app.article WHERE id = 'target-article'")
    await database.run("UPDATE app.project_transfer_session SET updated_at = current_timestamp WHERE id = 'missing-session'")
    await database.transaction(async (tx) => {
      await tx.run('CREATE TEMP TABLE w1_staged_article AS SELECT id, article_title FROM app.article')
      await tx.run("INSERT INTO w1_staged_article SELECT id, article_title FROM app.article WHERE id = 'target-article'")
      await tx.run('DROP TABLE IF EXISTS w1_staged_article')
    })
  })

  const beforeCommittedTransaction = await snapshot()
  let insideCommittedTransaction = null
  await database.transaction(async (tx) => {
    await tx.run("UPDATE app.article SET article_title = 'Inside Transaction' WHERE id = 'editable-article'")
    insideCommittedTransaction = trackerOnlySnapshot(beforeCommittedTransaction)
  })
  scenarios.committedTransaction = {after: await snapshot(), before: insideCommittedTransaction}

  const beforeRolledBackTransaction = await snapshot()
  let insideRolledBackTransaction = null
  await database.transaction(async (tx) => {
    await tx.run("UPDATE app.prompt SET original_text = 'Rolled back' WHERE id = 'editable-prompt'")
    insideRolledBackTransaction = trackerOnlySnapshot(beforeRolledBackTransaction)
    throw new Error('roll back on purpose')
  }).catch(() => undefined)
  scenarios.rolledBackTransaction = {after: await snapshot(), before: insideRolledBackTransaction}

  scenarios.attach = await pair(async () => {
    await database.run("ATTACH ':memory:' AS w1_scratch")
    await database.run('DETACH w1_scratch')
  })

  scenarios.recycle = await pair(async () => {
    await database.closeForReset()
  })

  const beforeClosedTracker = await snapshot()
  await database.closeForReset()
  scenarios.closedTracker = {after: trackerOnlySnapshot(beforeClosedTracker), before: beforeClosedTracker}

  scenarios.fileIdentityChange = await pair(async () => {
    await database.closeForReset()
    copyFileSync(process.env.DUCKDB_PATH, process.env.DUCKDB_PATH + '.replacement')
    renameSync(process.env.DUCKDB_PATH + '.replacement', process.env.DUCKDB_PATH)
  })

  const beforeSearchPath = await snapshot()
  await database.run("SET search_path = 'main'")
  const duringSearchPath = await snapshot()
  await database.closeForReset()
  scenarios.searchPathChanged = {after: duringSearchPath, before: beforeSearchPath}
  scenarios.afterSearchPathReopen = {after: await snapshot(), before: beforeSearchPath}

  const appTables = (await database.queryJson("SELECT 'app.' || table_name AS tableName FROM duckdb_tables() WHERE schema_name = 'app'")).map((row) => row.tableName)

  console.log(JSON.stringify({appTables, scenarios, surfaceWrites}))
`

const runTableWriteScript = (): TableWriteScriptResult => {
  const databaseRoot = mkdtempSync(join(tmpdir(), 'f2-project-transfer-table-writes-'))
  const result = globalThis.Bun.spawnSync(
    ['bun', '-e', `${tableWriteScriptBody}\nawait getAppDatabaseService().close()`],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '39991',
        DUCKDB_PATH: join(databaseRoot, 'table-writes.duckdb'),
        SERVER_ROLE: 'dev-single',
        VITE_PORT: '39992',
      },
    },
  )

  try {
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString() || result.stdout.toString() || 'Table write script failed')
    }

    return JSON.parse(getLastJsonLine(result.stdout.toString())) as TableWriteScriptResult
  } finally {
    rmSync(databaseRoot, {force: true, recursive: true})
  }
}

let scriptResult: TableWriteScriptResult | null = null

const getScriptResult = () => {
  if (scriptResult === null) {
    throw new Error('Table write script did not run')
  }

  return scriptResult
}

const getDecision = (snapshotPair: SnapshotPair) => {
  return getProjectTransferDirtyTokenRevalidationDecision({
    analyzedTargetState: snapshotPair.before,
    currentTargetState: snapshotPair.after,
  })
}

const getTrackedSnapshot = (
  overrides?: Partial<ProjectTransferTargetStateDirtyTokenSnapshot>,
): ProjectTransferTargetStateDirtyTokenSnapshot => {
  return {
    capturedAt: '2026-10-15T10:00:00.000Z',
    coverage: {
      coverageCodeVersion: projectTransferTargetStateCoverageCodeVersion,
      coveredSurfaces: [],
      dependencyFingerprintAlgorithm: projectTransferDependencyFingerprintAlgorithm,
      dependencyFingerprintCodeVersion: projectTransferDependencyFingerprintCodeVersion,
      initializedAt: '2026-10-15T09:00:00.000Z',
      updatedAt: '2026-10-15T09:00:00.000Z',
    },
    globalUnknownToken: 0,
    tableWrites: {
      available: true,
      counters: Object.fromEntries(
        projectTransferTargetStateTrackedTables.map((table) => {
          return [table, 3]
        }),
      ),
      epoch: 'epoch-a',
    },
    tokens: Object.fromEntries(
      projectTransferTargetStateSafetySurfaces.map((surface) => {
        return [surface, 0]
      }),
    ),
    ...overrides,
  }
}

beforeAll(() => {
  scriptResult = runTableWriteScript()
})

test.each([...projectTransferTargetStateSafetySurfaces])(
  'a tracked write to the %s surface between analyze and commit requires full revalidation',
  (surface) => {
    const decision = getDecision(getScriptResult().surfaceWrites[surface])

    expect(decision.status).toBe('full_revalidation_required')
    expect(decision.changedSurfaces).toContain(surface)
    expect(Object.keys(getProjectTransferDirtyTokenStalePlanReasons(decision)).length).toBeGreaterThan(0)
  },
)

test('every tracked target-state table exists in the migrated app schema', () => {
  const appTables = new Set(getScriptResult().appTables)

  expect(
    projectTransferTargetStateTrackedTables.filter((table) => {
      return !appTables.has(table)
    }),
  ).toEqual([])
})

test('no writes, or writes only to untracked tables, keep incremental revalidation allowed', () => {
  const {scenarios} = getScriptResult()

  expect(getDecision(scenarios.noWrites)).toMatchObject({status: 'incremental_revalidation_allowed'})
  expect(getDecision(scenarios.unrelatedWrites)).toMatchObject({status: 'incremental_revalidation_allowed'})
  expect(getDecision(scenarios.recycle)).toMatchObject({status: 'incremental_revalidation_allowed'})
})

test('a snapshot taken inside an open transaction differs from the one after COMMIT and after ROLLBACK', () => {
  const {scenarios} = getScriptResult()

  expect(getDecision(scenarios.committedTransaction)).toMatchObject({
    changedSurfaces: ['article'],
    reason: 'target_state_table_write_changed',
    status: 'full_revalidation_required',
  })
  expect(getDecision(scenarios.rolledBackTransaction)).toMatchObject({
    changedSurfaces: ['prompt'],
    reason: 'target_state_table_write_changed',
    status: 'full_revalidation_required',
  })
})

test('ATTACH, a database file identity change, and a search-path change renew the tracker epoch', () => {
  const {scenarios} = getScriptResult()

  expect(getDecision(scenarios.attach)).toMatchObject({reason: 'target_state_table_write_epoch_changed'})
  expect(getDecision(scenarios.fileIdentityChange)).toMatchObject({reason: 'target_state_table_write_epoch_changed'})
  expect(getDecision(scenarios.searchPathChanged)).toMatchObject({reason: 'current_target_state_coverage_incomplete'})
  expect(getDecision(scenarios.afterSearchPathReopen)).toMatchObject({reason: 'target_state_table_write_epoch_changed'})
})

test('an unavailable tracker in either snapshot requires full revalidation', () => {
  const {scenarios} = getScriptResult()
  const unavailable = getTrackedSnapshot({
    tableWrites: {
      ...(getTrackedSnapshot().tableWrites as NonNullable<ProjectTransferTargetStateDirtyTokenSnapshot['tableWrites']>),
      available: false,
    },
  })

  expect(scenarios.closedTracker.after.tableWrites?.available).toBe(false)
  expect(getDecision(scenarios.closedTracker)).toMatchObject({reason: 'current_target_state_coverage_incomplete'})
  expect(
    getProjectTransferDirtyTokenRevalidationDecision({
      analyzedTargetState: unavailable,
      currentTargetState: getTrackedSnapshot(),
    }),
  ).toMatchObject({reason: 'analyzed_target_state_coverage_incomplete', status: 'full_revalidation_required'})
})

test('old plans without table-write data and v2 coverage snapshots require full revalidation', () => {
  const current = getTrackedSnapshot()
  const {tableWrites: _tableWrites, ...oldPlanTargetState} = getTrackedSnapshot()
  const v2Coverage = getTrackedSnapshot({
    coverage: {
      ...(current.coverage as NonNullable<ProjectTransferTargetStateDirtyTokenSnapshot['coverage']>),
      coverageCodeVersion: 'project-transfer-target-state-coverage-v2',
    },
  })
  const partialCounters = getTrackedSnapshot({
    tableWrites: {available: true, counters: {'app.article': 3}, epoch: 'epoch-a'},
  })

  expect(
    getProjectTransferDirtyTokenRevalidationDecision({
      analyzedTargetState: oldPlanTargetState,
      currentTargetState: current,
    }),
  ).toMatchObject({reason: 'analyzed_target_state_coverage_incomplete', status: 'full_revalidation_required'})
  expect(
    getProjectTransferDirtyTokenRevalidationDecision({analyzedTargetState: v2Coverage, currentTargetState: current}),
  ).toMatchObject({reason: 'target_state_coverage_version_changed', status: 'full_revalidation_required'})
  expect(
    getProjectTransferDirtyTokenRevalidationDecision({
      analyzedTargetState: partialCounters,
      currentTargetState: current,
    }),
  ).toMatchObject({reason: 'analyzed_target_state_coverage_incomplete', status: 'full_revalidation_required'})
  expect(
    getProjectTransferDirtyTokenRevalidationDecision({analyzedTargetState: current, currentTargetState: current}),
  ).toMatchObject({eligible: true, status: 'incremental_revalidation_allowed'})
})

test('table-write epoch and counter changes map to stale-plan reasons', () => {
  const analyzed = getTrackedSnapshot()
  const epochChanged = getProjectTransferDirtyTokenRevalidationDecision({
    analyzedTargetState: analyzed,
    currentTargetState: getTrackedSnapshot({
      tableWrites: {...(analyzed.tableWrites as NonNullable<typeof analyzed.tableWrites>), epoch: 'epoch-b'},
    }),
  })
  const judgmentChanged = getProjectTransferDirtyTokenRevalidationDecision({
    analyzedTargetState: analyzed,
    currentTargetState: getTrackedSnapshot({
      tableWrites: {
        ...(analyzed.tableWrites as NonNullable<typeof analyzed.tableWrites>),
        counters: {...analyzed.tableWrites?.counters, 'app.judgment': 4},
      },
    }),
  })

  expect(epochChanged).toMatchObject({changedSurfaces: [], reason: 'target_state_table_write_epoch_changed'})
  expect(Object.keys(getProjectTransferDirtyTokenStalePlanReasons(epochChanged)).sort()).toEqual([
    'assessment',
    'dependency',
    'duplicatePackageHistory',
    'humanReview',
    'judgment',
    'targetArticle',
    'targetProject',
    'targetPrompt',
    'targetRoute',
  ])
  expect(judgmentChanged).toMatchObject({changedSurfaces: ['judgment'], reason: 'target_state_table_write_changed'})
  expect(getProjectTransferDirtyTokenStalePlanReasons(judgmentChanged)).toEqual({
    judgment: [{reason: 'target_state_table_write_changed', targetStateSurfaces: ['judgment']}],
  })
})
