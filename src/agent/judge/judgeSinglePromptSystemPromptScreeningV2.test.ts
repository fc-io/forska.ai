import {expect, test} from 'bun:test'

import {
  SINGLE_PROMPT_SYSTEM_PROMPT_SCREENING_V1,
  SINGLE_PROMPT_SYSTEM_PROMPT_SCREENING_V1_ANTHROPIC,
} from './judgeSinglePromptSystemPromptScreeningV1.ts'
import {
  SINGLE_PROMPT_SYSTEM_PROMPT_SCREENING_V2,
  SINGLE_PROMPT_SYSTEM_PROMPT_SCREENING_V2_ANTHROPIC,
} from './judgeSinglePromptSystemPromptScreeningV2.ts'

const v1MetadataItemEnd = 'use it for the setting, publication type and date, do not quote it\n'
const v2MetadataItemEnd = 'use it for the setting, publication type and date\n'
const v1QuoteSourceLine = '- Quotes may come only from article_title, article_summary, or article_fulltext.\n'
const v2QuoteSourceLine =
  '- Quotes may come only from article_title, article_summary, article_metadata, or article_fulltext.\n'

const getV2FromV1 = (v1: string) => {
  return v1.replace(v1MetadataItemEnd, v2MetadataItemEnd).replace(v1QuoteSourceLine, v2QuoteSourceLine)
}

const countOccurrences = (text: string, part: string) => {
  return text.split(part).length - 1
}

test('screening_v2 is screening_v1 with exactly the two article_metadata quote changes, for both intros', () => {
  const pairs: Array<[v1: string, v2: string]> = [
    [SINGLE_PROMPT_SYSTEM_PROMPT_SCREENING_V1, SINGLE_PROMPT_SYSTEM_PROMPT_SCREENING_V2],
    [SINGLE_PROMPT_SYSTEM_PROMPT_SCREENING_V1_ANTHROPIC, SINGLE_PROMPT_SYSTEM_PROMPT_SCREENING_V2_ANTHROPIC],
  ]

  pairs.map(([v1, v2]) => {
    expect([countOccurrences(v1, v1MetadataItemEnd), countOccurrences(v1, v1QuoteSourceLine)]).toEqual([1, 1])
    expect(v2).toBe(getV2FromV1(v1))
    expect(v2).not.toBe(v1)
    expect(v2).not.toContain('do not quote it')
    return expect(v2).toContain(
      '4. Sometimes an article_metadata block (journal, year, volume, issue, pages, publication type, identifiers): use it for the setting, publication type and date\n5. The expected output_type for your answer',
    )
  })
})
