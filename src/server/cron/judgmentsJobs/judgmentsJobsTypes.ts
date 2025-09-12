import * as schema from '../../../db/schema.ts'

export type ArticleProcessingData = {
  articlesToJudgeIds: string[]
  articlesToJudge: (typeof schema.articles.$inferSelect)[]
  projectPrompts: (typeof schema.prompts.$inferSelect)[]
  isSentToLLM?: boolean
  jobId?: string
}

export type JobData = {jobId: string; jobStatus: string; projectId: string; projectName: string}

export type ProcessingState = {
  articlesAlreadyProcessing: Map<string, ArticleProcessingData[]>
  waitingOnNewArticles: boolean
  waitingOnLLM: boolean
}
