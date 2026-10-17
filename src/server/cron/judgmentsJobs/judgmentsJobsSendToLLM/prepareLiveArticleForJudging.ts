import type {ArticleRecord} from '../../../../db/schemaTypes.ts'
import {ensureFullText} from '../../../utils/ensureFullText.ts'

export type PreparedLiveArticleForJudgingResult =
  | {article: ArticleRecord; kind: 'ready'}
  | {kind: 'retry'}
  | {kind: 'skipped'; skipReason: 'conversion_failed' | 'no_fulltext'}

export const prepareLiveArticleForJudging = async ({
  article,
  needsFulltext,
}: {
  article: ArticleRecord
  needsFulltext: boolean
}): Promise<PreparedLiveArticleForJudgingResult> => {
  if (!needsFulltext) {
    return {article: {...article, fullText: null}, kind: 'ready'}
  }

  const fullTextResult = await ensureFullText(article, article.id)

  if (!fullTextResult.text) {
    return fullTextResult.shouldSkip ? {kind: 'skipped', skipReason: fullTextResult.reason} : {kind: 'retry'}
  }

  return {article: {...article, fullText: fullTextResult.text}, kind: 'ready'}
}
