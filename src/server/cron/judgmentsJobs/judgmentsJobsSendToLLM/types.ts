import type * as schema from '../../../../db/schema.ts'

export type ArticleToProcess = {jobId: string; articleId: string; recordId: string; projectId: string}

export type ArticleRow = typeof schema.articles.$inferSelect
export type PromptRow = typeof schema.prompts.$inferSelect
