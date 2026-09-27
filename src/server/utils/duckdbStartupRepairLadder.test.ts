import {expect, test} from 'bun:test'

import {
  getDuckdbStartupRepairFirstRung,
  getEscalatedDuckdbStartupRepairRungs,
  getInitialDuckdbStartupRepairRungs,
} from './duckdbStartupRepairLadder.ts'

const sourceRecordTable = {dependencyTableKeys: [], tableKey: 'app.article_import_route_source_record'}
const importRouteTable = {dependencyTableKeys: [], tableKey: 'app.article_import_route'}
const judgmentDetailTable = {
  dependencyTableKeys: ['app.review_rebuild_request', 'app.review_rebuild_chunk_manifest'],
  tableKey: 'mart.review_article_judgment_detail_serving_v4',
}
const rebuildRequestTable = {dependencyTableKeys: [], tableKey: 'app.review_rebuild_request'}
const chunkManifestTable = {dependencyTableKeys: [], tableKey: 'app.review_rebuild_chunk_manifest'}

test('startup repair ladder starts at secondary indexes unless the probe demanded an inline primary key repair', () => {
  expect(getDuckdbStartupRepairFirstRung(null)).toBe('secondary-indexes')
  expect(getDuckdbStartupRepairFirstRung('custom-mutation-probe')).toBe('secondary-indexes')
  expect(getDuckdbStartupRepairFirstRung('inline-primary-key-repair')).toBe('table-rebuild')
})

test('startup repair ladder escalates only the table whose probe still failed', () => {
  const rungs = getInitialDuckdbStartupRepairRungs([sourceRecordTable, importRouteTable], 'secondary-indexes')

  expect(
    getEscalatedDuckdbStartupRepairRungs([sourceRecordTable, importRouteTable], rungs, [sourceRecordTable.tableKey]),
  ).toEqual({
    'app.article_import_route': 'secondary-indexes',
    'app.article_import_route_source_record': 'table-rebuild',
  })
})

test('startup repair ladder escalates every table when the failure names no table in the plan', () => {
  const rungs = getInitialDuckdbStartupRepairRungs([sourceRecordTable, importRouteTable], 'secondary-indexes')

  expect(getEscalatedDuckdbStartupRepairRungs([sourceRecordTable, importRouteTable], rungs, [])).toEqual({
    'app.article_import_route': 'table-rebuild',
    'app.article_import_route_source_record': 'table-rebuild',
  })
  expect(getEscalatedDuckdbStartupRepairRungs([sourceRecordTable, importRouteTable], rungs, ['app.unknown'])).toEqual({
    'app.article_import_route': 'table-rebuild',
    'app.article_import_route_source_record': 'table-rebuild',
  })
})

test('startup repair ladder climbs secondary indexes, table rebuild, all secondary indexes, then stops', () => {
  const tables = [sourceRecordTable]
  const firstRungs = getInitialDuckdbStartupRepairRungs(tables, 'secondary-indexes')
  const secondRungs = getEscalatedDuckdbStartupRepairRungs(tables, firstRungs, [sourceRecordTable.tableKey])
  const thirdRungs =
    secondRungs === null
      ? null
      : getEscalatedDuckdbStartupRepairRungs(tables, secondRungs, [sourceRecordTable.tableKey])

  expect(firstRungs).toEqual({'app.article_import_route_source_record': 'secondary-indexes'})
  expect(secondRungs).toEqual({'app.article_import_route_source_record': 'table-rebuild'})
  expect(thirdRungs).toEqual({'app.article_import_route_source_record': 'all-secondary-indexes'})
  expect(
    thirdRungs === null
      ? 'missing'
      : getEscalatedDuckdbStartupRepairRungs(tables, thirdRungs, [sourceRecordTable.tableKey]),
  ).toBeNull()
})

test('startup repair ladder rebuilds post-repair dependencies with the table that needs them', () => {
  const tables = [rebuildRequestTable, chunkManifestTable, judgmentDetailTable]
  const rungs = getInitialDuckdbStartupRepairRungs(tables, 'secondary-indexes')

  expect(rungs).toEqual({
    'app.review_rebuild_chunk_manifest': 'secondary-indexes',
    'app.review_rebuild_request': 'secondary-indexes',
    'mart.review_article_judgment_detail_serving_v4': 'secondary-indexes',
  })
  expect(getEscalatedDuckdbStartupRepairRungs(tables, rungs, [judgmentDetailTable.tableKey])).toEqual({
    'app.review_rebuild_chunk_manifest': 'table-rebuild',
    'app.review_rebuild_request': 'table-rebuild',
    'mart.review_article_judgment_detail_serving_v4': 'table-rebuild',
  })
  expect(getInitialDuckdbStartupRepairRungs(tables, 'table-rebuild')).toEqual({
    'app.review_rebuild_chunk_manifest': 'table-rebuild',
    'app.review_rebuild_request': 'table-rebuild',
    'mart.review_article_judgment_detail_serving_v4': 'table-rebuild',
  })
})

test('startup repair ladder keeps a dependency that already climbed past table rebuild', () => {
  const tables = [rebuildRequestTable, chunkManifestTable, judgmentDetailTable]

  expect(
    getEscalatedDuckdbStartupRepairRungs(
      tables,
      {
        'app.review_rebuild_chunk_manifest': 'all-secondary-indexes',
        'app.review_rebuild_request': 'secondary-indexes',
        'mart.review_article_judgment_detail_serving_v4': 'secondary-indexes',
      },
      [judgmentDetailTable.tableKey],
    ),
  ).toEqual({
    'app.review_rebuild_chunk_manifest': 'all-secondary-indexes',
    'app.review_rebuild_request': 'table-rebuild',
    'mart.review_article_judgment_detail_serving_v4': 'table-rebuild',
  })
})
