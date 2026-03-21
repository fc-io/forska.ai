import {cors} from '@elysiajs/cors'
import {Elysia} from 'elysia'

import {fullTextConversionJobsCron} from './cron/fullTextConversionJobs.ts'
import {fullTextJobsCron} from './cron/fullTextJobs.ts'
import {judgmentsJobsCron} from './cron/judgmentsJobs.ts'
import {nvidiaSmiCron} from './cron/nvidiaSmi.ts'
import {adminInvestigateRoutes} from './routes/AdminInvestigateRoutes.ts'
import {apiProxyRoutes} from './routes/ApiProxyRoutes.ts'
import {articleAdminRoutes} from './routes/ArticleAdminRoutes.ts'
import {articlesRoutes} from './routes/ArticlesRoutes.ts'
import {comparisonProjectsRoutes} from './routes/ComparisonProjectsRoutes.ts'
import {dataSourcesImportRoutes} from './routes/DataSourcesImportRoutes.ts'
import {dataSourcesRoutes} from './routes/DataSourcesRoutes.ts'
import {duckdbStudioRoutes} from './routes/DuckdbStudioRoutes.ts'
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
import {writerConnectionsRoutes} from './routes/WriterConnectionsRoutes.ts'
import {getCodexCliLoginStatus} from './utils/codexCliAuth.ts'
import {env} from './utils/env'
import {getAppServerRuntimeConfig} from './utils/getAppServerRuntimeConfig.ts'
import {warmCodexAppServer} from './utils/getCodexAppServerClient.ts'
import {inferenceRuntimeConfig} from './utils/getInferenceRuntimeConfig.ts'
import {shouldServerRoleMountWriterCrons} from './utils/serverRole.ts'
import {
  getCurrentServerRole,
  initializeServerRuntimeRole,
  shouldCurrentServerRunWriterWork,
  startServerRuntimeRoleMonitor,
} from './utils/serverRuntimeRole.ts'
import {startWriterConnectionHeartbeat} from './utils/writerConnectionHeartbeat.ts'

const appServerRuntimeConfig = getAppServerRuntimeConfig()
const allowedOrigins = [`http://localhost:${env.VITE_PORT}`, `http://localhost:${appServerRuntimeConfig.port}`]
const shouldMountWriterCrons = shouldServerRoleMountWriterCrons(env.SERVER_ROLE)
const writerCronRoutes = shouldMountWriterCrons
  ? new Elysia().use(fullTextJobsCron).use(fullTextConversionJobsCron).use(judgmentsJobsCron).use(nvidiaSmiCron)
  : new Elysia()

await initializeServerRuntimeRole()

const _app = new Elysia()
  .use(
    cors({
      origin: allowedOrigins,
      credentials: true,
      allowedHeaders: ['Content-Type', 'Authorization'],
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    }),
  )
  .use(apiProxyRoutes)
  .use(writerConnectionsRoutes)
  .use(writerCronRoutes)
  .use(adminInvestigateRoutes)
  .use(comparisonProjectsRoutes)
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
  .use(duckdbStudioRoutes)
  .use(tokensRoutes)
  .use(usersRoutes)
  .use(llmStatusRoutes)
  .use(nvidiaSmiRoutes)
  .use(subprojectsRoutes)
  .listen({port: env.API_SERVER_PORT, idleTimeout: 255})

console.log(
  `🦊 Elysia is running on :${env.API_SERVER_PORT} (nodes=${inferenceRuntimeConfig.gpuNnodes}, gpus/node=${inferenceRuntimeConfig.gpuGpusPerNode}, total_gpus=${inferenceRuntimeConfig.gpuTotalGpus}, shape=${inferenceRuntimeConfig.gpuShape ?? 'not set'}, tp=${inferenceRuntimeConfig.tpSize}, pp=${inferenceRuntimeConfig.ppSize}, dp=${inferenceRuntimeConfig.dpSize}, SGLANG_MAX_RUNNING_REQUESTS=${inferenceRuntimeConfig.sglangMaxRunningRequests}, SGLANG_API_MAX_INFLIGHT_REQUESTS=${inferenceRuntimeConfig.sglangApiMaxInflightRequests}, BUN_CONFIG_MAX_HTTP_REQUESTS=${inferenceRuntimeConfig.bunConfigMaxHttpRequests ?? 'not set'})`,
)
console.log(
  `[server] configured_role=${env.SERVER_ROLE} role=${getCurrentServerRole()} duckdb_writer=${shouldCurrentServerRunWriterWork()}`,
)
startServerRuntimeRoleMonitor()
startWriterConnectionHeartbeat()

void warmCodexAppServer()

void getCodexCliLoginStatus().then((status) => {
  if (!status.ok) {
    console.warn(
      '[codex] CLI not available. Install @openai/codex and/or configure the Codex binary in Settings. Then visit /admin/models to connect.',
    )
    return
  }

  if (!status.loggedIn) {
    console.log(
      `[codex] Not logged in. Run \`codex login\` or open http://localhost:${env.VITE_PORT}/admin/models to start device login.`,
    )
    return
  }

  const method = status.method ?? 'unknown'
  console.log(`[codex] Logged in (${method}).`)
})

export type App = typeof _app
