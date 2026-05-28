import {cors} from '@elysiajs/cors'
import {Elysia} from 'elysia'

import {migrateDuckdb} from '../db/migrateDuckdb.ts'
import {fullTextConversionJobsCron} from './cron/fullTextConversionJobs.ts'
import {fullTextJobsCron} from './cron/fullTextJobs.ts'
import {judgmentsJobsJudgingCron, judgmentsJobsMaintenanceCron} from './cron/judgmentsJobs.ts'
import {startJudgeWorkerStartupRolloutCleanup} from './cron/judgmentsJobs/judgeWorkerCompletionJournal.ts'
import {runStartupAutomaticOrphanedQueueRepair} from './cron/judgmentsJobs/judgmentJobRepair.ts'
import {getDefaultJudgmentServerJobId} from './cron/judgmentsJobs/judgmentJobServerIdentity.ts'
import {getJudgmentJobSqliteService} from './cron/judgmentsJobs/judgmentJobSqliteService.ts'
import {runStartupJudgmentRolloutCleanup} from './cron/judgmentsJobs/judgmentStartupRolloutCleanup.ts'
import {nvidiaSmiCron} from './cron/nvidiaSmi.ts'
import {apiProxyRoutes} from './routes/ApiProxyRoutes.ts'
import {duckdbOwnerPrivateApiPrefix} from './routes/apiRouteClassification.ts'
import {duckdbOwnerConnectionsRoutes} from './routes/DuckdbOwnerConnectionsRoutes.ts'
import {judgmentDispatchTelemetryRoutes} from './routes/JudgmentDispatchTelemetryRoutes.ts'
import {getProductApiRoutes} from './routes/productApiRoutes.ts'
import {publicRouteSurfaceGate} from './routes/publicRouteSurfaceGate.ts'
import {runtimeReadyRoutes} from './routes/runtimeReadyRoutes.ts'
import {
  type ProjectTransferSessionRecoveryResult,
  runProjectTransferStartupRecovery,
  runProjectTransferTtlRecovery,
} from './services/projectTransfer/projectTransferSessionRecovery.ts'
import {getCodexCliLoginStatus} from './utils/codexCliAuth.ts'
import {env} from './utils/env'
import {getAppServerRuntimeConfig} from './utils/getAppServerRuntimeConfig.ts'
import {warmCodexAppServer} from './utils/getCodexAppServerClient.ts'
import {inferenceRuntimeConfig} from './utils/getInferenceRuntimeConfig.ts'
import {initializeJudgeWorkerJournalIdentity} from './utils/judgeWorkerJournalIdentity.ts'
import {validateOwnerlessRouteBackends} from './utils/ownerlessReadableBackends.ts'
import {writeRuntimeFailureLogEvent, writeRuntimeOperatorLogEvent} from './utils/runtimeLogger.ts'
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
const projectTransferTtlRecoveryIntervalMs = 60_000
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

const hasProjectTransferRecoveryProgress = (recovery: ProjectTransferSessionRecoveryResult) => {
  return (
    recovery.cleanupTempArtifactCount > 0
    || recovery.deletedPromotedAssetCount > 0
    || recovery.expiredSessionCount > 0
    || recovery.recoveredCompletionCount > 0
  )
}

const writeProjectTransferRecoveryLogEvent = ({
  recovery,
  recoveryMode,
}: {
  recovery: ProjectTransferSessionRecoveryResult
  recoveryMode: 'startup' | 'ttl'
}) => {
  if (!hasProjectTransferRecoveryProgress(recovery)) {
    return
  }

  writeRuntimeOperatorLogEvent({
    attrs: recovery,
    event: `project-transfer.${recoveryMode}-recovery`,
    message:
      `[project-transfer] ${recoveryMode} recovery scanned ${recovery.scannedSessionCount} session(s), `
      + `${recovery.recoveredCompletionCount} recovered, `
      + `${recovery.expiredSessionCount} expired, `
      + `${recovery.cleanupTempArtifactCount} temp cleanup(s), `
      + `${recovery.deletedPromotedAssetCount} promoted asset(s) deleted`,
    severity: 'INFO',
  })
}

const getProjectTransferRecoveryErrorMessage = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)

  return message.trim().length > 0 ? message : 'Unknown project transfer recovery failure'
}

const writeProjectTransferRecoveryFailureLogEvent = ({
  error,
  recoveryMode,
}: {
  error: unknown
  recoveryMode: 'startup' | 'ttl'
}) => {
  const errorMessage = getProjectTransferRecoveryErrorMessage(error)

  writeRuntimeFailureLogEvent({
    attrs: {error, errorMessage},
    event: `project-transfer.${recoveryMode}-recovery.failure`,
    message: `[project-transfer] ${recoveryMode} recovery failed: ${errorMessage}`,
    terminalArgs: [errorMessage],
  })
}

const runProjectTransferStartupRecoveryWithLogging = async () => {
  try {
    writeProjectTransferRecoveryLogEvent({recovery: await runProjectTransferStartupRecovery(), recoveryMode: 'startup'})
  } catch (error) {
    writeProjectTransferRecoveryFailureLogEvent({error, recoveryMode: 'startup'})
  }
}

const startProjectTransferTtlRecoveryScheduler = () => {
  let running = false

  const runWake = async () => {
    if (running || !canCurrentServerOwnDuckdb()) {
      return
    }

    running = true

    try {
      writeProjectTransferRecoveryLogEvent({recovery: await runProjectTransferTtlRecovery(), recoveryMode: 'ttl'})
    } catch (error) {
      writeProjectTransferRecoveryFailureLogEvent({error, recoveryMode: 'ttl'})
    } finally {
      running = false
    }
  }

  const interval = setInterval(() => {
    void runWake()
  }, projectTransferTtlRecoveryIntervalMs)

  interval.unref()
  process.once('exit', () => {
    clearInterval(interval)
  })
}

