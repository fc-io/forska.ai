import {DuckDBInstance} from '@duckdb/node-api'
import {expect, test} from 'bun:test'

import {
  getNormalizedReviewServingTitleSearchText,
  getReviewServingTitleSearchNormalizedTitleSql,
  getReviewServingTitleSearchSegmentsSql,
  getReviewServingTitleSearchSegmentTokensSql,
  getReviewServingTitleSearchTokens,
  reviewServingTitleSearchTokenizerVersion,
} from './reviewServingTitleSearchTokenizer.ts'

const sortTokens = (tokens: readonly string[]) => {
  return [...tokens].sort((left, right) => {
    return left < right ? -1 : left > right ? 1 : 0
  })
}

const getDuckdbTokens = async (titles: readonly string[]) => {
  const duckdbInstance = await DuckDBInstance.create(':memory:')
  const connection = await duckdbInstance.connect()

  try {
    await connection.run('CREATE TABLE title_source(title_index INTEGER, title VARCHAR)')
    await connection.run(
      `INSERT INTO title_source VALUES ${titles
        .map((title, index) => {
          return `(${index}, '${title.replaceAll("'", "''")}')`
        })
        .join(', ')}`,
    )

    const reader = await connection.runAndReadAll(`
      WITH normalized AS (
        SELECT
          title_index,
          ${getReviewServingTitleSearchNormalizedTitleSql('title')} AS normalized_title
        FROM title_source
      ), segmented AS (
        SELECT normalized.title_index, segment_rows.segment
        FROM normalized
        CROSS JOIN unnest(${getReviewServingTitleSearchSegmentsSql('normalized.normalized_title')}) AS segment_rows(segment)
        WHERE segment_rows.segment <> ''
      ), tokenized AS (
        SELECT DISTINCT segmented.title_index, token_rows.token
        FROM segmented
        CROSS JOIN unnest(${getReviewServingTitleSearchSegmentTokensSql('segmented.segment')}) AS token_rows(token)
        WHERE token_rows.token <> ''
      )
      SELECT title_index AS titleIndex, token
      FROM tokenized
      ORDER BY title_index ASC, token ASC
    `)
    const rows = reader.getRowObjectsJson() as Array<{titleIndex: number; token: string}>

    return titles.map((_, index) => {
      return sortTokens(
        rows
          .filter((row) => {
            return Number(row.titleIndex) === index
          })
          .map((row) => {
            return row.token
          }),
      )
    })
  } finally {
    connection.closeSync()
    duckdbInstance.closeSync()
  }
}

test('title search tokenizer version is bumped for the Unicode tokenizer', () => {
  expect(reviewServingTitleSearchTokenizerVersion).toBe('title-token-v2')
})

test('title search tokenizer keeps ASCII behaviour: lowercase words and digits split on punctuation', () => {
  expect(getReviewServingTitleSearchTokens('COVID-19 Heart_Failure: a study (2024)')).toEqual([
    'covid',
    '19',
    'heart',
    'failure',
    'a',
    'study',
    '2024',
  ])
  expect(getReviewServingTitleSearchTokens('Alpha Beta alpha')).toEqual(['alpha', 'beta'])
  expect(getReviewServingTitleSearchTokens(null)).toEqual([])
  expect(getReviewServingTitleSearchTokens('  --  ')).toEqual([])
})

test('title search tokenizer strips accents and keeps non-Latin letters as tokens', () => {
  expect(getReviewServingTitleSearchTokens('Ünïcode Åäö études')).toEqual(['unicode', 'aao', 'etudes'])
  expect(getReviewServingTitleSearchTokens('Ελληνικά Кириллица العربية')).toEqual(['ελληνικα', 'кириллица', 'العربية'])
  expect(getReviewServingTitleSearchTokens('İstanbul')).toEqual(['istanbul'])
})

test('title search tokenizer indexes CJK runs as characters plus bigrams', () => {
  expect(getReviewServingTitleSearchTokens('医院')).toEqual(['医', '院', '医院'])
  expect(getReviewServingTitleSearchTokens('医院管理')).toEqual(['医', '院', '管', '理', '医院', '院管', '管理'])
  expect(getReviewServingTitleSearchTokens('癌')).toEqual(['癌'])
  expect(getReviewServingTitleSearchTokens('日本語のテキスト')).toEqual([
    '日',
    '本',
    '語',
    'の',
    'テ',
    'キ',
    'ス',
    'ト',
    '日本',
    '本語',
    '語の',
    'のテ',
    'テキ',
    'キス',
    'スト',
  ])
  expect(getReviewServingTitleSearchTokens('병원 감염')).toEqual(['병', '원', '병원', '감', '염', '감염'])
})

test('title search tokenizer separates CJK runs from adjacent Latin text', () => {
  expect(getReviewServingTitleSearchTokens('COVID-19在医院: a 病院 study')).toEqual([
    'covid',
    '19',
    '在',
    '医',
    '院',
    '在医',
    '医院',
    'a',
    '病',
    '病院',
    'study',
  ])
})

test('title search query tokens are a prefix-compatible subset of indexed title tokens', () => {
  const titleTokens = new Set(getReviewServingTitleSearchTokens('Infection control in the 医院管理 setting'))

  getReviewServingTitleSearchTokens('医院').forEach((queryToken) => {
    expect(
      [...titleTokens].some((titleToken) => {
        return titleToken.startsWith(queryToken)
      }),
    ).toBe(true)
  })
  expect(
    getReviewServingTitleSearchTokens('病院').every((queryToken) => {
      return [...titleTokens].some((titleToken) => {
        return titleToken.startsWith(queryToken)
      })
    }),
  ).toBe(false)
})

test('title search normalization mirrors DuckDB lower(strip_accents())', () => {
  expect(getNormalizedReviewServingTitleSearchText('Crème BRÛLÉE')).toBe('creme brulee')
  expect(getNormalizedReviewServingTitleSearchText('ΣΟΦΟΣ')).toBe('σοφοσ')
  expect(getNormalizedReviewServingTitleSearchText('병원')).toBe('병원')
})

test('title search TypeScript tokenizer matches the DuckDB rebuild SQL token for token', async () => {
  const titles = [
    'COVID-19 Heart_Failure: a study (2024)',
    'Ünïcode Åäö études — Straße',
    'Ελληνικά Кириллица العربية हिन्दी ไทย',
    '医院管理与感染控制',
    'COVID-19在医院: a 病院 study',
    '日本語のテキスト・カタカナ',
    '병원 감염 관리',
    'İstanbul Ａｂｃ ① ½',
    '',
    '  --  ',
  ]
  const duckdbTokens = await getDuckdbTokens(titles)

  titles.forEach((title, index) => {
    expect({title, tokens: sortTokens(getReviewServingTitleSearchTokens(title))}).toEqual({
      title,
      tokens: duckdbTokens[index] ?? [],
    })
  })
})
