import {existsSync, rmSync, unlinkSync} from 'node:fs'
import path from 'node:path'

import {expect, test} from 'bun:test'

const header = 'Title,Authors,Published Year,DOI,Ref,Covidence #'
const oldRows = {
  four: 'Study Four,"Park, Lee",2018,,104,#4',
  one: 'Study One,"Doe, Jane",2020,10.1000/one,101,#1',
  three: 'Study Three,"Lane, Kim",2019,,,#3',
  twinA: 'Twin Study,"Twin, Tom",2017,,,#5',
  twinB: 'Twin Study,"Twin, Tom",2017,,,#6',
  two: 'Study Two,"Roe, John",2021,,102,#2',
}
const newRows = {
  brandNew: 'Brand New Study,"New, Nina",2024,,,#70',
  four: 'Study Four,"Park, Lee",2018,,104,#40',
  one: oldRows.one,
  three: 'Study Three,"Lane, Kim",2019,,,#30',
  twin: 'Twin Study,"Twin, Tom",2017,,,#60',
  two: oldRows.two,
}
const getCsv = (rows: string[]) => {
  return `${[header, ...rows].join('\n')}\n`
}
const fixture = {
  newFiles: {
    all: getCsv(Object.values(newRows)),
    full_text: getCsv([newRows.one, newRows.three]),
    irrelevant: getCsv([newRows.two, newRows.four]),
  },
  oldFiles: {all: getCsv(Object.values(oldRows)), full_text: getCsv([oldRows.one]), irrelevant: getCsv([oldRows.two])},
}

type RouteLink = {articleId: string; matchTier: string | null; sameReview: string | null; sourceRecordKey: string}
type RouteLinks = Record<string, RouteLink>
type RematchSummary = {
  alreadySharedRecordCount: number
  ambiguousCount: number
  applyStarted: boolean
  blockers: unknown[]
  candidateCount: number
  deletedArticles: number
  dryRun: boolean
  projectsTouched: unknown[]
  remappedArticleCount: number
  remappedByTier: Record<string, number>
  unmatchedRecordCount: number
}
type RematchTestOutput = {
  afterApply: {
    answers: Record<string, string | null>
    articles: number
    dataSourceCursor: {baseImportRoute?: string}
    deltaCounts: Record<string, number>
    merges: Array<{deleted: boolean; matchTier: string}>
    orphanDuplicates: number
    projectArticles: number
    projectArticlesOutsideBase: number
    summaries: number
    targetAnswer: string | null
  }
  afterDryRun: {articles: number; summaries: number}
  afterSecondRun: {articles: number; links: RouteLinks; summaries: number}
  analysis: {
    matchSummary: {ambiguous: Array<Record<string, unknown>>} & Record<string, unknown>
    strongIdentifierRecordCount: number
    suggestedBaseImportRoute: Record<string, unknown> | null
  }
  applied: RematchSummary
  articlesAfterDuplicate: number
  articlesAfterOld: number
  articlesAfterSameReview: number
  before: {articles: number; projectArticles: number; summaries: number}
  deltaCountsBeforeApply: Record<string, number>
  dryRun: RematchSummary
  duplicateLinksAfter: RouteLinks
  duplicateLinksBefore: RouteLinks
  oldLinks: RouteLinks
  sameReviewAnswers: Record<string, string | null>
  sameReviewLinks: RouteLinks
  secondRun: RematchSummary
}

const getRouteLink = (links: RouteLinks, key: string) => {
  const link = links[key]

  if (!link) {
    throw new Error(`Missing route link ${key}`)
  }

  return link
}

