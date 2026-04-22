import {cors} from '@elysiajs/cors'
import {Elysia} from 'elysia'

import {migrateDuckdb} from '../db/migrateDuckdb.ts'
import {fullTextConversionJobsCron} from './cron/fullTextConversionJobs.ts'
import {fullTextJobsCron} from './cron/fullTextJobs.ts'
import {judgmentsJobsCron} from './cron/judgmentsJobs.ts'
import {getJudgmentJobSqliteService} from './cron/judgmentsJobs/judgmentJobSqliteService.ts'
import {nvidiaSmiCron} from './cron/nvidiaSmi.ts'
import {adminInvestigateRoutes} from './routes/AdminInvestigateRoutes.ts'
import {apiProxyRoutes} from './routes/ApiProxyRoutes.ts'
import {articleAdminRoutes} from './routes/ArticleAdminRoutes.ts'
import {articlesRoutes} from './routes/ArticlesRoutes.ts'
import {comparisonProjectsRoutes} from './routes/ComparisonProjectsRoutes.ts'
import {dataSourcesImportRoutes} from './routes/DataSourcesImportRoutes.ts'
import {dataSourcesRoutes} from './routes/DataSourcesRoutes.ts'
import {duckdbOwnerConnectionsRoutes} from './routes/DuckdbOwnerConnectionsRoutes.ts'
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
import {runtimeAssetsRoutes} from './routes/RuntimeAssetsRoutes.ts'
import {subprojectsRoutes} from './routes/SubprojectsRoutes.ts'
import {tokensRoutes} from './routes/TokensRoutes'
import {usersRoutes} from './routes/UsersRoutes'
import {getCodexCliLoginStatus} from './utils/codexCliAuth.ts'
import {env} from './utils/env'
import {getAppServerRuntimeConfig} from './utils/getAppServerRuntimeConfig.ts'
import {warmCodexAppServer} from './utils/getCodexAppServerClient.ts'
import {inferenceRuntimeConfig} from './utils/getInferenceRuntimeConfig.ts'
import {writeRuntimeOperatorLogEvent} from './utils/runtimeLogger.ts'
import {shouldServerRoleMountJudgingCrons, shouldServerRoleMountMaintenanceCrons} from './utils/serverRole.ts'
import {
  canCurrentServerOwnDuckdb,
  getCurrentServerRole,
  initializeServerRuntimeRole,
  shouldCurrentServerRunJudgingLoops,
} from './utils/serverRuntimeRole.ts'
import {startBackgroundWork} from './utils/startBackgroundWork.ts'

const parentMonitorIntervalMs = 1_000
const parentPid = process.ppid
let parentDisconnectSignalSent = false

const isParentProcessAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const startParentDisconnectMonitor = () => {
  const interval = setInterval(() => {
    if (parentDisconnectSignalSent) {
      return
    }

    if (process.ppid === parentPid && isParentProcessAlive(parentPid)) {
      return
    }

    parentDisconnectSignalSent = true
    writeRuntimeOperatorLogEvent({
      attrs: {parentPid},
      event: 'server.shutdown.parent-exited',
      message: `[server] parent pid=${parentPid} exited; shutting down`,
      severity: 'WARN',
      terminalLevel: 'error',
    })
    process.kill(process.pid, 'SIGTERM')
  }, parentMonitorIntervalMs)

  interval.unref()
}

startParentDisconnectMonitor()

const appServerRuntimeConfig = getAppServerRuntimeConfig()
const desktopAllowedOrigins = process.env.FORSKA_DESKTOP_MODE === 'true' ? ['null', 'views://mainview'] : []
const allowedOrigins = [
  `http://localhost:${env.VITE_PORT}`,
  `http://localhost:${appServerRuntimeConfig.port}`,
  ...desktopAllowedOrigins,
]
const shouldMountMaintenanceCrons = shouldServerRoleMountMaintenanceCrons(env.SERVER_ROLE)
const shouldMountJudgingCrons = shouldServerRoleMountJudgingCrons(env.SERVER_ROLE)
const maintenanceCronRoutes = shouldMountMaintenanceCrons
  ? new Elysia().use(fullTextJobsCron).use(fullTextConversionJobsCron).use(nvidiaSmiCron)
  : new Elysia()
const judgingCronRoutes = shouldMountJudgingCrons ? new Elysia().use(judgmentsJobsCron) : new Elysia()

await initializeServerRuntimeRole()

