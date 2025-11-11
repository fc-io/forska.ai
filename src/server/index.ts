import {cors} from '@elysiajs/cors'
import {Elysia} from 'elysia'

import {fullTextJobsCron} from './cron/fullTextJobs.ts'
import {judgmentsJobsCron} from './cron/judgmentsJobs.ts'
import {articlesRoutes} from './routes/ArticlesRoutes.ts'
import {authRoutes} from './routes/AuthRoutes.ts'
import {dataSourcesImportRoutes} from './routes/DataSourcesImportRoutes.ts'
import {dataSourcesRoutes} from './routes/DataSourcesRoutes.ts'
import {humanAssessmentRoutes} from './routes/HumanAssessmentRoutes.ts'
import {importRoutes} from './routes/ImportRoutes.ts'
import {judgmentsJobsRoutes} from './routes/JudgmentsJobsRoutes.ts'
import {judgmentsRoutes} from './routes/JudgmentsRoutes.ts'
import {llmStatusRoutes} from './routes/LlmStatusRoutes.ts'
import {modelsRoutes} from './routes/ModelsRoutes.ts'
import {projectsRoutes} from './routes/ProjectsRoutes.ts'
import {projectArticlesRoutes} from './routes/ProjectArticlesRoutes.ts'
import {adminPromptsRoutes} from './routes/AdminPromptsRoutes.ts'
import {tokensRoutes} from './routes/TokensRoutes.ts'
import {usersRoutes} from './routes/UsersRoutes.ts'
import {env} from './utils/env.ts'

const allowedOrigins = [`http://localhost:${env.VITE_PORT}`, `http://localhost:${process.env.PROD_SERVER ?? 8080}`]

const _app = new Elysia()
  .use(
    cors({
      origin: allowedOrigins,
      credentials: true,
      allowedHeaders: ['Content-Type', 'Authorization'],
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    }),
  )
  .use(fullTextJobsCron)
  .use(judgmentsJobsCron)
  .use(authRoutes)
  .use(judgmentsJobsRoutes)
  .use(articlesRoutes)
  .use(judgmentsRoutes)
  .use(humanAssessmentRoutes)
  .use(modelsRoutes)
  .use(projectsRoutes)
  .use(projectArticlesRoutes)
  .use(adminPromptsRoutes)
  .use(importRoutes)
  .use(dataSourcesRoutes)
  .use(dataSourcesImportRoutes)
  .use(tokensRoutes)
  .use(usersRoutes)
  .use(llmStatusRoutes)
  .listen(env.API_SERVER_PORT)

console.log(
  `🦊 Elysia is running on :${env.API_SERVER_PORT} (nodes=${env.GPU_NNODES}, gpus/node=${env.GPU_GPUS_PER_NODE}, total_gpus=${env.GPU_TOTAL_GPUS}, shape=${env.GPU_SHAPE}, tp=${env.TP_SIZE}, dp=${env.DP_SIZE}, max_running_requests=${env.SGLANG_MAX_RUNNING_REQUESTS})`,
)

export type App = typeof _app