const script = String.raw`
  const [{migrateDuckdb}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}, {getAppDatabaseService}, covidenceImportService, {getRunningCovidenceRematchApply, runCovidenceRematch}] = await Promise.all([
    import('./src/db/migrateDuckdb.ts'),
    import('./src/server/utils/duckdbService.ts'),
    import('./src/server/utils/serverRuntimeRole.ts'),
    import('./src/server/services/appDatabaseService.ts'),
    import('./src/server/services/covidenceImportService.ts'),
    import('./src/server/services/covidenceRematchService.ts'),
  ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()
  await migrateDuckdb()

  const fixture = JSON.parse(process.env.COVIDENCE_REMATCH_FIXTURE)
  const ids = JSON.parse(process.env.COVIDENCE_REMATCH_IDS)
  const database = getAppDatabaseService()
  const routeOf = (datasourceId) => 'covidence:' + datasourceId
  const storeConfig = async (datasourceId, files, baseImportRoute) => {
    const storedFiles = await covidenceImportService.storeCovidencePackageFiles({
      datasourceId,
      files: Object.entries(files).map(([fileRole, content]) => {
        return {file: new File([content], fileRole + '.csv', {type: 'text/csv'}), fileRole}
      }),
    })

    return covidenceImportService.buildCovidencePackageConfig({baseImportRoute, files: storedFiles, mode: 'title_abstract'})
  }
  const insertDataSource = async (datasourceId, title, config) => {
    await database.run(
      'INSERT INTO app.data_source (id, title, description, import_route, cursor) VALUES (' +
        [datasourceId, title, null, routeOf(datasourceId), covidenceImportService.getCovidencePackageCursor(config)]
          .map((value) => (value === null ? 'NULL' : "'" + String(value).replaceAll("'", "''") + "'"))
          .join(', ') +
        ')',
    )
  }
  const importPackage = async (datasourceId, config, projectId) => {
    await database.transaction(async (tx) => {
      const importRoute = routeOf(datasourceId)
      await covidenceImportService.importCovidencePackageFromConfig({config, datasourceId, importRoute, tx})
      if (projectId) {
        await covidenceImportService.seedCovidenceHumanJudgmentsFromConfig({config, importRoute, projectId, tx})
      }
    })
  }
  const count = async (sql) => Number((await database.queryJson(sql))[0].count)
  const articleCount = () => count('SELECT COUNT(*) AS count FROM app.article')
  const routeLinks = async (datasourceId) => {
    const rows = await database.queryJson(
      "SELECT sr.source_record_key AS sourceRecordKey, sr.article_id AS articleId, json_extract_string(sr.match_metadata, '$.covidenceSameReview.matchTier') AS matchTier, CAST(json_extract(sr.match_metadata, '$.covidenceSameReview') AS VARCHAR) AS sameReview FROM app.article_import_route_source_record sr INNER JOIN app.import_route ir ON ir.id = sr.import_route_id WHERE ir.route = '" + routeOf(datasourceId) + "' ORDER BY sr.source_record_key",
    )
    return Object.fromEntries(rows.map((row) => [row.sourceRecordKey, row]))
  }
  const humanAnswersByKey = async (projectId, datasourceId) => {
    const rows = await database.queryJson(
      "SELECT sr.source_record_key AS sourceRecordKey, jhs.answer FROM app.judgment_human_summary jhs INNER JOIN app.article_import_route_source_record sr ON sr.article_id = jhs.article_id INNER JOIN app.import_route ir ON ir.id = sr.import_route_id AND ir.route = '" + routeOf(datasourceId) + "' WHERE jhs.project_id = '" + projectId + "' ORDER BY sr.source_record_key",
    )
    return Object.fromEntries(rows.map((row) => [row.sourceRecordKey, row.answer]))
  }

  await database.run(
    "INSERT INTO app.provider_connection (id, label, provider_kind, enabled) VALUES ('pc-rematch', 'Rematch provider', 'openai-compatible', TRUE); " +
      "INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, enabled) VALUES ('model-rematch', 'pc-rematch', 'gpt-rematch', 'gpt-rematch', TRUE)",
  )

  const oldConfig = await storeConfig(ids.old, fixture.oldFiles, null)
  await insertDataSource(ids.old, 'Old export', oldConfig)
  await importPackage(ids.old, oldConfig, null)
  const oldLinks = await routeLinks(ids.old)
  const articlesAfterOld = await articleCount()

  const analysisConfig = await storeConfig(ids.sameReview, fixture.newFiles, null)
  const analysis = await covidenceImportService.getCovidenceSameReviewAnalysis({
    baseImportRoute: null,
    candidates: covidenceImportService.getCovidencePackageRowsFromConfig(analysisConfig).candidates,
  })

  const sameReviewConfig = await storeConfig(ids.sameReview, fixture.newFiles, routeOf(ids.old))
  await insertDataSource(ids.sameReview, 'New export with base', sameReviewConfig)
  await database.run("INSERT INTO app.import_route (id, route, name, active) VALUES ('route-same-review', '" + routeOf(ids.sameReview) + "', 'same review', TRUE)")
  const sameReviewProject = await covidenceImportService.getOrCreateCovidenceProject({importRoute: routeOf(ids.sameReview), mode: 'title_abstract', title: 'Same review project'})
  await importPackage(ids.sameReview, sameReviewConfig, sameReviewProject.id)
  const articlesAfterSameReview = await articleCount()
  const sameReviewLinks = await routeLinks(ids.sameReview)
  const sameReviewAnswers = await humanAnswersByKey(sameReviewProject.id, ids.sameReview)

  const duplicateConfig = await storeConfig(ids.duplicate, fixture.newFiles, null)
  await insertDataSource(ids.duplicate, 'New export without base', duplicateConfig)
  await database.run("INSERT INTO app.import_route (id, route, name, active) VALUES ('route-duplicate', '" + routeOf(ids.duplicate) + "', 'duplicate', TRUE)")
  const duplicateProject = await covidenceImportService.getOrCreateCovidenceProject({importRoute: routeOf(ids.duplicate), mode: 'title_abstract', title: 'Duplicate project'})
  await importPackage(ids.duplicate, duplicateConfig, duplicateProject.id)
  const articlesAfterDuplicate = await articleCount()
  const duplicateLinksBefore = await routeLinks(ids.duplicate)
  const conflictTargetId = oldLinks['covidence:#2'].articleId
  await database.run(
    "INSERT INTO app.project_article (id, project_id, article_id, imported_from_project_id) VALUES ('pa-conflict', '" + duplicateProject.id + "', '" + conflictTargetId + "', NULL); " +
      "INSERT INTO app.judgment_human_summary (id, project_id, article_id, answer, origin, updated_at) VALUES ('jhs-conflict', '" + duplicateProject.id + "', '" + conflictTargetId + "', 'yes', 'manual_override', now())",
  )
  const summaryCount = () => count("SELECT COUNT(*) AS count FROM app.judgment_human_summary WHERE project_id = '" + duplicateProject.id + "'")
  const projectArticleCount = () => count("SELECT COUNT(*) AS count FROM app.project_article WHERE project_id = '" + duplicateProject.id + "'")
  const before = {articles: articlesAfterDuplicate, projectArticles: await projectArticleCount(), summaries: await summaryCount()}

  const deltaCounts = async () => {
    const rows = await database.queryJson(
      "SELECT 'change' AS ledger, change_kind AS changeKind, COUNT(*) AS count FROM app.review_change_delta GROUP BY ALL UNION ALL SELECT 'import' AS ledger, change_kind AS changeKind, COUNT(*) AS count FROM app.import_run_article_delta GROUP BY ALL",
    )
    return Object.fromEntries(rows.map((row) => [row.ledger + ':' + row.changeKind, Number(row.count)]))
  }
  const deltaCountsBeforeApply = await deltaCounts()
  const dryRun = await runCovidenceRematch({baseImportRoute: routeOf(ids.old), dataSourceId: ids.duplicate, dryRun: true})
  const afterDryRun = {articles: await articleCount(), summaries: await summaryCount()}
  const appliedSummary = await runCovidenceRematch({baseImportRoute: routeOf(ids.old), dataSourceId: ids.duplicate, dryRun: false})
  const applied = {...appliedSummary, ...(await getRunningCovidenceRematchApply(ids.duplicate))}
  const duplicateLinksAfter = await routeLinks(ids.duplicate)
  const afterApply = {
    answers: await humanAnswersByKey(duplicateProject.id, ids.duplicate),
    articles: await articleCount(),
    merges: await database.queryJson('SELECT match_tier AS matchTier, article_deleted_at IS NOT NULL AS deleted FROM app.article_merge ORDER BY match_tier'),
    orphanDuplicates: await count(
      'SELECT COUNT(*) AS count FROM app.article WHERE id IN (' +
        ['covidence:#2', 'covidence:#30', 'covidence:#40'].map((key) => "'" + duplicateLinksBefore[key].articleId + "'").join(', ') +
        ')',
    ),
    projectArticles: await projectArticleCount(),
    projectArticlesOutsideBase: await count(
      "SELECT COUNT(*) AS count FROM app.project_article pa WHERE pa.project_id = '" + duplicateProject.id + "' AND pa.article_id NOT IN (SELECT article_id FROM app.article_import_route_source_record sr INNER JOIN app.import_route ir ON ir.id = sr.import_route_id WHERE ir.route = '" + routeOf(ids.old) + "')",
    ),
    summaries: await summaryCount(),
    targetAnswer: (await database.queryJson("SELECT answer FROM app.judgment_human_summary WHERE project_id = '" + duplicateProject.id + "' AND article_id = '" + conflictTargetId + "'"))[0]?.answer ?? null,
    dataSourceCursor: JSON.parse((await database.queryJson("SELECT cursor FROM app.data_source WHERE id = '" + ids.duplicate + "'"))[0].cursor),
    deltaCounts: await deltaCounts(),
  }
  const secondRunSummary = await runCovidenceRematch({baseImportRoute: routeOf(ids.old), dataSourceId: ids.duplicate, dryRun: false})
  const secondRun = {...secondRunSummary, ...(await getRunningCovidenceRematchApply(ids.duplicate))}
  const afterSecondRun = {articles: await articleCount(), links: await routeLinks(ids.duplicate), summaries: await summaryCount()}

  console.log(JSON.stringify({
    afterApply, afterDryRun, afterSecondRun, deltaCountsBeforeApply, analysis, applied, articlesAfterDuplicate, articlesAfterOld, articlesAfterSameReview, before,
    duplicateLinksAfter, duplicateLinksBefore, dryRun, oldLinks, sameReviewAnswers, sameReviewLinks, secondRun,
  }))
  Object.values(ids).map((datasourceId) => covidenceImportService.deleteCovidencePackageFiles(datasourceId))
  await database.close()
`

