import {expect, test} from 'bun:test'

import {loadFullTextTokenCounter} from '../../server/fullText/fullTextTokenizer.ts'
import {buildCanonicalFixture} from '../../server/test/canonicalFullTextFixtures.ts'
import {
  buildFullTextChunkPlan,
  FULL_TEXT_CHUNK_PROMPT_OVERHEAD_TOKENS,
  type FullTextChunkPlan,
  getFullTextChunkPlan,
  getFullTextChunkText,
  getFullTextChunkTextBudget,
  getFullTextFigureImageTokenCount,
  getFullTextJudgingTextHash,
  isFullTextChunkPlanCurrent,
} from './fullTextChunkPlan.ts'

const countWords = (text: string): number => {
  return text.split(/\s+/).filter((word) => {
    return word !== ''
  }).length
}

const words = (count: number, word = 'lorem'): string => {
  return Array.from({length: count}, () => {
    return word
  }).join(' ')
}

const policy24k = {maxPromptTokens: 24_000, mode: 'chunked'} as const

const budget24k = 24_000 - FULL_TEXT_CHUNK_PROMPT_OVERHEAD_TOKENS

const planWords = (renderedText: string, abstract: string | null = null): FullTextChunkPlan => {
  return buildFullTextChunkPlan({
    abstract,
    chunkPolicy: policy24k,
    countTokens: countWords,
    figureImageTokens: null,
    fullTextStrategyId: 'fts-test',
    renderedText,
  })
}

const planWordsWithImages = (renderedText: string, figureImageTokens: Map<number, number>): FullTextChunkPlan => {
  return buildFullTextChunkPlan({
    abstract: null,
    chunkPolicy: policy24k,
    countTokens: countWords,
    figureImageTokens,
    fullTextStrategyId: 'fts-test',
    renderedText,
  })
}

const getChunkTexts = (plan: FullTextChunkPlan, renderedText: string): string[] => {
  return plan.chunks.map((chunk) => {
    return getFullTextChunkText({chunk, renderedText})
  })
}

test('the chunk text budget is the policy minus the fixed overhead and the abstract', () => {
  expect(FULL_TEXT_CHUNK_PROMPT_OVERHEAD_TOKENS).toBe(10_000)
  expect(getFullTextChunkTextBudget({abstractTokens: 300, chunkPolicy: policy24k})).toBe(13_700)
  expect(getFullTextChunkTextBudget({abstractTokens: 0, chunkPolicy: {maxPromptTokens: 96_000, mode: 'chunked'}})).toBe(
    86_000,
  )
})

test('whole sections start new chunks, filled greedily up to the exact budget', () => {
  const text = `## A\n\n${words(budget24k - 3)}\n\n## B\n\n${words(5000)}\n\n## C\n\n${words(budget24k - 5007)}\n`
  const plan = planWords(text)

  expect(plan.chunkCount).toBe(2)
  expect(getChunkTexts(plan, text).map(countWords)).toEqual([budget24k - 1, budget24k - 3])
  expect(
    plan.chunks.map((chunk) => {
      return chunk.headingPath
    }),
  ).toEqual(['A', 'B'])
})

test('a section one token over the remaining budget moves whole to the next chunk', () => {
  const fits = `## A\n\n${words(100)}\n\n## B\n\n${words(budget24k - 107)}\n`
  const overflows = `## A\n\n${words(100)}\n\n## B\n\n${words(budget24k - 106)}\n`

  expect(planWords(fits).chunkCount).toBe(1)
  expect(
    planWords(overflows).chunks.map((chunk) => {
      return chunk.headingPath
    }),
  ).toEqual(['A', 'B'])
})

test('a section larger than a chunk is split at block boundaries and continuation chunks carry the heading path', () => {
  const paragraphs = Array.from({length: 5}, (_, index) => {
    return words(6000, `p${index}`)
  })
  const text = `Unheaded introduction.\n\n## 2 Methods > 2.1 Search\n\n${paragraphs.join('\n\n')}\n`
  const plan = planWords(text)
  const chunkTexts = getChunkTexts(plan, text)

  expect(plan.chunkCount).toBe(3)
  expect(chunkTexts[0]?.startsWith('Unheaded introduction.\n\n## 2 Methods > 2.1 Search\n\np0')).toBe(true)
  expect(chunkTexts[1]?.startsWith('## 2 Methods > 2.1 Search\n\np2')).toBe(true)
  expect(chunkTexts[1]?.includes('p3 p3')).toBe(true)
  expect(chunkTexts[2]?.startsWith('## 2 Methods > 2.1 Search\n\np4')).toBe(true)
  expect(plan.chunks[0]?.headingPath).toBeNull()
})

