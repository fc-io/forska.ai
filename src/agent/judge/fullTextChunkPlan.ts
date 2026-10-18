import {createHash} from 'node:crypto'

import type {FullTextTokenCounter} from '../../server/fullText/fullTextTokenizer.ts'
import type {FullTextChunkPolicy} from '../../utils/fullTextStrategyOptions.ts'

export const FULL_TEXT_CHUNK_PLAN_VERSION = 'chunk-plan-v1'

export const FULL_TEXT_CHUNK_PROMPT_OVERHEAD_TOKENS = 10_000

export type FullTextChunkPlanChunk = {
  endOffset: number
  headingPath: string | null
  /** Estimated tokens of the part's figure images; present only on native-images plans. */
  imageTokenCount?: number
  index: number
  startOffset: number
  tokenCount: number
}

/** Figure index → estimated image tokens; null for strategies that send no images. */
export type FullTextFigureImageTokens = ReadonlyMap<number, number> | null

export type FullTextChunkPlan = {
  chunkCount: number
  chunks: FullTextChunkPlanChunk[]
  planHash: string
  textHash: string
}

type TextUnit = {
  end: number
  headingPath: string | null
  imageTokens: number
  isHeading: boolean
  start: number
  tokens: number
}

type ChunkDraft = {breadcrumbTokens: number; headingPath: string | null; tokens: number; units: TextUnit[]}

type PlannerState = {chunks: ChunkDraft[]; current: ChunkDraft | null}

type PlannerContext = {
  budget: number
  countTokens: FullTextTokenCounter
  figureImageTokens: FullTextFigureImageTokens
  text: string
}

const headingPrefix = '## '

const figureMarkerPattern = /^\[figure:(\d+)\]$/gm

const blockSeparatorTokens = 1

