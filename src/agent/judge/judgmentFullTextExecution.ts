import type {JudgmentFullTextExecution} from '../../db/schemaTypes.ts'
import {isReservedFullTextStrategyId} from '../../server/fullText/fullTextStrategy.ts'

export const noJudgmentFullTextExecution: JudgmentFullTextExecution = {
  chunkCount: null,
  chunkPlanHash: null,
  fullTextMode: null,
}

export class JudgmentFullTextExecutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JudgmentFullTextExecutionError'
  }
}

const getNullableNumber = (value: unknown): number | null => {
  return value === null || value === undefined ? null : Number(value)
}

const getNullableString = (value: unknown): string | null => {
  return typeof value === 'string' ? value : null
}

const isChunkedExecution = ({chunkCount, chunkPlanHash}: {chunkCount: number | null; chunkPlanHash: string | null}) => {
  return chunkCount !== null && Number.isInteger(chunkCount) && chunkCount >= 1 && chunkPlanHash !== null
}

export const getJudgmentFullTextExecution = (input: {
  chunkCount?: unknown
  chunkPlanHash?: unknown
  fullTextMode?: unknown
}): JudgmentFullTextExecution => {
  const fullTextMode = input.fullTextMode ?? null
  const chunkCount = getNullableNumber(input.chunkCount)
  const chunkPlanHash = getNullableString(input.chunkPlanHash)
  const hasNoChunks = chunkCount === null && chunkPlanHash === null

  if (fullTextMode === null && hasNoChunks) {
    return noJudgmentFullTextExecution
  }

  if (fullTextMode === 'single' && hasNoChunks) {
    return {chunkCount: null, chunkPlanHash: null, fullTextMode: 'single'}
  }

  if (fullTextMode === 'chunked' && isChunkedExecution({chunkCount, chunkPlanHash})) {
    return {chunkCount, chunkPlanHash, fullTextMode: 'chunked'}
  }

  throw new JudgmentFullTextExecutionError(
    `Invalid full-text execution: mode=${JSON.stringify(fullTextMode)} chunkCount=${String(chunkCount)} chunkPlanHash=${String(chunkPlanHash)}`,
  )
}

export const getJudgmentFullTextExecutionForStrategy = (
  fullTextStrategyId: string,
  input: {chunkCount?: unknown; chunkPlanHash?: unknown; fullTextMode?: unknown},
): JudgmentFullTextExecution => {
  const execution = getJudgmentFullTextExecution(input)
  const expectsMode = !isReservedFullTextStrategyId(fullTextStrategyId)

  if (expectsMode !== (execution.fullTextMode !== null)) {
    throw new JudgmentFullTextExecutionError(
      `Full-text strategy ${fullTextStrategyId} ${expectsMode ? 'needs' : 'cannot have'} a full-text mode; got ${String(execution.fullTextMode)}`,
    )
  }

  return execution
}
