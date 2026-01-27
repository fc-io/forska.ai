import {cors} from '@elysiajs/cors'
import {Elysia} from 'elysia'

import {fullTextConversionJobsCron} from './cron/fullTextConversionJobs.ts'
import {fullTextJobsCron} from './cron/fullTextJobs.ts'
import {judgmentsJobsCron} from './cron/judgmentsJobs.ts'
import {nvidiaSmiCron} from './cron/nvidiaSmi.ts'
import {aaModelsRoutes} from './routes/AaModelsRoutes'
import {adminClickhouseHealthRoutes} from './routes/AdminClickhouseHealthRoutes.ts'
import {adminImportRouteStatsRoutes} from './routes/AdminImportRouteStatsRoutes.ts'
import {adminInvestigateRoutes} from './routes/AdminInvestigateRoutes.ts'
import {adminSyncStatsRoutes} from './routes/AdminSyncStatsRoutes.ts'
import {articleAdminRoutes} from './routes/ArticleAdminRoutes.ts'
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
import {nvidiaSmiRoutes} from './routes/NvidiaSmiRoutes.ts'
import {projectArticlesRoutes} from './routes/ProjectArticlesRoutes.ts'
import {projectExportRoutes} from './routes/ProjectExportRoutes.ts'
import {projectsAddArticlesRoutes} from './routes/ProjectsAddArticlesRoutes.ts'
import {projectsRoutes} from './routes/ProjectsRoutes.ts'
import {promptsRoutes} from './routes/PromptsRoutes.ts'
import {subprojectsRoutes} from './routes/SubprojectsRoutes.ts'
import {tokensRoutes} from './routes/TokensRoutes'
import {usersRoutes} from './routes/UsersRoutes'
import {env} from './utils/env'

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
  .use(fullTextConversionJobsCron)
  .use(judgmentsJobsCron)
  .use(nvidiaSmiCron)
  .use(authRoutes)
  .use(adminClickhouseHealthRoutes)
  .use(adminInvestigateRoutes)
  .use(adminImportRouteStatsRoutes)
  .use(adminSyncStatsRoutes)
  .use(judgmentsJobsRoutes)
  .use(articlesRoutes)
  .use(articleAdminRoutes)
  .use(judgmentsRoutes)
  .use(humanAssessmentRoutes)
  .use(modelsRoutes)
  .use(projectsRoutes)
  .use(projectExportRoutes)
  .use(projectsAddArticlesRoutes)
  .use(projectArticlesRoutes)
  .use(promptsRoutes)
  .use(importRoutes)
  .use(dataSourcesRoutes)
  .use(dataSourcesImportRoutes)
  .use(tokensRoutes)
  .use(usersRoutes)
  .use(llmStatusRoutes)
  .use(nvidiaSmiRoutes)
  .use(subprojectsRoutes)
  .use(aaModelsRoutes)
  .listen(env.API_SERVER_PORT)

console.log(
  `🦊 Elysia is running on :${env.API_SERVER_PORT} (nodes=${env.GPU_NNODES}, gpus/node=${env.GPU_GPUS_PER_NODE}, total_gpus=${env.GPU_TOTAL_GPUS}, shape=${env.GPU_SHAPE}, tp=${env.TP_SIZE}, pp=${env.PP_SIZE}, dp=${env.DP_SIZE}, SGLANG_MAX_RUNNING_REQUESTS=${env.SGLANG_MAX_RUNNING_REQUESTS}, SGLANG_API_MAX_INFLIGHT_REQUESTS=${env.SGLANG_API_MAX_INFLIGHT_REQUESTS}, SGLANG_CONTEXT_LENGTH=${env.SGLANG_CONTEXT_LENGTH}, BUN_CONFIG_MAX_HTTP_REQUESTS=${process.env.BUN_CONFIG_MAX_HTTP_REQUESTS})`,
)

export type App = typeof _app
