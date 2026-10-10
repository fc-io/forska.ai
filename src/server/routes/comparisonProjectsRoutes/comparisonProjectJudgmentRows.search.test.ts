import {DuckDBInstance} from '@duckdb/node-api'
import {expect, test} from 'bun:test'

import {
  getComparisonProjectServingJudgmentCount,
  getComparisonProjectServingJudgmentFilteredCountSql,
  getComparisonProjectServingJudgmentRowsPage,
  getComparisonProjectServingMemberSql,
} from './comparisonProjectJudgmentRows.ts'

const createServingFixture = async () => {
  const duckdbInstance = await DuckDBInstance.create(':memory:')
  const connection = await duckdbInstance.connect()
  const statements: string[] = []
  const queryRunner = {
    queryJson: async <T>(statement: string): Promise<T[]> => {
      statements.push(statement)
      const reader = await connection.runAndReadAll(statement)

      return reader.getRowObjectsJson() as T[]
    },
  }

  await connection.run('CREATE SCHEMA app')
  await connection.run('CREATE SCHEMA mart')
  await connection.run(
    'CREATE TABLE app.comparison_project_serving_generation (comparison_project_id VARCHAR, active_generation BIGINT)',
  )
  await connection.run(`
    CREATE TABLE mart.comparison_article_serving (
      comparison_project_id VARCHAR,
      generation BIGINT,
      article_id VARCHAR,
      article_external_id VARCHAR,
      article_title VARCHAR,
      article_summary VARCHAR,
      article_created_at TIMESTAMPTZ,
      article_category VARCHAR,
      doi VARCHAR,
      pubmed_id VARCHAR,
      arxiv_id VARCHAR,
      biorxiv_id VARCHAR,
      medrxiv_id VARCHAR,
      has_conflict BOOLEAN,
      row_sort_created_at TIMESTAMPTZ,
      row_sort_title VARCHAR,
      row_sort_article_id VARCHAR,
      passes_row_filter_all BOOLEAN,
      passes_row_filter_fully_answered BOOLEAN,
      passes_difference_filter_all BOOLEAN
    )
  `)
  await connection.run(`
    CREATE TABLE mart.comparison_cell_serving (
      comparison_project_id VARCHAR,
      generation BIGINT,
      article_id VARCHAR,
      column_id VARCHAR,
      column_order INTEGER,
      display_answer VARCHAR
    )
  `)
  await connection.run(`
    CREATE TABLE mart.comparison_filter_stats (
      comparison_project_id VARCHAR,
      generation BIGINT,
      row_filter VARCHAR,
      difference_filter VARCHAR,
      article_category_filter VARCHAR,
      total_count BIGINT
    )
  `)
  await connection.run("INSERT INTO app.comparison_project_serving_generation VALUES ('comparison-project-1', 1)")
  await connection.run(`
    INSERT INTO mart.comparison_article_serving
    SELECT
      'comparison-project-1',
      1,
      article_id,
      external_id,
      title,
      NULL,
      created_at,
      category,
      doi,
      NULL,
      NULL,
      NULL,
      NULL,
      FALSE,
      created_at,
      lower(title),
      article_id,
      TRUE,
      fully_answered,
      TRUE
    FROM (
      VALUES
        ('article-1', '#101', 'Metformin treatment in type 2 diabetes', TIMESTAMPTZ '2026-04-03 10:00:00+00', 'non_chinese', '10.1000/metformin', TRUE),
        ('article-2', '#102', 'Metformin and cardiovascular outcomes', TIMESTAMPTZ '2026-04-02 10:00:00+00', 'non_chinese', NULL, FALSE),
        ('article-3', '#103', '二甲双胍治疗糖尿病的研究', TIMESTAMPTZ '2026-04-01 10:00:00+00', 'chinese', NULL, TRUE),
        ('article-4', '#104', 'Aspirin for stroke prevention', TIMESTAMPTZ '2026-03-31 10:00:00+00', 'non_chinese', NULL, TRUE)
    ) AS seeded(article_id, external_id, title, created_at, category, doi, fully_answered)
  `)
  await connection.run(`
    INSERT INTO mart.comparison_filter_stats VALUES ('comparison-project-1', 1, 'all', 'all', 'all', 4)
  `)

  return {
    close: () => {
      connection.closeSync()
      duckdbInstance.closeSync()
    },
    queryRunner,
    statements,
  }
}

