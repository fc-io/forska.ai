import {getSqlLiteral} from './appQueryHelpers.ts'
import {
  type ComparisonJudgmentContext,
  type ComparisonJudgmentContextGenerationParams,
  comparisonJudgmentContextServingTable,
  getComparisonJudgmentContextGenerationLiteral,
  storeComparisonJudgmentContextForGeneration,
} from './comparisonJudgmentContext.ts'
import {computeComparisonJudgmentContextFromGenerationConfig} from './comparisonJudgmentContextDerivation.ts'

type ComparisonJudgmentContextBackfillRunner = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

type ComparisonJudgmentContextBackfillDatabase = ComparisonJudgmentContextBackfillRunner & {
  transaction: <T>(operation: (runner: ComparisonJudgmentContextBackfillRunner) => Promise<T>) => Promise<T>
}

type ComparisonJudgmentContextBackfillAttempt = {attempts: number; lastAttemptAt: number; nextAttemptAt: number}

export type ComparisonJudgmentContextBackfillState = Map<string, ComparisonJudgmentContextBackfillAttempt>

export type ComparisonJudgmentContextBackfillResult =
  | {comparisonProjectId: null; generation: null; status: 'idle'}
  | {comparisonProjectId: string; generation: number; status: 'skipped'}
  | {comparisonProjectId: string; generation: number; judgmentContextId: string; status: 'written'}
  | {
      attempts: number
      comparisonProjectId: string
      errorMessage: string
      generation: number
      nextAttemptAt: Date | null
      status: 'failed'
    }

type ComparisonJudgmentContextBackfillCandidateRow = {comparisonProjectId: string; generation: unknown}

type ComparisonJudgmentContextBackfillCandidate = ComparisonJudgmentContextGenerationParams & {key: string}

type ComparisonJudgmentContextBackfillOptions = {
  computeContext?: (
    runner: ComparisonJudgmentContextBackfillRunner,
    params: ComparisonJudgmentContextGenerationParams,
  ) => Promise<ComparisonJudgmentContext | null>
  now?: Date
  state?: ComparisonJudgmentContextBackfillState
}

export const comparisonJudgmentContextBackfillMaxAttempts = 5
export const comparisonJudgmentContextBackfillBaseDelayMs = 60_000

const defaultComparisonJudgmentContextBackfillState: ComparisonJudgmentContextBackfillState = new Map()

export const createComparisonJudgmentContextBackfillState = (): ComparisonJudgmentContextBackfillState => {
  return new Map()
}

export const getComparisonJudgmentContextBackfillCandidatesSql = () => {
  return `
    SELECT
      status.comparison_project_id AS comparisonProjectId,
      CAST(status.active_generation AS BIGINT) AS generation
    FROM app.comparison_project_serving_generation status
    INNER JOIN app.comparison_project project ON project.id = status.comparison_project_id
    WHERE status.active_generation > 0
      AND project.archived = FALSE
      AND NOT EXISTS (
        SELECT 1
        FROM ${comparisonJudgmentContextServingTable} context_serving
        WHERE context_serving.comparison_project_id = status.comparison_project_id
          AND context_serving.generation = status.active_generation
      )
    ORDER BY status.comparison_project_id ASC
  `
}

const getCandidateKey = (params: ComparisonJudgmentContextGenerationParams) => {
  return `${params.comparisonProjectId}:${params.generation}`
}

const getCandidates = (rows: readonly ComparisonJudgmentContextBackfillCandidateRow[]) => {
  return rows
    .map((row) => {
      const generation = Number(row.generation)

      return {comparisonProjectId: row.comparisonProjectId, generation, key: ''}
    })
    .filter((candidate) => {
      return Number.isSafeInteger(candidate.generation) && candidate.generation > 0
    })
    .map((candidate) => {
      return {...candidate, key: getCandidateKey(candidate)}
    })
}

const getIsCandidateDue = (
  candidate: ComparisonJudgmentContextBackfillCandidate,
  state: ComparisonJudgmentContextBackfillState,
  now: number,
) => {
  const attempt = state.get(candidate.key)

  return !attempt || (attempt.attempts < comparisonJudgmentContextBackfillMaxAttempts && attempt.nextAttemptAt <= now)
}

