import {
  type FullTextJudgingBlock,
  FullTextJudgingConfigError,
  type FullTextJudgingStrategy,
  getFullTextJudgingFigureDescriptionTarget,
} from '../../agent/judge/fullTextJudgingInput.ts'
import {createRateLimitedLogger} from '../utils/rateLimitedLogger.ts'
import type {FigureDescriptionTarget} from './figureDescriptionAssets.ts'
import type {EnsureFigureDescriptionsResult} from './figureDescriptionStore.ts'

const fullTextJudgingFigureDescriptionLogger = createRateLimitedLogger({sink: 'both', windowMs: 60_000})
const fullTextJudgingFigureDescriptionsInFlight = new Map<string, Promise<unknown>>()

const loadFigureDescriptionStore = () => {
  return import('./figureDescriptionStore.ts')
}

const getTargetLabel = (target: FigureDescriptionTarget): string => {
  return `model ${target.modelId} (${target.promptVersion})`
}

const isSameTarget = (left: FigureDescriptionTarget, right: FigureDescriptionTarget): boolean => {
  return left.modelId === right.modelId && left.promptVersion === right.promptVersion
}

export const getFullTextJudgingFigureDescriptionConfigError = async (
  strategy: FullTextJudgingStrategy,
): Promise<string | null> => {
  const strategyTarget = getFullTextJudgingFigureDescriptionTarget(strategy)
  const installationTarget = strategyTarget
    ? await (await loadFigureDescriptionStore()).getFigureDescriptionTarget()
    : null

  return strategyTarget === null
    ? null
    : installationTarget === null
      ? `Full-text strategy ${strategy.id} uses figure descriptions from ${getTargetLabel(strategyTarget)}, but no figure-description model is configured. Set it in Settings.`
      : isSameTarget(strategyTarget, installationTarget)
        ? null
        : `Full-text strategy ${strategy.id} uses figure descriptions from ${getTargetLabel(strategyTarget)}; the installation's figure-description model is ${getTargetLabel(installationTarget)}. Switch the setting back, or save the project again to adopt the new model as a new strategy.`
}

export const ensureFullTextJudgingFigureDescriptions = async ({
  articleId,
  strategy,
}: {
  articleId: string
  strategy: FullTextJudgingStrategy
}): Promise<EnsureFigureDescriptionsResult> => {
  const configError = await getFullTextJudgingFigureDescriptionConfigError(strategy)

  if (configError) {
    throw new FullTextJudgingConfigError(configError)
  }

  return (await loadFigureDescriptionStore()).ensureFigureDescriptions(articleId)
}

export const hasPendingFullTextJudgingFigureDescriptions = (block: FullTextJudgingBlock | null): boolean => {
  return (
    block?.strategy?.figureMode === 'descriptions'
    && (block.article.figureAssets ?? []).some((asset) => {
      return asset.descriptionState === 'needed'
    })
  )
}

const startArticleFigureDescriptions = (articleId: string, strategy: FullTextJudgingStrategy): void => {
  const key = `${articleId}|${strategy.id}`

  if (fullTextJudgingFigureDescriptionsInFlight.has(key)) {
    return undefined
  }

  const run = ensureFullTextJudgingFigureDescriptions({articleId, strategy})
    .catch((error: unknown) => {
      fullTextJudgingFigureDescriptionLogger.warn(
        `fullTextJudging:figureDescriptions:${strategy.id}`,
        `[fullTextJudging] Figure descriptions for judging could not start: ${error instanceof Error ? error.message : String(error)}`,
        {articleId, component: 'fullTextJudgingFigureDescriptions', fullTextStrategyId: strategy.id},
      )
    })
    .finally(() => {
      fullTextJudgingFigureDescriptionsInFlight.delete(key)
    })

  fullTextJudgingFigureDescriptionsInFlight.set(key, run)
}

export const startPendingFullTextJudgingFigureDescriptions = (
  entries: Array<{articleId: string; block: FullTextJudgingBlock | null}>,
): void => {
  entries.forEach(({articleId, block}) => {
    if (block?.strategy && hasPendingFullTextJudgingFigureDescriptions(block)) {
      startArticleFigureDescriptions(articleId, block.strategy)
    }
  })
}

export const waitForFullTextJudgingFigureDescriptionsForTests = async (): Promise<void> => {
  await Promise.all([...fullTextJudgingFigureDescriptionsInFlight.values()])
}
