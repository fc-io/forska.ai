import {cron} from '@elysiajs/cron'
import {Elysia} from 'elysia'

import {getDatabase} from '../utils/getDatabase.ts'
import {fetchNewArticlesForAllJobs, updateProcessingMap} from './judgmentsJobs/judgmentsJobsArticleProcessor.ts'
import {sendArticlesToLLM} from './judgmentsJobs/judgmentsJobsLLMProcessor.ts'
import {getAllJobs} from './judgmentsJobs/judgmentsJobsRepository.ts'
import type {ArticleProcessingData} from './judgmentsJobs/judgmentsJobsTypes.ts'

const articlesAlreadyProcessing = new Map<string, ArticleProcessingData[]>()
let waitingOnNewArticles = false
let waitingOnLLM = false

const NEW_ARTICLES_INTERVAL = '*/5 * * * * *' // Every 5 seconds
const LLM_PROCESSING_INTERVAL = '*/15 * * * * *' // Every 15 seconds

const fetchNewArticlesCronJob = async (): Promise<void> => {
  if (waitingOnNewArticles || waitingOnLLM) return

  waitingOnNewArticles = true
  try {
    const db = getDatabase()
    const allJobs = await getAllJobs(db)
    const newArticlesInProcess = await fetchNewArticlesForAllJobs(allJobs, articlesAlreadyProcessing)
    updateProcessingMap(articlesAlreadyProcessing, newArticlesInProcess)
  } finally {
    waitingOnNewArticles = false
  }
}

const sendToLLMCronJob = async (): Promise<void> => {
  if (waitingOnNewArticles || waitingOnLLM) return

  waitingOnLLM = true
  try {
    const db = getDatabase()
    const allJobs = await getAllJobs(db)
    const jobIds = allJobs.map((job) => {
      return job.jobId
    })
    await sendArticlesToLLM(jobIds, articlesAlreadyProcessing)
  } finally {
    waitingOnLLM = false
  }
}

export const judgmentsJobsCron = new Elysia()
  .use(cron({name: 'judgments-jobs-fetch-articles', pattern: NEW_ARTICLES_INTERVAL, run: fetchNewArticlesCronJob}))
  .use(cron({name: 'judgments-jobs-send-to-llm', pattern: LLM_PROCESSING_INTERVAL, run: sendToLLMCronJob}))
