import {getSupabaseClient} from '../../utils/getSupabaseClient.ts'
import type {ExtendedDatabaseItemType} from '../getNewestArticles.ts'
import {colorizeJudgment, colorizeLogMessage} from './colorize.ts'
import type {JudgmentResultType} from './judgeParseJudgment.ts'

// Helper that stores a validated judgment in Supabase and logs the outcome
export const judgeStoreJudgment = async (
  articleId: ExtendedDatabaseItemType['id'],
  articleTitle: string,
  judgment: JudgmentResultType,
): Promise<void> => {
  const supabase = getSupabaseClient()
  const {error} = await supabase
    .from('2025_July')
    .update(judgment)
    .eq('id', articleId)

  if (error) {
    console.error(
      `${articleId} | Failed to store judgment for article ${articleTitle}`,
      error.message,
    )
  } else {
    const logMessage = `${articleId} | ${articleTitle}, ai: ${colorizeJudgment(judgment.article_judged_as_ai)}, ai agent: ${colorizeJudgment(judgment.article_judged_as_ai_agent)}, healthcare: ${colorizeJudgment(judgment.article_judged_as_healthcare)}`
    console.log(colorizeLogMessage(logMessage, judgment))
  }
}