const appServerRuntimeConfig = getAppServerRuntimeConfig()
const desktopAllowedOrigins = process.env.FORSKA_DESKTOP_MODE === 'true' ? ['null', 'views://mainview'] : []
const allowedOrigins = [
  `http://localhost:${env.VITE_PORT}`,
  `http://127.0.0.1:${env.VITE_PORT}`,
  `http://localhost:${appServerRuntimeConfig.port}`,
  `http://127.0.0.1:${appServerRuntimeConfig.port}`,
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
  await runProjectTransferStartupRecoveryWithLogging()
}
startProjectTransferTtlRecoveryScheduler()

if (getCurrentServerRole() !== 'judge-worker' && shouldCurrentServerRunJudgingLoops()) {
  await getJudgmentJobSqliteService().recoverJudgmentJobLeasesOnStartup()
  const startupRolloutCleanup = await runStartupJudgmentRolloutCleanup({claimedBy: getDefaultJudgmentServerJobId()})

  if (
    startupRolloutCleanup.discardedRuntimeRows > 0
    || startupRolloutCleanup.drainingJobCount > 0
    || startupRolloutCleanup.failedJobCount > 0
    || startupRolloutCleanup.importedOutboxRows > 0
  ) {
    writeRuntimeOperatorLogEvent({
      attrs: startupRolloutCleanup,
      event: 'judgment-job.startup-rollout-cleanup',
      message:
        `[judgments] startup rollout cleanup processed ${startupRolloutCleanup.jobCount} job(s), `
        + `${startupRolloutCleanup.importedOutboxRows} imported, `
        + `${startupRolloutCleanup.discardedRuntimeRows} runtime row(s) discarded, `
        + `${startupRolloutCleanup.drainingJobCount} draining, ${startupRolloutCleanup.failedJobCount} failed`,
      severity: 'INFO',
    })
  }

  const startupOrphanedQueueRepair = await runStartupAutomaticOrphanedQueueRepair()

  if (
    startupOrphanedQueueRepair.requeuedRows > 0
    || startupOrphanedQueueRepair.deletedRows > 0
    || startupOrphanedQueueRepair.incompleteJobCount > 0
  ) {
    writeRuntimeOperatorLogEvent({
      attrs: startupOrphanedQueueRepair,
      event: 'judgment-job.startup-orphaned-queue-repair',
      message:
        `[judgments] startup orphaned queue repair processed ${startupOrphanedQueueRepair.jobCount} job(s), `
        + `${startupOrphanedQueueRepair.requeuedRows} requeued, ${startupOrphanedQueueRepair.deletedRows} deleted, `
        + `${startupOrphanedQueueRepair.incompleteJobCount} incomplete`,
      severity: startupOrphanedQueueRepair.incompleteJobCount > 0 ? 'WARN' : 'INFO',
    })
  }
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
  .use(publicRouteSurfaceGate)
  .use(apiProxyRoutes)
  .use(runtimeReadyRoutes)
  .use(duckdbOwnerConnectionsRoutes)
  .use(judgmentDispatchTelemetryRoutes)
  .use(maintenanceCronRoutes)
  .use(judgmentCronRoutes)
  .use(publicProductApiRoutes)
  .use(duckdbOwnerPrivateApiRoutes)
  .listen({hostname: '127.0.0.1', port: env.API_SERVER_PORT, idleTimeout: 255})

writeRuntimeOperatorLogEvent({
  attrs: {
    apiServerPort: env.API_SERVER_PORT,
    bunConfigMaxHttpRequests: inferenceRuntimeConfig.bunConfigMaxHttpRequests,
    duckdbPath: env.DUCKDB_PATH,
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
  message: `[duckdb] path=${env.DUCKDB_PATH}\n🦊 Elysia is running on 127.0.0.1:${env.API_SERVER_PORT} (nodes=${inferenceRuntimeConfig.gpuNnodes}, gpus/node=${inferenceRuntimeConfig.gpuGpusPerNode}, total_gpus=${inferenceRuntimeConfig.gpuTotalGpus}, shape=${inferenceRuntimeConfig.gpuShape ?? 'not set'}, tp=${inferenceRuntimeConfig.tpSize}, pp=${inferenceRuntimeConfig.ppSize}, dp=${inferenceRuntimeConfig.dpSize}, SGLANG_MAX_RUNNING_REQUESTS=${inferenceRuntimeConfig.sglangMaxRunningRequests}, SGLANG_API_MAX_INFLIGHT_REQUESTS=${inferenceRuntimeConfig.sglangApiMaxInflightRequests}, BUN_CONFIG_MAX_HTTP_REQUESTS=${inferenceRuntimeConfig.bunConfigMaxHttpRequests ?? 'not set'})`,
  severity: 'INFO',
})
writeRuntimeOperatorLogEvent({
  attrs: {configuredRole: env.SERVER_ROLE, duckdbOwner: canCurrentServerOwnDuckdb(), role: getCurrentServerRole()},
  event: 'server.startup.role-summary',
  message: `[server] configured_role=${env.SERVER_ROLE} role=${getCurrentServerRole()} duckdb_owner=${canCurrentServerOwnDuckdb()}`,
  severity: 'INFO',
})
if (getCurrentServerRole() === 'judge-worker') {
  void startJudgeWorkerStartupRolloutCleanup().catch((error) => {
    writeRuntimeOperatorLogEvent({
      attrs: {error},
      event: 'judge-worker.startup-rollout-cleanup-failed',
      message: '[judge-worker] startup rollout cleanup failed',
      severity: 'ERROR',
      terminalLevel: 'error',
    })
  })
}
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
