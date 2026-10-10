import {DuckDBInstance} from '@duckdb/node-api'
import {expect, test} from 'bun:test'

import {
  type ComparisonProjectSearchQuery,
  getComparisonProjectSearchArticleSourceSql,
  getComparisonProjectSearchPredicateSql,
  getComparisonProjectSearchQuery,
  getComparisonProjectSearchRequiresTokens,
  getComparisonProjectSearchTypoBudget,
} from './comparisonProjectJudgmentSearch.ts'

type SearchFixtureArticle = {
  articleExternalId?: string | null
  doi?: string | null
  id: string
  pubmedId?: string | null
  title: string
}

const fixtureArticles: SearchFixtureArticle[] = [
  {
    articleExternalId: '#4821',
    doi: '10.1056/NEJMoa2034577',
    id: 'metformin',
    pubmedId: '33301246',
    title: 'Metformin treatment in type 2 diabetes mellitus: a randomised trial',
  },
  {id: 'randomized', title: 'Randomized evaluation of SGLT2 inhibitors in heart failure'},
  {id: 'accents', title: 'Étude des effets de la metformine chez les patients âgés'},
  {id: 'chinese-full', title: '二甲双胍治疗2型糖尿病患者的随机对照研究'},
  {id: 'chinese-variant', title: '糖尿疾病患者的生活质量调查'},
  {id: 'japanese', title: '日本における糖尿病治療の現状'},
  {id: 'covid', title: 'COVID-19 vaccination outcomes in 2021'},
  {id: 'typo-title', title: 'Metfromin and cardiovascular risk'},
  {id: 'unrelated', title: 'Aspirin dosing for secondary prevention of stroke'},
]