test('serving member and count SQL stay byte-identical without a search', () => {
  const baseParams = {comparisonProjectId: 'comparison-project-1', differenceFilter: 'all', rowFilter: 'all'} as const

  expect(getComparisonProjectServingMemberSql({...baseParams, limit: 10})).toBe(
    getComparisonProjectServingMemberSql({...baseParams, limit: 10, searchText: '   '}),
  )
  expect(getComparisonProjectServingMemberSql({...baseParams, limit: 10})).toContain(
    'FROM mart.comparison_article_serving article',
  )
  expect(getComparisonProjectServingJudgmentFilteredCountSql({...baseParams, conflictResolutionFilter: []})).toBe(
    getComparisonProjectServingJudgmentFilteredCountSql({...baseParams, conflictResolutionFilter: [], searchText: ''}),
  )
})

test('serving page filters rows by fuzzy title search and keeps the existing sort and cursor', async () => {
  const fixture = await createServingFixture()

  try {
    const firstPage = await getComparisonProjectServingJudgmentRowsPage({
      comparisonProjectId: 'comparison-project-1',
      cursor: null,
      differenceFilter: 'all',
      limit: 1,
      queryRunner: fixture.queryRunner,
      rowFilter: 'all',
      searchText: 'metfromin',
    })

    expect(
      firstPage.rows.map((row) => {
        return row.id
      }),
    ).toEqual(['article-1'])
    expect(firstPage.nextCursor).not.toBeNull()

    const secondPage = await getComparisonProjectServingJudgmentRowsPage({
      comparisonProjectId: 'comparison-project-1',
      cursor: firstPage.nextCursor,
      differenceFilter: 'all',
      limit: 1,
      queryRunner: fixture.queryRunner,
      rowFilter: 'all',
      searchText: 'metfromin',
    })

    expect(
      secondPage.rows.map((row) => {
        return row.id
      }),
    ).toEqual(['article-2'])
    expect(secondPage.nextCursor).toBeNull()
  } finally {
    fixture.close()
  }
})

test('serving page combines the search with row and language filters', async () => {
  const fixture = await createServingFixture()

  try {
    const fullyAnsweredPage = await getComparisonProjectServingJudgmentRowsPage({
      comparisonProjectId: 'comparison-project-1',
      cursor: null,
      differenceFilter: 'all',
      limit: 10,
      queryRunner: fixture.queryRunner,
      rowFilter: 'fully-answered',
      searchText: 'metformin',
    })
    const chinesePage = await getComparisonProjectServingJudgmentRowsPage({
      articleCategoryFilter: ['chinese'],
      comparisonProjectId: 'comparison-project-1',
      cursor: null,
      differenceFilter: 'all',
      limit: 10,
      queryRunner: fixture.queryRunner,
      rowFilter: 'all',
      searchText: '糖尿病',
    })
    const doiPage = await getComparisonProjectServingJudgmentRowsPage({
      comparisonProjectId: 'comparison-project-1',
      cursor: null,
      differenceFilter: 'all',
      limit: 10,
      queryRunner: fixture.queryRunner,
      rowFilter: 'all',
      searchText: '10.1000/metformin',
    })

    expect(
      fullyAnsweredPage.rows.map((row) => {
        return row.id
      }),
    ).toEqual(['article-1'])
    expect(
      chinesePage.rows.map((row) => {
        return row.id
      }),
    ).toEqual(['article-3'])
    expect(
      doiPage.rows.map((row) => {
        return row.id
      }),
    ).toEqual(['article-1'])
  } finally {
    fixture.close()
  }
})

test('serving count bypasses precomputed stats when a search is active', async () => {
  const fixture = await createServingFixture()

  try {
    const unfilteredCount = await getComparisonProjectServingJudgmentCount({
      comparisonProjectId: 'comparison-project-1',
      differenceFilter: 'all',
      limit: 50,
      queryRunner: fixture.queryRunner,
      rowFilter: 'all',
      searchText: '',
    })
    const searchedCount = await getComparisonProjectServingJudgmentCount({
      comparisonProjectId: 'comparison-project-1',
      differenceFilter: 'all',
      limit: 50,
      queryRunner: fixture.queryRunner,
      rowFilter: 'all',
      searchText: 'metformin',
    })
    const emptyCount = await getComparisonProjectServingJudgmentCount({
      comparisonProjectId: 'comparison-project-1',
      differenceFilter: 'all',
      limit: 50,
      queryRunner: fixture.queryRunner,
      rowFilter: 'all',
      searchText: 'nothing matches this',
    })

    expect(unfilteredCount).toEqual({totalCount: 4, totalPages: 1})
    expect(fixture.statements[0]).toContain('mart.comparison_filter_stats')
    expect(searchedCount).toEqual({totalCount: 2, totalPages: 1})
    expect(fixture.statements[1]).toContain('COUNT(*)')
    expect(fixture.statements[1]).toContain('search_title')
    expect(emptyCount).toEqual({totalCount: 0, totalPages: 0})
  } finally {
    fixture.close()
  }
})