const getSha256 = (value: string): string => {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export const getFullTextJudgingTextHash = (renderedText: string): string => {
  return getSha256(renderedText)
}

export const getFullTextFigureMarkerIndexes = (text: string): number[] => {
  return Array.from(text.matchAll(figureMarkerPattern), (match) => {
    return Number(match[1])
  })
}

export const getFullTextFigureImageTokenCount = ({
  figureImageTokens,
  text,
}: {
  figureImageTokens: FullTextFigureImageTokens
  text: string
}): number => {
  return figureImageTokens === null
    ? 0
    : getFullTextFigureMarkerIndexes(text).reduce((total, figureIndex) => {
        const tokens = figureImageTokens.get(figureIndex)

        if (tokens === undefined) {
          throw new Error(`Figure ${figureIndex} is marked in the text but has no image token estimate`)
        }

        return total + tokens
      }, 0)
}

const getBlockRanges = (text: string): Array<{end: number; start: number}> => {
  const matches = [...text.matchAll(/[^\n]+(?:\n[^\n]+)*/g)]

  return matches.map((match) => {
    return {end: (match.index ?? 0) + match[0].length, start: match.index ?? 0}
  })
}

const isSplittableParagraph = (block: string): boolean => {
  return !block.includes('\n') && !/^(## |\||Figure \d|\$\$|```)/.test(block)
}

const getSentenceRanges = (text: string, range: {end: number; start: number}): Array<{end: number; start: number}> => {
  const block = text.slice(range.start, range.end)
  const breaks = [...block.matchAll(/(?<=[.!?])\s+(?=\S)/g)].map((match) => {
    return {next: (match.index ?? 0) + match[0].length, previousEnd: match.index ?? 0}
  })
  const starts = [
    0,
    ...breaks.map(({next}) => {
      return next
    }),
  ]
  const ends = [
    ...breaks.map(({previousEnd}) => {
      return previousEnd
    }),
    block.length,
  ]

  return starts.map((start, position) => {
    return {end: range.start + (ends[position] ?? block.length), start: range.start + start}
  })
}

const getHeadingPath = (block: string): string | null => {
  return block.startsWith(headingPrefix) && !block.includes('\n') ? block.slice(headingPrefix.length) : null
}

const getTextUnits = ({budget, countTokens, figureImageTokens, text}: PlannerContext): TextUnit[] => {
  return getBlockRanges(text).reduce<{headingPath: string | null; units: TextUnit[]}>(
    (state, range) => {
      const block = text.slice(range.start, range.end)
      const ownHeadingPath = getHeadingPath(block)
      const headingPath = ownHeadingPath ?? state.headingPath
      const tokens = countTokens(block)
      const imageTokens = getFullTextFigureImageTokenCount({figureImageTokens, text: block})
      const ranges =
        tokens + imageTokens > budget && isSplittableParagraph(block) ? getSentenceRanges(text, range) : [range]
      const units = ranges.map((unitRange): TextUnit => {
        const unitText = text.slice(unitRange.start, unitRange.end)

        return {
          ...unitRange,
          headingPath,
          imageTokens:
            ranges.length === 1 ? imageTokens : getFullTextFigureImageTokenCount({figureImageTokens, text: unitText}),
          isHeading: ownHeadingPath !== null,
          tokens: ranges.length === 1 ? tokens : countTokens(unitText),
        }
      })

      return {headingPath, units: [...state.units, ...units]}
    },
    {headingPath: null, units: []},
  ).units
}

const getSections = (units: TextUnit[]): TextUnit[][] => {
  return units.reduce<TextUnit[][]>((sections, unit) => {
    const lastSection = sections.at(-1)

    return unit.isHeading || !lastSection ? [...sections, [unit]] : [...sections.slice(0, -1), [...lastSection, unit]]
  }, [])
}

const getUnitsTokens = (units: TextUnit[]): number => {
  return units.reduce((total, unit, position) => {
    return total + unit.tokens + unit.imageTokens + (position === 0 ? 0 : blockSeparatorTokens)
  }, 0)
}

const getBreadcrumb = (headingPath: string | null): string => {
  return headingPath === null ? '' : `${headingPrefix}${headingPath}\n\n`
}

const getChunkDraft = (units: TextUnit[], countTokens: FullTextTokenCounter): ChunkDraft => {
  const [firstUnit] = units
  const headingPath = firstUnit?.headingPath ?? null
  const breadcrumbTokens =
    !firstUnit || firstUnit.isHeading || headingPath === null ? 0 : countTokens(getBreadcrumb(headingPath))

  return {breadcrumbTokens, headingPath, tokens: breadcrumbTokens + getUnitsTokens(units), units}
}

const appendUnits = (chunk: ChunkDraft, units: TextUnit[]): ChunkDraft => {
  return {
    ...chunk,
    tokens: chunk.tokens + blockSeparatorTokens + getUnitsTokens(units),
    units: [...chunk.units, ...units],
  }
}

const fitsChunk = (chunk: ChunkDraft, units: TextUnit[], budget: number): boolean => {
  return chunk.tokens + blockSeparatorTokens + getUnitsTokens(units) <= budget
}

const getTrailingHeadingUnits = (chunk: ChunkDraft | null): TextUnit[] => {
  const lastUnit = chunk?.units.at(-1)

  return lastUnit?.isHeading ? [lastUnit] : []
}

const closeChunkBefore = (state: PlannerState, units: TextUnit[], countTokens: FullTextTokenCounter): PlannerState => {
  const carriedHeadings = getTrailingHeadingUnits(state.current)
  const keptUnits = state.current
    ? state.current.units.slice(0, state.current.units.length - carriedHeadings.length)
    : []

  return {
    chunks: keptUnits.length > 0 ? [...state.chunks, getChunkDraft(keptUnits, countTokens)] : state.chunks,
    current: getChunkDraft([...carriedHeadings, ...units], countTokens),
  }
}

const addUnitByUnit = (state: PlannerState, units: TextUnit[], context: PlannerContext): PlannerState => {
  return units.reduce((next, unit) => {
    return next.current && fitsChunk(next.current, [unit], context.budget)
      ? {chunks: next.chunks, current: appendUnits(next.current, [unit])}
      : closeChunkBefore(next, [unit], context.countTokens)
  }, state)
}

const addSection = (state: PlannerState, section: TextUnit[], context: PlannerContext): PlannerState => {
  const sectionFitsOneChunk = getUnitsTokens(section) <= context.budget

  return state.current && fitsChunk(state.current, section, context.budget)
    ? {chunks: state.chunks, current: appendUnits(state.current, section)}
    : sectionFitsOneChunk
      ? closeChunkBefore(state, section, context.countTokens)
      : addUnitByUnit(state, section, context)
}

export const getFullTextChunkText = ({
  chunk,
  renderedText,
}: {
  chunk: Pick<FullTextChunkPlanChunk, 'endOffset' | 'headingPath' | 'startOffset'>
  renderedText: string
}): string => {
  const slice = renderedText.slice(chunk.startOffset, chunk.endOffset)

  return slice.startsWith(headingPrefix) ? slice : `${getBreadcrumb(chunk.headingPath)}${slice}`
}

export const getFullTextChunkTextBudget = ({
  abstractTokens,
  chunkPolicy,
}: {
  abstractTokens: number
  chunkPolicy: FullTextChunkPolicy
}): number => {
  return chunkPolicy.maxPromptTokens - FULL_TEXT_CHUNK_PROMPT_OVERHEAD_TOKENS - abstractTokens
}

const getChunkImageTokenFields = (
  figureImageTokens: FullTextFigureImageTokens,
  chunkText: string,
): Pick<FullTextChunkPlanChunk, 'imageTokenCount'> => {
  return figureImageTokens === null
    ? {}
    : {imageTokenCount: getFullTextFigureImageTokenCount({figureImageTokens, text: chunkText})}
}

const toPlanChunk = (
  draft: ChunkDraft,
  index: number,
  {countTokens, figureImageTokens, text}: Pick<PlannerContext, 'countTokens' | 'figureImageTokens' | 'text'>,
): FullTextChunkPlanChunk => {
  const firstUnit = draft.units[0] as TextUnit
  const lastUnit = draft.units.at(-1) as TextUnit
  const chunk = {endOffset: lastUnit.end, headingPath: draft.headingPath, index, startOffset: firstUnit.start}
  const chunkText = getFullTextChunkText({chunk, renderedText: text})

  return {...chunk, ...getChunkImageTokenFields(figureImageTokens, chunkText), tokenCount: countTokens(chunkText)}
}

export const getFullTextChunkPlanHash = ({
  chunks,
  fullTextStrategyId,
  textHash,
}: {
  chunks: FullTextChunkPlanChunk[]
  fullTextStrategyId: string
  textHash: string
}): string => {
  return getSha256(JSON.stringify({chunks, fullTextStrategyId, textHash, version: FULL_TEXT_CHUNK_PLAN_VERSION}))
}

/**
 * A part's budget covers its text and, on native-images strategies, the estimated tokens of the figures marked in
 * it. A figure block (caption plus marker) is never split, so a figure that cannot fit on its own ends up as an
 * oversized part; the judge skips such an article as `fulltext_figure_too_large`.
 */
export const buildFullTextChunkPlan = ({
  abstract,
  chunkPolicy,
  countTokens,
  figureImageTokens,
  fullTextStrategyId,
  renderedText,
}: {
  abstract: string | null
  chunkPolicy: FullTextChunkPolicy
  countTokens: FullTextTokenCounter
  figureImageTokens: FullTextFigureImageTokens
  fullTextStrategyId: string
  renderedText: string
}): FullTextChunkPlan => {
  const context = {
    budget: getFullTextChunkTextBudget({abstractTokens: countTokens(abstract ?? ''), chunkPolicy}),
    countTokens,
    figureImageTokens,
    text: renderedText,
  }
  const drafted = getSections(getTextUnits(context)).reduce<{chunks: ChunkDraft[]; current: ChunkDraft | null}>(
    (state, section) => {
      return addSection(state, section, context)
    },
    {chunks: [], current: null},
  )
  const drafts = drafted.current ? [...drafted.chunks, drafted.current] : drafted.chunks
  const chunks = drafts.map((draft, index) => {
    return toPlanChunk(draft, index, context)
  })
  const textHash = getFullTextJudgingTextHash(renderedText)

  return {
    chunkCount: chunks.length,
    chunks,
    planHash: getFullTextChunkPlanHash({chunks, fullTextStrategyId, textHash}),
    textHash,
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const isPlanChunk = (value: unknown): value is FullTextChunkPlanChunk => {
  return (
    isRecord(value)
    && Number.isInteger(value.index)
    && Number.isInteger(value.startOffset)
    && Number.isInteger(value.endOffset)
    && Number.isInteger(value.tokenCount)
    && (value.imageTokenCount === undefined || Number.isInteger(value.imageTokenCount))
    && (value.headingPath === null || typeof value.headingPath === 'string')
  )
}

export const getFullTextChunkPlan = (value: unknown): FullTextChunkPlan | null => {
  const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value

  return isRecord(parsed)
    && typeof parsed.planHash === 'string'
    && typeof parsed.textHash === 'string'
    && Array.isArray(parsed.chunks)
    && parsed.chunks.every(isPlanChunk)
    && parsed.chunkCount === parsed.chunks.length
    ? {chunkCount: parsed.chunks.length, chunks: parsed.chunks, planHash: parsed.planHash, textHash: parsed.textHash}
    : null
}

export const isFullTextChunkPlanCurrent = ({
  figureImageTokens,
  plan,
  renderedText,
  textHash,
}: {
  figureImageTokens: FullTextFigureImageTokens
  plan: FullTextChunkPlan | null | undefined
  renderedText: string
  textHash: string
}): boolean => {
  return (
    plan?.textHash === textHash
    && plan.chunks.every((chunk) => {
      const expected = getChunkImageTokenFields(figureImageTokens, getFullTextChunkText({chunk, renderedText}))

      return chunk.imageTokenCount === expected.imageTokenCount
    })
  )
}
