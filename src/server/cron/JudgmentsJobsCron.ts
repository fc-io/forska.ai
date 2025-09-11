import {cron} from '@elysiajs/cron'
import {eq} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'
import {Elysia} from 'elysia'

import * as schema from '../../db/schema.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {judgmentsJobsCronGetArticles} from './judgmentsJobs/judgmentsJobsCronGetArticles.ts'

const articlesAlreadyProccessing = new Map<string, string[]>()
let waitingOnNewArticles = false

const getAllJobs = async (db: PostgresJsDatabase<typeof schema>) => {
  return await db
    .select({
      jobId: schema.judgmentsJobs.id,
      jobStatus: schema.judgmentsJobs.status,
      projectId: schema.judgmentsJobs.projectId,
      projectName: schema.projects.name,
    })
    .from(schema.judgmentsJobs)
    .innerJoin(schema.projects, eq(schema.judgmentsJobs.projectId, schema.projects.id))
}

const getNewArticlesInProcess = async ({
  allJobs,
  articlesAlreadyProccessing,
}: {
  allJobs: {jobId: string; projectName: string; jobStatus: string; projectId: string}[]
  articlesAlreadyProccessing: Map<string, string[]>
}): Promise<[string, string[]][]> => {
  const numberOfArticlesToGet = 10

  return await Promise.all(
    allJobs.map(async (job) => {
      const {jobId, projectName, jobStatus, projectId} = job
      console.log(`- Project: "${projectName}" | Status: ${jobStatus} | Job ID: ${jobId} | projectId: ${projectId}`)
      console.log('prev articlesAlreadyProccessing least', (articlesAlreadyProccessing.get(jobId) || []).length)
      const articles = await judgmentsJobsCronGetArticles(
        projectId,
        numberOfArticlesToGet,
        articlesAlreadyProccessing.get(jobId) || [],
      )
      // console.log('articles', articles.join(', '))
      return [`${jobId}`, articles]
    }),
  )
}

export const judgmentsJobsCron = new Elysia().use(
  cron({
    name: 'judgments-jobs-cron',
    pattern: '*/10 * * * * *',
    async run() {
      const db = getDatabase()
      const allJobs = await getAllJobs(db)
      if (waitingOnNewArticles) {
        return
      }
      waitingOnNewArticles = true
      const newArticlesInProcess = await getNewArticlesInProcess({allJobs, articlesAlreadyProccessing})

      newArticlesInProcess.forEach(([jobId, articles]) => {
        // console.log(jobId, articles)
        if (jobId && typeof jobId === 'string') {
          const previousArticles = articlesAlreadyProccessing.get(jobId)
          // console.log('articles', articles)
          articlesAlreadyProccessing.set(jobId, [...(previousArticles || []), ...articles] as string[])
        }
      })
      console.log('articlesAlreadyProccessing size:', articlesAlreadyProccessing.size)
      waitingOnNewArticles = false
    },
  }),
)