const createSearchFixture = async () => {
  const duckdbInstance = await DuckDBInstance.create(':memory:')
  const connection = await duckdbInstance.connect()

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
      doi VARCHAR,
      pubmed_id VARCHAR,
      arxiv_id VARCHAR,
      biorxiv_id VARCHAR,
      medrxiv_id VARCHAR
    )
  `)
  await connection.run("INSERT INTO app.comparison_project_serving_generation VALUES ('comparison-project-1', 2)")
  await connection.run(`
    INSERT INTO mart.comparison_article_serving VALUES ${fixtureArticles
      .map((article) => {
        const literal = (value: string | null | undefined) => {
          return value === null || value === undefined ? 'NULL' : `'${value.replaceAll("'", "''")}'`
        }

        return `('comparison-project-1', 2, ${literal(article.id)}, ${literal(article.articleExternalId)}, ${literal(
          article.title,
        )}, ${literal(article.doi)}, ${literal(article.pubmedId)}, NULL, NULL, NULL)`
      })
      .join(', ')}
  `)
  await connection.run(`
    INSERT INTO mart.comparison_article_serving VALUES
      ('comparison-project-1', 1, 'retired-generation', NULL, 'Metformin in a retired generation', NULL, NULL, NULL, NULL, NULL),
      ('comparison-project-2', 2, 'other-project', NULL, 'Metformin in another comparison project', NULL, NULL, NULL, NULL, NULL)
  `)

  const searchArticleIds = async (searchText: string) => {
    const query = getComparisonProjectSearchQuery(searchText)

    if (query === null) {
      return null
    }

    const reader = await connection.runAndReadAll(`
      WITH active_generation AS (
        SELECT active_generation AS generation
        FROM app.comparison_project_serving_generation
        WHERE comparison_project_id = 'comparison-project-1'
          AND active_generation > 0
      )
      SELECT article.article_id AS articleId
      FROM ${getComparisonProjectSearchArticleSourceSql({
        articleTable: 'mart.comparison_article_serving',
        comparisonProjectIdSql: "'comparison-project-1'",
        generationSql: '(SELECT generation FROM active_generation)',
        query,
      })} article
      WHERE ${getComparisonProjectSearchPredicateSql(query, 'article')}
      ORDER BY article.article_id ASC
    `)

    return (reader.getRowObjectsJson() as Array<{articleId: string}>).map((row) => {
      return row.articleId
    })
  }

  return {
    close: () => {
      connection.closeSync()
      duckdbInstance.closeSync()
    },
    searchArticleIds,
  }
}

test('search typo budget follows word length and never applies to numbers', () => {
  expect(getComparisonProjectSearchTypoBudget('type')).toBe(0)
  expect(getComparisonProjectSearchTypoBudget('heart')).toBe(1)
  expect(getComparisonProjectSearchTypoBudget('diabetes')).toBe(1)
  expect(getComparisonProjectSearchTypoBudget('metformin')).toBe(2)
  expect(getComparisonProjectSearchTypoBudget('covid19')).toBe(0)
  expect(getComparisonProjectSearchTypoBudget('33301246')).toBe(0)
})

test('search query normalizes terms, dedupes them, caps the term count, and detects identifiers', () => {
  expect(getComparisonProjectSearchQuery('  Métformin   DIABETES metformin ')).toEqual({
    identifier: null,
    terms: [
      {kind: 'text', typoBudget: 2, value: 'metformin'},
      {kind: 'text', typoBudget: 1, value: 'diabetes'},
    ],
  })
  expect(getComparisonProjectSearchQuery('糖尿病 治疗')).toEqual({
    identifier: null,
    terms: [
      {allowedMissingBigrams: 0, bigrams: ['糖尿', '尿病'], kind: 'cjk', value: '糖尿病'},
      {allowedMissingBigrams: 0, bigrams: [], kind: 'cjk', value: '治疗'},
    ],
  })
  expect(getComparisonProjectSearchQuery('10.1056/NEJMoa2034577')).toEqual({
    identifier: '10.1056/nejmoa2034577',
    terms: [
      {kind: 'text', typoBudget: 0, value: '10'},
      {kind: 'text', typoBudget: 0, value: '1056'},
      {kind: 'text', typoBudget: 0, value: 'nejmoa2034577'},
    ],
  })
  expect(getComparisonProjectSearchQuery('#4821')?.identifier).toBe('4821')
  expect(getComparisonProjectSearchQuery('abc')?.identifier).toBeNull()
  expect(getComparisonProjectSearchQuery('a1')?.identifier).toBeNull()
  expect(getComparisonProjectSearchQuery('')).toBeNull()
  expect(getComparisonProjectSearchQuery('   ')).toBeNull()
  expect(getComparisonProjectSearchQuery('!!! ---')).toBeNull()
  expect(
    getComparisonProjectSearchQuery(['first term', 'ignored'])?.terms.map((term) => {
      return term.value
    }),
  ).toEqual(['first', 'term'])
  expect(getComparisonProjectSearchQuery('a b c d e f g h i j')?.terms).toHaveLength(8)
})

test('search source only tokenizes titles when a term has a typo budget', () => {
  const exactQuery = getComparisonProjectSearchQuery('type 2') as ComparisonProjectSearchQuery
  const fuzzyQuery = getComparisonProjectSearchQuery('diabetes') as ComparisonProjectSearchQuery
  const sourceParams = {
    articleTable: 'mart.comparison_article_serving',
    comparisonProjectIdSql: "'comparison-project-1'",
    generationSql: '(SELECT generation FROM active_generation)',
  }

  expect(getComparisonProjectSearchRequiresTokens(exactQuery)).toBe(false)
  expect(getComparisonProjectSearchRequiresTokens(fuzzyQuery)).toBe(true)
  expect(getComparisonProjectSearchArticleSourceSql({...sourceParams, query: exactQuery})).toContain(
    '[]::VARCHAR[] AS search_tokens',
  )
  expect(getComparisonProjectSearchArticleSourceSql({...sourceParams, query: fuzzyQuery})).toContain(
    'regexp_split_to_array(normalized_article.search_title',
  )
  expect(getComparisonProjectSearchPredicateSql(exactQuery, 'article')).not.toContain('damerau_levenshtein')
  expect(getComparisonProjectSearchPredicateSql(fuzzyQuery, 'article')).toContain('damerau_levenshtein')
  expect(getComparisonProjectSearchPredicateSql(fuzzyQuery, 'article')).toContain(
    "contains(article.search_title, 'diabetes')",
  )
})

test('search predicate escapes quotes in query terms', () => {
  const query = getComparisonProjectSearchQuery("o'brien") as ComparisonProjectSearchQuery

  expect(
    query.terms.map((term) => {
      return term.value
    }),
  ).toEqual(['o', 'brien'])
  expect(getComparisonProjectSearchPredicateSql(query, 'article')).toContain("'brien'")
  expect(getComparisonProjectSearchPredicateSql(query, 'article')).not.toContain("''")
})

test('search matches titles in the active generation by substring, prefix, accent-insensitive words', async () => {
  const fixture = await createSearchFixture()

  try {
    expect(await fixture.searchArticleIds('metformin')).toEqual(['accents', 'metformin', 'typo-title'])
    expect(await fixture.searchArticleIds('METFORMIN DIABETES')).toEqual(['metformin'])
    expect(await fixture.searchArticleIds('metformine')).toEqual(['accents', 'metformin', 'typo-title'])
    expect(await fixture.searchArticleIds('etude ages')).toEqual(['accents'])
    expect(await fixture.searchArticleIds('diab')).toEqual(['metformin'])
    expect(await fixture.searchArticleIds('sglt2')).toEqual(['randomized'])
    expect(await fixture.searchArticleIds('nothing-here')).toEqual([])
  } finally {
    fixture.close()
  }
})

test('search tolerates typos by word length but not in short words or numbers', async () => {
  const fixture = await createSearchFixture()

  try {
    expect(await fixture.searchArticleIds('metformn')).toEqual(['accents', 'metformin'])
    expect(await fixture.searchArticleIds('metfromin')).toEqual(['accents', 'metformin', 'typo-title'])
    expect(await fixture.searchArticleIds('diabetis')).toEqual(['metformin'])
    expect(await fixture.searchArticleIds('randomised')).toEqual(['metformin', 'randomized'])
    expect(await fixture.searchArticleIds('randomiz')).toEqual(['metformin', 'randomized'])
    expect(await fixture.searchArticleIds('aspirim strok')).toEqual(['unrelated'])
    expect(await fixture.searchArticleIds('typo')).toEqual([])
    expect(await fixture.searchArticleIds('2022')).toEqual([])
    expect(await fixture.searchArticleIds('covid19')).toEqual([])
    expect(await fixture.searchArticleIds('covid 19')).toEqual(['covid'])
    expect(await fixture.searchArticleIds('vaccinaton')).toEqual(['covid'])
  } finally {
    fixture.close()
  }
})

test('search matches Chinese and Japanese titles by substring and bigram coverage', async () => {
  const fixture = await createSearchFixture()

  try {
    expect(await fixture.searchArticleIds('糖尿病')).toEqual(['chinese-full', 'japanese'])
    expect(await fixture.searchArticleIds('二甲双胍 糖尿病')).toEqual(['chinese-full'])
    expect(await fixture.searchArticleIds('糖尿病患者')).toEqual(['chinese-full', 'chinese-variant'])
    expect(await fixture.searchArticleIds('糖尿病治疗')).toEqual(['chinese-full', 'japanese'])
    expect(await fixture.searchArticleIds('随机对照研究')).toEqual(['chinese-full'])
    expect(await fixture.searchArticleIds('生活')).toEqual(['chinese-variant'])
    expect(await fixture.searchArticleIds('糖尿病diabetes')).toEqual([])
    expect(await fixture.searchArticleIds('心脏')).toEqual([])
  } finally {
    fixture.close()
  }
})

test('search matches article identifiers with the whole query', async () => {
  const fixture = await createSearchFixture()

  try {
    expect(await fixture.searchArticleIds('10.1056/NEJMoa2034577')).toEqual(['metformin'])
    expect(await fixture.searchArticleIds('nejmoa2034577')).toEqual(['metformin'])
    expect(await fixture.searchArticleIds('33301246')).toEqual(['metformin'])
    expect(await fixture.searchArticleIds('#4821')).toEqual(['metformin'])
    expect(await fixture.searchArticleIds('4821')).toEqual(['metformin'])
    expect(await fixture.searchArticleIds('10.1056/other')).toEqual([])
  } finally {
    fixture.close()
  }
})
