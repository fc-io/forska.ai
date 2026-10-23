import {
  type CronRuntimeClassState,
  cronRuntimeTickNames,
  type CronRuntimeTickState,
  getCronRuntimeDiagnostics,
} from '../../cron/cronRuntimeState.ts'
import type {JudgmentsCleanupStaleCronActivity} from '../../cron/judgmentsJobsCronState.ts'

type JudgmentJobControlPlaneCronState = CronRuntimeTickState & {active: boolean; inactiveReason: string | null}
type JudgmentJobControlPlaneDiagnostics = {
  addToQueueCron: JudgmentJobControlPlaneCronState
  cleanupStaleActivity: JudgmentsCleanupStaleCronActivity
  cleanupStaleCron: JudgmentJobControlPlaneCronState
  duckdbMemoryLimit: string | null
  duckdbMemoryLimitMiB: number | null
  heavyMaintenanceCrons: CronRuntimeClassState
  importJudgmentsCron: JudgmentJobControlPlaneCronState
  llmStatusCron: JudgmentJobControlPlaneCronState
  lowMemoryOwner: boolean
  lowMemoryThresholdMiB: number
  operationalJudgmentCrons: CronRuntimeClassState
  sampleProviderTelemetryCron: JudgmentJobControlPlaneCronState
  serverRole: string
}

const getJudgmentJobControlPlaneCronState = ({
  classState,
  tickState,
}: {
  classState: CronRuntimeClassState
  tickState: CronRuntimeTickState
}): JudgmentJobControlPlaneCronState => {
  return {...tickState, active: classState.active, inactiveReason: classState.active ? null : classState.reason}
}

export const getJudgmentJobControlPlaneDiagnostics = (): JudgmentJobControlPlaneDiagnostics => {
  const cronRuntime = getCronRuntimeDiagnostics()
  const operationalClassState = cronRuntime.operationalJudgmentCrons

  return {
    addToQueueCron: getJudgmentJobControlPlaneCronState({
      classState: operationalClassState,
      tickState: cronRuntime.crons[cronRuntimeTickNames.addToQueue],
    }),
    cleanupStaleActivity: cronRuntime.cleanupStaleActivity,
    cleanupStaleCron: getJudgmentJobControlPlaneCronState({
      classState: operationalClassState,
      tickState: cronRuntime.crons[cronRuntimeTickNames.cleanupStale],
    }),
    duckdbMemoryLimit: cronRuntime.duckdbMemoryLimit,
    duckdbMemoryLimitMiB: cronRuntime.duckdbMemoryLimitMiB,
    heavyMaintenanceCrons: cronRuntime.heavyMaintenanceCrons,
    importJudgmentsCron: getJudgmentJobControlPlaneCronState({
      classState: operationalClassState,
      tickState: cronRuntime.crons[cronRuntimeTickNames.importJudgments],
    }),
    llmStatusCron: getJudgmentJobControlPlaneCronState({
      classState: operationalClassState,
      tickState: cronRuntime.crons[cronRuntimeTickNames.checkLlmStatus],
    }),
    lowMemoryOwner: cronRuntime.lowMemoryOwner,
    lowMemoryThresholdMiB: cronRuntime.lowMemoryThresholdMiB,
    operationalJudgmentCrons: operationalClassState,
    sampleProviderTelemetryCron: getJudgmentJobControlPlaneCronState({
      classState: operationalClassState,
      tickState: cronRuntime.crons[cronRuntimeTickNames.sampleProviderTelemetry],
    }),
    serverRole: cronRuntime.serverRole,
  }
}