test('Covidence same-review import reuses base articles and rematch repairs a duplicate route idempotently', () => {
  const runId = Date.now()
  const duckdbPath = `/tmp/f1-covidence-rematch-${runId}.duckdb`
  const ids = {
    duplicate: `covidence-rematch-dup-${runId}`,
    old: `covidence-rematch-old-${runId}`,
    sameReview: `covidence-rematch-same-${runId}`,
  }
  const result = globalThis.Bun.spawnSync(['bun', '-e', script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      API_SERVER_PORT: '39971',
      COVIDENCE_REMATCH_FIXTURE: JSON.stringify(fixture),
      COVIDENCE_REMATCH_IDS: JSON.stringify(ids),
      DUCKDB_PATH: duckdbPath,
      SERVER_ROLE: 'dev-single',
      VITE_PORT: '39972',
    },
  })

  try {
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString().slice(-4000) || 'Covidence rematch subprocess failed')
    }

    const parsed = JSON.parse(result.stdout.toString().trim().split('\n').at(-1) ?? '{}') as RematchTestOutput
    const oldArticleId = (key: string) => {
      return getRouteLink(parsed.oldLinks, key).articleId
    }

    expect(parsed.articlesAfterOld).toBe(6)
    expect(parsed.analysis.suggestedBaseImportRoute).toMatchObject({
      dataSourceTitle: 'Old export',
      importRoute: `covidence:${ids.old}`,
      matchedRecordCount: 1,
      share: 1,
    })
    expect(parsed.analysis.strongIdentifierRecordCount).toBe(1)
    expect(parsed.analysis.matchSummary).toMatchObject({
      ambiguousCount: 1,
      baseImportRoute: `covidence:${ids.old}`,
      countsByTier: {covidence_id: 1, reference_id: 1, strong_identifier: 1, title_year_first_author: 1},
      unmatchedCount: 1,
    })
    expect(parsed.analysis.matchSummary.ambiguous[0]).toMatchObject({
      articleIds: [oldArticleId('covidence:#5'), oldArticleId('covidence:#6')].sort(),
      articleKey: 'covidence:#60',
      matchTier: 'title_year_first_author',
    })

    expect(parsed.articlesAfterSameReview).toBe(7)
    expect(Object.keys(parsed.sameReviewLinks).sort()).toEqual([
      'covidence:#1',
      'covidence:#2',
      'covidence:#30',
      'covidence:#40',
      'covidence:#70',
    ])
    expect(getRouteLink(parsed.sameReviewLinks, 'covidence:#1')).toMatchObject({
      articleId: oldArticleId('covidence:#1'),
      matchTier: 'strong_identifier',
    })
    expect(getRouteLink(parsed.sameReviewLinks, 'covidence:#2')).toMatchObject({
      articleId: oldArticleId('covidence:#2'),
      matchTier: 'covidence_id',
    })
    expect(getRouteLink(parsed.sameReviewLinks, 'covidence:#30')).toMatchObject({
      articleId: oldArticleId('covidence:#3'),
      matchTier: 'title_year_first_author',
    })
    expect(getRouteLink(parsed.sameReviewLinks, 'covidence:#40')).toMatchObject({
      articleId: oldArticleId('covidence:#4'),
      matchTier: 'reference_id',
    })
    expect(getRouteLink(parsed.sameReviewLinks, 'covidence:#70').matchTier).toBeNull()
    expect(parsed.sameReviewAnswers).toEqual({
      'covidence:#1': 'yes',
      'covidence:#2': 'no',
      'covidence:#30': 'yes',
      'covidence:#40': 'no',
      'covidence:#70': null,
    })

    expect(parsed.articlesAfterDuplicate).toBe(12)
    expect(
      Object.values(parsed.duplicateLinksBefore).map((link) => {
        return link.sameReview
      }),
    ).toEqual([null, null, null, null, null, null])
    expect(getRouteLink(parsed.duplicateLinksBefore, 'covidence:#1').articleId).toBe(oldArticleId('covidence:#1'))

    expect(parsed.before).toEqual({articles: 12, projectArticles: 7, summaries: 7})
    expect(parsed.dryRun).toMatchObject({
      alreadySharedRecordCount: 1,
      ambiguousCount: 1,
      blockers: [],
      applyStarted: false,
      candidateCount: 6,
      dryRun: true,
      remappedArticleCount: 3,
      remappedByTier: {covidence_id: 1, reference_id: 1, strong_identifier: 0, title_year_first_author: 1},
      unmatchedRecordCount: 1,
    })
    expect(parsed.dryRun.projectsTouched).toHaveLength(1)
    expect(parsed.dryRun.projectsTouched[0]).toMatchObject({
      humanPromptRows: 0,
      humanSummaryConflicts: 1,
      humanSummaryRows: 3,
      projectArticles: 3,
    })
    expect(parsed.afterDryRun).toEqual({articles: 12, summaries: 7})

    expect(parsed.applied).toMatchObject({
      applyStarted: true,
      deletedArticles: 3,
      dryRun: false,
      remappedArticleCount: 3,
    })
    expect(getRouteLink(parsed.duplicateLinksAfter, 'covidence:#2')).toMatchObject({
      articleId: oldArticleId('covidence:#2'),
      matchTier: 'covidence_id',
    })
    expect(getRouteLink(parsed.duplicateLinksAfter, 'covidence:#30').articleId).toBe(oldArticleId('covidence:#3'))
    expect(getRouteLink(parsed.duplicateLinksAfter, 'covidence:#40').articleId).toBe(oldArticleId('covidence:#4'))
    expect(getRouteLink(parsed.duplicateLinksAfter, 'covidence:#60').articleId).toBe(
      getRouteLink(parsed.duplicateLinksBefore, 'covidence:#60').articleId,
    )
    expect(parsed.afterApply).toMatchObject({
      answers: {
        'covidence:#1': 'yes',
        'covidence:#2': 'no',
        'covidence:#30': 'yes',
        'covidence:#40': 'no',
        'covidence:#60': null,
        'covidence:#70': null,
      },
      articles: 9,
      merges: [
        {deleted: true, matchTier: 'covidence_id'},
        {deleted: true, matchTier: 'reference_id'},
        {deleted: true, matchTier: 'title_year_first_author'},
      ],
      orphanDuplicates: 0,
      projectArticles: 6,
      projectArticlesOutsideBase: 2,
      summaries: 6,
      targetAnswer: 'no',
    })
    expect(parsed.afterApply.dataSourceCursor.baseImportRoute).toBe(`covidence:${ids.old}`)
    expect(
      Object.fromEntries(
        Object.entries(parsed.afterApply.deltaCounts)
          .map(([key, value]) => {
            return [key, value - (parsed.deltaCountsBeforeApply[key] ?? 0)]
          })
          .filter(([, value]) => {
            return value !== 0
          }),
      ),
    ).toEqual({
      'change:judgment.human.updated': 6,
      'change:projectScope.article.added': 2,
      'change:projectScope.article.removed': 3,
      'import:importRoute.article.added': 3,
      'import:importRoute.article.removed': 3,
    })

    expect(parsed.secondRun).toMatchObject({deletedArticles: 0, remappedArticleCount: 0, ambiguousCount: 1})
    expect(parsed.afterSecondRun.articles).toBe(9)
    expect(parsed.afterSecondRun.summaries).toBe(6)
    expect(parsed.afterSecondRun.links).toEqual(parsed.duplicateLinksAfter)
  } finally {
    Object.values(ids).map((datasourceId) => {
      rmSync(path.join(process.cwd(), 'assets/covidence_imports', datasourceId), {force: true, recursive: true})

      return datasourceId
    })
    ;[
      duckdbPath,
      `${duckdbPath}.wal`,
      `${duckdbPath}.duckdb-owner.lock`,
      `${duckdbPath}.duckdb-owner.history.json`,
    ].map((filePath) => {
      if (existsSync(filePath)) {
        unlinkSync(filePath)
      }

      return filePath
    })
  }
}, 180_000)