const getLastAttemptAt = (
  candidate: ComparisonJudgmentContextBackfillCandidate,
  state: ComparisonJudgmentContextBackfillState,
) => {
  return state.get(candidate.key)?.lastAttemptAt ?? Number.NEGATIVE_INFINITY
}

const getNextCandidate = (
  candidates: readonly ComparisonJudgmentContextBackfillCandidate[],
  state: ComparisonJudgmentContextBackfillState,
  now: number,
) => {
  const [candidate = null] = candidates
    .filter((entry) => {
      return getIsCandidateDue(entry, state, now)
    })
    .sort((left, right) => {
      return getLastAttemptAt(left, state) - getLastAttemptAt(right, state)
    })

  return candidate
}

const getErrorMessage = (error: unknown) => {
  return error instanceof Error ? error.message : String(error)
}

const recordFailedAttempt = (
  candidate: ComparisonJudgmentContextBackfillCandidate,
  state: ComparisonJudgmentContextBackfillState,
  now: number,
  error: unknown,
): ComparisonJudgmentContextBackfillResult => {
  const attempts = (state.get(candidate.key)?.attempts ?? 0) + 1
  const nextAttemptAt = now + comparisonJudgmentContextBackfillBaseDelayMs * 2 ** (attempts - 1)

  state.set(candidate.key, {attempts, lastAttemptAt: now, nextAttemptAt})

  return {
    attempts,
    comparisonProjectId: candidate.comparisonProjectId,
    errorMessage: getErrorMessage(error),
    generation: candidate.generation,
    nextAttemptAt: attempts < comparisonJudgmentContextBackfillMaxAttempts ? new Date(nextAttemptAt) : null,
    status: 'failed',
  }
}

const writeCandidateContext = async (
  database: ComparisonJudgmentContextBackfillDatabase,
  candidate: ComparisonJudgmentContextBackfillCandidate,
  options: ComparisonJudgmentContextBackfillOptions,
): Promise<ComparisonJudgmentContextBackfillResult> => {
  const params = {comparisonProjectId: candidate.comparisonProjectId, generation: candidate.generation}
  const context = await (options.computeContext ?? computeComparisonJudgmentContextFromGenerationConfig)(
    database,
    params,
  )
  const judgmentContextId = context
    ? await database.transaction(async (runner) => {
        const [stillActive] = await runner.queryJson<{comparisonProjectId: string}>(`
          SELECT comparison_project_id AS comparisonProjectId
          FROM app.comparison_project_serving_generation
          WHERE comparison_project_id = ${getSqlLiteral(params.comparisonProjectId)}
            AND active_generation = ${getComparisonJudgmentContextGenerationLiteral(params.generation)}
          LIMIT 1
        `)

        return stillActive ? storeComparisonJudgmentContextForGeneration(runner, {...params, context}) : null
      })
    : null

  return judgmentContextId ? {...params, judgmentContextId, status: 'written'} : {...params, status: 'skipped'}
}

export const backfillNextComparisonJudgmentContext = async (
  database: ComparisonJudgmentContextBackfillDatabase,
  options: ComparisonJudgmentContextBackfillOptions = {},
): Promise<ComparisonJudgmentContextBackfillResult> => {
  const state = options.state ?? defaultComparisonJudgmentContextBackfillState
  const now = (options.now ?? new Date()).getTime()
  const rows = await database.queryJson<ComparisonJudgmentContextBackfillCandidateRow>(
    getComparisonJudgmentContextBackfillCandidatesSql(),
  )
  const candidate = getNextCandidate(getCandidates(rows), state, now)

  if (!candidate) {
    return {comparisonProjectId: null, generation: null, status: 'idle'}
  }

  try {
    const result = await writeCandidateContext(database, candidate, options)

    state.delete(candidate.key)
    return result
  } catch (error) {
    return recordFailedAttempt(candidate, state, now, error)
  }
}