test('tables and figure blocks stay whole even when larger than the budget; plain paragraphs split at sentences', () => {
  const table = ['Table 1: Outcomes', '| arm | n |', '| --- | --- |', `| ${words(budget24k + 10)} | 1 |`].join('\n')
  const figure = `Figure 1: Flow\n${words(50)}`
  const longParagraph = Array.from({length: 3}, (_, index) => {
    return `${words(6000, `s${index}`)}.`
  }).join(' ')
  const text = `## Results\n\n${table}\n\n${figure}\n\n${longParagraph}\n`
  const plan = planWords(text)
  const chunkTexts = getChunkTexts(plan, text)

  expect(
    chunkTexts.filter((chunkText) => {
      return chunkText.includes('| --- | --- |')
    }),
  ).toHaveLength(1)
  expect(
    chunkTexts.some((chunkText) => {
      return chunkText.includes(table)
    }),
  ).toBe(true)
  expect(
    chunkTexts.some((chunkText) => {
      return chunkText.includes(figure)
    }),
  ).toBe(true)
  expect(
    plan.chunks
      .filter((chunk) => {
        return chunk.tokenCount > budget24k
      })
      .map((chunk) => {
        return chunk.index
      }),
  ).toEqual([0])
  expect(
    chunkTexts.filter((chunkText) => {
      return chunkText.includes('s1 s1')
    }),
  ).toHaveLength(1)
})

test('the abstract reduces every chunk budget', () => {
  const text = `## A\n\n${words(5000)}\n\n## B\n\n${words(budget24k - 5007)}\n`

  expect(planWords(text).chunkCount).toBe(1)
  expect(planWords(text, 'One abstract word too many.').chunkCount).toBe(2)
})

test('chunks cover the text in order without gaps and offsets are JS string offsets', () => {
  const text = `Intro.\n\n## A\n\n${words(9000)}\n\n## B\n\n${words(9000)}\n\n## C\n\n${words(2000)}\n`
  const plan = planWords(text)
  const covered = plan.chunks
    .map((chunk) => {
      return text.slice(chunk.startOffset, chunk.endOffset)
    })
    .join('\n\n')

  expect(`${covered}\n`).toBe(text)
  expect(
    plan.chunks.map((chunk) => {
      return chunk.index
    }),
  ).toEqual([0, 1])
})

test('plans are deterministic, hash the strategy and text, and parse back from JSON', () => {
  const text = `## A\n\n${words(9000)}\n\n## B\n\n${words(9000)}\n`
  const plan = planWords(text)
  const otherStrategy = buildFullTextChunkPlan({
    abstract: null,
    chunkPolicy: policy24k,
    countTokens: countWords,
    figureImageTokens: null,
    fullTextStrategyId: 'fts-other',
    renderedText: text,
  })

  expect(planWords(text)).toEqual(plan)
  expect(plan.textHash).toBe(getFullTextJudgingTextHash(text))
  expect(otherStrategy.planHash).not.toBe(plan.planHash)
  expect(otherStrategy.chunks).toEqual(plan.chunks)
  expect(getFullTextChunkPlan(JSON.stringify(plan))).toEqual(plan)
  expect(getFullTextChunkPlan({...plan, chunkCount: 3})).toBeNull()
  expect(getFullTextChunkPlan({...plan, chunks: [{index: 0}]})).toBeNull()
})

test('o200k plans of real canonical text are frozen', async () => {
  const countTokens = await loadFullTextTokenCounter()
  const parts = [
    buildCanonicalFixture({converterKind: 'mineru', figureMode: 'none', name: 'arxiv-2111.06377'}).text,
    buildCanonicalFixture({converterKind: 'docling', figureMode: 'none', name: 'arxiv-2111.06377'}).text,
    buildCanonicalFixture({converterKind: 'docling', figureMode: 'none', name: 'frontiers-fmed-2023-1283512'}).text,
  ]
  const renderedText = parts.join('\n')
  const plan = buildFullTextChunkPlan({
    abstract: 'We show that masked autoencoders are scalable self-supervised learners for computer vision.',
    chunkPolicy: policy24k,
    countTokens,
    figureImageTokens: null,
    fullTextStrategyId: 'fts-frozen-test',
    renderedText,
  })
  const chunkTexts = getChunkTexts(plan, renderedText)

  expect({
    chunkCount: plan.chunkCount,
    planHash: plan.planHash,
    tokenCounts: plan.chunks.map((chunk) => {
      return chunk.tokenCount
    }),
  }).toEqual({
    chunkCount: 3,
    planHash: '4338ef2b21470fe2a5730471ca22f2ad5c6728e21d321ad14bf3679b955a3f74',
    tokenCounts: [13_427, 13_826, 1_067],
  })
  expect(
    plan.chunks.map((chunk) => {
      return chunk.headingPath
    }),
  ).toEqual(['1. Introduction', '2. Related Work', '3 Results > 3.7 Pain at 48 h on the VAS'])
  expect(
    chunkTexts.map((chunkText, index) => {
      return countTokens(chunkText) === plan.chunks[index]?.tokenCount
    }),
  ).toEqual(
    plan.chunks.map(() => {
      return true
    }),
  )
  expect(
    plan.chunks.every((chunk) => {
      return chunk.tokenCount <= getFullTextChunkTextBudget({abstractTokens: 17, chunkPolicy: policy24k})
    }),
  ).toBe(true)
})

