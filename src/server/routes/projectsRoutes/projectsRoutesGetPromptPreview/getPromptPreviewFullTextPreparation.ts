import type {ArticleRecord} from '../../../../db/schemaTypes.ts'
import {prepareFullTextJudging} from '../../../cron/judgmentsJobs/judgmentsJobsSendToLLM/prepareFullTextJudging.ts'
import {getFullTextChunkPlanKey} from '../../../fullText/fullTextChunkPlanStore.ts'
import {getFullTextJudgingBlocks} from '../../../fullText/fullTextJudgingBlocks.ts'
import {getAppDatabaseService} from '../../../services/appDatabaseService.ts'
import {getJsonValue} from '../../../services/appQueryHelpers.ts'
import type {PromptPreviewArticleDetailsRow} from './getPromptPreviewArticleDetails.ts'

export const getPromptPreviewFullTextPreparation = async (input: {
  article: ArticleRecord
  details: PromptPreviewArticleDetailsRow | null
  fullText: string
  fullTextStrategyId: string
  modelContext: number
  modelName: string
}) => {
  const blocks = await getFullTextJudgingBlocks({
    database: getAppDatabaseService(),
    rows: [
      {
        articleId: input.article.id,
        articleSummary: input.article.articleSummary,
        fullText: input.fullText,
        fullTextAssets: getJsonValue(input.details?.fullTextAssets),
        fullTextCanonicalVersion: input.details?.fullTextCanonicalVersion ?? null,
        fullTextFigureModeBuilt: input.details?.fullTextFigureModeBuilt ?? null,
        fullTextStrategyId: input.fullTextStrategyId,
      },
    ],
    writable: false,
  })

  return prepareFullTextJudging({
    abstract: input.article.articleSummary,
    articleId: input.article.id,
    block:
      blocks.get(getFullTextChunkPlanKey({articleId: input.article.id, fullTextStrategyId: input.fullTextStrategyId}))
      ?? null,
    fullText: input.fullText,
    fullTextStrategyId: input.fullTextStrategyId,
    modelContext: input.modelContext,
    modelName: input.modelName,
  })
}
