import {parseDuckdbMemoryLimitToMiB} from '../utils/duckdbMemoryLimit.ts'
import {env} from '../utils/env.ts'
import {lowMemoryMaintenanceDuckdbLimitMiB} from '../utils/serverCronMountDecisions.ts'
import {shouldDisableServerMutationWork} from '../utils/serverMutationMode.ts'
import {
  type ServerRole,
  shouldServerRoleMountJudgingCrons,
  shouldServerRoleMountMaintenanceCrons,
} from '../utils/serverRole.ts'
import {getCurrentServerRole} from '../utils/serverRuntimeRole.ts'

export type CronRuntimeClassName =
  | 'heavyMaintenanceCrons'
  | 'importOnlyCrons'
  | 'judgingCrons'
  | 'operationalJudgmentCrons'

export type CronRuntimeInactiveReason =
  | 'covered-by-operational-judgment-crons'
  | 'deferred-low-memory-owner'
  | 'mutation-work-disabled'
  | 'role-not-judging-capable'
  | 'role-not-maintenance-capable'

export type CronRuntimeStateSource = 'derived' | 'reported'

export type CronRuntimeClassState = {
  active: boolean
  lastSuccessAt: string | null
  lastTickAt: string | null
  reason: CronRuntimeInactiveReason | null
  source: CronRuntimeStateSource
}

export const cronRuntimeTickNames = {
  addToQueue: 'judgments-jobs-add-to-queue',
  checkLlmStatus: 'judgments-jobs-check-llm-status',
  cleanupStale: 'judgments-jobs-cleanup-stale',
  importJudgments: 'judgments-jobs-import-judgments',
  sampleProviderTelemetry: 'judgments-jobs-sample-provider-telemetry',
} as const

export type CronRuntimeTickName = (typeof cronRuntimeTickNames)[keyof typeof cronRuntimeTickNames]

export type CronRuntimeTickStatus = 'failure' | 'skipped' | 'started' | 'success'

export type CronRuntimeTickState = {
  lastFailureAt: string | null
  lastFailureMessage: string | null
  lastSkippedAt: string | null
  lastSuccessAt: string | null
  lastTickAt: string | null
  running: boolean
}

export type CronRuntimeDiagnostics = {
  crons: Record<CronRuntimeTickName, CronRuntimeTickState>
  duckdbMemoryLimit: string | null
  duckdbMemoryLimitMiB: number | null
  heavyMaintenanceCrons: CronRuntimeClassState
  importOnlyCrons: CronRuntimeClassState
  judgingCrons: CronRuntimeClassState
  lowMemoryOwner: boolean
  lowMemoryThresholdMiB: number
  mutationWorkEnabled: boolean
  operationalJudgmentCrons: CronRuntimeClassState
  serverRole: ServerRole
}

type CronRuntimeClassReport = {
  active?: boolean
  lastSuccessAt?: string | null
  lastTickAt?: string | null
  reason?: CronRuntimeInactiveReason | null
}

type CronRuntimeState = {
  classReports: Partial<Record<CronRuntimeClassName, CronRuntimeClassReport>>
  tickReports: Partial<Record<CronRuntimeTickName, CronRuntimeTickState>>
}

type CronRuntimeDiagnosticsInput = {
  duckdbMemoryLimit?: string | null
  mutationWorkEnabled?: boolean
  serverRole?: ServerRole
}

declare global {
  var __forskaCronRuntimeState: CronRuntimeState | undefined
}

const getCronRuntimeState = () => {
  globalThis.__forskaCronRuntimeState ??= {classReports: {}, tickReports: {}}

  return globalThis.__forskaCronRuntimeState
}

const cronRuntimeState = getCronRuntimeState()

const getRuntimeDuckdbMemoryLimit = () => {
  return String(process.env.DUCKDB_MEMORY_LIMIT ?? env.DUCKDB_MEMORY_LIMIT ?? '').trim() || null
}

const applyClassReport = (
  base: Omit<CronRuntimeClassState, 'source'>,
  report: CronRuntimeClassReport | undefined,
): CronRuntimeClassState => {
  if (!report) {
    return {...base, source: 'derived'}
  }

  const active = report.active ?? base.active

  return {
    active,
    lastSuccessAt: report.lastSuccessAt ?? base.lastSuccessAt,
    lastTickAt: report.lastTickAt ?? base.lastTickAt,
    reason: report.reason ?? (active ? null : base.reason),
    source: 'reported',
  }
}

const getInactiveClassState = (reason: CronRuntimeInactiveReason, report: CronRuntimeClassReport | undefined) => {
  return applyClassReport({active: false, lastSuccessAt: null, lastTickAt: null, reason}, report)
}

const getActiveClassState = (report: CronRuntimeClassReport | undefined) => {
  return applyClassReport({active: true, lastSuccessAt: null, lastTickAt: null, reason: null}, report)
}

const emptyCronRuntimeTickState: CronRuntimeTickState = {
  lastFailureAt: null,
  lastFailureMessage: null,
  lastSkippedAt: null,
  lastSuccessAt: null,
  lastTickAt: null,
  running: false,
}

const getCronRuntimeTickState = (cronName: CronRuntimeTickName): CronRuntimeTickState => {
  return {...emptyCronRuntimeTickState, ...(cronRuntimeState.tickReports[cronName] ?? {})}
}

const getCronRuntimeTickStates = (): Record<CronRuntimeTickName, CronRuntimeTickState> => {
  return {
    [cronRuntimeTickNames.addToQueue]: getCronRuntimeTickState(cronRuntimeTickNames.addToQueue),
    [cronRuntimeTickNames.checkLlmStatus]: getCronRuntimeTickState(cronRuntimeTickNames.checkLlmStatus),
    [cronRuntimeTickNames.cleanupStale]: getCronRuntimeTickState(cronRuntimeTickNames.cleanupStale),
    [cronRuntimeTickNames.importJudgments]: getCronRuntimeTickState(cronRuntimeTickNames.importJudgments),
    [cronRuntimeTickNames.sampleProviderTelemetry]: getCronRuntimeTickState(
      cronRuntimeTickNames.sampleProviderTelemetry,
    ),
  }
}

