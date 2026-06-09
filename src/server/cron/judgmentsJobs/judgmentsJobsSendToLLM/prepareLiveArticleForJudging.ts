import type {ArticleRecord} from '../../../../db/schemaTypes.ts'
import {ensureFullText} from '../../../utils/ensureFullText.ts'
import {processFulltextForLLM} from '../../../utils/fulltextProcessing.ts'

type FullTextBudget = {maxTokens: number; tokenCount: number; withinBudget: boolean} | null

export type PreparedLiveArticleForJudgingResult =
  | {article: ArticleRecord; fullTextBudget: FullTextBudget; kind: 'ready'}
  | {kind: 'retry'}
  | {kind: 'skipped'; skipReason: 'conversion_failed' | 'no_fulltext'}

export const prepareLiveArticleForJudging = async ({
  article,
  modelContext,
  useFulltext,
  useFulltextNoImages,
}: {
  article: ArticleRecord
  modelContext: number
  useFulltext: boolean
  useFulltextNoImages: boolean
}): Promise<PreparedLiveArticleForJudgingResult> => {
  const needsFulltext = useFulltext || useFulltextNoImages

  if (!needsFulltext) {
    return {article: {...article, fullText: null}, fullTextBudget: null, kind: 'ready'}
  }

  const fullTextResult = await ensureFullText(article, article.id)

  if (!fullTextResult.text) {
    return fullTextResult.shouldSkip ? {kind: 'skipped', skipReason: fullTextResult.reason} : {kind: 'retry'}
  }

  const processedFullText = processFulltextForLLM(fullTextResult.text, {
    stripImages: useFulltextNoImages,
    promptTokenLimit: modelContext,
  })

  return {
    article: {...article, fullText: processedFullText.processedText},
    fullTextBudget: {
      maxTokens: processedFullText.maxTokens,
      tokenCount: processedFullText.tokenCount,
      withinBudget: processedFullText.withinBudget,
    },
    kind: 'ready',
  }
}
