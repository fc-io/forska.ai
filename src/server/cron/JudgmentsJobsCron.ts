import {cron} from '@elysiajs/cron'
import {eq} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'
import {Elysia} from 'elysia'

import {judge} from '../../agent/judge.ts'
import * as schema from '../../db/schema.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {judgmentsJobsCronGetArticles} from './judgmentsJobs/judgmentsJobsCronGetArticles.ts'

const articlesAlreadyProccessing = new Map<
  string,
  {
    articlesToJudgeIds: string[]
    articlesToJudge: (typeof schema.articles.$inferSelect)[]
    projectPrompts: (typeof schema.prompts.$inferSelect)[]
    isSentToLLM?: boolean
  }[]
>()
let waitingOnNewArticles = false
let waitingOnLLM = false

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
  articlesAlreadyProccessing: Map<
    string,
    {
      articlesToJudgeIds: string[]
      articlesToJudge: (typeof schema.articles.$inferSelect)[]
      projectPrompts: (typeof schema.prompts.$inferSelect)[]
    }[]
  >
}): Promise<
  [
    string,
    {
      articlesToJudgeIds: string[]
      articlesToJudge: (typeof schema.articles.$inferSelect)[]
      projectPrompts: (typeof schema.prompts.$inferSelect)[]
    },
  ][]
> => {
  const numberOfArticlesToGet = 1

  return await Promise.all(
    allJobs.map(async (job) => {
      const {jobId, projectName, jobStatus, projectId} = job
      // console.log(`- Project: "${projectName}" | Status: ${jobStatus} | Job ID: ${jobId} | projectId: ${projectId}`)
      // console.log('prev articlesAlreadyProccessing least', (articlesAlreadyProccessing.get(jobId) || []).length)
      const {articlesToJudgeIds, articlesToJudge, projectPrompts} = await judgmentsJobsCronGetArticles(
        projectId,
        numberOfArticlesToGet,
        (articlesAlreadyProccessing.get(jobId) || [{articlesToJudgeIds: []}]).reduce(
          (acc: string[], {articlesToJudgeIds}) => {
            return [...acc, ...articlesToJudgeIds]
          },
          [],
        ),
      )
      // console.log('articles', articles.join(', '))
      return [jobId, {articlesToJudgeIds, articlesToJudge, projectPrompts}]
    }),
  )
}

export const judgmentsJobsCron = new Elysia()
  .use(
    cron({
      name: 'judgments-jobs-cron',
      pattern: '*/5 * * * * *',
      async run() {
        const db = getDatabase()
        const allJobs = await getAllJobs(db)
        // console.log('allJobs size:', allJobs.length)
        if (waitingOnNewArticles === false && waitingOnLLM === false) {
          waitingOnNewArticles = true
          const newArticlesInProcess = await getNewArticlesInProcess({allJobs, articlesAlreadyProccessing})
          // console.log('newArticlesInProcess size:', newArticlesInProcess.length)
          newArticlesInProcess.forEach(([jobId, data]) => {
            // console.log(jobId, articlesToJudgeIds)
            if (jobId && typeof jobId === 'string') {
              const previousArticles = articlesAlreadyProccessing.get(jobId) || []
              // console.log('articlesToJudgeIds', articlesToJudgeIds)
              articlesAlreadyProccessing.set(jobId, [...previousArticles, data])
            }
            // console.log('articlesAlreadyProccessing size:', articlesAlreadyProccessing.size)
            // console.log('in -> size:', (articlesAlreadyProccessing.get(jobId) || []).length)
          })
          waitingOnNewArticles = false
        }
      },
    }),
  )
  .use(
    cron({
      name: 'judgments-jobs-cron-send-to-llm',
      pattern: '*/15 * * * * *',
      async run() {
        console.log('send to LLM')
        const db = getDatabase()
        const allJobs = await getAllJobs(db)
        // console.log('allJobs size:', allJobs.length)
        if (waitingOnNewArticles === false && waitingOnLLM === false) {
          waitingOnLLM = true

          const sessionId = 'cron' + crypto.randomUUID()

          const jobIds = allJobs.map((job) => {
            return job.jobId
          })

          const toJudgeData = jobIds.map((jobId) => {
            return {data: articlesAlreadyProccessing.get(jobId), jobId}
          })
          console.log('toJudgeData:', toJudgeData)
          const filteredToJudgeData = toJudgeData.reduce<
            {
              articlesToJudgeIds: string[]
              articlesToJudge: (typeof schema.articles.$inferSelect)[]
              projectPrompts: (typeof schema.prompts.$inferSelect)[]
              isSentToLLM?: boolean
            }[]
          >((acc, {data = []}) => {
            const a = data.filter(({isSentToLLM}) => {
              return isSentToLLM === undefined
            })
            return [...acc, ...a]
          }, [])

          console.log('filteredToJudgeData:', filteredToJudgeData)

          toJudgeData.forEach(({data = [], jobId}) => {
            articlesAlreadyProccessing.set(
              jobId,
              data.map((d) => {
                return {...d, isSentToLLM: true}
              }),
            )
          })
          console.log('filteredToJudgeData length:', filteredToJudgeData.length)
          filteredToJudgeData.map(
            (data: {
              articlesToJudgeIds: string[]
              articlesToJudge: (typeof schema.articles.$inferSelect)[]
              projectPrompts: (typeof schema.prompts.$inferSelect)[]
              isSentToLLM?: boolean
            }) => {
              // console.log('data:', data.articlesToJudge)
              const {articlesToJudge, projectPrompts} = data
              // console.log(' filteredToJudgeData to send data', data.articlesToJudge.length)
              // await judge({articles: articlesToJudge, prompts: projectPrompts, sessionId})
            },
          )
          waitingOnLLM = false
          console.log('end send to LLM')
        }
      },
    }),
  )