const getMaintenanceClassState = ({
  active,
  lowMemoryOwner,
  maintenanceCapable,
  mutationWorkEnabled,
  report,
}: {
  active: boolean
  lowMemoryOwner: boolean
  maintenanceCapable: boolean
  mutationWorkEnabled: boolean
  report: CronRuntimeClassReport | undefined
}) => {
  if (active) {
    return getActiveClassState(report)
  }

  return getInactiveClassState(
    !mutationWorkEnabled
      ? 'mutation-work-disabled'
      : !maintenanceCapable
        ? 'role-not-maintenance-capable'
        : lowMemoryOwner
          ? 'deferred-low-memory-owner'
          : 'role-not-maintenance-capable',
    report,
  )
}

export const buildCronRuntimeDiagnostics = ({
  duckdbMemoryLimit = getRuntimeDuckdbMemoryLimit(),
  mutationWorkEnabled = !shouldDisableServerMutationWork(),
  serverRole = getCurrentServerRole(),
}: CronRuntimeDiagnosticsInput = {}): CronRuntimeDiagnostics => {
  const duckdbMemoryLimitMiB = parseDuckdbMemoryLimitToMiB(duckdbMemoryLimit)
  const maintenanceCapable = shouldServerRoleMountMaintenanceCrons(serverRole)
  const judgingCapable = shouldServerRoleMountJudgingCrons(serverRole)
  const lowMemoryOwner =
    maintenanceCapable && duckdbMemoryLimitMiB !== null && duckdbMemoryLimitMiB <= lowMemoryMaintenanceDuckdbLimitMiB
  const operationalActive = mutationWorkEnabled && maintenanceCapable
  const judgingActive = mutationWorkEnabled && judgingCapable
  const heavyMaintenanceActive = operationalActive && !lowMemoryOwner
  const importOnlyActive = false
  const reports = cronRuntimeState.classReports

  return {
    crons: getCronRuntimeTickStates(),
    duckdbMemoryLimit,
    duckdbMemoryLimitMiB,
    heavyMaintenanceCrons: getMaintenanceClassState({
      active: heavyMaintenanceActive,
      lowMemoryOwner,
      maintenanceCapable,
      mutationWorkEnabled,
      report: reports.heavyMaintenanceCrons,
    }),
    importOnlyCrons: importOnlyActive
      ? getActiveClassState(reports.importOnlyCrons)
      : getInactiveClassState(
          operationalActive
            ? 'covered-by-operational-judgment-crons'
            : !mutationWorkEnabled
              ? 'mutation-work-disabled'
              : !maintenanceCapable
                ? 'role-not-maintenance-capable'
                : !judgingCapable
                  ? 'role-not-judging-capable'
                  : 'covered-by-operational-judgment-crons',
          reports.importOnlyCrons,
        ),
    judgingCrons: judgingActive
      ? getActiveClassState(reports.judgingCrons)
      : getInactiveClassState(
          !mutationWorkEnabled ? 'mutation-work-disabled' : 'role-not-judging-capable',
          reports.judgingCrons,
        ),
    lowMemoryOwner,
    lowMemoryThresholdMiB: lowMemoryMaintenanceDuckdbLimitMiB,
    mutationWorkEnabled,
    operationalJudgmentCrons: operationalActive
      ? getActiveClassState(reports.operationalJudgmentCrons)
      : getInactiveClassState(
          !mutationWorkEnabled ? 'mutation-work-disabled' : 'role-not-maintenance-capable',
          reports.operationalJudgmentCrons,
        ),
    serverRole,
  }
}

export const getCronRuntimeDiagnostics = () => {
  return buildCronRuntimeDiagnostics()
}

export const recordCronRuntimeClassState = (className: CronRuntimeClassName, report: CronRuntimeClassReport) => {
  cronRuntimeState.classReports[className] = {...(cronRuntimeState.classReports[className] ?? {}), ...report}
}

const getCronRuntimeTickErrorMessage = (error: unknown): string | null => {
  if (error === null || error === undefined) {
    return null
  }

  if (error instanceof Error) {
    return error.message
  }

  if (typeof error === 'string') {
    return error
  }

  if (typeof error === 'number' || typeof error === 'boolean' || typeof error === 'bigint') {
    return String(error)
  }

  if (typeof error === 'function') {
    return error.name ? `[function ${error.name}]` : '[function]'
  }

  try {
    return JSON.stringify(error) ?? null
  } catch {
    return Object.prototype.toString.call(error)
  }
}

export const recordCronRuntimeTick = (
  cronName: CronRuntimeTickName,
  status: CronRuntimeTickStatus,
  error?: unknown,
) => {
  const now = new Date().toISOString()
  const previous = getCronRuntimeTickState(cronName)
  const next: CronRuntimeTickState = {...previous, lastTickAt: now, running: status === 'started'}

  if (status === 'success') {
    next.lastSuccessAt = now
    next.running = false
  }

  if (status === 'skipped') {
    next.lastSkippedAt = now
    next.running = false
  }

  if (status === 'failure') {
    next.lastFailureAt = now
    next.lastFailureMessage = getCronRuntimeTickErrorMessage(error)
    next.running = false
  }

  cronRuntimeState.tickReports[cronName] = next
}

export const resetCronRuntimeStateForTests = () => {
  cronRuntimeState.classReports = {}
  cronRuntimeState.tickReports = {}
}