// Section A: heading (2) + separator + text; section B: heading (2) + separator + figure block (4) + separator + 10.
const figureSectionText = `## A\n\n${words(budget24k - 1000)}\n\n## B\n\nFigure 1: Flow\n[figure:1]\n\n${words(10)}\n`

test('figure image tokens count toward the part budget, up to the exact budget', () => {
  expect(planWords(figureSectionText).chunkCount).toBe(1)
  expect(planWordsWithImages(figureSectionText, new Map([[1, 978]])).chunkCount).toBe(1)

  const split = planWordsWithImages(figureSectionText, new Map([[1, 979]]))

  expect(
    split.chunks.map((chunk) => {
      return [chunk.headingPath, chunk.imageTokenCount, chunk.tokenCount]
    }),
  ).toEqual([
    ['A', 0, budget24k - 998],
    ['B', 979, 16],
  ])
})

test('native-images plans record per-part image tokens and hash differently; text-only plans keep their shape', () => {
  const textOnly = planWords(figureSectionText)
  const withImages = planWordsWithImages(figureSectionText, new Map([[1, 0]]))

  expect(
    textOnly.chunks.every((chunk) => {
      return !Object.hasOwn(chunk, 'imageTokenCount')
    }),
  ).toBe(true)
  expect(
    withImages.chunks.map((chunk) => {
      return chunk.imageTokenCount
    }),
  ).toEqual([0])
  expect(withImages.planHash).not.toBe(textOnly.planHash)
  expect(getFullTextChunkPlan(JSON.parse(JSON.stringify(withImages)))).toEqual(withImages)
})

test('a figure that cannot fit on its own becomes one whole oversized part; it is never split or dropped', () => {
  const text = `## A\n\n${words(100)}\n\nFigure 1: Flow\n[figure:1]\n\n${words(100, 'tail')}\n`
  const plan = planWordsWithImages(text, new Map([[1, budget24k]]))

  expect(getChunkTexts(plan, text)).toEqual([
    `## A\n\n${words(100)}`,
    '## A\n\nFigure 1: Flow\n[figure:1]',
    `## A\n\n${words(100, 'tail')}`,
  ])
  expect(
    plan.chunks.map((chunk) => {
      return chunk.imageTokenCount
    }),
  ).toEqual([0, budget24k, 0])
})

test('a cached plan is current only for the same text hash and the same per-part image tokens', () => {
  const textHash = getFullTextJudgingTextHash(figureSectionText)
  const textOnly = planWords(figureSectionText)
  const withImages = planWordsWithImages(figureSectionText, new Map([[1, 979]]))
  const isCurrent = (plan: FullTextChunkPlan, figureImageTokens: Map<number, number> | null, hash = textHash) => {
    return isFullTextChunkPlanCurrent({figureImageTokens, plan, renderedText: figureSectionText, textHash: hash})
  }

  expect(isCurrent(textOnly, null)).toBe(true)
  expect(isCurrent(textOnly, null, getFullTextJudgingTextHash('other'))).toBe(false)
  expect(isCurrent(withImages, new Map([[1, 979]]))).toBe(true)
  expect(isCurrent(withImages, new Map([[1, 980]]))).toBe(false)
  expect(isCurrent(textOnly, new Map([[1, 979]]))).toBe(false)
  expect(isCurrent(withImages, null)).toBe(false)
})

test('a marked figure without an estimate is a named error', () => {
  expect(getFullTextFigureImageTokenCount({figureImageTokens: null, text: '[figure:2]'})).toBe(0)
  expect(getFullTextFigureImageTokenCount({figureImageTokens: new Map([[2, 40]]), text: 'a\n[figure:2]\nb'})).toBe(40)
  expect(() => {
    return getFullTextFigureImageTokenCount({figureImageTokens: new Map([[1, 40]]), text: 'x\n[figure:2]'})
  }).toThrow('Figure 2 is marked in the text but has no image token estimate')
})
