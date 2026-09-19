/**
 * Title search tokenizer shared by the TypeScript projector (dirty patches and
 * query parsing) and the SQL-native rebuild path in DuckDB.
 *
 * Both implementations must agree token-for-token, because queries are
 * tokenized in TypeScript and matched with `starts_with` against postings that
 * are usually produced by the DuckDB rebuild SQL.
 *
 * Normalization mirrors DuckDB `lower(strip_accents(title))`: canonical
 * decomposition, drop combining marks, recompose, then a context-free
 * lowercase. Tokens are maximal runs of Unicode letters and digits. Runs of
 * Han, Hiragana, Katakana, and Hangul characters have no word boundaries, so
 * they are additionally indexed as single characters plus character bigrams;
 * a multi-character CJK query then becomes an AND over its bigrams.
 */

export const reviewServingTitleSearchTokenizerVersion = 'title-token-v2'

const cjkSqlCharacterClass = '\\p{Han}\\p{Hiragana}\\p{Katakana}\\p{Hangul}'
const cjkRunPattern = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu
const cjkSegmentPattern = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u
const segmentSeparatorPattern = /[^\p{L}\p{N}]+/u
const combiningMarkPattern = /\p{M}+/gu

export const reviewServingTitleSearchSegmentSeparatorSqlPattern = '[^\\p{L}\\p{N}]+'

const getContextFreeLowercase = (value: string) => {
  return Array.from(value, (character) => {
    return character.toLowerCase()
  }).join('')
}

export const getNormalizedReviewServingTitleSearchText = (value: string) => {
  return getContextFreeLowercase(value.normalize('NFD').replace(combiningMarkPattern, '').normalize('NFC'))
}

const getCjkSegmentTokens = (segment: string) => {
  const characters = Array.from(segment)
  const bigrams = characters.slice(0, -1).map((character, index) => {
    return `${character}${characters[index + 1] ?? ''}`
  })

  return [...characters, ...bigrams]
}

export const getReviewServingTitleSearchTokens = (title: string | null) => {
  const segments = getNormalizedReviewServingTitleSearchText(title ?? '')
    .replace(cjkRunPattern, ' $& ')
    .split(segmentSeparatorPattern)
    .filter((segment) => {
      return segment.length > 0
    })

  return [
    ...new Set(
      segments.flatMap((segment) => {
        return cjkSegmentPattern.test(segment) ? getCjkSegmentTokens(segment) : [segment]
      }),
    ),
  ]
}

/**
 * DuckDB expression producing the normalized title with CJK runs padded by
 * spaces so the segment split below never mixes scripts inside one segment.
 */
export const getReviewServingTitleSearchNormalizedTitleSql = (titleSql: string) => {
  return `regexp_replace(lower(strip_accents(COALESCE(${titleSql}, ''))), '([${cjkSqlCharacterClass}]+)', ' \\1 ', 'g')`
}

/**
 * DuckDB expression splitting a normalized title into letter/digit segments.
 */
export const getReviewServingTitleSearchSegmentsSql = (normalizedTitleSql: string) => {
  return `regexp_split_to_array(${normalizedTitleSql}, '${reviewServingTitleSearchSegmentSeparatorSqlPattern}')`
}

/**
 * DuckDB list expression expanding one segment into its tokens: the segment
 * itself, or single characters plus bigrams for CJK segments.
 */
export const getReviewServingTitleSearchSegmentTokensSql = (segmentSql: string) => {
  return `CASE
        WHEN regexp_matches(${segmentSql}, '^[${cjkSqlCharacterClass}]+$')
        THEN list_concat(
          list_transform(range(1, length(${segmentSql}) + 1), lambda i: substring(${segmentSql}, i, 1)),
          list_transform(range(1, length(${segmentSql})), lambda i: substring(${segmentSql}, i, 2))
        )
        ELSE [${segmentSql}]
      END`
}