if (canCurrentServerOwnDuckdb()) {
  await migrateDuckdb()
}

if (shouldCurrentServerRunJudgingLoops()) {
  await getJudgmentJobSqliteService().recoverJudgmentJobLeasesOnStartup()
}

const shouldWarmCodex = getCurrentServerRole() !== 'maintenance-worker'

export const app = new Elysia()
  .use(
    cors({
      origin: allowedOrigins,
      credentials: true,
      allowedHeaders: ['Content-Type', 'Authorization'],
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    }),
  )
  .use(apiProxyRoutes)
  .use(duckdbOwnerConnectionsRoutes)
  .use(maintenanceCronRoutes)
  .use(judgingCronRoutes)
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
  .use(runtimeAssetsRoutes)
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

writeRuntimeOperatorLogEvent({
  attrs: {
    apiServerPort: env.API_SERVER_PORT,
    bunConfigMaxHttpRequests: inferenceRuntimeConfig.bunConfigMaxHttpRequests,
    gpuGpusPerNode: inferenceRuntimeConfig.gpuGpusPerNode,
    gpuNnodes: inferenceRuntimeConfig.gpuNnodes,
    gpuShape: inferenceRuntimeConfig.gpuShape,
    gpuTotalGpus: inferenceRuntimeConfig.gpuTotalGpus,
    sglangApiMaxInflightRequests: inferenceRuntimeConfig.sglangApiMaxInflightRequests,
    sglangMaxRunningRequests: inferenceRuntimeConfig.sglangMaxRunningRequests,
    tpSize: inferenceRuntimeConfig.tpSize,
    ppSize: inferenceRuntimeConfig.ppSize,
    dpSize: inferenceRuntimeConfig.dpSize,
  },
  event: 'server.startup.port-bound',
  message: `🦊 Elysia is running on :${env.API_SERVER_PORT} (nodes=${inferenceRuntimeConfig.gpuNnodes}, gpus/node=${inferenceRuntimeConfig.gpuGpusPerNode}, total_gpus=${inferenceRuntimeConfig.gpuTotalGpus}, shape=${inferenceRuntimeConfig.gpuShape ?? 'not set'}, tp=${inferenceRuntimeConfig.tpSize}, pp=${inferenceRuntimeConfig.ppSize}, dp=${inferenceRuntimeConfig.dpSize}, SGLANG_MAX_RUNNING_REQUESTS=${inferenceRuntimeConfig.sglangMaxRunningRequests}, SGLANG_API_MAX_INFLIGHT_REQUESTS=${inferenceRuntimeConfig.sglangApiMaxInflightRequests}, BUN_CONFIG_MAX_HTTP_REQUESTS=${inferenceRuntimeConfig.bunConfigMaxHttpRequests ?? 'not set'})`,
  severity: 'INFO',
})
writeRuntimeOperatorLogEvent({
  attrs: {configuredRole: env.SERVER_ROLE, duckdbOwner: canCurrentServerOwnDuckdb(), role: getCurrentServerRole()},
  event: 'server.startup.role-summary',
  message: `[server] configured_role=${env.SERVER_ROLE} role=${getCurrentServerRole()} duckdb_owner=${canCurrentServerOwnDuckdb()}`,
  severity: 'INFO',
})
startBackgroundWork()

if (shouldWarmCodex) {
  void warmCodexAppServer()
}

if (shouldWarmCodex) {
  void getCodexCliLoginStatus().then((status) => {
    if (!status.ok) {
      writeRuntimeOperatorLogEvent({
        event: 'server.operator-guidance.codex-cli-unavailable',
        message:
          '[codex] CLI not available. Install @openai/codex and/or configure the Codex binary in Settings. Then visit /providers to connect.',
        severity: 'WARN',
      })
      return
    }

    if (!status.loggedIn) {
      writeRuntimeOperatorLogEvent({
        attrs: {providersUrl: `http://localhost:${env.VITE_PORT}/providers`},
        event: 'server.operator-guidance.codex-login',
        message: `[codex] Not logged in. Run \`codex login\` or open http://localhost:${env.VITE_PORT}/providers to start device login.`,
        severity: 'INFO',
      })
      return
    }

    const method = status.method ?? 'unknown'
    writeRuntimeOperatorLogEvent({
      attrs: {method},
      event: 'server.startup.codex-login-status',
      message: `[codex] Logged in (${method}).`,
      severity: 'INFO',
    })
  })
}

export type App = typeof app
