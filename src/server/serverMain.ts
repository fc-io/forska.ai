import {cors} from '@elysiajs/cors'
import {Elysia} from 'elysia'

import {migrateDuckdb} from '../db/migrateDuckdb.ts'
import {fullTextConversionJobsCron} from './cron/fullTextConversionJobs.ts'
import {fullTextJobsCron} from './cron/fullTextJobs.ts'
import {judgmentsJobsJudgingCron, judgmentsJobsMaintenanceCron} from './cron/judgmentsJobs.ts'
import {replayJudgeWorkerCompletionOutbox} from './cron/judgmentsJobs/judgeWorkerCompletionJournal.ts'
import {getJudgmentJobSqliteService} from './cron/judgmentsJobs/judgmentJobSqliteService.ts'
import {nvidiaSmiCron} from './cron/nvidiaSmi.ts'
import {adminInvestigateRoutes} from './routes/AdminInvestigateRoutes.ts'
import {apiProxyRoutes} from './routes/ApiProxyRoutes.ts'
import {duckdbOwnerPrivateApiPrefix} from './routes/apiRouteClassification.ts'
import {articleAdminRoutes} from './routes/ArticleAdminRoutes.ts'
import {articlesRoutes} from './routes/ArticlesRoutes.ts'
import {comparisonProjectsRoutes} from './routes/ComparisonProjectsRoutes.ts'
import {dataSourcesImportRoutes} from './routes/DataSourcesImportRoutes.ts'
import {dataSourcesRoutes} from './routes/DataSourcesRoutes.ts'
import {duckdbOwnerConnectionsRoutes} from './routes/DuckdbOwnerConnectionsRoutes.ts'
import {duckdbStudioRoutes} from './routes/DuckdbStudioRoutes.ts'
import {humanAssessmentRoutes} from './routes/HumanAssessmentRoutes.ts'
import {importRoutes} from './routes/ImportRoutes.ts'
import {judgmentDispatchTelemetryRoutes} from './routes/JudgmentDispatchTelemetryRoutes.ts'
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
import {runtimeReadyRoutes} from './routes/runtimeReadyRoutes.ts'
import {subprojectsRoutes} from './routes/SubprojectsRoutes.ts'
import {tokensRoutes} from './routes/TokensRoutes'
import {usersRoutes} from './routes/UsersRoutes'
import {getCodexCliLoginStatus} from './utils/codexCliAuth.ts'
import {env} from './utils/env'
import {getAppServerRuntimeConfig} from './utils/getAppServerRuntimeConfig.ts'
import {warmCodexAppServer} from './utils/getCodexAppServerClient.ts'
import {inferenceRuntimeConfig} from './utils/getInferenceRuntimeConfig.ts'
import {initializeJudgeWorkerJournalIdentity} from './utils/judgeWorkerJournalIdentity.ts'
import {validateOwnerlessRouteBackends} from './utils/ownerlessReadableBackends.ts'
import {writeRuntimeOperatorLogEvent} from './utils/runtimeLogger.ts'
import {
  shouldServerRoleMountJudgingCrons,
  shouldServerRoleMountMaintenanceCrons,
  shouldServerRoleRunCodexStartup,
} from './utils/serverRole.ts'
import {
  canCurrentServerOwnDuckdb,
  getCurrentServerRole,
  initializeServerRuntimeRole,
  shouldCurrentServerMountDuckdbOwnerPrivateApi,
  shouldCurrentServerMountPublicProductApi,
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

await initializeServerRuntimeRole()
await validateOwnerlessRouteBackends()

if (getCurrentServerRole() === 'judge-worker') {
  const judgeWorkerJournalIdentity = initializeJudgeWorkerJournalIdentity()

  writeRuntimeOperatorLogEvent({
    attrs: judgeWorkerJournalIdentity,
    event: 'judge-worker.journal.identity-ready',
    message: `[judge-worker] journal identity ready source=${judgeWorkerJournalIdentity.source} path=${judgeWorkerJournalIdentity.journalPath}`,
    severity: 'INFO',
  })
}

if (canCurrentServerOwnDuckdb()) {
  await migrateDuckdb()
}

if (getCurrentServerRole() === 'judge-worker') {
  await replayJudgeWorkerCompletionOutbox()
}

if (getCurrentServerRole() !== 'judge-worker' && shouldCurrentServerRunJudgingLoops()) {
  await getJudgmentJobSqliteService().recoverJudgmentJobLeasesOnStartup()
}

const shouldMountMaintenanceCrons = shouldServerRoleMountMaintenanceCrons(getCurrentServerRole())
const shouldMountJudgingCrons = shouldServerRoleMountJudgingCrons(getCurrentServerRole())
const maintenanceCronRoutes = shouldMountMaintenanceCrons
  ? new Elysia()
      .use(fullTextJobsCron)
      .use(fullTextConversionJobsCron)
      .use(nvidiaSmiCron)
      .use(judgmentsJobsMaintenanceCron)
  : new Elysia()
const judgmentCronRoutes = shouldMountJudgingCrons ? new Elysia().use(judgmentsJobsJudgingCron) : new Elysia()
const shouldWarmCodex = shouldServerRoleRunCodexStartup(getCurrentServerRole())
const getProductApiRoutes = () => {
  return new Elysia()
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
}
const publicProductApiRoutes = shouldCurrentServerMountPublicProductApi() ? getProductApiRoutes() : new Elysia()
const duckdbOwnerPrivateApiRoutes = shouldCurrentServerMountDuckdbOwnerPrivateApi()
  ? new Elysia({prefix: duckdbOwnerPrivateApiPrefix}).use(getProductApiRoutes())
  : new Elysia()
const _publicAppContract = new Elysia()
  .use(runtimeReadyRoutes)
  .use(duckdbOwnerConnectionsRoutes)
  .use(getProductApiRoutes())

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
  .use(runtimeReadyRoutes)
  .use(duckdbOwnerConnectionsRoutes)
  .use(judgmentDispatchTelemetryRoutes)
  .use(maintenanceCronRoutes)
  .use(judgmentCronRoutes)
  .use(publicProductApiRoutes)
  .use(duckdbOwnerPrivateApiRoutes)
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

export type App = typeof _publicAppContract
