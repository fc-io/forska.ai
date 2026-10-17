import {cron} from '@elysiajs/cron'
import {Elysia} from 'elysia'

import {
  describeFigureCandidates,
  getFigureDescriptionTarget,
  selectFigureDescriptionCandidates,
} from '../fullText/figureDescriptionStore.ts'
import {env} from '../utils/env.ts'
import {createRateLimitedLogger} from '../utils/rateLimitedLogger.ts'
import {isExpectedDuckdbOwnerRoleLossError, shouldCurrentServerRunMaintenanceLoops} from '../utils/serverRuntimeRole.ts'

const FIGURE_DESCRIPTION_INTERVAL = '30 * * * * *'
const DEFAULT_BATCH_SIZE = 8
const DEFAULT_CONCURRENCY = 2
const figureDescriptionJobsLogger = createRateLimitedLogger({sink: 'file-only', windowMs: 30_000})
const figureDescriptionJobsComponent = 'figureDescriptionJobs'

const runningBatch = {active: false}

const normalizePositiveInt = (value: number | null | undefined, fallback: number): number => {
  const normalized = Math.trunc(value ?? fallback)

  return normalized > 0 ? normalized : fallback
}

export const getFigureDescriptionBatchSize = (): number => {
  return normalizePositiveInt(env.FIGURE_DESCRIPTION_BATCH_SIZE, DEFAULT_BATCH_SIZE)
}

export const getFigureDescriptionConcurrency = (batchSize: number): number => {
  return Math.min(batchSize, normalizePositiveInt(env.FIGURE_DESCRIPTION_CONCURRENCY, DEFAULT_CONCURRENCY))
}

const getOutcomeCounts = (outcomes: string[]) => {
  return outcomes.reduce<Record<string, number>>((counts, outcome) => {
    return {...counts, [outcome]: (counts[outcome] ?? 0) + 1}
  }, {})
}

export const runFigureDescriptionBatch = async ({cwd}: {cwd?: string} = {}) => {
  const target = await getFigureDescriptionTarget()

  if (!target) {
    figureDescriptionJobsLogger.log(
      'figureDescriptionJobs:modelConfigMissing',
      '[figureDescriptionJobs] No figure-description model configured',
      {component: figureDescriptionJobsComponent},
    )
    return {candidates: 0, outcomes: {}}
  }

  const batchSize = getFigureDescriptionBatchSize()
  const candidates = await selectFigureDescriptionCandidates({limit: batchSize, target})
  const outcomes = await describeFigureCandidates({
    candidates,
    concurrency: getFigureDescriptionConcurrency(batchSize),
    cwd,
    target,
  })
  const outcomeCounts = getOutcomeCounts(outcomes)

  figureDescriptionJobsLogger.log('figureDescriptionJobs:batchFinished', '[figureDescriptionJobs] Batch finished', {
    batchSize,
    candidates: candidates.length,
    component: figureDescriptionJobsComponent,
    modelId: target.modelId,
    outcomes: outcomeCounts,
    promptVersion: target.promptVersion,
  })

  return {candidates: candidates.length, outcomes: outcomeCounts}
}

const runScheduledFigureDescriptionBatch = async () => {
  if (!env.RUN_SERVER_FULL_TEXT_CONVERSION_CRON || !shouldCurrentServerRunMaintenanceLoops() || runningBatch.active) {
    return
  }

  runningBatch.active = true

  await runFigureDescriptionBatch()
    .catch((error: unknown) => {
      if (!isExpectedDuckdbOwnerRoleLossError(error)) {
        throw error
      }
    })
    .finally(() => {
      runningBatch.active = false
    })
}

export const figureDescriptionJobsCron = new Elysia().use(
  cron({
    name: 'full-text-jobs-describe-figures',
    pattern: FIGURE_DESCRIPTION_INTERVAL,
    run: runScheduledFigureDescriptionBatch,
  }),
)
