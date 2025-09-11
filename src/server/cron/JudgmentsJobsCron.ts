import {cron} from '@elysiajs/cron'
import {eq} from 'drizzle-orm'
import {Elysia} from 'elysia'

import {judgmentsJobs, projects} from '../../db/schema.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {judgmentsJobsCronGetArticles} from './judgmentsJobs/judgmentsJobsCronGetArticles.ts'

const articlesAlreadyProccessing = new Map<string, string[]>()
let waitingOnNewArticles = false
export const judgmentsJobsCron = new Elysia().use(
  cron({
    name: 'judgments-jobs-cron',
    pattern: '*/5 * * * * *',
    async run() {
      const db = getDatabase()
      const allJobs = await db
        .select({
          jobId: judgmentsJobs.id,
          jobStatus: judgmentsJobs.status,
          projectId: judgmentsJobs.projectId,
          projectName: projects.name,
        })
        .from(judgmentsJobs)
        .innerJoin(projects, eq(judgmentsJobs.projectId, projects.id))

      if (waitingOnNewArticles) {
        return
      }
      waitingOnNewArticles = true
      const newArticlesInProcess = await Promise.all(
        allJobs.map(async (job) => {
          const {jobId, projectName, jobStatus, projectId} = job
          console.log(`- Project: "${projectName}" | Status: ${jobStatus} | Job ID: ${jobId} | projectId: ${projectId}`)

          const articles = await judgmentsJobsCronGetArticles({
            projectId,
            numberOfArticlesToGet: 10,
            // articlesAlreadyProccessing: articlesAlreadyProccessing.get(jobId) || [],
            articlesAlreadyProccessing: [],
          })
          console.log('articles', articles.join(', '))
          return [`${jobId}_${articles.join(', ')}`, articles]
        }),
      )
      newArticlesInProcess.forEach(([jobId, articles]) => {
        // console.log(jobId, articles)
        if (jobId && typeof jobId === 'string') {
          articlesAlreadyProccessing.set(jobId, articles as string[])
        }
      })
      console.log('articlesAlreadyProccessing', articlesAlreadyProccessing.size)
      waitingOnNewArticles = false
    },
  }),
)
